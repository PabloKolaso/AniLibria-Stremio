/**
 * Formatting helpers. Times are shown in the browser's local time zone;
 * tooltips carry the exact UTC value.
 */

const numberFmt = new Intl.NumberFormat();
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayHourFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export const DASH = '—';

export function num(n) {
  return n === null || n === undefined || Number.isNaN(n) ? DASH : numberFmt.format(n);
}

export function pct(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return DASH;
  const value = ratio * 100;
  return `${value.toFixed(value >= 99.95 || value === 0 ? 0 : digits)}%`;
}

export function ms(value) {
  if (value === null || value === undefined) return DASH;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function bytes(b) {
  if (b === null || b === undefined) return DASH;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** "3d 4h", "5h 12m", "4m 10s", "12s" */
export function duration(msValue) {
  if (msValue === null || msValue === undefined || msValue < 0) return DASH;
  const s = Math.floor(msValue / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** "just now", "12s ago", "5m ago", "3h ago", "2d ago" (or "in 3m" for the future). */
export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const diff = now - ts;
  const abs = Math.abs(diff);
  let text;
  if (abs < 5000) return 'just now';
  if (abs < 60_000) text = `${Math.round(abs / 1000)}s`;
  else if (abs < 3_600_000) text = `${Math.round(abs / 60_000)}m`;
  else if (abs < 172_800_000) text = `${Math.round(abs / 3_600_000)}h`;
  else text = `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

export function dateTime(ts) {
  return ts ? dateTimeFmt.format(new Date(ts)) : DASH;
}

export function date(ts) {
  return ts ? dateFmt.format(new Date(ts)) : DASH;
}

export function hour(ts) {
  return hourFmt.format(new Date(ts));
}

export function dayHour(ts) {
  return dayHourFmt.format(new Date(ts));
}

export function utc(ts) {
  return ts ? `${new Date(ts).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '';
}

/**
 * Change against a previous value.
 * @param {number|null} cur
 * @param {number|null} prev
 * @param {{ higherIsBetter?: boolean, ratio?: boolean }} [opts] - ratio: values are ratios (show points)
 * @returns {{ text: string, tone: 'good'|'bad'|'flat' }|null}
 */
export function delta(cur, prev, { higherIsBetter = true, ratio = false } = {}) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  let diff;
  let text;
  if (ratio) {
    diff = (cur - prev) * 100;
    if (Math.abs(diff) < 0.05) return { text: '±0 pts', tone: 'flat' };
    text = `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)} pts`;
  } else {
    if (prev === 0) return cur === 0 ? { text: '±0%', tone: 'flat' } : { text: 'new', tone: 'flat' };
    diff = ((cur - prev) / prev) * 100;
    if (Math.abs(diff) < 0.5) return { text: '±0%', tone: 'flat' };
    text = `${diff > 0 ? '+' : '−'}${Math.abs(diff) >= 10 ? Math.round(Math.abs(diff)) : Math.abs(diff).toFixed(1)}%`;
  }
  const good = higherIsBetter ? diff > 0 : diff < 0;
  return { text, tone: good ? 'good' : 'bad' };
}

export function plural(n, word, pluralWord = `${word}s`) {
  return `${num(n)} ${n === 1 ? word : pluralWord}`;
}
