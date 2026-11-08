// Review screen — a port of ReviewBuddy (sentence-by-sentence review of long legal drafts),
// adapted for briefs and connected to the drafting workspace.
// Privacy: this page is locked by a Content-Security-Policy with connect-src 'none'. It reads and
// writes only this device's storage (IndexedDB). Document text is always inserted as plain text.

import { buildSections, blocksFromParagraphs, paragraphsFromText, normalize, ranges } from '../shared/brief.mjs';
import { extractDocxBlocks } from '../shared/docx.mjs';
import { db, uid } from '../shared/db.mjs';
import { openDocViewer, displayText, quotesFromAnalysis } from '../shared/passages.mjs';

const APP_VERSION = 'review-1';
const PREFS_KEY = 'cr.review.prefs';
const COLORS = {
  green: { label: 'Approve / keep', short: 'Green', glyph: '✓' },
  yellow: { label: 'Mixed / needs refinement', short: 'Yellow', glyph: '~' },
  red: { label: 'Revise', short: 'Red', glyph: '✗' },
};
// Cite-check layer (separate from the style colors above).
const CITES = {
  ok: { label: 'Cite checked — good to go', short: 'Cite checked', glyph: '✔' },
  confirm: { label: 'Confirm the cite (pin, quote, or holding)', short: 'Confirm cite', glyph: '?' },
  support: { label: 'Needs better support', short: 'Needs better support', glyph: '+' },
  none: { label: 'No cite needed', short: 'No cite needed', glyph: '∅' },
};
const RATINGS = {
  like: { label: 'Like', glyph: '👍' },
  mixed: { label: 'Mixed', glyph: '〰️' },
  revise: { label: 'Revise', glyph: '✏️' },
};
const ANALYSIS_LABELS = {
  support: 'Support check', breakdown: 'Break it down', compare: 'Compare', better: 'Better-case search',
  gaps: 'Gap research', paragraph: 'Paragraph written for the point', chat: 'Ask chat', text: 'Case text', citation: 'Cited in the sentence',
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

// ---------------------------------------------------------------- storage

function loadPrefs() {
  try { return { tool: 'green', citeTool: 'ok', mode: 'style', showChanges: true, currentId: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { tool: 'green', showChanges: true, currentId: null }; }
}
const prefs = loadPrefs();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

let store = { reviews: {} };
let review = null;
let undoStack = [];
let saveTimer = null;
let saving = Promise.resolve();

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!review) return Promise.resolve(true);
  review.updatedAt = Date.now();
  const snapshot = JSON.parse(JSON.stringify(review));
  saving = saving.then(() => db.put('reviews', snapshot)).then(() => {
    setStatus(`Saved on this device · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    return true;
  }).catch(() => {
    setStatus('⚠ Not saved', true);
    toast('Could not save. Browser storage may be full, or Private Browsing may be on. Use Submit → Save backup to keep a copy.', 6000);
    return false;
  });
  return saving;
}

function saveSoon() {
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

const flush = () => { if (saveTimer) saveNow(); };
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function setStatus(text, warn = false) {
  const el = $('#doc-status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function openDialog(id) {
  const d = document.getElementById(id);
  if (!d.open) d.showModal();
  return d;
}

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  if (e.target instanceof HTMLDialogElement && e.target.open) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
  }
});

// Footnote markers [^3] are shown as superscripts. Text is always inserted as text nodes.
function textWithMarkers(text) {
  const parts = String(text).split(/(\[\^\d+\])/);
  return parts.filter(Boolean).map((p) => {
    const m = /^\[\^(\d+)\]$/.exec(p);
    return m ? h('sup', { class: 'fnref' }, m[1]) : document.createTextNode(p);
  });
}

// ---------------------------------------------------------------- review model

const hasUnits = (sec) => sec.items.some((i) => i.sentences && i.sentences.length);
const isCounted = (rev, sec) => (!rev.structured || sec.kind !== 'other') && hasUnits(sec);

function createReview(name, blocks, extra = {}) {
  const { structured, sections } = buildSections(blocks);
  return {
    id: uid(),
    docName: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    round: 1,
    parentId: null,
    structured,
    sections: sections.map((s) => ({ id: s.id, label: s.label, title: s.title, kind: s.kind, heading: s.heading, items: s.items.map((it) => ({ type: it.type, text: it.text, id: it.id, n: it.n, sentences: it.sentences, sids: it.sids })) })),
    marks: {},
    cites: {},
    comments: {},
    notes: {},
    ratings: {},
    carried: {},
    changes: {},
    quoteChanged: {},
    prev: {},
    sources: {},
    recordSources: {},
    ...extra,
  };
}

function* sentences(rev, onlyCounted = false) {
  for (const sec of rev.sections) {
    if (onlyCounted && !isCounted(rev, sec)) continue;
    for (const it of sec.items) {
      if (!it.sentences) continue;
      for (let j = 0; j < it.sentences.length; j++) yield { sec, it, j, text: it.sentences[j], key: it.sids[j] };
    }
  }
}

function quotesOf(sec) { return normalize(sec.items.filter((i) => i.type === 'q').map((i) => i.text).join(' ')); }

function applyCarryOver(prev, next) {
  let carried = 0;
  let changed = 0;
  let unrevised = 0;
  for (const sec of next.sections) {
    const old = prev.sections.find((x) => x.label === sec.label);
    if (old) {
      if (quotesOf(old) !== quotesOf(sec)) next.quoteChanged[sec.label] = true;
      if (prev.notes[old.label] || prev.ratings[old.label]) next.prev[sec.label] = { round: prev.round, notes: prev.notes[old.label] || '', rating: prev.ratings[old.label] || null };
    }
    const prior = new Map();
    const priorCite = new Map();
    if (old) {
      for (const it of old.items) (it.sentences || []).forEach((text, j) => {
        const n = normalize(text);
        if (!prior.has(n)) prior.set(n, prev.marks[it.sids[j]] || null);
        if (prev.cites?.[it.sids[j]] && !priorCite.has(n)) priorCite.set(n, prev.cites[it.sids[j]]);
      });
    }
    for (const it of sec.items) (it.sentences || []).forEach((text, j) => {
      const k = it.sids[j];
      const n = normalize(text);
      if (!prior.has(n)) {
        if (old || prev.sections.length) { next.changes[k] = 'new'; changed++; }
        return;
      }
      const pc = priorCite.get(n);
      if (pc === 'ok' || pc === 'none') { (next.cites ||= {})[k] = pc; }
      const color = prior.get(n);
      if (color === 'green') { next.marks[k] = 'green'; next.carried[k] = true; carried++; }
      else if (color === 'red' || color === 'yellow') { next.changes[k] = `unrevised-${color}`; unrevised++; }
    });
  }
  return { carried, changed, unrevised };
}

// Link sentences to the cases / saved analyses that support them (shown as ⚖).
async function attachSources(rev, version) {
  const recs = version.recordSources || [];
  if (recs.length) {
    rev.recordSources = {};
    for (const x of sentences(rev)) {
      const hit = recs.filter((r) => normalize(r.text) === normalize(x.text));
      if (hit.length) rev.recordSources[x.key] = hit.map((r) => ({ docId: r.docId, quote: r.quote || '', pin: r.pin || '' }));
    }
  }
  const list = version.sources || [];
  if (!list.length) return;
  const byText = new Map();
  for (const s of list) {
    const k = normalize(s.text || '');
    if (!k) continue;
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(s);
  }
  for (const x of sentences(rev)) {
    const hit = byText.get(normalize(x.text));
    if (hit) rev.sources[x.key] = hit.map((s) => ({ caseId: s.caseId, caseName: s.caseName || '', kind: s.kind || 'text', propId: s.propId || '' }));
  }
}

// ---------------------------------------------------------------- loading documents

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) await handleFile(file);
});

function pickFile() { $('#file-input').click(); }

async function blocksFromFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'docx') return extractDocxBlocks(await file.arrayBuffer());
  if (ext === 'txt' || ext === 'md' || file.type === 'text/plain') return blocksFromParagraphs(paragraphsFromText(await file.text()));
  if (ext === 'pdf' || ext === 'doc' || ext === 'pages' || ext === 'rtf') {
    throw new Error(`.${ext} files can't be read here. Save the draft as Word (.docx), paste the text, or add it in the Draft tab (which reads PDFs).`);
  }
  throw new Error('Unsupported file. Use a Word (.docx) or plain-text (.txt) file, or paste the text.');
}

async function handleFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'json') return importBackup(await file.text());
    const blocks = await blocksFromFile(file);
    if (review && review.projectId) return addVersionAndOpen(review.projectId, blocks, `Uploaded in review: ${file.name}`);
    return startReview(name, blocks);
  } catch (err) {
    toast(err.message || String(err), 7000);
  }
}

// A revised draft loaded while reviewing a project brief becomes the project's next version.
async function addVersionAndOpen(projectId, blocks, note) {
  const versions = await db.byIndex('versions', 'projectId', projectId);
  const n = Math.max(0, ...versions.map((v) => v.n || 0)) + 1;
  const v = { id: uid(), projectId, n, createdAt: Date.now(), source: 'upload', note, blocks, sources: [] };
  await db.put('versions', v);
  await openForVersion(v.id);
}

function startReview(name, blocks) {
  if (!blocks.length) { toast('No text found in that document.'); return; }
  const next = createReview(name, blocks);
  const prior = Object.values(store.reviews).filter((r) => !r.projectId).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!prior.length) return commitReview(next);
  const opts = $('#round-options');
  opts.replaceChildren(...prior.slice(0, 8).map((p) => h('button', {
    class: 'btn block', type: 'button',
    onclick: () => {
      $('#dlg-round').close();
      next.round = (p.round || 1) + 1;
      next.parentId = p.id;
      const r = applyCarryOver(p, next);
      commitReview(next);
      toast(roundMessage(next.round, r), 6000);
    },
  }, `Yes — Round ${(p.round || 1) + 1} of “${p.docName}”`, h('small', {}, `Round ${p.round || 1} · last edited ${fmtDate(p.updatedAt)}`))));
  $('#btn-round-new').onclick = () => { $('#dlg-round').close(); commitReview(next); };
  openDialog('dlg-round');
}

const roundMessage = (round, r) => `Round ${round}: kept ${r.carried} approved sentence${r.carried === 1 ? '' : 's'}; ${r.changed} new/changed; ${r.unrevised} flagged but unchanged.`;

async function openForVersion(versionId) {
  const existing = Object.values(store.reviews).find((r) => r.versionId === versionId);
  if (existing) return openReview(existing);
  const version = await db.get('versions', versionId);
  if (!version) { toast('That draft version was not found on this device.'); return render(); }
  const project = await db.get('projects', version.projectId);
  const next = createReview(project ? project.name : 'Brief', version.blocks, { projectId: version.projectId, versionId, versionN: version.n });
  await attachSources(next, version);
  const prior = Object.values(store.reviews).filter((r) => r.projectId === version.projectId).sort((a, b) => (b.round || 1) - (a.round || 1) || b.createdAt - a.createdAt);
  let msg = null;
  if (prior.length) {
    const p = prior[0];
    next.round = (p.round || 1) + 1;
    next.parentId = p.id;
    msg = roundMessage(next.round, applyCarryOver(p, next));
  }
  await commitReview(next);
  if (msg) toast(msg, 6000);
}

function openReview(r) {
  store.reviews[r.id] = r;
  review = r;
  prefs.currentId = r.id;
  savePrefs();
  undoStack = [];
  render();
  window.scrollTo(0, 0);
}

async function commitReview(next) {
  store.reviews[next.id] = next;
  review = next;
  prefs.currentId = next.id;
  savePrefs();
  undoStack = [];
  requestPersistence();
  await saveNow();
  render();
  window.scrollTo(0, 0);
  if (!next.structured) toast('No section headings were found, so the whole brief is shown as one section.', 6000);
}

function importBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('That .json file is not a review backup.'); }
  const rev = obj && (obj.format === 'casereview-review' || obj.format === 'reviewbuddy-review') ? obj.review : null;
  if (!rev || !Array.isArray(rev.sections) || !rev.sections.every((s) => Array.isArray(s.items))) throw new Error('That .json file is not a Case Review backup.');
  for (const f of ['marks', 'cites', 'comments', 'notes', 'ratings', 'carried', 'changes', 'quoteChanged', 'prev', 'sources']) rev[f] = rev[f] || {};
  if (store.reviews[rev.id] && !confirm(`Replace the saved copy of “${rev.docName}” with this backup?`)) return;
  rev.id = rev.id || uid();
  commitReview(rev);
  toast('Backup restored.');
}

// ---------------------------------------------------------------- rendering

function render() {
  const has = !!review;
  $('#btn-export').disabled = !has;
  $('#topbar-second').hidden = !has;
  document.body.classList.toggle('show-changes', !!prefs.showChanges);
  if (!has) {
    $('#doc-title').textContent = 'Review';
    setStatus('Private · nothing leaves this screen');
    main.replaceChildren(renderWelcome());
    updateUndo();
    return;
  }
  const v = review.versionN ? ` · v${review.versionN}` : '';
  $('#doc-title').textContent = `${review.docName}${v}${review.round > 1 ? ` · Round ${review.round}` : ''}`;
  setStatus(`Saved on this device · ${fmtDate(review.updatedAt)}`);
  const frag = document.createDocumentFragment();
  if (review.projectId) {
    frag.append(h('div', { class: 'backbar' },
      h('a', { class: 'btn', href: `index.html#/p/${encodeURIComponent(review.projectId)}?tab=draft` }, '← Drafting'),
      review.submitted ? h('span', { class: 'hint' }, `Sent to the drafting assistant ${fmtDate(review.submitted.at)}`) : null));
  }
  if (review.round > 1) frag.append(renderRoundBanner());
  frag.append(renderLegend());
  for (const sec of review.sections) frag.append(renderSection(sec));
  frag.append(h('div', { class: 'end-panel' },
    h('p', {}, 'End of document.'),
    h('div', { class: 'btn-row center' },
      h('button', { class: 'btn primary', type: 'button', onclick: openExport }, 'Submit review'),
      h('button', { class: 'btn', type: 'button', onclick: pickFile }, 'Load revised draft…'))));
  main.replaceChildren(frag);
  renderJump();
  updateProgress();
  updateUndo();
  for (const ta of main.querySelectorAll('textarea.notes')) if (ta.value) autosize(ta);
}

function renderWelcome() {
  return h('div', { class: 'welcome' },
    h('h1', {}, 'Review drafts, privately.'),
    h('p', {}, 'Open a brief from the Draft tab in Case Review, or load a draft here. Tap sentences to mark them green, yellow, or red, add a rating and notes for each section, then submit structured feedback.'),
    h('p', {}, h('a', { class: 'btn', href: 'index.html' }, '← Back to Case Review')),
    renderLoadButtons(),
    renderSavedList(),
    renderPrivacy());
}

function renderLoadButtons() {
  return h('div', { class: 'btn-col' },
    h('button', { class: 'btn primary big', type: 'button', onclick: () => { $('#dlg-library').close(); pickFile(); } }, 'Open draft (.docx or .txt)…'),
    h('button', { class: 'btn', type: 'button', onclick: () => { $('#dlg-library').close(); openDialog('dlg-paste'); } }, 'Paste text instead'),
    h('p', { class: 'hint' }, 'You can also open a review backup (.json) to restore a review.'));
}

function counts(rev, secId = null) {
  let total = 0;
  let marked = 0;
  const by = { green: 0, yellow: 0, red: 0 };
  const cite = { ok: 0, confirm: 0, support: 0, none: 0 };
  let cited = 0;
  for (const x of sentences(rev, secId == null)) {
    if (secId != null && x.sec.id !== secId) continue;
    total++;
    const m = rev.marks[x.key];
    if (m) { marked++; by[m]++; }
    const cm = rev.cites?.[x.key];
    if (cm) { cited++; cite[cm]++; }
  }
  return { total, marked, by, cite, cited };
}

function renderSavedList() {
  const list = Object.values(store.reviews).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return h('div');
  return h('div', { class: 'saved' },
    h('h3', {}, 'Saved on this device'),
    h('ul', { class: 'saved-list' }, list.map((r) => {
      const { marked, total } = counts(r);
      return h('li', { class: review && r.id === review.id ? 'current' : '' },
        h('button', {
          class: 'saved-open', type: 'button',
          onclick: () => { $('#dlg-library').close(); openReview(r); },
        }, h('strong', {}, r.docName + (r.versionN ? ` · v${r.versionN}` : '')), h('small', {}, `Round ${r.round || 1} · ${marked}/${total} marked · ${fmtDate(r.updatedAt)}`)),
        h('button', {
          class: 'icon-btn danger', type: 'button', 'aria-label': `Delete ${r.docName}`,
          onclick: async () => {
            if (!confirm(`Delete “${r.docName}” (round ${r.round || 1}) and all of its highlights and notes from this device?`)) return;
            delete store.reviews[r.id];
            await db.del('reviews', r.id);
            if (review && review.id === r.id) { review = null; prefs.currentId = null; savePrefs(); }
            refreshLibrary();
            render();
          },
        }, '🗑'));
    })));
}

function renderPrivacy() {
  return h('details', { class: 'privacy' },
    h('summary', {}, '🔒 How this review screen stays private'),
    h('ul', {},
      h('li', {}, 'This screen is locked by a Content Security Policy that forbids any network connection, so it cannot send data anywhere, even by accident.'),
      h('li', {}, 'Your marks and notes autosave to this device’s browser storage only.'),
      h('li', {}, 'Nothing goes to Claude until you tap “Send to drafting assistant”. That hands your feedback to the Draft tab, which sends it to the Claude API (and nowhere else).'),
      h('li', {}, 'No analytics, trackers, cookies, fonts, or third-party code.'),
      h('li', {}, 'Safari may clear site data if you don’t open the app for several weeks, and a Home Screen app has separate storage from Safari tabs. Save a .json backup for anything important.')));
}

function renderRoundBanner() {
  return h('div', { class: 'banner' },
    h('strong', {}, `Round ${review.round}. `),
    'Green approvals from the previous round were kept on unchanged sentences. ',
    h('span', { class: 'chg-sample new' }, 'Dashed outline'), ' = new or rewritten. ',
    h('span', { class: 'chg-sample unrev' }, '⟲'), ' = flagged last round but unchanged. ',
    h('label', { class: 'check inline' },
      h('input', { type: 'checkbox', checked: !!prefs.showChanges, onchange: (e) => { prefs.showChanges = e.target.checked; document.body.classList.toggle('show-changes', prefs.showChanges); savePrefs(); } }),
      ' Show changes'));
}

function renderLegend() {
  const cite = prefs.mode === 'cite';
  return h('div', { class: 'legend' },
    h('div', { class: 'modeswitch', role: 'radiogroup', 'aria-label': 'What you are marking' },
      h('button', { type: 'button', 'data-mode': 'style', 'aria-checked': String(!cite), role: 'radio' }, '✍️ Style & writing'),
      h('button', { type: 'button', 'data-mode': 'cite', 'aria-checked': String(cite), role: 'radio' }, '⚖ Cite check')),
    cite
      ? [h('span', {}, 'Tap sentences to mark cite checking:'),
        ...Object.entries(CITES).map(([k, v]) => h('span', { class: `lg cite-lg ${k}` }, `${v.glyph} ${v.short}`)),
        h('span', { class: 'lg' }, '✎ Comment')]
      : [h('span', {}, 'Pick a color beside any paragraph, then tap sentences:'),
        h('span', { class: 'lg green' }, '✓ Keep'),
        h('span', { class: 'lg yellow' }, '~ Refine'),
        h('span', { class: 'lg red' }, '✗ Revise'),
        h('span', { class: 'lg' }, '✎ Comment'),
        h('span', { class: 'lg' }, '⚖ Case'),
        h('span', { class: 'lg' }, '📄 Record')]);
}

function renderTools(spec, label) {
  const tools = h('div', { class: 'tools', role: 'toolbar', 'aria-label': `${label} highlighter` },
    h('span', { class: 'pnum' }, label));
  const cite = prefs.mode === 'cite';
  const active = cite ? prefs.citeTool : prefs.tool;
  for (const [c, info] of Object.entries(cite ? CITES : COLORS)) {
    tools.append(h('button', { class: `tool ${cite ? 'cite ' : ''}${c}`, type: 'button', 'data-tool': c, 'aria-label': info.label, title: info.label, 'aria-pressed': String(active === c) }, info.glyph));
  }
  tools.append(
    h('button', { class: 'tool erase', type: 'button', 'data-tool': 'erase', 'aria-label': cite ? 'Clear cite mark' : 'Clear highlight', title: 'Clear', 'aria-pressed': String(active === 'erase') }, '⌫'),
    h('button', { class: 'tool comment', type: 'button', 'data-tool': 'comment', 'aria-label': 'Add a comment to a sentence', title: 'Comment on a sentence', 'aria-pressed': String(active === 'comment') }, '✎'),
    h('button', { class: 'tool all', type: 'button', 'data-all': spec, title: 'Apply the selected color to the whole paragraph' }, 'All'));
  return tools;
}

function sentenceClass(k) {
  const c = ['sent'];
  const m = review.marks[k];
  if (m) c.push(`m-${m}`);
  if (review.comments[k]) c.push('has-comment');
  if (review.carried[k]) c.push('carried');
  const cm = review.cites?.[k];
  if (cm) c.push(`cite-${cm}`);
  const ch = review.changes[k];
  if (ch === 'new') c.push('chg-new');
  else if (ch) c.push('chg-unrev');
  return c.join(' ');
}

function itemLabel(it) {
  if (it.type === 'h') return 'Head';
  if (it.type === 'fn') return `fn${it.n}`;
  return '¶' + it.id.split('¶').pop();
}

function renderSection(sec) {
  const body = [];
  if (review.quoteChanged[sec.label]) body.push(h('p', { class: 'warn-line' }, '⚠ Quoted text in this section differs from the previous round. Quoted record and statutory text should stay unchanged.'));
  sec.items.forEach((it, idx) => {
    if (it.type === 'h' && !it.sentences) return; // topic heading: shown as the section title
    if (it.type === 'q') {
      body.push(h('div', { class: 'request' }, h('div', { class: 'label' }, 'Quoted text (read-only)'), h('p', {}, ...textWithMarkers(it.text))));
      return;
    }
    const ptext = h('p', { class: `para-text${it.type === 'h' ? ' heading' : ''}${it.type === 'fn' ? ' footnote' : ''}` });
    it.sentences.forEach((text, j) => {
      const k = it.sids[j];
      if (j) ptext.append(' ');
      ptext.append(h('span', { class: sentenceClass(k), 'data-k': k, role: 'button', tabindex: '0' }, ...textWithMarkers(text)));
      if (review.sources[k]?.length) ptext.append(h('button', { class: 'src', type: 'button', 'data-src': k, 'aria-label': 'Show the case and analysis behind this sentence', title: 'Source' }, '⚖'));
      (review.recordSources?.[k] || []).forEach((rs, ri) => ptext.append(h('button', { class: 'src rec', type: 'button', 'data-rec': `${k}|${ri}`, 'aria-label': 'Open the record document at the supporting words', title: rs.pin || 'Record' }, '📄' + (rs.pin ? ' ' + rs.pin : ''))));
    });
    body.push(h('div', { class: 'para' }, renderTools(`${sec.id}|${idx}`, itemLabel(it)), ptext));
  });
  if (!sec.items.some((i) => i.sentences)) body.push(h('p', { class: 'muted' }, '(No text in this section.)'));
  body.push(renderReviewBox(sec));

  const head = h('header', { class: 'sec-head' },
    h('h2', {}, sec.kind === 'other' ? sec.title : sec.label),
    sec.heading && sec.items[0] && sec.items[0].type === 'h' && !sec.items[0].sentences && sec.heading.toUpperCase() !== sec.label.toUpperCase() ? h('span', { class: 'hint' }, sec.heading) : null,
    h('span', { class: 'sec-stats', id: `stats-${sec.id}` }));

  if (!hasUnits(sec) && sec.kind === 'body') {
    return h('div', { class: 'divider', id: `sec-${sec.id}` }, sec.heading || sec.label);
  }
  if (!isCounted(review, sec)) {
    return h('details', { class: 'section other', id: `sec-${sec.id}` }, h('summary', {}, head), ...body);
  }
  return h('section', { class: `section ${sec.kind}`, id: `sec-${sec.id}` }, head, ...body);
}

function renderReviewBox(sec) {
  const rating = review.ratings[sec.label] || null;
  const box = h('div', { class: 'review-box' });
  const row = h('div', { class: 'rating-row', role: 'radiogroup', 'aria-label': `Overall rating for ${sec.label}` },
    h('span', { class: 'label' }, 'Overall'));
  for (const [r, info] of Object.entries(RATINGS)) {
    row.append(h('button', { class: `rate ${r}`, type: 'button', role: 'radio', 'data-rate': `${sec.id}|${r}`, 'aria-checked': String(rating === r) }, `${info.glyph} ${info.label}`));
  }
  box.append(row);
  const ta = h('textarea', { class: 'notes', 'data-notes': sec.id, rows: '3', placeholder: `Notes on ${sec.label} (broader comments)…`, 'aria-label': `Notes for ${sec.label}` });
  ta.value = review.notes[sec.label] || '';
  box.append(ta);
  const prev = review.prev[sec.label];
  if (prev && (prev.notes || prev.rating)) {
    box.append(h('details', { class: 'prev-notes' },
      h('summary', {}, `Your Round ${prev.round} feedback${prev.rating ? ` (${RATINGS[prev.rating].label})` : ''}`),
      h('p', {}, prev.notes || '(no notes)')));
  }
  return box;
}

function renderJump() {
  const sel = $('#jump');
  sel.replaceChildren(h('option', { value: '' }, 'Jump to…'), ...review.sections.map((sec) => {
    const r = review.ratings[sec.label];
    const dot = r === 'like' ? '🟢 ' : r === 'mixed' ? '🟡 ' : r === 'revise' ? '🔴 ' : '⚪ ';
    return h('option', { value: sec.id }, dot + (sec.kind === 'other' ? sec.title : sec.label));
  }).filter((o, i) => { const sec = review.sections[i]; return hasUnits(sec) || sec.kind !== 'body'; }));
}

$('#jump').addEventListener('change', (e) => {
  const id = e.target.value;
  e.target.value = '';
  if (!id) return;
  const el = document.getElementById(`sec-${id}`);
  if (!el) return;
  if (el.tagName === 'DETAILS') el.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function updateSectionStats(sec) {
  const el = document.getElementById(`stats-${sec.id}`);
  if (!el) return;
  const { total, marked, by, cite, cited } = counts(review, sec.id);
  const r = review.ratings[sec.label];
  el.replaceChildren(...[
    h('span', { class: 'count' }, `${marked}/${total}`),
    ...Object.entries(cite).filter(([, n]) => n).map(([k, n]) => h('span', { class: `pill cite-pill ${k}` }, `${CITES[k].glyph}${n}`)),
    by.green ? h('span', { class: 'pill green' }, `✓${by.green}`) : null,
    by.yellow ? h('span', { class: 'pill yellow' }, `~${by.yellow}`) : null,
    by.red ? h('span', { class: 'pill red' }, `✗${by.red}`) : null,
    r ? h('span', { class: `pill rating ${r}` }, RATINGS[r].label) : null].filter(Boolean));
}

function updateProgress() {
  if (!review) return;
  for (const sec of review.sections) updateSectionStats(sec);
  const { total, marked, cited } = counts(review);
  const secs = review.sections.filter((s) => isCounted(review, s));
  const rated = secs.filter((s) => review.ratings[s.label]).length;
  $('#progress').textContent = `${marked}/${total} sentences · ${rated}/${secs.length} rated${cited ? ` · ${cited} cite-checked` : ''}`;
}

function refreshSentence(k) {
  const el = main.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (el) el.className = sentenceClass(k);
}

// ---------------------------------------------------------------- interactions

function setTool(tool) {
  if (prefs.mode === 'cite') prefs.citeTool = tool; else prefs.tool = tool;
  for (const b of main.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  savePrefs();
}

function setMarks(changes, field = 'marks') {
  const undo = [];
  const layer = (review[field] ||= {});
  for (const { k, color } of changes) {
    const before = layer[k] || null;
    if (before === color) continue;
    undo.push({ k, color: before, carried: !!review.carried[k], field });
    if (color) layer[k] = color; else delete layer[k];
    if (field === 'marks') delete review.carried[k];
    refreshSentence(k);
  }
  if (!undo.length) return;
  undoStack.push(undo);
  if (undoStack.length > 200) undoStack.shift();
  updateUndo();
  updateProgress();
  saveNow();
}

function undo() {
  const last = undoStack.pop();
  if (!last) return;
  for (const { k, color, carried, field = 'marks' } of last) {
    const layer = (review[field] ||= {});
    if (color) layer[k] = color; else delete layer[k];
    if (carried && field === 'marks') review.carried[k] = true;
    refreshSentence(k);
  }
  updateUndo();
  updateProgress();
  saveNow();
}

function updateUndo() { $('#btn-undo').disabled = !undoStack.length; }

function onSentence(el) {
  const k = el.dataset.k;
  const field = prefs.mode === 'cite' ? 'cites' : 'marks';
  const tool = field === 'cites' ? prefs.citeTool : prefs.tool;
  if (tool === 'comment') return openComment(k);
  if (tool === 'erase') return setMarks([{ k, color: null }], field);
  const cur = review[field]?.[k] || null;
  setMarks([{ k, color: cur === tool ? null : tool }], field);
}

function onAll(spec) {
  const [secId, idx] = spec.split('|');
  const sec = review.sections.find((s) => s.id === secId);
  const it = sec && sec.items[+idx];
  if (!it || !it.sids) return;
  const field = prefs.mode === 'cite' ? 'cites' : 'marks';
  const tool = field === 'cites' ? prefs.citeTool : prefs.tool;
  let color = tool === 'erase' || tool === 'comment' ? null : tool;
  if (color && it.sids.every((k) => review[field]?.[k] === color)) color = null;
  setMarks(it.sids.map((k) => ({ k, color })), field);
}

main.addEventListener('click', (e) => {
  if (!review) return;
  const t = e.target;
  const mode = t.closest('[data-mode]');
  if (mode) { prefs.mode = mode.dataset.mode; savePrefs(); const y = scrollY; render(); scrollTo(0, y); return; }
  const tool = t.closest('.tool[data-tool]');
  if (tool) return setTool(tool.dataset.tool);
  const all = t.closest('[data-all]');
  if (all) return onAll(all.dataset.all);
  const rec = t.closest('[data-rec]');
  if (rec) { const i = rec.dataset.rec.lastIndexOf('|'); return openRecord(rec.dataset.rec.slice(0, i), +rec.dataset.rec.slice(i + 1)); }
  const src = t.closest('[data-src]');
  if (src) return openSources(src.dataset.src);
  const rate = t.closest('[data-rate]');
  if (rate) {
    const [secId, r] = rate.dataset.rate.split('|');
    const sec = review.sections.find((s) => s.id === secId);
    if (review.ratings[sec.label] === r) delete review.ratings[sec.label]; else review.ratings[sec.label] = r;
    for (const b of rate.parentElement.querySelectorAll('[data-rate]')) b.setAttribute('aria-checked', String(review.ratings[sec.label] === b.dataset.rate.split('|')[1]));
    updateProgress();
    renderJump();
    saveNow();
    return;
  }
  const sent = t.closest('.sent');
  if (sent) {
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).length > 1) return;
    onSentence(sent);
  }
});

main.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('sent')) {
    e.preventDefault();
    onSentence(e.target);
  }
});

main.addEventListener('input', (e) => {
  const ta = e.target.closest('[data-notes]');
  if (!ta || !review) return;
  const sec = review.sections.find((s) => s.id === ta.dataset.notes);
  const v = ta.value;
  if (v.trim()) review.notes[sec.label] = v; else delete review.notes[sec.label];
  autosize(ta);
  saveSoon();
});

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 480)}px`;
}

$('#btn-undo').addEventListener('click', undo);
$('#btn-menu').addEventListener('click', () => { refreshLibrary(); openDialog('dlg-library'); });
$('#btn-export').addEventListener('click', openExport);

// ---------------------------------------------------------------- comments

let commentKey = null;
function findSentence(k) {
  for (const x of sentences(review)) if (x.key === k) return x;
  return null;
}
function openComment(k) {
  commentKey = k;
  const x = findSentence(k);
  $('#comment-title').textContent = k;
  $('#comment-sentence').textContent = x ? x.text : '';
  $('#comment-text').value = review.comments[k] || '';
  $('#btn-comment-delete').hidden = !review.comments[k];
  openDialog('dlg-comment');
  setTimeout(() => $('#comment-text').focus(), 50);
}
$('#btn-comment-save').addEventListener('click', () => {
  const v = $('#comment-text').value.trim();
  if (v) review.comments[commentKey] = v; else delete review.comments[commentKey];
  refreshSentence(commentKey);
  saveNow();
  $('#dlg-comment').close();
});
$('#btn-comment-delete').addEventListener('click', () => {
  delete review.comments[commentKey];
  refreshSentence(commentKey);
  saveNow();
  $('#dlg-comment').close();
});

// ---------------------------------------------------------------- sources (⚖)

function excerptFor(c, src) {
  const cut = (t) => (t ? (t.length > 1400 ? t.slice(0, 1400) + '…' : t) : '');
  if (src.kind === 'support' && c.support?.[src.propId]) return cut(c.support[src.propId].text);
  if (src.kind === 'compare' && c.compare?.[src.propId]) return cut(c.compare[src.propId].text);
  if (src.kind === 'gaps' && c.compareResearch?.[src.propId]) return cut(c.compareResearch[src.propId].text);
  if (src.kind === 'better' && c.better) return cut(c.better.text);
  if (src.kind === 'breakdown' && c.breakdown) return cut(c.breakdown);
  return cut(c.breakdown || (src.propId && c.support?.[src.propId]?.text) || '');
}

async function openSources(k) {
  const list = review.sources[k] || [];
  const x = findSentence(k);
  const body = $('#src-body');
  body.replaceChildren(h('blockquote', {}, x ? x.text : ''));
  for (const s of list) {
    const c = s.caseId ? await db.get('cases', s.caseId) : null;
    const name = c ? (c.name || c.citation) : (s.caseName || 'Case');
    const ex = c ? excerptFor(c, s) : '';
    const tab = s.kind === 'support' ? 'support' : s.kind === 'compare' || s.kind === 'gaps' ? 'compare' : s.kind === 'breakdown' || s.kind === 'better' ? 'breakdown' : 'read';
    body.append(h('div', { class: 'src-card' },
      h('strong', {}, name), c?.citation && c.name ? h('div', { class: 'hint' }, c.citation) : null,
      h('div', { class: 'hint' }, `From: ${ANALYSIS_LABELS[s.kind] || s.kind}${s.kind === 'support' && c?.support?.[s.propId]?.at ? `, saved ${new Date(c.support[s.propId].at).toLocaleDateString()}` : ''}`),
      h('div', { class: 'hint' }, 'Your saved research about the case (possibly from an earlier draft), not a comment on this sentence.'),
      ex ? h('p', { class: 'src-ex' }, ex) : h('p', { class: 'hint' }, c ? 'No saved analysis text for this link.' : 'This case is not saved on this device.'),
      c ? h('div', { class: 'btn-row' },
        c.text ? h('button', { class: 'btn primary', type: 'button', onclick: () => { $('#dlg-src').close(); openCase(c, s.propId, x ? x.text : ''); } }, '📖 Read the case here') : null,
        h('a', { class: 'btn', href: `index.html#/c/${encodeURIComponent(c.id)}?tab=${tab}${s.propId ? '&prop=' + encodeURIComponent(s.propId) : ''}` }, 'Open in Case Review ↗')) : null));
  }
  openDialog('dlg-src');
}

/** Read a case in a pop-up over the review, at the passages that support the point. */
function openCase(c, propId, sentence) {
  const sp = propId ? c.support?.[propId] : null;
  const quotes = sp ? (sp.quotes?.length ? sp.quotes : quotesFromAnalysis(sp.text, 'The exact language that helps', 'Language that helps us'))
    : Object.values(c.support || {}).flatMap((x) => x.quotes || []);
  openDocViewer({ title: c.name || c.citation, subtitle: c.citation || '', text: displayText(c), passages: quotes, sentence });
}

/** Open the record document behind a sentence, at the quoted words. */
async function openRecord(k, i) {
  const rs = review.recordSources?.[k]?.[i];
  if (!rs) return;
  const d = await db.get('cases', rs.docId);
  if (!d) { toast('That document isn’t on this device.'); return; }
  const x = findSentence(k);
  openDocViewer({ title: d.name, subtitle: rs.pin ? `Cited at ${rs.pin}` : 'Record document', text: displayText(d), passages: [{ quote: rs.quote, pin: rs.pin }], sentence: x ? x.text : '', note: rs.quote ? '' : 'No exact quote was saved for this cite.' });
}

// ---------------------------------------------------------------- paste

$('#btn-paste-load').addEventListener('click', () => {
  const text = $('#paste-text').value;
  if (!text.trim()) { toast('Paste the draft text first.'); return; }
  const name = $('#paste-name').value.trim() || 'Pasted draft';
  $('#dlg-paste').close();
  $('#paste-text').value = '';
  const blocks = blocksFromParagraphs(paragraphsFromText(text));
  if (review && review.projectId) addVersionAndOpen(review.projectId, blocks, 'Pasted in review');
  else startReview(name, blocks);
});

// ---------------------------------------------------------------- library dialog

function refreshLibrary() {
  const body = $('#library-body');
  body.replaceChildren(
    h('p', {}, h('a', { class: 'btn', href: review && review.projectId ? `index.html#/p/${encodeURIComponent(review.projectId)}?tab=draft` : 'index.html' }, '← Back to Case Review')),
    renderLoadButtons(),
    renderSavedList(),
    renderPrivacy(),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          if (!confirm('Erase ALL reviews (highlights, ratings and notes) stored on this device? Your projects, cases and draft versions are kept. This cannot be undone.')) return;
          try { await db.clear('reviews'); localStorage.removeItem(PREFS_KEY); } catch { /* ignore */ }
          store = { reviews: {} };
          review = null;
          undoStack = [];
          $('#dlg-library').close();
          render();
          toast('All review data erased from this device.');
        },
      }, 'Erase all review data on this device'),
      h('p', { class: 'hint' }, `Review screen ${APP_VERSION}`)));
}

// ---------------------------------------------------------------- export / submit

function buildFeedback(rev) {
  const out = [];
  for (const sec of rev.sections) {
    const items = [];
    for (const it of sec.items) {
      if (!it.sentences) continue;
      it.sentences.forEach((text, j) => {
        const k = it.sids[j];
        items.push({ id: k, paragraph: it.id, sentence: j + 1, color: rev.marks[k] || null, cite: rev.cites?.[k] || null, text, comment: rev.comments[k] || null, carriedFromPreviousRound: !!rev.carried[k], change: rev.changes[k] || null });
      });
    }
    out.push({ section: sec.label, title: sec.title, kind: sec.kind, heading: sec.heading, rating: rev.ratings[sec.label] || null, notes: rev.notes[sec.label] || '', quotedTextChangedFromPreviousRound: !!rev.quoteChanged[sec.label], sentences: items });
  }
  return out;
}

function groupByPara(items, secLabel) {
  const byP = new Map();
  for (const it of items) {
    if (!byP.has(it.paragraph)) byP.set(it.paragraph, []);
    byP.get(it.paragraph).push(it.sentence);
  }
  return [...byP].map(([p, ss]) => {
    const short = p.startsWith(secLabel + ' ') ? p.slice(secLabel.length + 1) : p;
    return short === 'Heading' ? 'Heading' : `${short} ${ranges(ss)}`;
  }).join('; ');
}

export function buildFeedbackText(rev, { greenText = false, instructions = true } = {}) {
  const fb = buildFeedback(rev);
  const L = [];
  const counted = fb.filter((s) => (!rev.structured || s.kind !== 'other') && s.sentences.length);
  const all = counted.flatMap((s) => s.sentences);
  const n = (c) => all.filter((x) => x.color === c).length;
  const nr = (r) => counted.filter((s) => s.rating === r).length;

  L.push('REVIEW FEEDBACK');
  L.push(`Document: ${rev.docName}${rev.versionN ? ` (version ${rev.versionN})` : ''}`);
  L.push(`Review round: ${rev.round || 1}`);
  L.push(`Submitted: ${new Date().toLocaleString()}`);
  L.push('');
  if (instructions) {
    L.push('INSTRUCTIONS FOR THE NEXT ROUND');
    L.push('- Keep quoted record and statutory text (block quotes) exactly as written.');
    L.push('- Preserve GREEN (approved) sentences word-for-word unless a note below specifically requires a change.');
    L.push('- Revise RED sentences. Refine YELLOW sentences. Leave unmarked sentences unchanged unless a note says otherwise.');
    L.push('- Address each section-level note.');
    L.push('- CITE CHECK: For NEEDS BETTER SUPPORT, strengthen the authority from my research (or bracket [need stronger authority]). For CONFIRM CITE, verify the case, pin cite, quotation, and holding against my saved analyses and the opinion, then fix it or bracket what you could not confirm. CITE CHECKED sentences are confirmed by me: keep their citations exactly and do not bracket them. NO CITE NEEDED: do not add a citation.');
    L.push('- Return the complete updated brief, keeping the same headings and paragraph structure unless a note asks for a change.');
    L.push('');
  }
  L.push('SUMMARY');
  L.push(`Sections rated: ${counted.length - nr(null)}/${counted.length} · Like ${nr('like')} · Mixed ${nr('mixed')} · Revise ${nr('revise')}`);
  L.push(`Sentences: ${all.length} · Green ${n('green')} · Yellow ${n('yellow')} · Red ${n('red')} · Unmarked ${n(null)}`);
  const nc = (k) => all.filter((x) => x.cite === k).length;
  if (all.some((x) => x.cite)) L.push(`Cite check: Cite checked ${nc('ok')} · Confirm cite ${nc('confirm')} · Needs better support ${nc('support')} · No cite needed ${nc('none')}`);

  for (const sec of fb) {
    const hasFeedback = sec.rating || sec.notes.trim() || sec.sentences.some((x) => x.color || x.comment || x.cite);
    if (!sec.sentences.length && !hasFeedback) continue;
    if (sec.kind === 'other' && rev.structured && !hasFeedback) continue;
    L.push('');
    L.push('========================================');
    L.push(`${(sec.kind === 'other' ? sec.title : sec.section).toUpperCase()} — Overall: ${sec.rating ? RATINGS[sec.rating].label.toUpperCase() : 'NOT RATED'}`);
    if (sec.heading) L.push(`Heading: ${sec.heading}`);
    if (sec.quotedTextChangedFromPreviousRound) L.push('⚠ Quoted text in this section differs from the previous round — restore the original quoted wording.');
    L.push(`Notes: ${sec.notes.trim() ? sec.notes.trim().replace(/\n/g, '\n       ') : '(none)'}`);
    const list = (color, title) => {
      const xs = sec.sentences.filter((x) => x.color === color);
      if (!xs.length) return;
      L.push('');
      L.push(`${title}:`);
      for (const x of xs) {
        L.push(`  [${x.id}] “${x.text}”`);
        if (x.comment) L.push(`      Comment: ${x.comment.replace(/\n/g, ' ')}`);
      }
    };
    list('red', 'RED — revise');
    list('yellow', 'YELLOW — needs refinement');
    const greens = sec.sentences.filter((x) => x.color === 'green');
    if (greens.length) {
      L.push('');
      if (greenText) {
        L.push('GREEN — approved, keep verbatim:');
        for (const x of greens) {
          L.push(`  [${x.id}] “${x.text}”`);
          if (x.comment) L.push(`      Comment: ${x.comment.replace(/\n/g, ' ')}`);
        }
      } else {
        L.push(`GREEN — approved, keep verbatim: ${groupByPara(greens, sec.section)}`);
        for (const x of greens.filter((g) => g.comment)) L.push(`  [${x.id}] Comment: ${x.comment.replace(/\n/g, ' ')}`);
      }
    }
    const unmarked = sec.sentences.filter((x) => !x.color);
    if (unmarked.length) {
      L.push('');
      L.push(`UNMARKED: ${groupByPara(unmarked, sec.section)}`);
      for (const x of unmarked.filter((u) => u.comment)) L.push(`  [${x.id}] “${x.text}”\n      Comment: ${x.comment.replace(/\n/g, ' ')}`);
    }
    const citeList = (k, title) => {
      const xs = sec.sentences.filter((x) => x.cite === k);
      if (!xs.length) return;
      L.push('');
      L.push(`${title}:`);
      for (const x of xs) L.push(`  [${x.id}] “${x.text}”${x.comment ? `\n      Comment: ${x.comment.replace(/\n/g, ' ')}` : ''}`);
    };
    citeList('support', 'CITE CHECK — NEEDS BETTER SUPPORT');
    citeList('confirm', 'CITE CHECK — CONFIRM CITE');
    const okc = sec.sentences.filter((x) => x.cite === 'ok');
    if (okc.length) { L.push(''); L.push(`CITE CHECK — CITE CHECKED (confirmed by me; keep these citations, no brackets): ${groupByPara(okc, sec.section)}`); }
    const noc = sec.sentences.filter((x) => x.cite === 'none');
    if (noc.length) { L.push(''); L.push(`CITE CHECK — NO CITE NEEDED: ${groupByPara(noc, sec.section)}`); }
  }
  return L.join('\n');
}

function refreshExportText() {
  $('#export-text').value = buildFeedbackText(review, { greenText: $('#opt-green-text').checked, instructions: $('#opt-instructions').checked });
}

function openExport() {
  if (!review) return;
  flush();
  refreshExportText();
  $('#btn-share').hidden = !navigator.share;
  $('#send-row').hidden = !(review.projectId && review.versionId);
  openDialog('dlg-export');
}
$('#opt-green-text').addEventListener('change', refreshExportText);
$('#opt-instructions').addEventListener('change', refreshExportText);

function fileBase() {
  const safe = review.docName.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'review';
  return `${safe}_round${review.round || 1}`;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('#btn-copy').addEventListener('click', async () => {
  const text = $('#export-text').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = $('#export-text');
    ta.removeAttribute('readonly');
    ta.select();
    document.execCommand('copy');
    ta.setAttribute('readonly', '');
  }
  toast('Feedback copied.');
});
$('#btn-share').addEventListener('click', async () => {
  try { await navigator.share({ title: `Review feedback – ${review.docName}`, text: $('#export-text').value }); } catch { /* cancelled */ }
});
$('#btn-save-txt').addEventListener('click', () => download(`${fileBase()}_feedback.txt`, $('#export-text').value, 'text/plain'));
$('#btn-save-json').addEventListener('click', () => {
  const payload = { format: 'casereview-review', version: 1, exportedAt: new Date().toISOString(), feedback: buildFeedback(review), review };
  download(`${fileBase()}_backup.json`, JSON.stringify(payload, null, 2), 'application/json');
});
$('#btn-send').addEventListener('click', async () => {
  if (!review || !review.projectId) return;
  if (saveTimer) await saveNow();
  review.submitted = {
    at: Date.now(),
    text: buildFeedbackText(review, { greenText: false, instructions: true }),
    feedback: buildFeedback(review),
  };
  const ok = await saveNow();
  if (!ok) return;
  location.href = `index.html#/p/${encodeURIComponent(review.projectId)}?tab=draft&revise=${encodeURIComponent(review.id)}`;
});

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const all = await db.all('reviews');
    for (const r of all) store.reviews[r.id] = r;
  } catch {
    setStatus('⚠ Storage unavailable', true);
  }
  if (await routeFromHash()) return;
  if (prefs.currentId && store.reviews[prefs.currentId]) { review = store.reviews[prefs.currentId]; }
  render();
}

async function routeFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('v')) { await openForVersion(params.get('v')); return true; }
  if (params.get('r') && store.reviews[params.get('r')]) { openReview(store.reviews[params.get('r')]); return true; }
  return false;
}
addEventListener('hashchange', () => { flush(); routeFromHash(); });
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Test hook only (nothing leaves the page).
window.__review = { buildFeedbackText: () => review && buildFeedbackText(review), current: () => review };
