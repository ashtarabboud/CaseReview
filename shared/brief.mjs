// Brief engine: sentence splitting, brief structure (sections + labels), Claude edit
// application, redlines, and plain-text import/export. Pure functions — no DOM, no network.
// Shared by the drafting workspace (app.js) and the review screen (review/review.js).
//
// A brief is stored as an array of blocks:
//   { type: 'h', text }   heading
//   { type: 'p', text }   paragraph
//   { type: 'q', text }   block quote (shown read-only in review)
//   { type: 'fn', n, text } footnote body (markers in text look like [^3])

// ------------------------------------------------------------------ sentences
// Ported from ReviewBuddy's parse.js, with extra legal abbreviations.

const ABBREVIATIONS = new Set([
  'fed', 'civ', 'crim', 'evid', 'proc', 'app', 'bankr', 'supp', 'cir', 'dist', 'ct', 'super',
  'cal', 'stat', 'ann', 'rev', 'reg', 'regs', 'admin', 'gov', 'govt', 'code', 'const', 'amend',
  'sec', 'secs', 'art', 'arts', 'ch', 'chs', 'cl', 'para', 'paras', 'subd', 'subds', 'pt', 'pts',
  'p', 'pp', 'n', 'nn', 'fn', 'vol', 'ed', 'eds', 'ex', 'exs', 'exh', 'exhs', 'dep', 'tr', 'decl',
  'inc', 'corp', 'co', 'ltd', 'bros', 'assn', "ass'n", 'dept', 'intl', 'natl', 'mfg', 'ins',
  'v', 'vs', 'cf', 'al', 'ibid', 'approx', 'misc', 'mun', 'ord', 'cent',
  'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'st', 'ave', 'blvd', 'hon', 'esq', 'prof',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // added for briefs
  'nom', 'atl', 'pac', 'am', 'auth', 'cas', 'chem', 'coop', 'distrib', 'econ', 'equip', 'exch', 'grp',
  'guar', 'hous', 'indem', 'info', 'lab', 'liab', 'maint', 'med', 'merch', 'mut', 'org', 'pharm', 'prods',
  'pub', 'rd', 'ry', 'sch', 'soc', 'sur', 'unemp', 'ft', 'mt', 'pres', 'cnty', "comm'n", "comm'r", "dep't",
  "gov't", 'sav', 'cmty', 'servs', 'sys', 'tech', 'transp', 'util', 'indus', 'inv', 'invs', 'mgmt', 'agric',
  'bus', 'coll', 'envtl', 'fin', 'educ', 'bd', 'comm', 'div', 'juv', 'prob', 'dom', 'rel', 'univ', 'hosp',
  'ala', 'ariz', 'ark', 'colo', 'conn', 'del', 'fla', 'ga', 'haw', 'ill', 'ind', 'kan', 'ky', 'la', 'md',
  'mass', 'mich', 'minn', 'miss', 'mo', 'mont', 'neb', 'nev', 'okla', 'pa', 'tenn', 'tex', 'vt', 'va',
  'wash', 'wis', 'wyo', 'cert', 'den', "reh'g", "aff'd", "rev'd", 'op', 'ord', 'mem', 'resp', 'mot', 'compl',
  'ans', 'opp', 'br', 'rptr',
]);

const CLOSERS = /["'”’)\]»]/;
const TOKEN_STOP = /[\s(\["“‘]/;

function isNonTerminalPeriod(s, dotIndex, sentenceStart, nextIndex) {
  let i = dotIndex;
  while (i > sentenceStart && !TOKEN_STOP.test(s[i - 1])) i--;
  const token = s.slice(i, dotIndex);
  const bare = token.replace(/^[^A-Za-z0-9]+/, '');
  const lower = bare.toLowerCase().replace(/’/g, "'");
  if (!bare) return false;
  if (ABBREVIATIONS.has(lower)) return true;
  if ((lower === 'no' || lower === 'nos') && /\d/.test(s[nextIndex])) return true; // "No. 5"
  if (/^[A-Za-z]$/.test(bare)) return true; // initials: "R." in "Fed. R. Civ. P."
  if (/^([A-Za-z]\.)+[A-Za-z]{1,3}$/.test(bare)) return true; // "U.S", "e.g", "L.L.C", "N.E.2d"
  // A list number / heading number at the very start of a sentence: "1. All documents", "IV. Argument"
  if (/^(\d{1,3}|[ivxlc]{1,6}|[a-z])$/i.test(bare) && s.slice(sentenceStart, i).trim() === '') return true;
  return false;
}

function looksLikeSentenceStart(s, n) {
  const rest = s.slice(n, n + 6);
  if (/^\p{Lu}/u.test(rest)) return true;
  if (/^["'“‘(\[]\s?\p{Lu}/u.test(rest)) return true;
  if (/^[(\[]\s?([0-9]{1,2}|[a-z]|[ivx]{1,4})[)\]]/.test(rest)) return true; // "(a) ..." enumerations
  if (/^\d{1,2}[.)]\s+\p{Lu}/u.test(s.slice(n, n + 8))) return true; // "2. All emails" inline lists
  return false;
}

export function splitSentences(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  let start = 0;
  const re = /[.?!]+/g;
  let m;
  while ((m = re.exec(s))) {
    let end = m.index + m[0].length;
    while (end < s.length && CLOSERS.test(s[end])) end++;
    // keep a footnote marker with the sentence it ends: "…claim.[^3] Next"
    while (s.startsWith('[^', end)) { const close = s.indexOf(']', end); if (close < 0) break; end = close + 1; }
    if (end >= s.length) break;
    if (s[end] !== ' ') continue;
    let n = end;
    while (n < s.length && s[n] === ' ') n++;
    if (n >= s.length) break;
    if (!looksLikeSentenceStart(s, n)) continue;
    if (m[0] === '.' && isNonTerminalPeriod(s, m.index, start, n)) continue;
    const piece = s.slice(start, end).trim();
    if (piece) out.push(piece);
    start = n;
    re.lastIndex = n;
  }
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

export function normalize(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Compress [1,2,3,5] -> "S1–S3, S5"
export function ranges(nums, prefix = 'S') {
  const n = [...nums].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `${prefix}${n[i]}–${prefix}${n[j]}` : `${prefix}${n[i]}`);
    i = j;
  }
  return out.join(', ');
}

// ------------------------------------------------------------------ plain text -> paragraphs

export function paragraphsFromText(text) {
  const t = String(text).replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const blocks = t.split(/\n[ \t]*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  let inner = 0;
  let open = 0;
  for (const b of blocks) {
    if (b.length < 2) continue;
    for (let i = 0; i < b.length - 1; i++) {
      inner++;
      if (!/[.:;!?"”)]$/.test(b[i])) open++;
    }
  }
  const hardWrapped = blocks.length > 1 && inner > 0 && open / inner >= 0.5;
  const paras = [];
  for (const b of blocks) {
    if (hardWrapped) paras.push(b.join(' '));
    else paras.push(...b);
  }
  return paras;
}

// ------------------------------------------------------------------ headings

const MAJOR = /^(?:MEMORANDUM (?:IN SUPPORT|OF LAW|OF POINTS AND AUTHORITIES)(?: IN SUPPORT)?|INTRODUCTION|PRELIMINARY STATEMENT|STATEMENT OF (?:THE )?(?:RELEVANT )?(?:FACTS|CASE|ISSUES?(?: PRESENTED)?)|(?:RELEVANT |FACTUAL |PROCEDURAL )?BACKGROUND|FACTUAL AND PROCEDURAL BACKGROUND|PROCEDURAL HISTORY|SUMMARY OF (?:THE )?ARGUMENT|LEGAL STANDARDS?|STANDARD OF REVIEW|(?:LAW AND )?ARGUMENT|LAW AND ANALYSIS|DISCUSSION|ANALYSIS|CONCLUSION|RELIEF REQUESTED|ISSUES? PRESENTED|QUESTIONS? PRESENTED|FACTS)\s*[:.]?$/i;
const CLOSING_RE = /^(?:dated\b|date:|respectfully submitted|verification\b|certificate of (?:service|compliance)|proof of service|declaration of service|\/s\/)/i;
const TOC_LINE = /(?:\.{3,}|…{2,}|\t)\s*\d{1,3}\s*$|\s{2,}\d{1,3}\s*$/;
const NUMBERED = /^(?:([IVXL]+)|([A-Z])|(\d{1,2})|\(?([a-z])\)?)[.)]\s+(\S[\s\S]*)$/;

function titleCase(s) {
  const small = new Set(['of', 'the', 'and', 'in', 'to', 'for', 'a', 'an', 'on', 'or']);
  return s.toLowerCase().replace(/[:.]$/, '').split(/\s+/).map((w, i) => (i && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** Classify a heading's level and short key. */
export function headingInfo(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (MAJOR.test(t) && t.length < 90) return { level: 0, key: titleCase(t) };
  const m = NUMBERED.exec(t);
  if (m) {
    if (m[1]) return { level: 1, key: m[1] };
    if (m[2]) return { level: 2, key: m[2] };
    if (m[3]) return { level: 3, key: m[3] };
    if (m[4]) return { level: 4, key: m[4] };
  }
  // Any other heading: a short title from its first words
  const words = t.replace(/[^\w\s'’-]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return { level: 0, key: titleCase(words || 'Section') };
}

/** Is this plain paragraph (from a .txt/.pdf/paste) a heading? Used once, at import. */
export function looksLikeHeading(text, { seenHeading = false } = {}) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length > 320 || TOC_LINE.test(t)) return false;
  if (MAJOR.test(t) && t.length < 90) return true;
  const m = NUMBERED.exec(t);
  if (m) {
    const rest = m[5];
    if (m[4] && !seenHeading) return false;
    if (splitSentences(rest).length > 1) return false;
    if (m[3] && rest.length > 200 && !/^[A-Z\s\W]+$/.test(rest)) return false; // long numbered list item
    return true;
  }
  if (seenHeading && t.length < 90 && /[A-Z]{3}/.test(t) && t === t.toUpperCase() && !/[.;,]$/.test(t)) return true;
  return false;
}

/**
 * Turn paragraphs from a plain-text source into typed blocks.
 * Recognises headings, "> " block quotes, "# " headings and footnotes ("[^3]: text" or a FOOTNOTES section of "[3] text"/"3 text").
 */
export function blocksFromParagraphs(paras, { heuristics = true } = {}) {
  const blocks = [];
  let seen = false;
  let inFootnotes = false;
  for (const raw of paras) {
    let t = String(raw).replace(/\s+$/g, '');
    if (!t.trim()) continue;
    let m;
    if ((m = /^\[\^(\d+)\]:\s*([\s\S]*)$/.exec(t.trim()))) { blocks.push({ type: 'fn', n: +m[1], text: m[2].trim() }); continue; }
    if (/^#{0,3}\s*FOOTNOTES\s*:?$/i.test(t.trim())) { inFootnotes = true; continue; }
    if (inFootnotes && (m = /^\[?(\d{1,3})[\].]?\s+([\s\S]+)$/.exec(t.trim()))) { blocks.push({ type: 'fn', n: +m[1], text: m[2].trim() }); continue; }
    if ((m = /^#{1,4}\s+([\s\S]+)$/.exec(t.trim()))) { blocks.push({ type: 'h', text: m[1].trim() }); seen = true; inFootnotes = false; continue; }
    if ((m = /^>\s?([\s\S]*)$/.exec(t.trim()))) { blocks.push({ type: 'q', text: m[1].trim() }); continue; }
    t = t.trim();
    if (heuristics && looksLikeHeading(t, { seenHeading: seen })) { blocks.push({ type: 'h', text: t }); seen = true; continue; }
    blocks.push({ type: 'p', text: t });
  }
  return blocks;
}

// ------------------------------------------------------------------ structure: sections, labels, ids

/**
 * Build the review/edit structure. Returns { structured, sections }.
 * Each section: { id, label, kind: 'body'|'other'|'footnotes', heading: text|null, items: [...] }
 * Items: { type: 'h'|'p'|'q'|'fn', text, sentences?: [..], id, block (index into blocks), n? }
 * Paragraph ids: "<label> Heading", "<label> ¶k", "<label> Qk", "Footnote n". Sentence ids add " Sj"
 * (except headings, which are one unit).
 */
export function buildSections(blocks) {
  const sections = [];
  const used = new Set();
  const uniq = (label) => { let l = label; let k = 2; while (used.has(l)) l = `${label} (${k++})`; used.add(l); return l; };
  let stack = []; // [{level, key}]
  let cur = null;
  let mode = 'pre';
  const pre = { id: 'pre', label: 'Opening', title: 'Text before the first heading', kind: 'other', heading: null, items: [] };
  const post = { id: 'post', label: 'Closing', title: 'Closing (signature, certificate of service)', kind: 'other', heading: null, items: [] };
  const fns = { id: 'footnotes', label: 'Footnotes', title: 'Footnotes', kind: 'footnotes', heading: null, items: [] };
  let hasHeadings = blocks.some((b) => b.type === 'h');

  blocks.forEach((b, bi) => {
    if (b.type === 'fn') { fns.items.push({ type: 'fn', text: b.text, n: b.n, block: bi }); return; }
    if (b.type === 'h' && mode !== 'post') {
      const info = headingInfo(b.text);
      if (info.level === 0) stack = [{ level: 0, key: info.key }];
      else {
        while (stack.length && stack[stack.length - 1].level >= info.level) stack.pop();
        stack.push({ level: info.level, key: info.key });
      }
      const major = stack.find((x) => x.level === 0);
      const nums = stack.filter((x) => x.level > 0).map((x) => x.key);
      const label = uniq([major ? major.key : null, nums.length ? nums.join('.') : null].filter(Boolean).join(' ') || info.key);
      cur = { id: 's' + sections.length, label, title: b.text, kind: 'body', heading: b.text, level: info.level, items: [{ type: 'h', text: b.text, block: bi }] };
      sections.push(cur);
      mode = 'body';
      return;
    }
    if (mode === 'body' && b.type === 'p' && CLOSING_RE.test(b.text.trim())) mode = 'post';
    const target = mode === 'pre' ? pre : mode === 'post' ? post : cur;
    target.items.push({ type: b.type, text: b.text, block: bi });
  });

  if (!hasHeadings) {
    const doc = { id: 'doc', label: 'Brief', title: 'Brief', kind: 'body', heading: null, items: [...pre.items, ...post.items] };
    const out = [doc];
    if (fns.items.length) out.push(fns);
    return finishSections(out, false);
  }
  const out = [];
  if (pre.items.length) out.push(pre);
  out.push(...sections);
  if (fns.items.length) out.push(fns);
  if (post.items.length) out.push(post);
  return finishSections(out, true);
}

function finishSections(sections, structured) {
  for (const sec of sections) {
    let p = 0;
    let q = 0;
    for (const it of sec.items) {
      if (it.type === 'h') {
        it.id = `${sec.label} Heading`;
        // Plain topic headings ("ARGUMENT", "INTRODUCTION") aren't drafted prose, so they aren't reviewable units.
        if (MAJOR.test(it.text.trim()) && it.text.length < 90) { it.sentences = null; it.sids = null; }
        else { it.sentences = [it.text]; it.sids = [it.id]; }
        continue;
      }
      if (it.type === 'q') { it.id = `${sec.label} Q${++q}`; continue; }
      if (it.type === 'fn') { it.id = `Footnote ${it.n}`; }
      else it.id = `${sec.label} ¶${++p}`;
      it.sentences = splitSentences(it.text);
      it.sids = it.sentences.map((_, j) => `${it.id} S${j + 1}`);
    }
  }
  return { structured, sections };
}

/** Every reviewable unit (sentence or heading) in order: { id, text, sec, item, j } */
export function* units(struct) {
  for (const sec of struct.sections) {
    for (const it of sec.items) {
      if (!it.sentences) continue;
      for (let j = 0; j < it.sentences.length; j++) yield { id: it.sids[j], text: it.sentences[j], sec, item: it, j };
    }
  }
}

// ------------------------------------------------------------------ serialisation

/** The brief as labelled lines, so Claude can point at exact sentences. */
export function labeledBrief(blocks) {
  const { sections } = buildSections(blocks);
  const L = [];
  for (const sec of sections) {
    L.push(`=== ${sec.label}${sec.kind === 'other' ? ` (${sec.title})` : ''} ===`);
    for (const it of sec.items) {
      if (it.type === 'h') L.push(`[${it.id}] ${it.text}`);
      else if (it.type === 'q') L.push(`[${it.id}] > ${it.text}`);
      else it.sentences.forEach((s, j) => L.push(`[${it.sids[j]}] ${s}`));
      L.push('');
    }
  }
  return L.join('\n').trim();
}

/** Plain text with light markup (# headings, > quotes, [^n] footnotes) — the format Claude writes new drafts in. */
export function blocksToMarkup(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'h') out.push('# ' + b.text);
    else if (b.type === 'q') out.push('> ' + b.text);
    else if (b.type === 'fn') out.push(`[^${b.n}]: ${b.text}`);
    else out.push(b.text);
  }
  return out.join('\n\n');
}

export function blocksFromMarkup(text) {
  return blocksFromParagraphs(String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((x) => x.replace(/\n/g, ' ').trim()), { heuristics: true });
}

/** Readable plain text for copying / .txt export. */
export function blocksToPlainText(blocks) {
  const out = [];
  const fns = blocks.filter((b) => b.type === 'fn');
  for (const b of blocks) {
    if (b.type === 'fn') continue;
    const t = b.text.replace(/\[\^(\d+)\]/g, '[$1]');
    if (b.type === 'q') out.push(t.replace(/^/gm, '    '));
    else out.push(t);
  }
  if (fns.length) {
    out.push('FOOTNOTES');
    for (const f of fns) out.push(`[${f.n}] ${f.text.replace(/\[\^(\d+)\]/g, '[$1]')}`);
  }
  return out.join('\n\n');
}

// ------------------------------------------------------------------ applying Claude's edits

/**
 * Apply edits to blocks. Edits reference ids from labeledBrief(blocks).
 * locked: Set of sentence ids that must stay word-for-word (approved, no note allowing change).
 * Returns { blocks, applied, skipped: [{edit, reason}] }.
 */
export function applyEdits(blocks, edits, { locked = new Set() } = {}) {
  const struct = buildSections(blocks);
  const items = new Map(); // paragraph/heading/quote/footnote id -> item
  const sents = new Map(); // sentence id -> { item, j }
  const sectionByLabel = new Map();
  for (const sec of struct.sections) {
    sectionByLabel.set(sec.label, sec);
    for (const it of sec.items) {
      items.set(it.id, it);
      it.ops = { replace: null, del: false, after: [], sent: (it.sentences || []).map((s) => ({ text: s, del: false, after: [] })) };
      if (it.sids) it.sids.forEach((sid, j) => sents.set(sid, { item: it, j }));
    }
  }
  const strip = (id) => String(id || '').replace(/^\[|\]$/g, '').trim();
  const skipped = [];
  let applied = 0;
  let nextFn = Math.max(0, ...blocks.filter((b) => b.type === 'fn').map((b) => b.n)) + 1;
  const lockedIn = (it) => (it.sids || []).filter((sid) => locked.has(sid));
  const keepsLocked = (it, newText) => {
    const n = normalize(newText);
    return lockedIn(it).every((sid) => n.includes(normalize(it.ops.sent[it.sids.indexOf(sid)].text)));
  };
  const sectionEnd = (sec) => {
    // last block index belonging to this section or any of its subsections
    const idx = struct.sections.indexOf(sec);
    let last = sec;
    for (let k = idx + 1; k < struct.sections.length; k++) {
      const s = struct.sections[k];
      if (s.kind !== 'body' || sec.level == null || s.level == null || s.level <= sec.level) break;
      last = s;
    }
    return last.items[last.items.length - 1];
  };
  const newBlocksFrom = (text, type = 'p') => String(text).split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const m = /^>\s?([\s\S]*)$/.exec(t);
    return m ? { type: 'q', text: m[1].trim() } : { type, text: t.replace(/\n/g, ' ') };
  });

  for (const e of edits || []) {
    const op = e && e.op;
    const id = strip(e && e.id);
    try {
      if (op === 'replace_sentence' || op === 'delete_sentence' || op === 'insert_sentence_after') {
        const s = sents.get(id);
        if (!s) throw new Error(`no sentence ${id}`);
        const st = s.item.ops.sent[s.j];
        if (op !== 'insert_sentence_after' && locked.has(id)) throw new Error('approved (green) sentence');
        if (op === 'replace_sentence') st.text = String(e.text || '').trim();
        else if (op === 'delete_sentence') st.del = true;
        else st.after.push(String(e.text || '').trim());
      } else if (op === 'replace_paragraph' || op === 'delete_paragraph' || op === 'insert_paragraph_after') {
        let it = items.get(id);
        let sec = null;
        if (!it && op === 'insert_paragraph_after') {
          sec = sectionByLabel.get(id);
          if (sec) it = sec.items[0];
        }
        if (!it) throw new Error(`no paragraph ${id}`);
        if (op === 'replace_paragraph') {
          if (it.type === 'h') throw new Error('use replace_heading for headings');
          if (!keepsLocked(it, e.text || '')) throw new Error('would change an approved (green) sentence');
          it.ops.replace = String(e.text || '').trim();
        } else if (op === 'delete_paragraph') {
          if (lockedIn(it).length) throw new Error('paragraph contains approved (green) sentences');
          it.ops.del = true;
        } else {
          it.ops.after.push(...newBlocksFrom(e.text || '', e.type === 'q' ? 'q' : e.type === 'h' ? 'h' : 'p'));
        }
      } else if (op === 'replace_heading') {
        const sec = sectionByLabel.get(id) || [...sectionByLabel.values()].find((x) => `${x.label} Heading` === id);
        const it = sec && sec.items[0] && sec.items[0].type === 'h' ? sec.items[0] : null;
        if (!it) throw new Error(`no heading ${id}`);
        if (locked.has(it.id)) throw new Error('approved (green) heading');
        it.ops.replace = String(e.text || '').trim();
      } else if (op === 'insert_section_after') {
        const sec = sectionByLabel.get(id);
        if (!sec) throw new Error(`no section ${id}`);
        const anchor = sectionEnd(sec);
        anchor.ops.after.push({ type: 'h', text: String(e.heading || '').trim() }, ...(e.paragraphs || []).flatMap((t) => newBlocksFrom(t)));
      } else if (op === 'add_footnote') {
        const s = sents.get(id);
        if (!s) throw new Error(`no sentence ${id}`);
        const st = s.item.ops.sent[s.j];
        const n = nextFn++;
        st.text = st.text.replace(/\s*$/, '') + `[^${n}]`;
        (s.item.ops.fnAdds ||= []).push({ type: 'fn', n, text: String(e.text || '').trim() });
      } else {
        throw new Error(`unknown edit "${op}"`);
      }
      applied++;
    } catch (err) {
      skipped.push({ edit: e, reason: err.message });
    }
  }

  // Rebuild blocks in order.
  const out = [];
  const newFns = [];
  const byBlock = new Map();
  for (const it of items.values()) byBlock.set(it.block, it);
  blocks.forEach((b, bi) => {
    const it = byBlock.get(bi);
    if (!it) { out.push({ ...b }); return; }
    const o = it.ops;
    if (!o.del) {
      if (o.replace != null) out.push(it.type === 'fn' ? { type: 'fn', n: it.n, text: o.replace } : { type: it.type, text: o.replace });
      else if (it.sentences) {
        const parts = [];
        for (const st of o.sent) {
          if (!st.del && st.text) parts.push(st.text);
          parts.push(...st.after.filter(Boolean));
        }
        const text = parts.join(' ').trim();
        if (text) out.push(it.type === 'fn' ? { type: 'fn', n: it.n, text } : { type: it.type, text });
      } else out.push({ ...b });
    }
    out.push(...o.after);
    if (o.fnAdds) newFns.push(...o.fnAdds);
  });
  // New footnotes go in numeric order with the others.
  if (newFns.length) {
    const firstFn = out.findIndex((b) => b.type === 'fn');
    const allFns = [...out.filter((b) => b.type === 'fn'), ...newFns].sort((a, b) => a.n - b.n);
    const rest = out.filter((b) => b.type !== 'fn');
    const at = firstFn < 0 ? rest.length : Math.min(firstFn, rest.length);
    return { blocks: [...rest.slice(0, at), ...allFns, ...rest.slice(at)], applied, skipped };
  }
  return { blocks: out, applied, skipped };
}

// ------------------------------------------------------------------ redline

function lcsPairs(a, b, eq) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Word-level diff of two strings: [{t:'same'|'del'|'ins', s}] */
export function diffWords(a, b) {
  const A = String(a).split(/(\s+)/).filter((x) => x !== '');
  const B = String(b).split(/(\s+)/).filter((x) => x !== '');
  if (A.length * B.length > 4e6) return [{ t: 'del', s: a }, { t: 'ins', s: b }];
  const pairs = lcsPairs(A, B, (x, y) => x === y);
  const out = [];
  let i = 0, j = 0;
  const push = (t, s) => { if (!s) return; const last = out[out.length - 1]; if (last && last.t === t) last.s += s; else out.push({ t, s }); };
  for (const [pi, pj] of [...pairs, [A.length, B.length]]) {
    push('del', A.slice(i, pi).join(''));
    push('ins', B.slice(j, pj).join(''));
    if (pi < A.length) push('same', A[pi]);
    i = pi + 1; j = pj + 1;
  }
  return out;
}

/** Block-level redline between two versions: [{kind:'same'|'changed'|'added'|'removed', a, b, words?}] */
export function diffBlocks(A, B) {
  const key = (x) => x.type + '|' + normalize(x.text);
  const pairs = lcsPairs(A, B, (x, y) => key(x) === key(y));
  const out = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [A.length, B.length]]) {
    const dels = A.slice(i, pi);
    const ins = B.slice(j, pj);
    const k = Math.min(dels.length, ins.length);
    for (let x = 0; x < k; x++) out.push({ kind: 'changed', a: dels[x], b: ins[x], words: diffWords(dels[x].text, ins[x].text) });
    for (let x = k; x < dels.length; x++) out.push({ kind: 'removed', a: dels[x] });
    for (let x = k; x < ins.length; x++) out.push({ kind: 'added', b: ins[x] });
    if (pi < A.length) out.push({ kind: 'same', a: A[pi], b: B[pj] });
    i = pi + 1; j = pj + 1;
  }
  return out;
}

// ------------------------------------------------------------------ case names (for italics in Word export)

const SIGNALS = /^(?:See also|See generally|See, e\.g\.,|See|Cf\.|But see|But|Accord|Compare|Also|And|Here|Thus|Under|In|Like|Unlike|As|Because|Although|While|When|Where|Following|Applying|Citing|Quoting)\s+/;
const CASE_NAME = /\b(?:In re\s+[A-Z][\w.'’&-]*(?:\s+(?:[A-Z][\w.'’&-]*|of|the|&))*|(?:[A-Z][\w.'’&-]*,?\s+(?:(?:[A-Z][\w.'’&-]*|of|the|and|for|&|ex rel\.)\s+){0,6})v\.\s+[A-Z][\w.'’&-]*(?:\s+(?:[A-Z][\w.'’&-]*|of|the|and|for|&)){0,6})/g;

/** Find case-name spans to italicise: [[start, end], ...] */
export function caseNameSpans(text, extraNames = []) {
  const spans = [];
  let m;
  CASE_NAME.lastIndex = 0;
  while ((m = CASE_NAME.exec(text))) {
    let s = m.index;
    let t = m[0];
    const sig = SIGNALS.exec(t);
    if (sig && !/^In re\b/.test(t)) { s += sig[0].length; t = t.slice(sig[0].length); }
    t = t.replace(/[,\s]+$/, '');
    spans.push([s, s + t.length]);
  }
  for (const name of extraNames) {
    if (!name || name.length < 4) continue;
    let i = text.indexOf(name);
    while (i >= 0) { spans.push([i, i + name.length]); i = text.indexOf(name, i + name.length); }
  }
  const idRe = /\bId\.(?=[\s,]|$)/g;
  while ((m = idRe.exec(text))) spans.push([m.index, m.index + 3]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]);
  }
  return merged;
}
