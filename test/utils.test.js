const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TTLCache = require('../src/util/ttl-cache');
const JsonStore = require('../src/util/json-store');
const { withTimeout, TimeoutError } = require('../src/util/timeout');

test('TTLCache expires entries and evicts least recently used', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const cache = new TTLCache({ ttlMs: 1000, max: 2 });
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.get('a'), 1);        // touch "a" → "b" is now the oldest
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  cache.set('short', 'x', 10);
  t.mock.timers.tick(11);
  assert.equal(cache.get('short'), undefined);
  assert.equal(cache.has('a'), true);
  t.mock.timers.tick(1000);
  assert.equal(cache.get('a'), undefined);
});

test('TTLCache round-trips through toJSON/load and skips expired rows', () => {
  const cache = new TTLCache({ ttlMs: 60_000 });
  cache.set('k', { v: 1 }).set(2, null);
  const restored = new TTLCache({ ttlMs: 60_000 });
  const rows = cache.toJSON();
  rows.push(['old', 1, Date.now() - 1], 'garbage');
  assert.equal(restored.load(rows), 2);
  assert.deepEqual(restored.get('k'), { v: 1 });
  assert.equal(restored.get(2), null);
  assert.equal(restored.get('old'), undefined);
});

test('JsonStore writes atomically and reads back; corrupt files are ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-store-'));
  const file = path.join(dir, 'nested', 'state.json');
  let state = { n: 1 };
  const store = new JsonStore(file, { serialize: () => state, debounceMs: 10 });

  store.schedule();
  state = { n: 2 };           // serialized at write time, not at schedule time
  await store.flush();
  assert.deepEqual(JsonStore.read(file), { n: 2 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  await store.flush();        // nothing dirty → no-op
  fs.writeFileSync(file, '{not json');
  assert.equal(JsonStore.read(file), undefined);
  assert.equal(JsonStore.read(path.join(dir, 'missing.json')), undefined);
});

test('withTimeout rejects slow promises and passes fast ones through', async () => {
  assert.equal(await withTimeout(Promise.resolve(5), 1000), 5);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), TimeoutError);
});
