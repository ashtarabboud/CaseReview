// Finding quoted passages in opinions and record documents, and a pop-up reader that shows a
// document with those passages underlined. Shared by the main app and the review screen.
// No network. Document text is always inserted as plain text.

const PARA_MARK = /^(\{¶\s*\d+\}|¶\s*\d+\.?|\[\d+\])\s*/;
const NUMBERED_PARA = /^(\d{1,3}\.)\s+(?=\S)/;
const PAGE_MARK = /^\[Page (\d{1,4})\]$/;

/** A "## Heading" section of a Markdown analysis (up to the next heading of the same or higher level). */
export function mdSection(text, name) {
  const lines = String(text || '').split('\n');
  const i = lines.findIndex((l) => /^#{2,3}\s/.test(l) && l.replace(/^#+\s*/, '').toLowerCase().startsWith(name.toLowerCase()));
  if (i < 0) return '';
  const level = lines[i].match(/^#+/)[0].length;
  let j = i + 1;
  while (j < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[j]))) j++;
  return lines.slice(i + 1, j).join('\n').trim();
}

/** Normalised copy of the text (lowercase, plain quotes/dashes, single spaces) with a map back to original offsets. */
export function normMap(text) {
  let out = '';
  const map = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (ch === '‘' || ch === '’') ch = "'"; else if (ch === '“' || ch === '”') ch = '"'; else if (ch === '–' || ch === '—') ch = '-';
    if (/\s/.test(ch)) { if (space) continue; ch = ' '; space = true; } else space = false;
    out += ch.toLowerCase();
    map.push(i);
  }
  return { out, map };
}

/** Find a quoted passage, tolerating curly quotes, spacing, [a]lterations and ellipses. Returns [start, end] or null. */
export function findQuote(text, quote, nm) {
  const { out, map } = nm || normMap(text);
  const q = normMap(String(quote || '').replace(/\[\^\d+\]/g, '').replace(/\[([a-zA-Z])\]/g, '$1')).out.trim().replace(/^["'“]+|["'”]+$/g, '').trim();
  if (q.length < 12) return null;
  const at = (needle, from = 0) => { const i = out.indexOf(needle, from); return i < 0 ? null : [i, i + needle.length]; };
  const toOrig = ([a, b]) => [map[a], map[b - 1] + 1];
  const hit = at(q);
  if (hit) return toOrig(hit);
  const parts = q.split(/\s*(?:\.\s?\.\s?\.|…)\s*/).map((x) => x.trim()).filter((x) => x.length >= 12);
  if (parts.length > 1) {
    const a = at(parts[0]);
    const b = a && at(parts[parts.length - 1], a[1]);
    if (a && b) return toOrig([a[0], b[1]]);
    if (a) return toOrig(a);
  }
  const head = at(q.slice(0, 70));
  if (head) { const tail = at(q.slice(-50), head[1]); return toOrig([head[0], tail && tail[1] - head[0] < q.length * 2 ? tail[1] : head[1]]); }
  return null;
}

/** Quotes from an older analysis that didn't save them separately. */
export function quotesFromAnalysis(text, ...sections) {
  const sec = sections.map((n) => mdSection(text, n)).find(Boolean) || '';
  const out = [];
  for (const m of sec.matchAll(/[“"]([^”"]{25,600})[”"]/g)) out.push({ quote: m[1] });
  for (const line of sec.split('\n')) { const m = /^>\s*(.{25,})$/.exec(line.trim()); if (m && !out.some((o) => m[1].includes(o.quote))) out.push({ quote: m[1].replace(/^["“]|["”]$/g, '') }); }
  return out;
}

/** Pin for a position: page marker ([Page 4] → p. 4), star page (*512), and ¶ number. */
export function pinAt(text, pos) {
  const before = text.slice(Math.max(0, pos - 30000), pos);
  const page = [...before.matchAll(/\[Page (\d{1,4})\]/g)].pop();
  const star = [...before.matchAll(/\*{1,2}(\d{1,4})\b/g)].pop();
  const ps = text.lastIndexOf('\n\n', pos);
  const head = text.slice(ps < 0 ? 0 : ps + 2, (ps < 0 ? 0 : ps + 2) + 24);
  const pm = head.match(PARA_MARK) || head.match(NUMBERED_PARA);
  return [page ? 'p. ' + page[1] : null, star ? '*' + star[1] : null, pm ? '¶ ' + pm[1].replace(/[{}¶\s.]/g, '') : null].filter(Boolean).join(', ');
}

/** Text ready to show: opinions saved before clean-up still have hard line breaks. */
export function displayText(doc) {
  const t = String(doc?.text || '');
  if (doc?.kind === 'record' || (doc?.fmt || 0) >= 2) return t;
  return t.replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
}

// ---------------------------------------------------------------- pop-up reader

let cssLoaded = false;
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

/**
 * Show a document in a pop-up over the current screen, with passages underlined.
 * passages: [{ quote, pin?, why?, label? }]. Closing (✕, Escape, or the phone's Back) returns to exactly where you were.
 */
export function openDocViewer({ title, subtitle = '', text, passages = [], sentence = '', note = '', fullLink = null }) {
  if (!cssLoaded) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./viewer.css', import.meta.url).href;
    document.head.append(link);
    cssLoaded = true;
  }
  const nm = normMap(text);
  const found = [];
  for (const p of passages) {
    const r = findQuote(text, p.quote, nm);
    if (r && !found.some((f) => f.r[0] === r[0])) found.push({ ...p, r, pin: p.pin || pinAt(text, r[0]) });
  }
  found.sort((a, b) => a.r[0] - b.r[0]);

  const body = el('article', 'dv-text');
  let base = 0;
  for (const para of text.split('\n\n')) {
    const start = base;
    base += para.length + 2;
    if (!para.trim()) continue;
    const pm = PAGE_MARK.exec(para.trim());
    if (pm) { body.append(el('div', 'dv-page', `Page ${pm[1]}`)); continue; }
    const p = el('p', '');
    let pos = start;
    const end = start + para.length;
    for (const [i, f] of found.entries()) {
      const a = Math.max(f.r[0], pos), b = Math.min(f.r[1], end);
      if (b <= a) continue;
      if (a > pos) p.append(text.slice(pos, a));
      if (a === f.r[0]) p.append(el('span', 'dv-chip', '📍 ' + (f.pin || 'here')));
      const m = el('mark', 'dv-mark', text.slice(a, b));
      m.dataset.i = i;
      p.append(m);
      pos = b;
    }
    if (pos < end) p.append(text.slice(pos, end));
    body.append(p);
  }

  let cur = -1;
  const counter = el('span', 'dv-count', found.length ? `${found.length} passage${found.length === 1 ? '' : 's'} underlined` : (passages.length ? 'The quoted words weren’t found in this copy — search the text below.' : ''));
  const why = el('div', 'dv-why');
  const go = (i) => {
    if (!found.length) return;
    cur = (i + found.length) % found.length;
    const marks = body.querySelectorAll(`mark[data-i="${cur}"]`);
    body.querySelectorAll('mark.on').forEach((m) => m.classList.remove('on'));
    marks.forEach((m) => m.classList.add('on'));
    marks[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    counter.textContent = `Passage ${cur + 1} of ${found.length}${found[cur].pin ? ' · ' + found[cur].pin : ''}`;
    why.textContent = found[cur].why || found[cur].label || '';
  };
  const btn = (label, onclick, cls = 'dv-btn') => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', onclick); return b; };

  const bg = el('div', 'dv-bg');
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); removeEventListener('popstate', onPop); };
  const onKey = (e) => { if (e.key === 'Escape') history.back(); };
  const onPop = () => close();
  const panel = el('div', 'dv-panel',
    el('div', 'dv-head',
      el('div', 'dv-titles', el('div', 'dv-title', title), subtitle ? el('div', 'dv-sub', subtitle) : null),
      btn('✕', () => history.back(), 'dv-x')),
    sentence ? el('div', 'dv-sentence', el('span', 'dv-label', 'Your sentence'), sentence) : null,
    note ? el('div', 'dv-note', note) : null,
    found.length ? el('div', 'dv-nav', counter, btn('‹', () => go(cur - 1)), btn('›', () => go(cur + 1))) : el('div', 'dv-nav', counter),
    why,
    body,
    fullLink ? el('div', 'dv-foot', Object.assign(el('a', 'dv-btn', fullLink.label), { href: fullLink.href })) : null);
  bg.append(panel);
  bg.addEventListener('click', (e) => { if (e.target === bg) history.back(); });
  document.body.append(bg);
  history.pushState({ docViewer: true }, '');
  addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey);
  if (found.length) setTimeout(() => go(0), 60);
  return { close: () => history.back(), found };
}
