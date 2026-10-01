/**
 * Debounced, atomic JSON persistence.
 *
 * Each store serializes its in-memory state on demand, writes it to a temp
 * file and renames it over the target, so a crash mid-write never leaves a
 * truncated file behind. Writes are asynchronous and never overlap.
 *
 * Every store (and anything else registered with JsonStore.register) is
 * flushed on shutdown and reports its save status to the dashboard.
 */

const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');

const stores = new Set();

class JsonStore {
  /**
   * @param {string} file - Absolute path of the JSON file
   * @param {{ serialize: () => any, debounceMs?: number, label?: string, mode?: number }} opts
   */
  constructor(file, { serialize, debounceMs = 2000, label = path.basename(file), mode }) {
    this.file = file;
    this.serialize = serialize;
    this.debounceMs = debounceMs;
    this.label = label;
    this.mode = mode;
    this._timer = null;
    this._writing = null;
    this._dirty = false;
    this.lastSavedAt = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.bytes = null;
    stores.add(this);
  }

  /**
   * Read and parse a JSON file. Returns undefined when the file is missing
   * or unreadable (a warning is logged for corrupt files).
   */
  static read(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] Cannot read ${path.basename(file)}: ${err.message}`);
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[store] Ignoring corrupt ${path.basename(file)}: ${err.message}`);
      return undefined;
    }
  }

  /** Mark the state dirty and write it after the debounce interval. */
  schedule() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.debounceMs);
    this._timer.unref?.();
  }

  /** Write pending changes now. Resolves once the latest state is on disk. */
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    while (this._writing) await this._writing;
    if (!this._dirty) return;
    this._dirty = false;
    this._writing = this._write()
      .then(() => {
        this.lastSavedAt = Date.now();
        this.lastError = null;
      })
      .catch(err => {
        this._dirty = true; // retry on the next schedule/flush
        this.lastError = err.message;
        this.lastErrorAt = Date.now();
        console.error(`[store] Failed to save ${this.label}: ${err.message}`);
      })
      .finally(() => { this._writing = null; });
    await this._writing;
  }

  async _write() {
    const json = JSON.stringify(this.serialize());
    const tmp = `${this.file}.tmp`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, json, { encoding: 'utf8', mode: this.mode });
    await fsp.rename(tmp, this.file);
    this.bytes = Buffer.byteLength(json);
  }

  /** Save status for the dashboard. */
  status() {
    return {
      label: this.label,
      file: path.basename(this.file),
      lastSavedAt: this.lastSavedAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      bytes: this.bytes,
      pending: this._dirty,
    };
  }

  /** Track another persistence object (needs flush() and status()). */
  static register(store) {
    stores.add(store);
  }

  /** Flush every store; used on graceful shutdown. */
  static flushAll() {
    return Promise.all([...stores].map(s => s.flush()));
  }

  /** Save status of every store. */
  static statusAll() {
    return [...stores].map(s => s.status());
  }
}

module.exports = JsonStore;
