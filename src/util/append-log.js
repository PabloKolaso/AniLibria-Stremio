/**
 * Append-only NDJSON persistence for a bounded list of records.
 *
 * New records are appended to the file in small batches, so a busy server
 * never rewrites the whole history for every request. When enough records
 * have been dropped from memory (retention), the file is compacted: the
 * live records are written to a temp file that replaces the old one.
 */

const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');

class AppendLog {
  /**
   * @param {string} file - Absolute path of the .ndjson file
   * @param {{ records: () => object[], label?: string, debounceMs?: number }} opts
   *   records — the live records, used when compacting
   */
  constructor(file, { records, label = path.basename(file), debounceMs = 2000 }) {
    this.file = file;
    this.records = records;
    this.label = label;
    this.debounceMs = debounceMs;
    this.lines = 0;        // records currently in the file
    this._pending = [];
    this._timer = null;
    this._chain = Promise.resolve();
    this.lastSavedAt = null;
    this.lastError = null;
    this.lastErrorAt = null;
  }

  /** Parse every valid line of an NDJSON file ([] when missing). */
  static read(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] Cannot read ${path.basename(file)}: ${err.message}`);
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') out.push(record);
      } catch { /* torn or corrupt line: skip */ }
    }
    return out;
  }

  /** Queue a record for appending. */
  append(record) {
    this._pending.push(JSON.stringify(record));
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.debounceMs);
    this._timer.unref?.();
  }

  /** Append queued records now. */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pending.length === 0) return this._chain;
    const batch = this._pending;
    this._pending = [];
    return this._run(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.appendFile(this.file, batch.join('\n') + '\n', 'utf8');
      this.lines += batch.length;
    });
  }

  /** Rewrite the file with the live records when it holds too many dropped ones. */
  compactIfNeeded() {
    const live = this.records().length;
    if (this.lines + this._pending.length <= live * 1.5 + 500) return this._chain;
    return this.compact();
  }

  /** Rewrite the file with exactly the live records (atomic). */
  compact() {
    this._pending = []; // the live records include everything still queued
    return this._run(async () => {
      const records = this.records();
      const tmp = `${this.file}.tmp`;
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
      await fsp.rename(tmp, this.file);
      this.lines = records.length;
    });
  }

  _run(op) {
    this._chain = this._chain.then(op).then(
      () => {
        this.lastSavedAt = Date.now();
        this.lastError = null;
      },
      err => {
        this.lastError = err.message;
        this.lastErrorAt = Date.now();
        console.error(`[store] Failed to save ${this.label}: ${err.message}`);
      },
    );
    return this._chain;
  }

  status() {
    let bytes = null;
    try { bytes = fs.statSync(this.file).size; } catch { /* not written yet */ }
    return {
      label: this.label,
      file: path.basename(this.file),
      lastSavedAt: this.lastSavedAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      bytes,
      pending: this._pending.length > 0,
    };
  }
}

module.exports = AppendLog;
