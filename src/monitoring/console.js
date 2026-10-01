/**
 * Console capture: keeps the most recent console lines in memory for the
 * dashboard's server console and notifies listeners (the problem tracker)
 * of error lines.
 *
 * Must be required FIRST in index.js so console is patched before any
 * other module logs anything.
 */

const util = require('util');

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 8000;

const lines = [];     // { seq, ts, level, text }, oldest first
let seq = 0;          // monotonically increasing line number
const listeners = new Set();
let notifying = false;

function format(args) {
  try {
    // util.format renders Errors with stacks and never throws on circular objects
    return util.formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...args);
  } catch {
    return args.map(String).join(' ');
  }
}

function capture(level, original) {
  return function (...args) {
    let text = format(args);
    if (text.length > MAX_LINE_LENGTH) text = `${text.slice(0, MAX_LINE_LENGTH)}… [truncated]`;
    const line = { seq: ++seq, ts: Date.now(), level, text };
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    original.apply(console, args);

    // Listeners may log themselves; never recurse.
    if (!notifying && listeners.size > 0) {
      notifying = true;
      try {
        for (const listener of listeners) listener(line);
      } catch { /* a broken listener must not break logging */ }
      notifying = false;
    }
  };
}

console.log   = capture('log',   console.log);
console.info  = capture('log',   console.info);
console.warn  = capture('warn',  console.warn);
console.error = capture('error', console.error);

/**
 * Lines after a sequence number (newest `limit` of them).
 * @param {{ after?: number, limit?: number }} [opts]
 */
function getLines({ after = 0, limit = MAX_LINES } = {}) {
  let start = lines.length;
  while (start > 0 && lines[start - 1].seq > after) start--;
  const out = lines.slice(start);
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** "[ISO] [LEVEL] text", the classic console format. */
function formatLine(line) {
  return `[${new Date(line.ts).toISOString()}] [${line.level.toUpperCase()}] ${line.text}`;
}

/** Called with every captured line. */
function onLine(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function lastSeq() {
  return seq;
}

module.exports = { getLines, formatLine, onLine, lastSeq, MAX_LINES };
