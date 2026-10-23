// Small DOM + API helpers shared by the employee form and the admin page.

/** Create an element. Children may be strings, nodes, or falsy (skipped). Text is always set safely. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'hidden') node.hidden = Boolean(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false || c === '') continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Paragraph-like element that supports **bold** runs, with no HTML injection. */
export function rich(tag, text) {
  const node = document.createElement(tag);
  String(text).split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) node.append(el('strong', {}, part.slice(2, -2)));
    else if (part) node.append(document.createTextNode(part));
  });
  return node;
}

export function fillPlaceholders(text, t) {
  const company = t.companyName || '';
  return String(text || '')
    .replace(/\{\{\s*company\s*\}\}(\.?)/gi, (_, dot) => (company.endsWith('.') ? company : company + dot))
    .replace(/\{\{\s*startDate\s*\}\}/gi, t.startDate || '________')
    .replace(/\{\{\s*anniversaryDate\s*\}\}/gi, t.anniversaryDate || '________');
}

export const tierKey = (column) => String(column || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** fetch wrapper: JSON in/out, throws Error(message) with .status and .data on failure. */
export async function api(url, { method = 'GET', body, token, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, cache: 'no-store' });
  } catch {
    const err = new Error('We couldn’t reach the server. Check your connection and try again.');
    err.status = 0;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    const data = type.includes('json') ? await res.json().catch(() => ({})) : {};
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (type.includes('json')) return res.json();
  return res;
}
