/**
 * Tiny DOM builder. Text is always inserted as text nodes (never parsed as
 * HTML), which makes rendering XSS-safe by construction, and styles are set
 * through the CSSOM, which the Content-Security-Policy allows.
 */

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function applyProps(el, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked' && 'checked' in el) el.checked = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
}

/** Create an element: h('div', { class: 'x', onClick }, 'text', child, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

/** Create an SVG element. */
export function svg(tag, props, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

/** Replace an element's children. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Highlight occurrences of `needle` in `text` with <mark> (text-safe). */
export function highlight(text, needle) {
  if (!needle) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  let pos = 0;
  for (;;) {
    const i = lower.indexOf(n, pos);
    if (i < 0) break;
    frag.append(text.slice(pos, i), h('mark', null, text.slice(i, i + n.length)));
    pos = i + n.length;
  }
  frag.append(text.slice(pos));
  return frag;
}
