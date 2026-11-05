// Case Review — a phone-friendly case law reader & brief assistant.
// Everything (your API key, drafts, cases, notes) is stored only on this device.
import { Anthropic } from './vendor/anthropic.mjs';
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';
import { db, uid } from './shared/db.mjs';
import { buildSections, blocksFromParagraphs, paragraphsFromText, blocksFromMarkup, labeledBrief, applyEdits, diffBlocks, blocksToPlainText, normalize, units } from './shared/brief.mjs';
import { extractDocxBlocks, buildDocx } from './shared/docx.mjs';

/* ============================== Settings ============================== */

const APP_VERSION = '14';

const DEFAULT_STYLE = `You are my patient legal research partner. I work in litigation and I find dense case law hard to read and understand. When you explain anything to me:

- Explain it like I'm smart but brand new to the topic ("explain it like I'm five" clarity) without dumbing down the law.
- Define every legal term the first time you use it, in plain English. Example: "**Pleading standard** — the minimum a complaint has to say to survive a motion to dismiss."
- Show the logic step by step: "If X, then Y, because Z." Never jump from point A to point C without showing point B. Don't assume I already know what something means.
- Use a short, concrete hypothetical when it helps something click.
- Write in short, clear paragraphs and simple lists. Not bare-bones fragments, and not thick, dense blocks of text.
- Always separate (1) what the court actually HELD, (2) what it said in passing (dicta), and (3) your own interpretation.
- Tell me what the court based its reasoning on (statute, prior cases, policy, specific facts).
- Be honest: if a case doesn't really support my point, say so plainly and explain why.`;

const BASE_RULES = `

Ground rules (always follow):
- Never invent cases, quotes, holdings, citations, or page numbers. Quote the opinion word-for-word when you quote it.
- If the opinion text shows star pages (like *123) use them for pincites; otherwise write "[pin — check Westlaw]".
- Format answers in Markdown with clear headings and short lists.`;

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best reasoning (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, about half the cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
];

const DEFAULTS = { apiKey: '', clToken: '', model: 'claude-opus-5-5', effort: 'medium', style: DEFAULT_STYLE };
const S = {
  get() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cr.settings') || '{}') }; }
    catch { return { ...DEFAULTS }; }
  },
  set(patch) { localStorage.setItem('cr.settings', JSON.stringify({ ...S.get(), ...patch })); },
};

/* ============================== Storage (IndexedDB) ============================== */

navigator.storage?.persist?.().catch(() => {});

const projectCases = async (pid) => (await db.all('cases')).filter((c) => c.projectId === pid);
const save = (store, o) => { o.updatedAt = Date.now(); return db.put(store, o); };

/* ============================== Small DOM helpers ============================== */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));
const mdEl = (s) => h('div', { class: 'md', html: md(s) });
const $ = (sel) => document.querySelector(sel);
const go = (hash) => { location.hash = hash; };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function sheet(title, body, actions = []) {
  return new Promise((resolve) => {
    const root = $('#sheet-root');
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    const bg = h('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) close(null); } },
      h('div', { class: 'sheet' },
        h('h2', {}, title),
        body,
        h('div', { class: 'row', style: 'margin-top:16px; justify-content:flex-end' },
          h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
          actions.map((a) => h('button', { class: 'btn ' + (a.cls || 'primary'), onclick: async () => { const v = await a.run(); if (v !== false) close(v ?? true); } }, a.label)))));
    root.innerHTML = '';
    root.append(bg);
    bg.querySelector('input,textarea')?.focus();
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Couldn’t copy — select and copy manually'); }
}

const busy = (btn, label = 'Working…') => {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${label}`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
};

/* ============================== Claude API ============================== */

class NeedKey extends Error {}

function friendlyError(e) {
  if (e instanceof NeedKey) return 'Add your Claude API key in Settings first.';
  const s = e?.status;
  if (s === 401) return 'Your Claude API key was rejected. Check it in Settings.';
  if (s === 403) return 'Your API key doesn’t have permission for this (403).';
  if (s === 429) return 'Rate limit hit — wait a minute and try again. (Or raise your limits in the Claude Console.)';
  if (s === 529 || s === 503) return 'Claude is overloaded right now. Try again in a moment.';
  if (s === 400 && /credit balance/i.test(e.message)) return 'Your Claude API account is out of credits. Add credits at console.anthropic.com → Billing.';
  if (isDropped(e)) return 'The connection dropped before Claude finished. Keep the app open on screen while it works (switching apps or locking the phone cuts it off), then try again.';
  return e?.message || String(e);
}

// ---- Connection diagnostics (kept on this device; shown in Settings) ----
function logDiag(d, outcome, req) {
  if (!d) return;
  try {
    const log = JSON.parse(localStorage.getItem('cr.diag') || '[]');
    log.unshift({
      at: new Date(d.t0).toLocaleTimeString(), secs: ((Date.now() - d.t0) / 1000).toFixed(1),
      firstByte: (d.first / 1000).toFixed(1), maxGap: (d.gap / 1000).toFixed(1), events: d.n,
      size: Math.round((JSON.stringify(req.messages).length + JSON.stringify(req.system || '').length) / 1000) + 'k', effort: req.output_config?.effort, outcome: String(outcome).slice(0, 200),
    });
    localStorage.setItem('cr.diag', JSON.stringify(log.slice(0, 25)));
  } catch {}
}

// Safari reports a dropped connection as "Load failed"; other browsers say "network" / "fetch".
const isDropped = (e) => !e?.status && !(e instanceof NeedKey) &&
  (e instanceof TypeError || e?.name === 'APIConnectionError' || /load failed|network|fetch|connection|aborted|stream ended|ended without/i.test(e?.message || ''));

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Keep the phone screen on during long requests (iOS suspends network when the screen locks).
async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

const upgradeTool = (t) => ({ ...t, type: t.type.replace('web_search_20250305', 'web_search_20260209').replace('web_fetch_20250910', 'web_fetch_20260209') });

/**
 * One call to Claude, streamed. Handles server-tool pauses, refusal fallback,
 * and a couple of compatibility retries. Returns { text, content, message }.
 */
async function claude({ system, messages, tools, effort, maxTokens = 32000, format, onText, onProgress, clientTools }) {
  const s = S.get();
  if (!s.apiKey) throw new NeedKey();
  const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const params = {
    model: s.model,
    max_tokens: maxTokens,
    system,
    messages: [...messages],
    output_config: { effort: effort || s.effort, ...(format ? { format } : {}) },
    // Summarized thinking streams while Claude reasons, so the phone's connection never sits idle.
    thinking: { type: 'adaptive', display: 'summarized' },
    ...(tools ? { tools } : {}),
  };
  const lock = await keepAwake();
  try {
    return await claudeLoop(client, params, s, { onText, onProgress, clientTools });
  } finally {
    lock?.release?.().catch(() => {});
  }
}

const CONTINUE_MSG = 'Your reply above was cut off by a network glitch. Continue it from exactly where it stops (starting with the next word). Do not repeat anything, and do not add any preamble or mention that you are continuing.';

async function claudeLoop(client, params, s, { onText, onProgress, clientTools }) {
  // Server-side fallback: if a safety filter declines, the server reroutes the request.
  let useFallbacks = !s.model.startsWith('claude-haiku');
  let upgraded = false;
  let drops = 0;
  let resumes = 0;
  let trimNextLead = false;
  const origMessages = params.messages;
  let text = '';
  const content = [];
  let final;
  let freshTurn = false; // a new turn after a tool result: separate its text from what came before
  for (let turn = 0; turn < 16 + resumes; turn++) {
    const req = { ...params };
    if (useFallbacks) { req.betas = ['server-side-fallback-2026-07-01']; req.fallbacks = 'default'; }
    const before = text;
    const doneBlocks = []; // content blocks that finished arriving in this attempt
    let curText = '';      // text of the block still arriving
    try {
      const stream = client.beta.messages.stream(req);
      stream.on('contentBlock', (b) => { doneBlocks.push(b); curText = ''; });
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
          if ((ev.index > 0 || freshTurn) && text && !trimNextLead && !/\n\s*$/.test(text)) text += '\n\n';
          freshTurn = false;
        }
      });
      const t0 = Date.now(); const diag = { t0, first: 0, last: t0, gap: 0, n: 0 };
      stream.on('streamEvent', () => { const now = Date.now(); if (!diag.first) diag.first = now - t0; diag.gap = Math.max(diag.gap, now - diag.last); diag.last = now; diag.n++; });
      req._diag = diag;
      stream.on('text', (t) => {
        if (trimNextLead) { t = t.replace(/^[ \t]+/, ''); if (!t) return; trimNextLead = false; }
        text += t; curText += t; onText?.(text); onProgress?.('writing', text);
      });
      stream.on('thinking', () => onProgress?.('thinking'));
      final = await stream.finalMessage();
      // A stream that just stops (no finish signal) is a dropped connection, not a finished answer.
      if (!final.stop_reason) throw new TypeError('Load failed (stream ended early)');
      logDiag(req._diag, 'ok ' + final.stop_reason, req);
    } catch (e) {
      logDiag(req._diag, 'ERROR ' + (e?.status || '') + ' ' + (e?.name || '') + ': ' + (e?.message || e), req);
      // Web research: keep every search / page read / paragraph that finished, and let Claude
      // carry on from there (the same way the API resumes a paused turn).
      if (isDropped(e) && params.tools && resumes < 30) {
        const blocks = doneBlocks.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b));
        while (blocks.length && ['server_tool_use', 'tool_use', 'thinking', 'redacted_thinking'].includes(blocks.at(-1).type)) blocks.pop();
        const keep = curText.slice(0, Math.max(curText.lastIndexOf(' '), curText.lastIndexOf('\n')) + 1);
        if (keep.trim()) blocks.push({ type: 'text', text: keep.trimEnd() });
        if (blocks.length) {
          resumes++; drops = 0;
          text = text.slice(0, text.length - (curText.length - keep.length));
          trimNextLead = /[ \t]$/.test(text);
          content.push(...blocks);
          onText?.(text);
          onProgress?.('resume');
          await sleep(1200);
          const msgs = [...params.messages];
          const last = msgs.at(-1);
          if (last.role === 'assistant') {
            const prev = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
            msgs[msgs.length - 1] = { role: 'assistant', content: [...prev, ...blocks] };
          } else msgs.push({ role: 'assistant', content: blocks });
          if (blocks.at(-1).type === 'text') msgs.push({ role: 'user', content: CONTINUE_MSG });
          params.messages = msgs;
          turn--; continue;
        }
      }
      // Phones cut off long connections (~1 min). If Claude had already written part of the
      // answer, ask it to continue from where it stopped instead of starting over.
      if (isDropped(e) && !params.output_config?.format && !params.tools && text.length - before.length > 40 && resumes < 30) {
        resumes++;
        drops = 0;
        await sleep(1200); // give the phone a moment to open a fresh connection
        const cut = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n')) + 1; // drop only the half-written last word
        text = text.slice(0, Math.max(cut, before.length));
        trimNextLead = /[ \t]$/.test(text);
        onText?.(text);
        onProgress?.('resume');
        params.messages = [...origMessages,
          { role: 'assistant', content: text.trimEnd() },
          { role: 'user', content: CONTINUE_MSG }];
        turn--; continue;
      }
      text = before;
      if (e?.status === 400 && useFallbacks && /fallback|beta/i.test(e.message)) { useFallbacks = false; turn--; continue; }
      if (e?.status === 400 && params.thinking?.display && /display|thinking/i.test(e.message)) { delete params.thinking; turn--; continue; }
      if (isDropped(e) && drops < 5) {
        drops++; onProgress?.('retry'); onText?.(text);
        await sleep(1000 * 2 ** (drops - 1)); // 1s, 2s, 4s, 8s, 16s
        turn--; continue;
      }
      if (e?.status === 400 && params.tools && !upgraded && /web_(search|fetch)|tool/i.test(e.message)) {
        upgraded = true; params.tools = params.tools.map(upgradeTool); turn--; continue;
      }
      throw e;
    }
    content.push(...final.content);
    // Tools the app runs itself (e.g. opening a case's full text from this device).
    if (final.stop_reason === 'tool_use' && clientTools) {
      const results = [];
      for (const u of final.content.filter((b) => b.type === 'tool_use')) {
        try {
          const fn = clientTools[u.name];
          if (!fn) throw new Error(`Unknown tool ${u.name}`);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: String(await fn(u.input || {})) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Error: ' + (err.message || err), is_error: true });
        }
      }
      onProgress?.('tool');
      params.messages = [...params.messages, { role: 'assistant', content: final.content }, { role: 'user', content: results }];
      freshTurn = true;
      continue;
    }
    if (final.stop_reason === 'pause_turn') {
      freshTurn = true;
      params.messages = [...params.messages, { role: 'assistant', content: final.content }];
      continue;
    }
    break;
  }
  if (final?.stop_reason === 'refusal') {
    throw new Error('Claude declined this request (a safety filter flagged it). Try rephrasing, or switch models in Settings.');
  }
  if (final?.stop_reason === 'max_tokens') text += '\n\n_(Answer was cut off because it hit the length limit.)_';
  return { text, content, message: final };
}

// Machine-readable case lists (```json …```) are shown as cards, never as raw text — even mid-stream.
const hideJSON = (t) => t.replace(/```json[\s\S]*?(```|$)/g, '').trim();

/** Stream an answer into an element, rendering Markdown as it arrives. */
async function streamInto(el, opts) {
  el.innerHTML = '<div class="thinking"><span class="spin"></span> Reading and thinking… (long cases can take a minute)</div>';
  let pending = null;
  const paint = (t) => {
    pending = t;
    if (paint.raf) return;
    paint.raf = requestAnimationFrame(() => { paint.raf = 0; el.innerHTML = md(hideJSON(pending)); });
  };
  try {
    const r = await claude({ ...opts, onText: paint });
    cancelAnimationFrame(paint.raf); paint.raf = 0;
    el.innerHTML = md(hideJSON(r.text));
    return r;
  } catch (e) {
    cancelAnimationFrame(paint.raf); paint.raf = 0;
    el.innerHTML = '';
    el.append(h('div', { class: 'err' }, '⚠️ ' + friendlyError(e)));
    if (e instanceof NeedKey) el.append(h('p', {}, h('a', { href: '#/settings' }, 'Open Settings →')));
    throw e;
  }
}

function lastJSON(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) { try { return JSON.parse(c); } catch {} }
  return null;
}
const stripJSONBlocks = (text) => text.replace(/```json[\s\S]*?```/g, '').trim();

/* ---- Context builders (stable order so prompt caching kicks in) ---- */

function systemFor(p, c) {
  const blocks = [{ type: 'text', text: S.get().style + BASE_RULES }];
  let ctx = `PROJECT: ${p.name}\nCOURT / JURISDICTION: ${p.court || 'not specified'}\nOUR SIDE: ${p.side || 'not specified'}`;
  if (p.draft) ctx += `\n\nMY DRAFT BRIEF (context for everything we discuss):\n<brief>\n${p.draft}\n</brief>`;
  blocks.push({ type: 'text', text: ctx, cache_control: { type: 'ephemeral' } });
  if (c?.text) {
    blocks.push({
      type: 'text',
      text: `THE CASE WE ARE READING: ${c.name}${c.citation ? ', ' + c.citation : ''}${c.court ? ' (' + c.court + (c.year ? ' ' + c.year : '') + ')' : ''}\n<opinion>\n${c.text}\n</opinion>`,
      cache_control: { type: 'ephemeral' },
    });
  }
  return blocks;
}

/* ============================== Reading files ============================== */

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.append(s);
  });
}

async function pdfToText(buf) {
  await import('./vendor/rs-polyfill.mjs');
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.shim.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    for (const it of tc.items) {
      line += it.str;
      if (it.hasEOL) { out += line + '\n'; line = ''; }
    }
    out += line + '\n\n';
  }
  // Gentle reflow: rejoin lines broken mid-sentence by the PDF layout.
  return out
    .replace(/(\w)-\n(?=[a-z])/g, '$1')
    .replace(/([^\n.:;?!"”)\]])\n(?=[a-z(“"])/g, '$1 ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fileToText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const t = await pdfToText(await file.arrayBuffer());
    if (t.replace(/\s/g, '').length < 200) throw new Error('This PDF seems to be a scanned image with no text layer. Try downloading it again as a text PDF (Westlaw’s normal PDF download works).');
    return t;
  }
  if (name.endsWith('.docx')) {
    await loadScript('vendor/mammoth.browser.min.js');
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return r.value.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (name.endsWith('.doc')) throw new Error('Old .doc files aren’t supported — save it as .docx or PDF first.');
  return (await file.text()).trim();
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,blockquote,tr,pre').forEach((el) => el.append('\n\n'));
  return (doc.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ============================== Finding case text ============================== */

const CL = 'https://www.courtlistener.com';

async function clFetch(path, opts = {}) {
  const token = S.get().clToken;
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Token ' + token;
  const r = await fetch(path.startsWith('http') ? path : CL + path, { ...opts, headers });
  if (!r.ok) throw new Error('CourtListener HTTP ' + r.status);
  return r.json();
}

/** Look up a citation in CourtListener. Returns the matching cluster or null. Needs a (free) token. */
async function clLookupCitation(citation) {
  if (!S.get().clToken) return null;
  const arr = await clFetch('/api/rest/v4/citation-lookup/', { method: 'POST', body: new URLSearchParams({ text: citation }) });
  const hit = (arr || []).find((x) => x.clusters?.length);
  return hit ? hit.clusters[0] : null;
}

async function clOpinionText(opinionUrlOrId) {
  const id = String(opinionUrlOrId).match(/(\d+)\/?$/)?.[1];
  const o = await clFetch(`/api/rest/v4/opinions/${id}/`);
  const html = o.html_with_citations || o.html || o.html_lawbox || o.html_columbia || o.xml_harvard || '';
  const text = o.plain_text?.trim() ? o.plain_text : htmlToText(html);
  return { text: text.trim(), type: o.type || '' };
}

async function pullFromCourtListener(c, status) {
  let cluster = null;
  if (c.citation) {
    status('Checking CourtListener’s citation database…');
    cluster = await clLookupCitation(c.citation);
  }
  if (!cluster) {
    status('Searching CourtListener…');
    const q = c.citation ? `"${c.citation}"` : `caseName:(${c.name})`;
    const j = await clFetch('/api/rest/v4/search/?type=o&q=' + encodeURIComponent(q));
    const r = j.results?.[0];
    if (!r) return null;
    cluster = { case_name: r.caseName, absolute_url: r.absolute_url, date_filed: r.dateFiled, court: r.court, citations: r.citation, sub_opinions: (r.opinions || []).map((o) => o.id) };
  }
  const ops = (cluster.sub_opinions || []).slice(0, 5);
  if (!ops.length) return null;
  status('Downloading the opinion from CourtListener…');
  const parts = [];
  for (const op of ops) {
    const { text, type } = await clOpinionText(op);
    if (text) parts.push((ops.length > 1 ? `===== ${opinionLabel(type)} =====\n\n` : '') + text);
  }
  const text = parts.join('\n\n');
  if (text.length < 1500) return null;
  return {
    text,
    source: 'CourtListener',
    url: CL + (cluster.absolute_url || ''),
    name: cluster.case_name || c.name,
    year: (cluster.date_filed || '').slice(0, 4),
    court: typeof cluster.court === 'string' ? cluster.court : '',
    verified: true,
  };
}
const opinionLabel = (t) => ({ '010combined': 'Opinion', '020lead': 'Lead opinion', '030concurrence': 'Concurrence', '040dissent': 'Dissent' }[t] || 'Opinion');

/** Fallback: have Claude search the web and fetch the opinion. The raw page text comes back to us directly. */
async function pullWithClaude(c, status) {
  status('Asking Claude to find the opinion online… (this can take 30–90 seconds)');
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 6, max_content_tokens: 150000 },
  ];
  const prompt = `Find and fetch the FULL TEXT of this court opinion:
Case: ${c.name || '(unknown name)'}
Citation: ${c.citation || '(unknown)'}
${c.url ? 'Start with this URL: ' + c.url : ''}

Use web search to locate a free, full-text copy, then use web_fetch on that page. Good sources: courtlistener.com, law.justia.com, casetext.com, law.cornell.edu, caselaw.findlaw.com, leagle.com, casemine.com, govinfo.gov, and official court websites. If a page only has a summary or is blocked, try another source. Make sure it is the right case (name, court, and year match the citation).

When finished, reply with ONLY a JSON object in a \`\`\`json block:
{"found": true|false, "url": "URL of the full opinion you fetched", "case_name": "...", "citation": "...", "court": "...", "year": "...", "note": "anything I should know"}`;
  const r = await claude({ system: 'You are a careful legal research assistant who retrieves court opinions.', messages: [{ role: 'user', content: prompt }], tools, effort: 'low', maxTokens: 8000 });
  const info = lastJSON(r.text) || {};
  // Collect every fetched document from the tool results.
  const docs = [];
  for (const b of r.content) {
    if (b.type !== 'web_fetch_tool_result') continue;
    const res = b.content;
    if (!res || res.type !== 'web_fetch_result') continue;
    const src = res.content?.source;
    if (!src) continue;
    let text = '';
    if (src.type === 'text') text = src.data || '';
    else if (src.type === 'base64' && /pdf/.test(src.media_type || '')) {
      try { text = await pdfToText(Uint8Array.from(atob(src.data), (ch) => ch.charCodeAt(0)).buffer); } catch {}
    }
    if (text) docs.push({ url: res.url, text });
  }
  if (!docs.length) return { notFound: true, note: info.note || 'Claude couldn’t fetch a full-text copy.' };
  const pick = docs.find((d) => info.url && d.url === info.url) || docs.sort((a, b) => b.text.length - a.text.length)[0];
  if (info.found === false || pick.text.length < 1500) return { notFound: true, note: info.note || 'Only a partial or summary page was found.' };
  return {
    text: pick.text.trim(),
    source: new URL(pick.url).hostname.replace(/^www\./, ''),
    url: pick.url,
    name: info.case_name || c.name,
    citation: info.citation || c.citation,
    court: info.court || c.court,
    year: info.year || c.year,
    note: info.note,
  };
}

async function pullCase(c, status) {
  let got = null;
  try { got = await pullFromCourtListener(c, status); }
  catch (e) { console.warn('CourtListener failed', e); }
  if (!got) {
    got = await pullWithClaude(c, status);
    if (got.notFound) throw new Error('Couldn’t find a free full-text copy online. ' + (got.note || '') + '\n\nDownload it from Westlaw and upload the PDF instead.');
  }
  Object.assign(c, {
    text: got.text, source: got.source, url: got.url,
    name: got.name || c.name, citation: got.citation || c.citation,
    court: got.court || c.court, year: got.year || c.year,
    verified: !!got.verified, fetchNote: got.note || '',
  });
  return c;
}

/* ============================== Data shapes ============================== */

function newCase(projectId, { name = '', citation = '', url = '' } = {}) {
  return { id: uid(), projectId, name, citation, url, text: '', annotations: [], chat: [], support: {}, breakdown: '', createdAt: Date.now() };
}
const normCite = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const caseTitle = (c) => c.name || c.citation || 'Untitled case';

async function findOrCreateCase(p, cit) {
  const all = await projectCases(p.id);
  const key = normCite(cit.citation);
  let c = all.find((x) => (key && normCite(x.citation) === key) || (!key && x.name && x.name === cit.case_name));
  if (!c) {
    c = newCase(p.id, { name: cit.case_name, citation: cit.citation, url: cit.url || '' });
    await save('cases', c);
  }
  return c;
}

async function deleteCase(c, after) {
  if (!confirm(`Delete “${caseTitle(c)}” and all its highlights, notes, and chat? This can’t be undone.`)) return false;
  const p = await db.get('projects', c.projectId);
  for (const prop of p?.props || []) prop.caseIds = (prop.caseIds || []).filter((x) => x !== c.id);
  if (p) await save('projects', p);
  await db.del('cases', c.id);
  toast('Case deleted');
  if (after) after(); else route();
  return true;
}

const RECS = {
  use: { label: '✅ Use it', cls: 'ok' },
  caution: { label: '🟡 Use with caution', cls: 'warn' },
  replace: { label: '🔁 Look for a better case', cls: 'warn' },
  skip: { label: '⛔ Don’t rely on it', cls: 'bad' },
};
const recBadge = (v) => (v && RECS[v] ? h('span', { class: 'badge ' + RECS[v].cls }, RECS[v].label) : null);

/** Cards for suggested cases: "Pull & read" opens it now, "Add to point" saves it for later. */
function candidateCards(p, cands, propId, { unverified = false, title = 'Suggested cases' } = {}) {
  const wrap = h('div', {});
  if (!cands?.length) return wrap;
  wrap.append(h('div', { class: 'section-title' }, title),
    h('p', { class: 'small muted' }, unverified
      ? 'Mentioned from Claude’s own knowledge, not a web search — pulling a case checks that it really exists. KeyCite before citing.'
      : 'AI-suggested from web search. Pull and read each one, and KeyCite it on Westlaw before citing.'));
  const saveCand = async (cand) => {
    const fresh = await db.get('projects', p.id);
    const c = await findOrCreateCase(fresh, { case_name: cand.case_name, citation: cand.citation, url: cand.url });
    if (propId) {
      const again = await db.get('projects', p.id);
      const fp = again.props?.find((x) => x.id === propId);
      if (fp && !fp.caseIds.includes(c.id)) { fp.caseIds.push(c.id); await save('projects', again); }
    }
    return c;
  };
  for (const cand of cands) {
    const addBtn = h('button', { class: 'btn slim', onclick: async () => {
      await saveCand(cand);
      addBtn.textContent = propId ? '✓ Added to point' : '✓ Saved to Cases';
      addBtn.disabled = true;
      toast(propId ? 'Added to this point — pull it from the point whenever you’re ready' : 'Saved to your Cases tab');
    } }, propId ? '＋ Add to point' : '＋ Save to Cases');
    wrap.append(h('div', { class: 'card', style: 'background:var(--soft)' },
      h('h3', {}, cand.case_name),
      h('div', { class: 'small muted' }, [cand.citation, cand.court, cand.year].filter(Boolean).join(' · ')),
      cand.strength ? h('div', { class: 'row', style: 'margin:6px 0' }, h('span', { class: 'badge ' + (cand.strength === 'strong' ? 'ok' : 'warn') }, cand.strength)) : null,
      cand.why ? h('p', { class: 'small', style: 'margin:4px 0' }, cand.why) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn slim primary', onclick: async () => {
          const c = await saveCand(cand);
          go(`#/c/${c.id}?${propId ? 'prop=' + propId + '&' : ''}${c.text ? '' : 'pull=1'}`);
        } }, '📖 Pull & read'),
        addBtn,
        cand.url ? h('a', { class: 'btn slim', href: cand.url, target: '_blank', rel: 'noopener' }, 'Source ↗') : null)));
  }
  return wrap;
}

const MENTIONED_RULE = 'If you name any OTHER case in your answer (for example, a case that might be better), end your reply with a ```json block listing them: {"cases":[{"case_name":"","citation":"","why":"one sentence"}]}. Only list cases you are confident really exist; leave the citation blank if you are not sure of it.';

const WEB_TOOLS = (searches = 8, fetches = 4) => [
  { type: 'web_search_20250305', name: 'web_search', max_uses: searches },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: fetches, max_content_tokens: 60000 },
];
const CASES_JSON_RULE = `Only suggest cases you actually saw in search results or fetched pages — never from memory alone — and include the URL where you found each. Whenever you recommend specific cases, end your reply with a \`\`\`json block: {"cases":[{"case_name":"","citation":"full reporter citation","court":"","year":"","url":"","why":"one sentence","strength":"strong|moderate|weak"}]}`;

const VERDICTS = {
  strong: { label: '✅ Strong support', cls: 'ok' },
  partial: { label: '🟡 Partial support', cls: 'warn' },
  weak: { label: '⚠️ Weak / dicta only', cls: 'warn' },
  none: { label: '❌ Doesn’t support', cls: 'bad' },
  against: { label: '🚫 Cuts against us', cls: 'bad' },
};
const verdictBadge = (v) => (v && VERDICTS[v] ? h('span', { class: 'badge ' + VERDICTS[v].cls }, VERDICTS[v].label) : null);

/* ============================== Router ============================== */

const app = $('#app');
async function route() {
  hideSelbar();
  $('#toast').classList.add('hidden');
  $('#sheet-root').innerHTML = ''; // a sheet left open must not cover the next screen
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'settings') return viewSettings();
    if (parts[0] === 'p' && parts[2] === 'prop') return await viewProp(parts[1], parts[3]);
    if (parts[0] === 'p' && parts[2] === 'v') return await viewVersion(parts[1], parts[3]);
    if (parts[0] === 'p' && parts[2] === 'diff') return await viewDiff(parts[1], parts[3], parts[4]);
    if (parts[0] === 'p') return await viewProject(parts[1], q.tab || 'points', q);
    if (parts[0] === 'c') return await viewCase(parts[1], q.tab || 'read', q.prop);
    return await viewHome();
  } catch (e) {
    console.error(e);
    app.innerHTML = '';
    app.append(header('Something went wrong', '#/'), h('main', {}, h('div', { class: 'err' }, String(e?.message || e))));
  }
}
window.addEventListener('hashchange', route);

function header(title, back, sub, right) {
  return h('header', { class: 'top' },
    back ? h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => go(back) }, '‹') : null,
    h('h1', {}, title, sub ? h('span', { class: 'sub' }, sub) : null),
    right || null);
}
function tabs(items, active, hrefFor) {
  return h('nav', { class: 'tabs' }, items.map(([k, label]) => h('button', { class: 'tab' + (k === active ? ' on' : ''), onclick: () => go(hrefFor(k)) }, label)));
}

/* ============================== Home ============================== */

async function viewHome() {
  const s = S.get();
  const projects = (await db.all('projects')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const cases = await db.all('cases');
  const main = h('main', {});
  if (!s.apiKey) {
    main.append(h('div', { class: 'banner' },
      h('strong', {}, 'One-time setup: '), 'add your Claude API key so the app can explain cases. ',
      h('a', { href: '#/settings' }, 'Open Settings →')));
  }
  main.append(
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary big', onclick: newProjectSheet }, '＋ New brief or motion'),
      h('button', { class: 'btn big', onclick: quickCase }, '📄 Just explain one case')),
    h('div', { class: 'section-title' }, 'Your projects'));
  if (!projects.length) main.append(h('p', { class: 'muted' }, 'No projects yet. Start one by uploading your draft motion — or just explain a single case.'));
  for (const p of projects) {
    const n = cases.filter((c) => c.projectId === p.id).length;
    main.append(h('div', { class: 'card tap', onclick: () => go('#/p/' + p.id) },
      h('h3', {}, p.name),
      h('div', { class: 'small muted' }, [p.court, `${(p.props || []).length} points`, `${n} cases`].filter(Boolean).join(' · '))));
  }
  app.replaceChildren(header('Case Review', null, null, h('button', { class: 'iconbtn', 'aria-label': 'Settings', onclick: () => go('#/settings') }, '⚙︎')), main);
}

function draftPicker() {
  const state = { text: '', fileName: '' };
  const status = h('div', { class: 'small muted' });
  const paste = h('textarea', { placeholder: 'Or paste your draft here…' });
  paste.addEventListener('input', () => { state.text = paste.value; state.fileName = ''; });
  const input = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    status.textContent = 'Reading ' + f.name + '…';
    try {
      state.text = await fileToText(f);
      state.fileName = f.name;
      paste.value = state.text;
      status.textContent = `✓ Loaded ${f.name} (${state.text.length.toLocaleString()} characters)`;
    } catch (e) { status.textContent = '⚠️ ' + e.message; }
  });
  const el = h('div', {}, h('label', { class: 'file' }, input, '📎 Upload draft (Word .docx, PDF, or text)'), status, h('label', { class: 'f' }, 'Paste instead'), paste);
  return { el, state };
}

async function newProjectSheet() {
  const name = h('input', { type: 'text', placeholder: 'e.g., Smith v. Acme — MTD' });
  const court = h('input', { type: 'text', placeholder: 'e.g., S.D.N.Y. (2d Cir.) — or leave blank to detect' });
  const side = h('input', { type: 'text', value: 'Defendant, moving to dismiss' });
  const dp = draftPicker();
  const body = h('div', {},
    h('label', { class: 'f' }, 'Project name'), name,
    h('label', { class: 'f' }, 'Court / jurisdiction (helps find binding cases)'), court,
    h('label', { class: 'f' }, 'Our side'), side,
    h('label', { class: 'f' }, 'Your draft (with case cites and [brackets] for research you still need)'), dp.el);
  const p = await sheet('New brief or motion', body, [{
    label: 'Create', run: async () => {
      const proj = {
        id: uid(), name: name.value.trim() || dp.state.fileName || 'Untitled brief', court: court.value.trim(), side: side.value.trim(),
        draft: dp.state.text.trim(), draftName: dp.state.fileName, props: [], createdAt: Date.now(),
      };
      await save('projects', proj);
      return proj;
    },
  }]);
  if (p) { go(`#/p/${p.id}?tab=points`); if (p.draft) setTimeout(() => analyzeDraft(p.id), 50); }
}

async function quickCase() {
  let p = (await db.all('projects')).find((x) => x.quick);
  if (!p) {
    p = { id: uid(), name: 'Quick cases', quick: true, court: '', side: '', draft: '', props: [], createdAt: Date.now() };
    await save('projects', p);
  }
  const c = await addCaseSheet(p);
  if (c) go('#/c/' + c.id + (c.text ? '' : '?pull=1'));
}

/* ============================== Settings ============================== */

function viewSettings() {
  const s = S.get();
  const key = h('input', { type: 'password', value: s.apiKey, placeholder: 'sk-ant-…', autocomplete: 'off' });
  const cl = h('input', { type: 'password', value: s.clToken, placeholder: 'optional', autocomplete: 'off' });
  const model = h('select', {}, MODELS.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)));
  const effort = h('select', {}, [['low', 'Quick'], ['medium', 'Balanced (default)'], ['high', 'Thorough (slower, costs more)']].map(([v, l]) => h('option', { value: v, selected: v === s.effort }, l)));
  const style = h('textarea', { style: 'min-height:260px' }, s.style);
  const doSave = () => {
    S.set({ apiKey: key.value.trim(), clToken: cl.value.trim(), model: model.value, effort: effort.value, style: style.value.trim() || DEFAULT_STYLE });
    toast('Saved');
  };
  const main = h('main', {},
    h('div', { class: 'card' },
      h('h3', {}, 'Claude API key (required)'),
      h('p', { class: 'small muted' }, 'This is what lets the app read and explain cases. Get one at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), ' → API Keys, and add a few dollars of credit under Billing. The key is saved only on this phone.'),
      key,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn slim', onclick: testKey }, 'Test key'))),
    h('div', { class: 'card' },
      h('h3', {}, 'CourtListener token (optional, free)'),
      h('p', { class: 'small muted' }, 'CourtListener is a free public case law library. A token makes pulling cases faster and lets the app double-check that citations are real. Sign up at ', h('a', { href: 'https://www.courtlistener.com/sign-in/', target: '_blank', rel: 'noopener' }, 'courtlistener.com'), ', then copy your token from Profile → Developer Tools → API.'),
      cl),
    h('div', { class: 'card' },
      h('h3', {}, 'Model & depth'),
      h('label', { class: 'f' }, 'Model'), model,
      h('label', { class: 'f' }, 'How hard Claude thinks'), effort),
    h('div', { class: 'card' },
      h('h3', {}, 'How to explain things to me'),
      h('p', { class: 'small muted' }, 'These are the built-in instructions used for every explanation. Edit them any time.'),
      style,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn slim', onclick: () => { style.value = DEFAULT_STYLE; } }, 'Reset to default'))),
    h('button', { class: 'btn primary big', onclick: doSave }, 'Save settings'),
    manualCard(),
    h('div', { class: 'section-title' }, 'Connection check'),
    diagCard(),
    h('div', { class: 'section-title' }, 'Backup'),
    h('div', { class: 'card stack' },
      h('p', { class: 'small muted', style: 'margin:0' }, 'Your projects live only on this device. Export a backup now and then (and to move to another device).'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: exportBackup }, '⬇︎ Export backup'),
        h('label', { class: 'btn' }, '⬆︎ Import backup', h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: importBackup })))),
    h('p', { class: 'small muted' }, `App version ${APP_VERSION}`),
    h('p', { class: 'small muted' }, 'Privacy: when you ask for an explanation, your draft and the case text are sent to Anthropic’s API to generate the answer. Anthropic does not train on API data by default. Check your firm’s policy before uploading client-confidential drafts.'));
  app.replaceChildren(header('Settings', '#/'), main);

  async function testKey(e) {
    doSave();
    const done = busy(e.currentTarget, 'Testing…');
    try {
      await claude({ system: 'Reply with exactly: OK', messages: [{ role: 'user', content: 'Test' }], effort: 'low', maxTokens: 2000 });
      toast('✓ Key works');
    } catch (err) { toast('⚠️ ' + friendlyError(err), 5000); }
    done();
  }
}

function diagCard() {
  const list = h('div', { class: 'small kbd', style: 'white-space:pre-wrap; margin-top:10px' });
  const draw = () => {
    const log = JSON.parse(localStorage.getItem('cr.diag') || '[]');
    list.textContent = log.length
      ? log.map((d) => `${d.at} · ${d.secs}s · 1st ${d.firstByte}s · gap ${d.maxGap}s · ${d.events} ev · ${d.size}${d.effort ? ' · ' + d.effort : ''}\n  ${d.outcome}`).join('\n')
      : 'No requests logged yet.';
  };
  draw();
  const btn = h('button', { class: 'btn', onclick: async () => {
    const done = busy(btn, 'Testing… (about 1–2 min, keep the app open)');
    try {
      await claude({
        system: 'You are a test.',
        messages: [{ role: 'user', content: 'Write a numbered list of 60 different well-known U.S. Supreme Court cases, each with a 3-sentence plain-English summary. This is a connection test.' }],
        effort: 'low', maxTokens: 16000,
      });
      toast('✓ Long request finished fine');
    } catch (e) { toast('⚠️ ' + friendlyError(e), 5000); }
    done(); draw();
  } }, '📶 Long answer test');
  const test = (label, opts) => {
    const b = h('button', { class: 'btn', onclick: async () => {
      const done = busy(b, 'Testing…');
      try { await claude(opts); toast('✓ ' + label + ' finished fine'); } catch (e) { toast('⚠️ ' + friendlyError(e), 5000); }
      done(); draw();
    } }, label);
    return b;
  };
  const filler = 'The court considered the parties’ arguments regarding standing, abandonment, and the statutory notice requirements under the Dormant Mineral Act. '.repeat(1200);
  const bigBtn = test('📦 Big upload test', {
    system: [{ type: 'text', text: 'Test. Here is a long document:\n' + filler }],
    messages: [{ role: 'user', content: 'Connection test: write a numbered list of 40 short plain-English sentences about motions to dismiss.' }],
    effort: 'low', maxTokens: 8000,
  });
  const thinkBtn = test('🧠 Thinking test', {
    system: 'You are a careful legal tutor.',
    messages: [{ role: 'user', content: 'Connection test. Think carefully, then explain step by step, with a hypothetical, how a court decides whether a plaintiff has standing, and how that differs from failure to state a claim. About 600 words.' }],
    effort: 'medium', maxTokens: 16000,
  });
  return h('div', { class: 'card' },
    h('p', { class: 'small muted', style: 'margin-top:0' }, 'If things keep failing, run each test below (one at a time, keep the app open), then screenshot the log. Together they cost about 30 cents.'),
    h('div', { class: 'stack' }, btn, bigBtn, thinkBtn, h('button', { class: 'btn slim', onclick: () => { localStorage.removeItem('cr.diag'); draw(); } }, 'Clear log')),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, 'App mode: ' + (matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'Home Screen app' : 'Browser tab')),
    list);
}

async function exportBackup() {
  const data = { version: 2, exportedAt: new Date().toISOString(), projects: await db.all('projects'), cases: await db.all('cases'), versions: await db.all('versions'), reviews: await db.all('reviews'), kv: await db.all('kv') };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `case-review-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}
async function importBackup(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    for (const p of data.projects || []) await db.put('projects', p);
    for (const c of data.cases || []) await db.put('cases', c);
    for (const v of data.versions || []) await db.put('versions', v);
    for (const rv of data.reviews || []) await db.put('reviews', rv);
    for (const k of data.kv || []) await db.put('kv', k);
    await loadManual();
    toast(`Imported ${(data.projects || []).length} projects`);
  } catch (err) { toast('⚠️ Not a valid backup file'); }
}

/* ============================== Project ============================== */

async function viewProject(pid, tab, q = {}) {
  const p = await db.get('projects', pid);
  if (!p) return go('#/');
  if (p.analyzing && Date.now() - (p.updatedAt || 0) > 15 * 60 * 1000) { p.analyzing = false; p.analyzeError = 'The last analysis didn’t finish (the app may have been closed). Try again.'; await save('projects', p); }
  const cases = await projectCases(pid);
  const menu = h('button', { class: 'iconbtn', 'aria-label': 'Project menu', onclick: () => projectMenu(p) }, '⋯');
  const items = p.quick ? [['cases', 'Cases'], ['research', 'Research chat']] : [['points', 'Points'], ['draft', 'Draft & review'], ['research', 'Research chat'], ['cases', `Cases (${cases.length})`], ['brief', 'Uploaded draft']];
  if (p.quick && tab !== 'research') tab = 'cases';
  const main = h('main', {});
  app.replaceChildren(header(p.name, '#/', p.court || null, menu), tabs(items, tab, (k) => `#/p/${pid}?tab=${k}`), main);

  if (tab === 'points') {
    const props = p.props || [];
    if (p.analyzing) {
      main.append(h('div', { class: 'card' },
        h('div', { class: 'thinking' }, h('span', { class: 'spin' }), h('span', { id: 'analyze-status' }, 'Reading your draft and splitting it into points…')),
        h('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'Keep the app open on screen until this finishes (usually 1–2 minutes).')));
      return;
    }
    if (!props.length) {
      main.append(h('div', { class: 'card stack' },
        h('h3', {}, p.draft ? 'Ready to go through your draft' : 'Add your draft'),
        h('p', { class: 'muted', style: 'margin:0' }, p.draft
          ? 'I’ll go through it point by point: each legal proposition, the cases you cited for it, and every [bracket] where you still need authority.'
          : 'Upload your draft motion (with citations and [brackets]) under “My draft”, or add points by hand.'),
        p.draft ? h('button', { class: 'btn primary big', onclick: () => analyzeDraft(p.id) }, '🧭 Go through my draft') : h('button', { class: 'btn primary big', onclick: () => go(`#/p/${pid}?tab=brief`) }, 'Add my draft'),
        h('button', { class: 'btn big', onclick: () => addPropSheet(p) }, '＋ Add a point by hand')));
      // Hide an old "add your key" error once a key has been saved.
      if (p.analyzeError && !(S.get().apiKey && /API key in Settings/.test(p.analyzeError))) {
        main.append(h('div', { class: 'err' }, '⚠️ ' + p.analyzeError, ' Tap “Go through my draft” to try again.'));
      }
      return;
    }
    const research = props.filter((x) => x.kind === 'research_needed').length;
    main.append(h('p', { class: 'small muted' }, `${props.length} points · ${research} need research. Tap a point to work on it.`));
    let lastSection = null;
    for (const prop of props) {
      if (prop.section !== lastSection) { main.append(h('div', { class: 'section-title' }, prop.section || 'General')); lastSection = prop.section; }
      const linked = (prop.caseIds || []).map((id) => cases.find((c) => c.id === id)).filter(Boolean);
      main.append(h('div', { class: 'card tap', onclick: () => go(`#/p/${pid}/prop/${prop.id}`) },
        h('div', { class: 'row', style: 'margin-bottom:4px' },
          prop.kind === 'research_needed' ? h('span', { class: 'badge research' }, '🔎 Needs research') : null,
          prop.paragraph ? h('span', { class: 'badge ok' }, '✍️ Paragraph drafted') : null),
        h('div', {}, prop.text),
        prop.bracket ? h('div', { class: 'small note' }, prop.bracket) : null,
        linked.length ? h('div', { style: 'margin-top:6px' }, linked.map((c) => h('span', { class: 'chip' + (c.text ? ' pulled' : '') }, c.support?.[prop.id]?.verdict ? VERDICTS[c.support[prop.id].verdict]?.label.split(' ')[0] : (c.text ? '📖' : '·'), ' ', caseTitle(c)))) : null));
    }
    main.append(h('button', { class: 'btn big', onclick: () => addPropSheet(p) }, '＋ Add a point'));
  }

  if (tab === 'cases') {
    main.append(h('button', { class: 'btn primary big', onclick: async () => { const c = await addCaseSheet(p); if (c) go('#/c/' + c.id + (c.text ? '' : '?pull=1')); } }, '＋ Add a case'));
    if (!cases.length) main.append(h('p', { class: 'muted' }, p.quick ? 'Add a case by citation, or upload a PDF from Westlaw, and I’ll break it down for you.' : 'Cases from your draft show up here once you open them from a point.'));
    for (const c of cases.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      const verdicts = Object.values(c.support || {}).map((s) => s.verdict).filter(Boolean);
      main.append(h('div', { class: 'card tap', onclick: () => go('#/c/' + c.id) },
        h('div', { class: 'row', style: 'flex-wrap:nowrap; align-items:flex-start' },
          h('h3', { class: 'grow' }, caseTitle(c)),
          h('button', { class: 'iconbtn', 'aria-label': 'Delete case', style: 'font-size:17px; margin:-6px -8px 0 0', onclick: (e) => { e.stopPropagation(); deleteCase(c); } }, '🗑')),
        h('div', { class: 'small muted' }, [c.citation, c.text ? '📖 ready to read' : 'not pulled yet', c.annotations?.length ? `${c.annotations.length} notes` : null].filter(Boolean).join(' · ')),
        (verdicts.length || c.rec) ? h('div', { class: 'row', style: 'margin-top:6px' }, recBadge(c.rec?.value), verdicts.map(verdictBadge)) : null));
    }
  }

  if (tab === 'draft') return draftTab(main, p, q);

  if (tab === 'research') return researchTab(main, p, cases);

  if (tab === 'brief') {
    main.append(h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('button', { class: 'btn', onclick: () => replaceDraft(p) }, p.draft ? '↻ Replace draft' : '📎 Add draft'),
      p.draft ? h('button', { class: 'btn', onclick: () => analyzeDraft(p.id, true) }, '🧭 Re-analyze') : null));
    main.append(p.draft ? h('div', { class: 'card pre' }, p.draft) : h('p', { class: 'muted' }, 'No draft yet.'));
  }
}

async function projectMenu(p) {
  const name = h('input', { type: 'text', value: p.name });
  const court = h('input', { type: 'text', value: p.court || '' });
  const side = h('input', { type: 'text', value: p.side || '' });
  const del = h('button', { class: 'btn danger', style: 'margin-top:16px', onclick: async () => {
    if (!confirm(`Delete “${p.name}” and all its cases and notes? This can’t be undone.`)) return;
    for (const c of await projectCases(p.id)) await db.del('cases', c.id);
    await db.del('projects', p.id);
    $('#sheet-root').innerHTML = '';
    go('#/');
  } }, '🗑 Delete project');
  const ok = await sheet('Project details', h('div', {},
    h('label', { class: 'f' }, 'Name'), name,
    h('label', { class: 'f' }, 'Court / jurisdiction'), court,
    h('label', { class: 'f' }, 'Our side'), side, del), [{ label: 'Save', run: () => true }]);
  if (ok) {
    Object.assign(p, { name: name.value.trim() || p.name, court: court.value.trim(), side: side.value.trim() });
    await save('projects', p);
    route();
  }
}

async function replaceDraft(p) {
  const dp = draftPicker();
  const ok = await sheet('Your draft', dp.el, [{ label: 'Use this draft', run: () => !!dp.state.text.trim() || (toast('Add a file or paste text'), false) }]);
  if (!ok) return;
  p.draft = dp.state.text.trim();
  p.draftName = dp.state.fileName;
  await save('projects', p);
  if (!(p.props || []).length || confirm('Go through the new draft and rebuild the list of points? (Cases and notes you’ve pulled are kept.)')) analyzeDraft(p.id, true);
  else route();
}

const PROPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'court', 'propositions'],
  properties: {
    title: { type: 'string', description: 'Short name for this brief, e.g. "Smith v. Acme — Motion to Dismiss"' },
    court: { type: 'string', description: 'Court/jurisdiction from the caption, or empty string' },
    propositions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'text', 'kind', 'bracket', 'citations'],
        properties: {
          section: { type: 'string', description: 'The brief heading this falls under' },
          text: { type: 'string', description: 'The legal proposition, stated in one or two plain sentences' },
          kind: { type: 'string', enum: ['cited', 'research_needed'] },
          bracket: { type: 'string', description: 'Exact text of any bracketed research note, or empty string' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['case_name', 'citation', 'pincite'],
              properties: { case_name: { type: 'string' }, citation: { type: 'string' }, pincite: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

function splitDraft(text, max = 6000) {
  const paras = text.split(/\n(?=\s*\S)/);
  const parts = [];
  let cur = '';
  for (const para of paras) {
    if (cur && cur.length + para.length > max) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + para;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

async function analyzeDraft(pid, rebuild = false) {
  const p = await db.get('projects', pid);
  if (!p?.draft) return;
  p.analyzing = true; p.analyzeError = '';
  await save('projects', p);
  if (location.hash.startsWith('#/p/' + pid)) route();
  // Several short requests instead of one long one: phones drop long-running connections.
  const parts = splitDraft(p.draft);
  const results = new Array(parts.length);
  let doneCount = 0;
  const status = (msg) => { const el = document.getElementById('analyze-status'); if (el) el.textContent = msg; };
  const system = [
    { type: 'text', text: 'You are a meticulous litigation associate who maps briefs into their legal building blocks.' },
    { type: 'text', text: `THE FULL DRAFT BRIEF (for context):\n<brief>\n${p.draft}\n</brief>`, cache_control: { type: 'ephemeral' } },
  ];
  const runPart = async (i) => {
    const r = await claude({
      system,
      messages: [{ role: 'user', content: `Go through EXCERPT ${i + 1} of ${parts.length} of my brief (below) and break it into PROPOSITIONS: each distinct legal point that is (or should be) supported by case law. Use the full brief above only for context (section headings, resolving "Id." and short cites). Only list points whose main statement is inside this excerpt.

For each proposition:
- section: the heading it falls under in the brief.
- text: the proposition in one or two plain sentences, faithful to what I wrote.
- kind: "cited" if I cite case law for it; "research_needed" if it has a bracket or placeholder asking for research (e.g. [find a case that says…], [cite], [confirm cite], [add support], TK, ??), or it is a legal assertion with no authority at all.
- bracket: the exact bracketed note, if any (else "").
- citations: every CASE cited for that point (case name, full citation, pincite if given), with short cites resolved to the full case. Skip statutes and rules.

Keep the brief's order. Don't merge different points; don't split one point into many. If the excerpt has no legal propositions (e.g. caption, signature block), return an empty list.

<excerpt>
${parts[i]}
</excerpt>` }],
      format: { type: 'json_schema', schema: PROPS_SCHEMA },
      maxTokens: 32000,
      effort: 'low',
    });
    results[i] = JSON.parse(r.text);
    doneCount++;
    const found = results.filter(Boolean).reduce((n, x) => n + x.propositions.length, 0);
    status(`Done with part ${doneCount} of ${parts.length} — ${found} points so far…`);
  };
  try {
    status(`Reading your draft in ${parts.length} part${parts.length > 1 ? 's' : ''}…`);
    // First part alone (it warms the cache), then the rest 3 at a time.
    await runPart(0);
    const queue = parts.map((_, i) => i).slice(1);
    await Promise.all([0, 1, 2].map(async () => { while (queue.length) await runPart(queue.shift()); }));
    const fresh = await db.get('projects', pid);
    const old = rebuild ? [] : (fresh.props || []);
    const props = results.flatMap((d) => d.propositions).map((x) => ({ id: uid(), section: x.section, text: x.text, kind: x.kind, bracket: x.bracket, citations: x.citations, caseIds: [] }));
    for (const prop of props) {
      for (const cit of prop.citations) {
        if (!cit.citation && !cit.case_name) continue;
        const c = await findOrCreateCase(fresh, cit);
        if (!prop.caseIds.includes(c.id)) prop.caseIds.push(c.id);
      }
    }
    fresh.props = [...old, ...props];
    const meta = results[0];
    if (!fresh.court && meta.court) fresh.court = meta.court;
    if ((!fresh.name || fresh.name === fresh.draftName || fresh.name === 'Untitled brief') && meta.title) fresh.name = meta.title;
    fresh.analyzing = false;
    await save('projects', fresh);
    toast(`Found ${props.length} points`);
  } catch (e) {
    const fresh = await db.get('projects', pid);
    fresh.analyzing = false; fresh.analyzeError = friendlyError(e);
    await save('projects', fresh);
  }
  if (location.hash.startsWith('#/p/' + pid)) route();
}

async function addPropSheet(p) {
  const section = h('input', { type: 'text', placeholder: 'e.g., I. Plaintiff fails to state a claim' });
  const text = h('textarea', { placeholder: 'The legal point, e.g., “A complaint must plead facts, not just labels and conclusions.”' });
  const cites = h('textarea', { placeholder: 'Cases you have for it, one per line (optional)\nBell Atl. Corp. v. Twombly, 550 U.S. 544 (2007)', style: 'min-height:80px' });
  const ok = await sheet('Add a point', h('div', {}, h('label', { class: 'f' }, 'Section'), section, h('label', { class: 'f' }, 'Proposition'), text, h('label', { class: 'f' }, 'Cases'), cites),
    [{ label: 'Add', run: () => !!text.value.trim() || (toast('Write the point first'), false) }]);
  if (!ok) return;
  const prop = { id: uid(), section: section.value.trim(), text: text.value.trim(), kind: 'research_needed', bracket: '', citations: [], caseIds: [] };
  for (const line of cites.value.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, ...rest] = line.split(/,\s*(?=\d)/);
    const cit = { case_name: name.trim(), citation: rest.length ? line : '', pincite: '' };
    const c = await findOrCreateCase(p, cit);
    prop.caseIds.push(c.id);
    prop.kind = 'cited';
  }
  p.props = [...(p.props || []), prop];
  await save('projects', p);
  go(`#/p/${p.id}/prop/${prop.id}`);
}

/* ============================== Research chat (project-wide) ============================== */

function projectOverview(p, cases) {
  const lines = [];
  if ((p.props || []).length) {
    lines.push('THE POINTS IN MY BRIEF (and the cases I have for each):');
    for (const x of p.props) {
      const cs = (x.caseIds || []).map((id) => cases.find((c) => c.id === id)).filter(Boolean)
        .map((c) => `${caseTitle(c)}${c.citation ? ', ' + c.citation : ''}${c.support?.[x.id]?.verdict ? ' [' + c.support[x.id].verdict + ']' : ''}`);
      lines.push(`- ${x.kind === 'research_needed' ? '[NEEDS RESEARCH] ' : ''}${x.text}${cs.length ? '\n    cases: ' + cs.join('; ') : ''}`);
    }
  }
  const loose = cases.filter((c) => !(p.props || []).some((x) => (x.caseIds || []).includes(c.id)));
  if (loose.length) lines.push('OTHER CASES IN THIS PROJECT: ' + loose.map((c) => caseTitle(c) + (c.citation ? ', ' + c.citation : '')).join('; '));
  return lines.join('\n') || 'No points or cases saved yet.';
}

function researchTab(main, p, cases) {
  const list = h('div', { class: 'chat' });
  const draw = () => {
    list.replaceChildren(...(p.chat || []).map((m) => m.role === 'user'
      ? h('div', { class: 'msg user' }, m.content)
      : h('div', { class: 'msg assistant' }, mdEl(m.content), candidateCards(p, m.cases))));
    if (!p.chat?.length) list.append(h('div', { class: 'muted' },
      h('p', {}, 'Ask me anything about your case or the law — not just “find a case.” I know your whole draft and every case you’ve saved, and I can search the web for authority.'),
      h('p', { class: 'small' }, 'Examples: “What’s the standard for a motion to dismiss in Ohio?” · “What will the other side argue against Section II?” · “Is there an Ohio case applying the Dormant Mineral Act to a lessee?”')));
  };
  draw();
  const input = h('textarea', { placeholder: 'Ask a research question…', rows: 1 });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
  const send = h('button', { class: 'btn primary', 'aria-label': 'Send' }, '↑');
  const quick = [
    `What’s the legal standard for this motion in ${p.court || 'my court'}?`,
    'What will the other side argue, and how do we answer it?',
    'Which points in my brief are weakest right now?',
    'Which points still need authority, and what should I search for?',
  ];
  const composer = h('div', { class: 'composer' },
    h('div', { class: 'quick' }, quick.map((q) => h('button', { class: 'chip', onclick: () => ask(q) }, q))),
    h('div', { class: 'in' }, input, send));
  const clear = h('button', { class: 'btn slim', style: 'margin-top:14px', onclick: async () => {
    if (!confirm('Clear this research conversation?')) return;
    const fresh = await db.get('projects', p.id); fresh.chat = []; await save('projects', fresh); p.chat = []; draw();
  } }, 'Clear chat');
  main.style.paddingBottom = '190px';
  main.append(list, p.chat?.length ? clear : '', composer);
  send.addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); ask(input.value); } });

  let running = false;
  async function ask(text) {
    text = (text || '').trim();
    if (!text || running) return;
    running = true;
    input.value = ''; input.style.height = '';
    const history = [...(p.chat || []), { role: 'user', content: text }];
    p.chat = history;
    draw();
    const bubble = h('div', { class: 'msg assistant' });
    const out = h('div', { class: 'md' });
    bubble.append(out);
    list.append(bubble);
    bubble.scrollIntoView({ block: 'end', behavior: 'smooth' });
    try {
      const r = await streamInto(out, {
        system: [...withManual(systemFor(p)), { type: 'text', text: `You are my legal research partner for this whole project. Answer research questions, explain the law, brainstorm arguments, anticipate the other side's counterarguments, and find authority. Use web search whenever the answer depends on case law, statutes, rules, or current law — especially in ${p.court || 'my jurisdiction'} — and link your sources. Prefer binding authority. Be clear about what you verified in a source versus what is general knowledge.

${CASES_JSON_RULE}

${projectOverview(p, cases)}` }],
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        tools: WEB_TOOLS(6, 4),
        maxTokens: 32000,
      });
      const json = lastJSON(r.text);
      const msg = { role: 'assistant', content: stripJSONBlocks(r.text), cases: json?.cases || [] };
      const fresh = await db.get('projects', p.id);
      fresh.chat = [...history, msg];
      await save('projects', fresh);
      p.chat = fresh.chat;
      bubble.append(candidateCards(p, msg.cases));
    } catch {
      p.chat = history.slice(0, -1); // drop the unanswered question
    }
    running = false;
  }
}

/* ============================== Add a case ============================== */

async function addCaseSheet(p, propId) {
  const cite = h('input', { type: 'text', placeholder: 'e.g., Ashcroft v. Iqbal, 556 U.S. 662 (2009)' });
  const status = h('div', { class: 'small muted' });
  const state = { text: '', fileName: '' };
  const input = h('input', { type: 'file', accept: '.pdf,.docx,.txt,application/pdf' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    status.textContent = 'Reading ' + f.name + '…';
    try { state.text = await fileToText(f); state.fileName = f.name; status.textContent = `✓ ${f.name} loaded`; }
    catch (e) { status.textContent = '⚠️ ' + e.message; }
  });
  const body = h('div', {},
    h('label', { class: 'f' }, 'Case name and/or citation'), cite,
    h('p', { class: 'small muted' }, 'I’ll try to pull the full opinion from free sources. Or upload it:'),
    h('label', { class: 'file' }, input, '📎 Upload the case (Westlaw PDF, Word, or text)'), status);
  return sheet('Add a case', body, [{
    label: 'Add case', run: async () => {
      const raw = cite.value.trim();
      if (!raw && !state.text) { toast('Enter a citation or upload a file'); return false; }
      const [name, ...rest] = raw.split(/,\s*(?=\d)/);
      const c = newCase(p.id, { name: (name || state.fileName.replace(/\.\w+$/, '')).trim(), citation: rest.length ? raw : (/\d/.test(raw) ? raw : '') });
      if (state.text) { c.text = state.text; c.source = 'Uploaded: ' + state.fileName; }
      await save('cases', c);
      if (propId) {
        const fresh = await db.get('projects', p.id);
        const prop = fresh.props.find((x) => x.id === propId);
        if (prop && !prop.caseIds.includes(c.id)) prop.caseIds.push(c.id);
        await save('projects', fresh);
      }
      if (state.text && !c.citation) identifyCase(c.id);
      return c;
    },
  }]);
}

/** For uploaded cases without a citation, ask Claude to read the caption. */
async function identifyCase(cid) {
  try {
    const c = await db.get('cases', cid);
    const r = await claude({
      system: 'Extract case metadata from the start of a court opinion.',
      messages: [{ role: 'user', content: `From this opinion text, give the case name (Bluebook short form, e.g. "Smith v. Jones"), the reporter citation if shown, the court, and year.\n\n${c.text.slice(0, 12000)}` }],
      format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['case_name', 'citation', 'court', 'year'], properties: { case_name: { type: 'string' }, citation: { type: 'string' }, court: { type: 'string' }, year: { type: 'string' } } } },
      effort: 'low', maxTokens: 4000,
    });
    const m = JSON.parse(r.text);
    const fresh = await db.get('cases', cid);
    Object.assign(fresh, { name: m.case_name || fresh.name, citation: m.citation || fresh.citation, court: m.court || fresh.court, year: m.year || fresh.year });
    await save('cases', fresh);
    if (location.hash.includes(cid)) route();
  } catch (e) { console.warn(e); }
}

/* ============================== Proposition (point) view ============================== */

async function viewProp(pid, propId) {
  const p = await db.get('projects', pid);
  const prop = p?.props?.find((x) => x.id === propId);
  if (!prop) return go('#/p/' + pid);
  const cases = (await projectCases(pid));
  const linked = (prop.caseIds || []).map((id) => cases.find((c) => c.id === id)).filter(Boolean);
  const main = h('main', {});
  app.replaceChildren(header('Point', `#/p/${pid}?tab=points`, prop.section), main);

  main.append(h('div', { class: 'card' },
    prop.kind === 'research_needed' ? h('span', { class: 'badge research' }, '🔎 Needs research') : null,
    h('p', { style: 'margin:6px 0; font-size:17px' }, prop.text),
    prop.bracket ? h('p', { class: 'note', style: 'margin:4px 0' }, prop.bracket) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn slim', onclick: editProp }, '✎ Edit'),
      h('button', { class: 'btn slim danger', onclick: deleteProp }, 'Remove'))));

  main.append(h('div', { class: 'section-title' }, `Cases for this point (${linked.length})`));
  for (const c of linked) {
    const sup = c.support?.[prop.id];
    const pin = prop.citations?.find((x) => normCite(x.citation) === normCite(c.citation))?.pincite;
    main.append(h('div', { class: 'card tap', onclick: () => go(`#/c/${c.id}?prop=${prop.id}&tab=${c.text ? (sup ? 'read' : 'support') : 'read'}`) },
      h('h3', {}, caseTitle(c)),
      h('div', { class: 'small muted' }, [c.citation, pin ? 'pin ' + pin : null, c.text ? '📖 ready' : 'tap to pull the case'].filter(Boolean).join(' · ')),
      h('div', { class: 'row', style: 'margin-top:6px' },
        sup ? verdictBadge(sup.verdict) : (c.text ? h('span', { class: 'badge' }, 'Support not checked yet') : null),
        c.rec?.propId === prop.id ? recBadge(c.rec.value) : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn slim', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Remove ${caseTitle(c)} from this point? (The case stays in your Cases tab.)`)) return;
          await persist((fp) => { fp.caseIds = fp.caseIds.filter((x) => x !== c.id); });
          route();
        } }, 'Remove'))));
  }
  main.append(h('div', { class: 'btns' },
    h('button', { class: 'btn', onclick: async () => { const c = await addCaseSheet(p, prop.id); if (c) go(`#/c/${c.id}?prop=${prop.id}${c.text ? '' : '&pull=1'}`); } }, '＋ Add a case'),
    h('button', { class: 'btn', onclick: (e) => checkAll(e.currentTarget) }, '⚖️ Check all cases')));

  // Research
  main.append(h('div', { class: 'section-title' }, 'Find more support'));
  const resOut = h('div', { class: 'md' });
  const resCands = h('div', {});
  const resCard = h('div', { class: 'card' },
    h('p', { class: 'small muted', style: 'margin-top:0' }, prop.kind === 'research_needed' ? 'Your draft flags this point for research. I’ll search the web for cases in your jurisdiction that support it.' : 'Want stronger or binding authority? I’ll search for more cases that support this point.'),
    h('button', { class: 'btn primary big', onclick: (e) => research(e.currentTarget) }, prop.research ? '🔎 Search again' : '🔎 Find cases that support this'),
    resOut, resCands);
  main.append(resCard);
  if (prop.research) showResearch(prop.research);

  // Compare & paragraph
  main.append(h('div', { class: 'section-title' }, 'Put it together'));
  const synOut = h('div', { class: 'md' });
  main.append(h('div', { class: 'card' },
    h('button', { class: 'btn big', onclick: (e) => synthesize(e.currentTarget) }, prop.synthesis ? '🧩 Redo comparison' : '🧩 Compare the cases & how they fit together'),
    synOut));
  if (prop.synthesis) synOut.innerHTML = md(prop.synthesis);

  const paraOut = h('div', {});
  main.append(h('div', { class: 'card' },
    h('button', { class: 'btn primary big', onclick: (e) => writeParagraph(e.currentTarget) }, prop.paragraph ? '✍️ Rewrite the paragraph' : '✍️ Write the paragraph for my motion'),
    paraOut));
  if (prop.paragraph) showParagraph(prop.paragraph, prop.paragraphNotes);

  async function persist(mut) {
    const fresh = await db.get('projects', pid);
    const fp = fresh.props.find((x) => x.id === propId);
    mut(fp);
    await save('projects', fresh);
    return fp;
  }
  async function editProp() {
    const t = h('textarea', {}, prop.text);
    const ok = await sheet('Edit point', t, [{ label: 'Save', run: () => true }]);
    if (ok) { await persist((fp) => { fp.text = t.value.trim() || fp.text; }); route(); }
  }
  async function deleteProp() {
    if (!confirm('Remove this point? (Its cases stay in the Cases tab.)')) return;
    const fresh = await db.get('projects', pid);
    fresh.props = fresh.props.filter((x) => x.id !== propId);
    await save('projects', fresh);
    go(`#/p/${pid}?tab=points`);
  }

  async function checkAll(btn) {
    const todo = linked.filter((c) => !c.support?.[prop.id]);
    if (!todo.length) return toast('All cases here are already checked');
    const done = busy(btn, 'Checking…');
    for (const [i, c] of todo.entries()) {
      btn.innerHTML = `<span class="spin"></span> ${i + 1} of ${todo.length}: ${caseTitle(c).slice(0, 30)}`;
      try {
        if (!c.text) { await pullCase(c, () => {}); await save('cases', c); }
        await runSupportCheck(p, c, prop, h('div'));
      } catch (e) { toast(`⚠️ ${caseTitle(c)}: ${friendlyError(e)}`, 5000); }
    }
    done();
    route();
  }

  async function research(btn) {
    const done = busy(btn, 'Searching… (1–2 minutes)');
    resCands.innerHTML = '';
    const have = linked.map((c) => `- ${caseTitle(c)} ${c.citation || ''}`).join('\n') || '(none yet)';
    try {
      const r = await streamInto(resOut, {
        system: systemFor(p),
        messages: [{ role: 'user', content: `Find case law that supports this point in my brief.

POINT: ${prop.text}
${prop.bracket ? 'MY RESEARCH NOTE: ' + prop.bracket : ''}
SECTION: ${prop.section || ''}
JURISDICTION: ${p.court || 'not specified — infer from my brief'}
CASES I ALREADY HAVE:
${have}

Use web search. Prioritize binding authority (the controlling appellate court and the highest court for my jurisdiction), then persuasive authority from the same district/circuit, then others. Prefer recent, frequently-cited cases. Only suggest cases you actually saw in search results or fetched pages — never from memory alone — and include the URL where you found each.

Write for me in plain English:
1. A short overview of what you found and how strong the support is.
2. For each case: what it held, in one or two sentences, and exactly how it supports my point (step by step), plus any quote you saw word-for-word.
3. Anything that cuts against my point.

Then end with a \`\`\`json block: {"cases":[{"case_name":"","citation":"full reporter citation","court":"","year":"","url":"","why":"one sentence","strength":"strong|moderate|weak"}]}` }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4, max_content_tokens: 60000 },
        ],
        maxTokens: 32000,
      });
      const json = lastJSON(r.text);
      const out = { text: stripJSONBlocks(r.text), cases: json?.cases || [], at: Date.now() };
      await persist((fp) => { fp.research = out; });
      prop.research = out;
      showResearch(out);
      verifyCandidates(out);
    } catch (e) { /* shown inline */ }
    done();
  }

  function showResearch(out) {
    resOut.innerHTML = md(out.text);
    resCands.innerHTML = '';
    if (!out.cases?.length) return;
    resCands.append(h('div', { class: 'section-title' }, 'Suggested cases'),
      h('p', { class: 'small muted' }, 'AI-suggested from web search. Always pull and read the case — and confirm it on Westlaw (KeyCite) before citing.'));
    for (const cand of out.cases) {
      const already = cases.find((c) => cand.citation && normCite(c.citation) === normCite(cand.citation));
      resCands.append(h('div', { class: 'card', style: 'background:var(--soft)' },
        h('h3', {}, cand.case_name),
        h('div', { class: 'small muted' }, [cand.citation, cand.court, cand.year].filter(Boolean).join(' · ')),
        h('div', { class: 'row', style: 'margin:6px 0' },
          cand.strength ? h('span', { class: 'badge ' + (cand.strength === 'strong' ? 'ok' : 'warn') }, cand.strength) : null,
          cand.verified === true ? h('span', { class: 'badge ok' }, '✓ citation found on CourtListener') : cand.verified === false ? h('span', { class: 'badge bad' }, '⚠️ citation not found — double-check') : null),
        h('p', { class: 'small', style: 'margin:4px 0' }, cand.why),
        h('div', { class: 'row' },
          already
            ? h('button', { class: 'btn slim', onclick: () => go(`#/c/${already.id}?prop=${prop.id}`) }, 'Open')
            : h('button', { class: 'btn slim primary', onclick: async () => {
              const fresh = await db.get('projects', pid);
              const c = await findOrCreateCase(fresh, { case_name: cand.case_name, citation: cand.citation, url: cand.url });
              await persist((fp) => { if (!fp.caseIds.includes(c.id)) fp.caseIds.push(c.id); });
              go(`#/c/${c.id}?prop=${prop.id}&pull=1`);
            } }, '📖 Pull & read'),
          cand.url ? h('a', { class: 'btn slim', href: cand.url, target: '_blank', rel: 'noopener' }, 'Source ↗') : null)));
    }
  }

  async function verifyCandidates(out) {
    if (!S.get().clToken) return;
    let changed = false;
    for (const cand of out.cases) {
      if (!cand.citation || cand.verified !== undefined) continue;
      try { cand.verified = !!(await clLookupCitation(cand.citation)); changed = true; } catch { /* CORS or rate limit — skip */ }
    }
    if (changed) { await persist((fp) => { fp.research = out; }); showResearch(out); }
  }

  async function synthesize(btn) {
    const ready = linked.filter((c) => c.support?.[prop.id]);
    if (!ready.length) return toast('Check at least one case against this point first (“Check all cases”).', 4000);
    const done = busy(btn, 'Comparing…');
    const analyses = ready.map((c) => `### ${caseTitle(c)} ${c.citation || ''}\n${c.support[prop.id].text}`).join('\n\n');
    const notes = ready.map((c) => (c.annotations || []).filter((a) => a.note).map((a) => `- [${caseTitle(c)}] “${a.quote}” — my note: ${a.note}`).join('\n')).filter(Boolean).join('\n');
    try {
      const r = await streamInto(synOut, {
        system: systemFor(p),
        messages: [{ role: 'user', content: `Compare these cases and explain how they fit together to support my point.

POINT: ${prop.text}

YOUR EARLIER ANALYSIS OF EACH CASE:
${analyses}
${notes ? '\nMY HIGHLIGHT NOTES:\n' + notes : ''}

Give me:
## The big picture — do these cases, together, prove my point? How solidly?
## How each case adds something (a short paragraph per case: the role it plays — e.g., sets out the rule, applies it to similar facts, binding authority)
## How they connect — the logic chain from the rule to my facts (If… then… because…)
## Weak spots and gaps — and what kind of case would fill them
## Best order to cite them in` }],
      });
      await persist((fp) => { fp.synthesis = r.text; });
    } catch {}
    done();
  }

  function showParagraph(text, notes) {
    paraOut.innerHTML = '';
    paraOut.append(
      h('div', { class: 'pre', style: 'margin:12px 0; padding:12px; background:var(--soft); border-radius:10px' }, text),
      h('div', { class: 'row' }, h('button', { class: 'btn slim', onclick: () => copyText(text) }, '📋 Copy paragraph')),
      notes ? h('details', { style: 'margin-top:10px' }, h('summary', {}, 'Why I wrote it this way & what to check'), mdEl(notes)) : null);
  }

  async function writeParagraph(btn) {
    const ready = linked.filter((c) => c.support?.[prop.id] && !['none', 'against'].includes(c.support[prop.id].verdict));
    if (!ready.length) return toast('Check your cases against this point first — I only write with cases you’ve reviewed.', 4500);
    const done = busy(btn, 'Writing…');
    const analyses = ready.map((c) => `### ${caseTitle(c)} — ${c.citation || '(citation unknown)'}\n${c.support[prop.id].text}`).join('\n\n');
    const live = h('div', { class: 'md' });
    paraOut.replaceChildren(live);
    try {
      await loadManual();
      const r = await streamInto(live, {
        system: withManual(systemFor(p)),
        messages: [{ role: 'user', content: `Write the paragraph for my motion that makes this point.

POINT: ${prop.text}
SECTION: ${prop.section}
${prop.synthesis ? 'YOUR COMPARISON OF THE CASES:\n' + prop.synthesis + '\n' : ''}
CASES I'VE REVIEWED (use ONLY these):
${analyses}

Rules: follow my brief-writing manual if it's provided; persuasive, formal motion style that matches the voice of my draft; consistent with the rest of my brief. Bluebook citations with pincites where the opinion text shows them; otherwise put [pin]. Use explanatory parentheticals where helpful. Don't overstate what a case held.

Output exactly two parts:
<paragraph>
(the paragraph only, plain text, no Markdown)
</paragraph>
<notes>
## Why I wrote it this way (plain English, step by step)
## Check before filing (pincites, KeyCite, anything I assumed)
</notes>` }],
      });
      const para = (r.text.match(/<paragraph>([\s\S]*?)<\/paragraph>/)?.[1] || r.text).trim();
      const notes = (r.text.match(/<notes>([\s\S]*?)<\/notes>/)?.[1] || '').trim();
      await persist((fp) => { fp.paragraph = para; fp.paragraphNotes = notes; });
      showParagraph(para, notes);
    } catch {}
    done();
  }
}

/* ============================== Case view ============================== */

const COLORS = [
  { key: 'yellow', label: 'Important' },
  { key: 'green', label: 'Helps us' },
  { key: 'red', label: 'Hurts us' },
  { key: 'blue', label: 'The rule' },
];

async function viewCase(cid, tab, propId) {
  const c = await db.get('cases', cid);
  if (!c) return go('#/');
  const p = await db.get('projects', c.projectId);
  const prop = p.props?.find((x) => x.id === propId);
  const back = prop ? `#/p/${p.id}/prop/${prop.id}` : `#/p/${p.id}?tab=cases`;
  const qs = (t) => `#/c/${cid}?tab=${t}${propId ? '&prop=' + propId : ''}`;
  const menu = h('button', { class: 'iconbtn', 'aria-label': 'Case menu', onclick: () => caseMenu(c) }, '⋯');
  const main = h('main', {});
  const items = [['read', 'Read'], ['breakdown', 'Break it down'], ...(p.quick ? [] : [['compare', 'Compare'], ['support', 'Support?']]), ['chat', 'Ask'], ['notes', 'Saved']];
  const hdr = header(caseTitle(c), back, [c.citation, c.court, c.year].filter(Boolean).join(' · ') || null, menu);
  hdr.classList.add('compact');
  if (!p.quick && p.props?.length) hdr.append(propBar(p, c, prop, tab));
  app.replaceChildren(hdr, tabs(items, tab, qs), main);

  if (!c.text) return getCasePanel(main, c, p);

  if (tab === 'read') return readTab(main, c, p, prop);
  if (tab === 'breakdown') return breakdownTab(main, c, p, prop);
  if (tab === 'support') return supportTab(main, c, p, prop);
  if (tab === 'compare') return compareTab(main, c, p, prop);
  if (tab === 'chat') return chatTab(main, c, p, prop);
  if (tab === 'notes') return savedTab(main, c, p, propId);
}

/** Choose which points this case is used for (any number), and which one to pin. */
async function connectSheet(p, c, prop, tab) {
  const fresh = await db.get('projects', p.id);
  const props = fresh.props || [];
  const chosen = new Set(props.filter((x) => (x.caseIds || []).includes(c.id)).map((x) => x.id));
  let pin = prop?.id || null;
  const rows = h('div', { class: 'stack' });
  const draw = () => rows.replaceChildren(...props.map((x) => h('div', { class: 'connrow' + (chosen.has(x.id) ? ' on' : '') },
    h('button', { class: 'conncheck', 'aria-pressed': chosen.has(x.id), onclick: () => { chosen.has(x.id) ? chosen.delete(x.id) : chosen.add(x.id); if (!chosen.has(x.id) && pin === x.id) pin = null; draw(); } },
      h('span', { class: 'box' }, chosen.has(x.id) ? '✓' : ''),
      h('span', { class: 'grow', style: 'text-align:left' }, x.section ? h('span', { class: 'small muted', style: 'display:block' }, x.section) : null, x.text)),
    h('button', { class: 'btn slim' + (pin === x.id ? ' primary' : ''), onclick: () => { pin = x.id; chosen.add(x.id); draw(); } }, pin === x.id ? '📌 Pinned' : 'Pin'))));
  draw();
  const ok = await sheet('Connect this case to points', h('div', {},
    h('p', { class: 'small muted', style: 'margin-top:0' }, 'Check every point this case is used for. “Pin” shows that point at the top while you read, and the Compare tab uses its cases.'),
    rows), [{ label: 'Save', run: () => true }]);
  if (!ok) return;
  const again = await db.get('projects', p.id);
  for (const x of again.props || []) {
    const has = (x.caseIds || []).includes(c.id);
    if (chosen.has(x.id) && !has) x.caseIds = [...(x.caseIds || []), c.id];
    if (!chosen.has(x.id) && has) x.caseIds = x.caseIds.filter((id) => id !== c.id);
  }
  await save('projects', again);
  toast(`Connected to ${chosen.size} point${chosen.size === 1 ? '' : 's'}`);
  const nextPin = pin && chosen.has(pin) ? pin : [...chosen][0];
  location.hash = `#/c/${c.id}?tab=${tab}${nextPin ? '&prop=' + nextPin : ''}`;
  route();
}

/** Pinned bar under the case title showing the point you're researching. */
function propBar(p, c, prop, tab) {
  const open = () => connectSheet(p, c, prop, tab);
  if (!prop) return h('div', { class: 'propbar' }, h('button', { class: 'pchoose', onclick: open }, '🔗 Connect this case to a point'));
  const sup = c.support?.[prop.id];
  const text = h('div', { class: 'ptext clamp', onclick: () => text.classList.toggle('clamp') }, prop.text);
  return h('div', { class: 'propbar' },
    h('div', { class: 'phead' },
      h('span', { class: 'plabel' }, 'Your point'),
      sup ? verdictBadge(sup.verdict) : null,
      h('button', { class: 'pswitch', onclick: open }, 'Change')),
    text);
}

async function caseMenu(c) {
  const name = h('input', { type: 'text', value: c.name || '' });
  const cite = h('input', { type: 'text', value: c.citation || '' });
  const del = h('button', { class: 'btn danger', style: 'margin-top:16px', onclick: async () => {
    await deleteCase(c, () => { $('#sheet-root').innerHTML = ''; go(`#/p/${c.projectId}?tab=cases`); });
  } }, '🗑 Delete this case');
  const replace = h('button', { class: 'btn', style: 'margin-top:16px; margin-right:8px', onclick: async () => {
    if (c.annotations?.length && !confirm('Replacing the text removes your highlights on this case. Continue?')) return;
    $('#sheet-root').innerHTML = '';
    c.text = ''; c.fmt = 0; c.annotations = []; c.breakdown = ''; await save('cases', c); route();
  } }, '↻ Replace case text');
  const p0 = await db.get('projects', c.projectId);
  const conn = !p0?.quick && p0?.props?.length ? h('button', { class: 'btn', style: 'margin-top:16px; margin-right:8px', onclick: () => { $('#sheet-root').innerHTML = ''; const q = new URLSearchParams(location.hash.split('?')[1]); const pr = p0.props.find((x) => x.id === q.get('prop')); connectSheet(p0, c, pr, q.get('tab') || 'read'); } }, '🔗 Connect to points') : null;
  const ok = await sheet('Case options', h('div', {},
    h('label', { class: 'f' }, 'Case name'), name, h('label', { class: 'f' }, 'Citation'), cite,
    c.url ? h('p', { class: 'small' }, 'Source: ', h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.source || c.url)) : (c.source ? h('p', { class: 'small muted' }, 'Source: ' + c.source) : null),
    h('div', {}, conn, replace, del)), [{ label: 'Save', run: () => true }]);
  if (ok) { c.name = name.value.trim(); c.citation = cite.value.trim(); await save('cases', c); route(); }
}

function getCasePanel(main, c, p) {
  const status = h('div', { class: 'small muted', style: 'margin-top:8px; white-space:pre-wrap' });
  const auto = h('button', { class: 'btn primary big', onclick: async () => {
    const done = busy(auto, 'Finding the case…');
    try {
      await pullCase(c, (m) => { status.textContent = m; });
      await save('cases', c);
      toast('Got it');
      route();
    } catch (e) {
      status.innerHTML = '';
      status.append(h('span', { class: 'err' }, '⚠️ ' + friendlyError(e)));
      done();
    }
  } }, '🔎 Find this case for me');
  const input = h('input', { type: 'file', accept: '.pdf,.docx,.txt,application/pdf' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    status.textContent = 'Reading ' + f.name + '…';
    try {
      c.text = await fileToText(f); c.source = 'Uploaded: ' + f.name;
      await save('cases', c);
      if (!c.citation) identifyCase(c.id);
      route();
    } catch (e) { status.textContent = '⚠️ ' + e.message; }
  });
  const paste = h('textarea', { placeholder: 'Or paste the opinion text here…' });
  main.append(h('div', { class: 'card stack' },
    h('h3', {}, 'Get the full opinion'),
    h('p', { class: 'muted', style: 'margin:0' }, 'I’ll look on free sources (CourtListener, Justia, and others). If it isn’t free online, download it from Westlaw and upload the PDF here.'),
    auto, status,
    h('label', { class: 'file' }, input, '📎 Upload from Westlaw (PDF, Word, or text)'),
    paste,
    h('button', { class: 'btn', onclick: async () => { if (!paste.value.trim()) return; c.text = paste.value.trim(); c.source = 'Pasted'; await save('cases', c); if (!c.citation) identifyCase(c.id); route(); } }, 'Use pasted text')));
  if (new URLSearchParams(location.hash.split('?')[1]).get('pull') === '1') auto.click();
}

/* ---- Reader: cleaned-up text, tap-a-sentence highlighting ---- */

const TEXT_FORMAT = 3; // bump when normalizeOpinion changes

const isHeadingLine = (k) => k.length < 90 && (
  (/[A-Z]{3}/.test(k) && k === k.toUpperCase() && !/[.;,]$/.test(k)) ||
  /^(?:[IVXL]+|[A-H])\.\s+[A-Z][^.;]*$/.test(k)
);
const PARA_MARK = /^(\{¶\s*\d+\}|¶\s*\d+\.?|\[\d+\])\s*/;

/** Turn raw opinion text (hard-wrapped lines, tabs, page headers) into clean paragraphs separated by blank lines. */
function normalizeOpinion(raw) {
  let lines = raw.replace(/\r\n?/g, '\n').replace(/[   ]/g, ' ').replace(/[​﻿]/g, '').split('\n');
  // Drop running headers/footers (short lines repeated 3+ times) and bare page numbers.
  const counts = new Map();
  for (const l of lines) { const k = l.trim(); if (k && k.length < 70) counts.set(k, (counts.get(k) || 0) + 1); }
  const pageNum = /^(?:[-–—]\s*)?(?:page\s+)?\d{1,3}(?:\s*[-–—])?$|^\d+\s+of\s+\d+$/i;
  lines = lines.filter((l) => {
    const k = l.trim();
    if (!k) return true;
    if (pageNum.test(k)) return false;
    const looksLikeHeader = /\d/.test(k) || / v\. /.test(k) || (k === k.toUpperCase() && /[A-Z]{3}/.test(k)) || /^(case|no\.|page|docket)/i.test(k);
    return !(counts.get(k) >= 3 && looksLikeHeader && !/[.;:,]$/.test(k) && !PARA_MARK.test(k) && !/^[*\s]+$/.test(k));
  });
  const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
  const nonblank = lines.filter((l) => l.trim());
  const indented = nonblank.filter((l) => indentOf(l) >= 2).length;
  const useIndent = indented > 0 && indented / nonblank.length < 0.4;
  const lens = nonblank.map((l) => l.trim().length).filter((n) => n > 25).sort((a, b) => a - b);
  const median = lens[lens.length >> 1] || 80;

  const paras = [];
  let cur = '', prev = '', blank = true;
  for (const l of lines) {
    if (!l.trim()) { blank = true; continue; }
    const k = l.trim().replace(/\s+/g, ' ');
    const midSentence = cur && !(blank && FOOTNOTE.test(cur)) && (/[-–]$/.test(cur) || (!/[.:?!;"”’)\]]$/.test(cur) && /^[a-z(,;]/.test(k)));
    const start = !cur || PARA_MARK.test(k) || isHeadingLine(k) || isHeadingLine(prev) ||
      (!midSentence && (blank || (useIndent && indentOf(l) >= 2) ||
        (/[.:?!]["”’)]?$/.test(prev) && prev.length < median * 0.7)));
    if (start) { if (cur) paras.push(cur); cur = k; }
    else if (/\S[-–]$/.test(cur)) cur += k; // line broke right after a hyphen (e.g. "2024-" / "Ohio-2133")
    else cur += ' ' + k;
    prev = k; blank = false;
  }
  if (cur) paras.push(cur);
  return mendFootnoteBreaks(paras).join('\n\n');
}

// Footnotes at the bottom of a PDF page land in the middle of a paragraph that continues
// on the next page. Rejoin the paragraph and move the footnote(s) after it.
const FOOTNOTE = /^\d{1,2}\s+(?:[A-Z"“(]|See\b)/;
function mendFootnoteBreaks(paras) {
  const out = [...paras];
  for (let i = 0; i < out.length - 1; i++) {
    if (/[.:?!"”’)\]]$/.test(out[i]) || isHeadingLine(out[i])) continue;
    let j = i + 1;
    const notes = [];
    while (j < out.length && j - i <= 4 && FOOTNOTE.test(out[j])) notes.push(out[j++]);
    if (!notes.length || j >= out.length || !/^[a-z(,;]/.test(out[j])) continue;
    out.splice(i, j - i + 1, out[i] + ' ' + out[j], ...notes);
  }
  return out;
}

// Words that end with a period but don't end a sentence (legal citations are full of them).
const ABBR = new Set(("v vs inc co corp ltd llc no nos st ct app dist cir supp ed eds mr mrs ms dr jr sr rev stat ann civ crim gen sec secs art " +
  "fed jud admin prac proc evid const amend cl ch pt vol cf al approx dept div bd educ comm assn ass'n univ hosp mfg nat'l int'l " +
  "elec ins tel prop dev ctr cty twp mun sup super prob juv dom rel misc fig para pp nn fn hon atty gov sens rep reps cmty servs " +
  "sys tech transp util indus inv invs mgmt mktg agric bus coll envtl fin rptr nom atl pac am amer auth bros cas cent chem coop " +
  "distrib econ eng'g equip exch grp guar hous indem info lab liab maint med merch metro mut org pharm prods pub reg rd rest ry " +
  "sch soc sur temp unemp ave blvd ft mt pres prof sgt lt capt col messrs cnty comm'n comm'r dep't gov't sav ass'ns " +
  "ala ariz ark cal colo conn del fla ga haw ill ind kan ky la md mass mich minn miss mo mont neb nev okla or pa tenn tex vt va " +
  "wash wis wyo ne nw se sw subd subds supp div'l cert den reh'g aff'd rev'd vacated cir'g").split(' '));

/** Split a paragraph into sentences. Returns [start, end] index pairs (end exclusive, no surrounding spaces). */
function segmentSentences(p, from = 0) {
  const out = [];
  const skipWs = (i) => { while (i < p.length && /\s/.test(p[i])) i++; return i; };
  let start = skipWs(from);
  const re = /[.?!]+["”’)\]]*(?=\s+(?:["“‘(\[]?[A-Z]|\{¶|¶))/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(p))) {
    const end = m.index + m[0].length;
    if (m[0][0] === '.') {
      const w = (p.slice(start, m.index).match(/([A-Za-z.'’]+)$/) || [])[1] || '';
      const wl = w.toLowerCase().replace(/’/g, "'");
      if (w.length === 1 || ABBR.has(wl) || /\.[A-Za-z]{1,3}$/.test(w)) continue; // initials, U.S., L.L.C., e.g.
    }
    if (end - start < 3) continue;
    out.push([start, end]);
    start = skipWs(end);
  }
  let end = p.length;
  while (end > start && /\s/.test(p[end - 1])) end--;
  if (end > start) out.push([start, end]);
  return out;
}

/** Make sure a case's text is in the clean format; remap old highlights onto it. */
async function ensureCleanText(c) {
  if (!c.text || c.fmt === TEXT_FORMAT) return;
  const clean = normalizeOpinion(c.text);
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  c.annotations = (c.annotations || []).map((a) => {
    const q = squash(a.quote);
    let i = clean.indexOf(q);
    if (i < 0) i = clean.indexOf(q.replace(/- /g, '-'));
    return i < 0 ? null : { ...a, start: i, end: i + q.length, quote: q };
  }).filter(Boolean);
  c.text = clean;
  c.fmt = TEXT_FORMAT;
  await save('cases', c);
}

function appendText(parent, str) {
  // Style star pages (*123 / **45) so they're visible but quiet.
  const parts = str.split(/(\*{1,2}\d{1,4}\b)/);
  parts.forEach((t, i) => { if (!t) return; parent.append(i % 2 ? h('span', { class: 'star' }, t) : t); });
}

function fillSentence(span, c) {
  const s = +span.dataset.s, e = +span.dataset.e;
  span.textContent = '';
  const anns = (c.annotations || []).filter((a) => a.end > s && a.start < e).sort((a, b) => a.start - b.start);
  let pos = s;
  for (const a of anns) {
    const from = Math.max(a.start, pos), to = Math.min(a.end, e);
    if (to <= from) continue;
    if (from > pos) appendText(span, c.text.slice(pos, from));
    const mark = h('mark', { class: `c-${a.color}${a.note ? ' has-note' : ''}`, 'data-id': a.id });
    appendText(mark, c.text.slice(from, to));
    span.append(mark);
    pos = to;
  }
  if (pos < e) appendText(span, c.text.slice(pos, e));
}

function renderOpinion(el, c) {
  el.textContent = '';
  let base = 0;
  for (const para of c.text.split('\n\n')) {
    const pStart = base;
    base += para.length + 2;
    if (!para.trim()) continue;
    const heading = isHeadingLine(para.trim());
    const block = h(heading ? 'h3' : 'p', { class: !heading && FOOTNOTE.test(para) && para.length < 1500 ? 'fn' : null });
    let from = 0;
    const m = !heading && para.match(PARA_MARK);
    if (m) { block.append(h('span', { class: 'pnum' }, m[1].replace(/[{}]/g, '').replace(/\s+/g, ''))); from = m[0].length; }
    for (const [s, e] of segmentSentences(para, from)) {
      const span = h('span', { class: 's', 'data-s': pStart + s, 'data-e': pStart + e });
      fillSentence(span, c);
      block.append(span, ' ');
    }
    el.append(block);
  }
}

function refreshSentences(root, c, start, end) {
  root.querySelectorAll('.s').forEach((span) => {
    if (+span.dataset.e > start && +span.dataset.s < end) fillSentence(span, c);
  });
}

/** Absolute text offset for a DOM position inside a sentence span. */
function absOffset(node, offset) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  const span = el?.closest('.s');
  if (!span) return null;
  const r = document.createRange();
  r.selectNodeContents(span);
  r.setEnd(node, offset);
  return +span.dataset.s + r.toString().length;
}

let selHandler = null;
let scrollHandler = null;
function hideSelbar() {
  $('#selbar').classList.add('hidden');
  if (selHandler) { document.removeEventListener('selectionchange', selHandler); selHandler = null; }
  if (scrollHandler) { window.removeEventListener('scroll', scrollHandler); scrollHandler = null; }
  document.getElementById('readprog')?.remove();
  delete document.body.dataset.reading;
}

const READER_DEFAULTS = { size: 19, font: 'serif', theme: 'paper', pen: 'yellow' };
const R = {
  get() { try { return { ...READER_DEFAULTS, ...JSON.parse(localStorage.getItem('cr.reader') || '{}') }; } catch { return { ...READER_DEFAULTS }; } },
  set(patch) { localStorage.setItem('cr.reader', JSON.stringify({ ...R.get(), ...patch })); },
};

function applyReader(el) {
  const r = R.get();
  el.style.setProperty('--rsize', r.size + 'px');
  el.dataset.font = r.font;
  el.dataset.theme = r.theme;
  document.body.dataset.reading = r.theme;
}

async function readTab(main, c, p, prop) {
  await ensureCleanText(c);
  main.classList.add('reading');
  const op = h('article', { class: 'reader', id: 'opinion' });
  applyReader(op);
  renderOpinion(op, c);

  const source = c.source ? (c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.source + ' ↗') : c.source) : null;
  main.append(
    h('div', { class: 'readbar' },
      h('div', { class: 'small muted grow' }, source ? ['Source: ', source] : null),
      h('button', { class: 'btn slim', 'aria-label': 'Text settings', onclick: textSettings }, 'Aa')),
    ...(c.fetchNote ? [h('p', { class: 'small muted' }, c.fetchNote)] : []),
    op);

  // Reading progress bar
  const prog = h('div', { id: 'readprog', class: 'readprog' });
  document.body.append(prog);
  scrollHandler = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    prog.style.width = (max > 0 ? Math.min(100, (scrollY / max) * 100) : 0) + '%';
  };
  window.addEventListener('scroll', scrollHandler, { passive: true });

  // Pen tray (bottom)
  const bar = $('#selbar');
  const drawTray = () => {
    const pen = R.get().pen;
    bar.className = 'selbar tray';
    bar.replaceChildren(
      h('button', { class: pen === 'none' ? 'on' : '', onclick: () => { R.set({ pen: 'none' }); drawTray(); toast('Reading mode — tap a sentence for options'); } }, h('span', { class: 'penicon' }, '👁'), 'Read'),
      ...COLORS.map((x) => h('button', { class: pen === x.key ? 'on' : '', onclick: () => { R.set({ pen: x.key }); drawTray(); } }, h('span', { class: 'dot c-' + x.key, style: 'width:20px;height:20px' }), x.label)));
  };
  drawTray();

  // Tap a sentence → highlight it with the current pen. Tap a highlight → options.
  op.addEventListener('click', (e) => {
    if (!window.getSelection().isCollapsed) return;
    const mark = e.target.closest('mark');
    if (mark) return openHighlight(c.annotations.find((x) => x.id === mark.dataset.id));
    const span = e.target.closest('.s');
    if (!span) return;
    const s = +span.dataset.s, en = +span.dataset.e;
    const pen = R.get().pen;
    if (pen === 'none') return sentenceSheet(s, en);
    addAnn(s, en, pen);
  });

  // Long-press selection still works for highlighting just a few words.
  let pending = null;
  selHandler = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { pending = null; drawTray(); return; }
    const rg = sel.getRangeAt(0);
    const a = absOffset(rg.startContainer, rg.startOffset), b = absOffset(rg.endContainer, rg.endOffset);
    if (a == null || b == null || b <= a) return;
    pending = { start: a, end: b };
    bar.className = 'selbar';
    bar.replaceChildren(
      ...COLORS.map((x) => h('button', { onpointerdown: (ev) => ev.preventDefault(), onclick: (ev) => { ev.preventDefault(); const pd = pending; window.getSelection().removeAllRanges(); if (pd) addAnn(pd.start, pd.end, x.key); } }, h('span', { class: 'dot c-' + x.key, style: 'width:18px;height:18px' }), x.label)),
      h('button', { onpointerdown: (ev) => ev.preventDefault(), onclick: (ev) => { ev.preventDefault(); if (pending) explainSnippet(c, prop, c.text.slice(pending.start, pending.end)); } }, h('span', { class: 'penicon' }, '❓'), 'Explain'));
  };
  document.addEventListener('selectionchange', selHandler);

  async function addAnn(start, end, color) {
    const quote = c.text.slice(start, end).trim();
    if (!quote) return;
    // Replace any highlight that overlaps this range.
    c.annotations = (c.annotations || []).filter((a) => !(a.end > start && a.start < end));
    c.annotations.push({ id: uid(), start, end, quote, color, note: '', at: Date.now() });
    await save('cases', c);
    refreshSentences(op, c, start, end);
    if (navigator.vibrate) navigator.vibrate(8);
  }

  async function removeAnn(a) {
    c.annotations = c.annotations.filter((x) => x.id !== a.id);
    await save('cases', c);
    refreshSentences(op, c, a.start, a.end);
  }

  function colorButtons(current, onPick) {
    const row = h('div', { class: 'colorrow' });
    for (const x of COLORS) {
      row.append(h('button', { class: 'colorbtn' + (current === x.key ? ' on' : ''), onclick: (ev) => {
        row.querySelectorAll('.colorbtn').forEach((b) => b.classList.remove('on'));
        ev.currentTarget.classList.add('on');
        onPick(x.key);
      } }, h('span', { class: 'dot c-' + x.key, style: 'width:16px;height:16px' }), x.label));
    }
    return row;
  }

  function wordAsk(text) {
    const word = h('input', { type: 'text', placeholder: 'A word or phrase from this sentence…' });
    return h('div', { class: 'row', style: 'margin-top:10px' }, word,
      h('button', { class: 'btn slim', onclick: () => { const w = word.value.trim(); if (!w) return; $('#sheet-root').innerHTML = ''; explainSnippet(c, prop, w, text); } }, 'What does this mean?'));
  }

  async function sentenceSheet(start, end) {
    const text = c.text.slice(start, end);
    let color = null;
    const note = h('textarea', { placeholder: 'Add a note (optional)…', style: 'min-height:80px' });
    const ok = await sheet('This sentence', h('div', {},
      h('blockquote', { class: 'quote' }, text),
      colorButtons(null, (k) => { color = k; }),
      note,
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn slim', onclick: () => { $('#sheet-root').innerHTML = ''; explainSnippet(c, prop, text); } }, '❓ Explain this sentence')),
      wordAsk(text)), [{ label: 'Save', run: () => true }]);
    if (ok && (color || note.value.trim())) {
      await addAnn(start, end, color || 'yellow');
      const a = c.annotations.at(-1);
      a.note = note.value.trim();
      await save('cases', c);
      refreshSentences(op, c, start, end);
    }
  }

  async function openHighlight(a) {
    if (!a) return;
    let color = a.color;
    const note = h('textarea', { placeholder: 'Add a note…', style: 'min-height:80px' }, a.note || '');
    const ok = await sheet('Highlight', h('div', {},
      h('blockquote', { class: 'quote' }, a.quote),
      colorButtons(a.color, (k) => { color = k; }),
      note,
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn slim', onclick: () => { $('#sheet-root').innerHTML = ''; explainSnippet(c, prop, a.quote); } }, '❓ Explain this'),
        h('button', { class: 'btn slim danger', onclick: async () => { $('#sheet-root').innerHTML = ''; await removeAnn(a); } }, 'Remove highlight')),
      wordAsk(a.quote)), [{ label: 'Save', run: () => true }]);
    if (ok) { a.color = color; a.note = note.value.trim(); await save('cases', c); refreshSentences(op, c, a.start, a.end); }
  }

  async function textSettings() {
    const r = R.get();
    const preview = h('p', { class: 'small muted' }, `Text size: ${r.size}`);
    const set = (patch) => { R.set(patch); applyReader(op); preview.textContent = `Text size: ${R.get().size}`; };
    const choice = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, label]) => h('button', { class: R.get()[key] === v ? 'on' : '', onclick: (ev) => {
      set({ [key]: v });
      ev.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
      ev.currentTarget.classList.add('on');
    } }, label)));
    await sheet('Reading settings', h('div', {},
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => set({ size: Math.max(14, R.get().size - 1) }) }, 'A−'),
        h('button', { class: 'btn', onclick: () => set({ size: Math.min(28, R.get().size + 1) }) }, 'A+'),
        preview),
      h('label', { class: 'f' }, 'Font'), choice('font', [['serif', 'Book'], ['sans', 'Clean'], ['dyslexia', 'Easy-read']]),
      h('label', { class: 'f' }, 'Page'), choice('theme', [['paper', 'Paper'], ['white', 'White'], ['night', 'Night']])),
    [{ label: 'Done', run: () => true }]);
  }

  const focus = new URLSearchParams(location.hash.split('?')[1]).get('focus');
  if (focus) setTimeout(() => { const m = op.querySelector(`mark[data-id="${focus}"]`); if (m) { m.scrollIntoView({ block: 'center' }); m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 1800); } }, 50);
  else if (!localStorage.getItem('cr.tip.tap')) { localStorage.setItem('cr.tip.tap', '1'); toast('Tip: tap any sentence to highlight it. Pick the color at the bottom.', 4500); }
}

async function explainSnippet(c, prop, snippet, within) {
  const i = c.text.indexOf(within || snippet);
  const len = (within || snippet).length;
  const around = i >= 0 ? c.text.slice(Math.max(0, i - 600), i + len + 600) : '';
  const short = snippet.length < 60 && !/[.;:]/.test(snippet);
  const q = short
    ? `What does “${snippet}” mean here? Define it in plain English, then explain what it means in this specific part of the opinion and why it matters.`
    : `Explain this passage from the opinion in plain English, step by step:\n\n“${snippet}”\n\nWhat is the court saying, what is it based on, and why does it matter${prop ? ' for my point: ' + prop.text : ''}?`;
  c.pendingQuestion = { q, context: around };
  await save('cases', c);
  go(`#/c/${c.id}?tab=chat${prop ? '&prop=' + prop.id : ''}`);
}

/* ---- Breakdown ---- */

function otherAuthorities(p, c, prop, cases) {
  if (!prop) return '';
  const others = (prop.caseIds || []).filter((id) => id !== c.id).map((id) => cases.find((x) => x.id === id)).filter(Boolean);
  if (!others.length) return 'OUR OTHER AUTHORITIES FOR THIS POINT: none yet.';
  return 'OUR OTHER AUTHORITIES FOR THIS POINT:\n' + others.map((x) => {
    const sup = x.support?.[prop.id];
    return `- ${caseTitle(x)}${x.citation ? ', ' + x.citation : ''}${sup?.verdict ? ` (support check: ${sup.verdict})` : ''}${x.rec?.propId === prop.id ? ` (recommendation: ${x.rec.value})` : ''}`;
  }).join('\n');
}

async function breakdownTab(main, c, p, prop) {
  const cases = await projectCases(p.id);
  const linkedProps = (p.props || []).filter((x) => (x.caseIds || []).includes(c.id));
  const out = h('div', { class: 'md' });
  const recRow = h('div', { class: 'row', style: 'margin-bottom:6px' });
  const btn = h('button', { class: 'btn primary big', onclick: run }, c.breakdown ? '↻ Redo breakdown' : '🧠 Break this case down for me');
  const betterBtn = h('button', { class: 'btn big', onclick: findBetter }, c.better ? '🔎 Search again for a better case' : '🔎 Look for a better case');
  const betterOut = h('div', { class: 'md' });
  const betterCands = h('div', {});
  const intro = h('p', { class: 'muted', style: 'margin-top:0' }, 'Starts with whether to use this case — does it support your point, how close are its facts to yours, is there a better case — then the best quotes, then a plain-English walkthrough.');
  const staleNote = c.breakdown && prop && c.breakdownFor && c.breakdownFor !== prop.id
    ? h('div', { class: 'banner small' }, 'This breakdown was written for a different point. Tap “Redo breakdown” to judge it against the point pinned above.') : null;
  const mentionedEl = h('div', {}, candidateCards(p, c.mentioned, prop?.id, { unverified: true, title: 'Cases mentioned' }));
  main.append(staleNote || '', h('div', { class: 'card' }, recRow, c.breakdown ? out : intro, c.breakdown ? null : out, mentionedEl), btn,
    h('div', { class: 'card', style: 'margin-top:12px' + (c.breakdown ? '' : ';display:none'), id: 'better-card' }, betterBtn, betterOut, betterCands));
  if (c.breakdown) out.innerHTML = md(c.breakdown);
  if (c.rec) recRow.append(recBadge(c.rec.value));
  if (c.better) { betterOut.innerHTML = md(c.better.text); betterCands.replaceChildren(candidateCards(p, c.better.cases, prop?.id || c.better.propId)); }

  function pointContext() {
    if (prop) return `THE POINT I'M USING THIS CASE FOR: ${prop.text}${prop.section ? `\n(Section: ${prop.section})` : ''}\n${otherAuthorities(p, c, prop, cases)}`;
    if (linkedProps.length) return 'POINTS IN MY BRIEF THIS CASE IS CITED FOR:\n' + linkedProps.map((x) => '- ' + x.text).join('\n');
    return 'I have not said which point this case is for — judge it against the arguments in my brief (or, if there is no brief, against how it would typically be used).';
  }

  async function run() {
    const done = busy(btn, 'Breaking it down…');
    if (!out.isConnected) main.querySelector('.card').replaceChildren(recRow, out, mentionedEl);
    mentionedEl.replaceChildren();
    recRow.replaceChildren();
    try {
      const r = await streamInto(out, {
        system: systemFor(p, c),
        messages: [{ role: 'user', content: `${pointContext()}

Break this case down for me. Start with exactly one line: "RECOMMENDATION: use", "RECOMMENDATION: caution", "RECOMMENDATION: replace", or "RECOMMENDATION: skip" (use = strong fit, cite it; caution = helps but has gaps the other side could exploit; replace = supports us but a better-fitting case likely exists; skip = doesn't really help us). Then use exactly these sections:

## Should we use this case?
### 1. Does it support our point?
(Yes / partly / no — and exactly why, step by step: what the court held → how that gets us to our point, or where the chain breaks.)
### 2. How close is it to our case?
(Compare it to OUR facts and posture from my brief. Same type of motion or procedural posture? Same argument? Same industry, type of contract, or kind of parties? Same jurisdiction / binding on ${p.court || 'my court'}? List the similarities, then the differences the other side would use to distinguish it.)
### 3. Is there a better case?
(Describe the ideal case for this point — for example, same motion + same argument + same industry — and whether such a case likely exists. If one of our other authorities for this point is stronger, name it and say why.)
### 4. Recommendation
(**Helpfulness:** x/5 · **Relevance to our facts:** x/5. Then say plainly: use it, use it with caution (and how to frame it), replace it, or rely on another authority instead.)
## Best quotes
(The most useful exact words from the opinion for us, with star pages or ¶ numbers if shown. Say in a few words why each quote helps.)
## The bottom line
(2–3 sentences: who won, and the one rule this case stands for.)
## The story (facts)
(Only the facts that mattered to the decision.)
## How it got here (procedural posture)
(What happened below, what kind of motion/appeal this is, and what standard of review applied, explained simply.)
## The question the court had to answer
## Legal terms, defined
(Every term of art in the opinion that I might not know.)
## The rule of law
(The proposition of law this case stands for, in one or two sentences I could put in a brief.)
## How the court got there — step by step
(A numbered chain: "1. The rule is… 2. So the court asked… 3. Here, the facts showed… 4. Therefore…". For each step, say what the court based it on — statute, earlier case, policy, or a specific fact.)
## What the court decided
(Holding and outcome. Note any concurrence or dissent and why it matters.)
## A hypothetical to make it click
## Watch-outs
(Dicta vs. holding; limits on the case; later cases that may have limited it, if mentioned.)

${MENTIONED_RULE}` }],
      });
      const rec = (r.text.match(/RECOMMENDATION:\s*(use|caution|replace|skip)/i)?.[1] || '').toLowerCase();
      c.mentioned = lastJSON(r.text)?.cases || [];
      c.breakdown = stripJSONBlocks(r.text.replace(/^\s*RECOMMENDATION:.*\n?/i, '')).trim();
      mentionedEl.replaceChildren(candidateCards(p, c.mentioned, prop?.id, { unverified: true, title: 'Cases mentioned' }));
      c.breakdownFor = prop?.id || '';
      c.rec = rec ? { value: rec, propId: prop?.id || '' } : null;
      await save('cases', c);
      out.innerHTML = md(c.breakdown);
      recRow.replaceChildren(recBadge(rec) || '');
      document.getElementById('better-card')?.style.removeProperty('display');
      if (rec === 'replace' || rec === 'skip') toast('Recommendation: look for a better case — tap “Look for a better case” below.', 4500);
    } catch {}
    done();
    btn.textContent = '↻ Redo breakdown';
  }

  async function findBetter() {
    const done = busy(betterBtn, 'Searching… (1–2 minutes)');
    betterCands.replaceChildren();
    const assessment = (c.breakdown || '').split(/\n## Best quotes/)[0].slice(0, 6000);
    try {
      const r = await streamInto(betterOut, {
        system: systemFor(p),
        messages: [{ role: 'user', content: `Find a BETTER case than ${caseTitle(c)}${c.citation ? ', ' + c.citation : ''} for my point, if one exists.

${pointContext()}
JURISDICTION: ${p.court || 'not specified — infer from my brief'}

YOUR EARLIER ASSESSMENT OF ${caseTitle(c)}:
${assessment || '(none yet)'}

Use web search. Look for cases that match as many of these as possible, in this order of importance: (1) binding in my jurisdiction, (2) same procedural posture / type of motion as mine, (3) same legal argument, (4) same industry or type of contract or parties, (5) similar facts. If no case matches everything, find the ones that match the most, and say which features each one shares with us.

Write for me in plain English:
1. What you looked for and what you found.
2. For each case: what it held, how it compares to ${caseTitle(c)} (better or worse, and in what ways), and any quote you saw word-for-word.
3. Your recommendation: keep ${caseTitle(c)}, add one of these alongside it, or replace it. If nothing better turned up, say so plainly.

${CASES_JSON_RULE}` }],
        tools: WEB_TOOLS(),
        maxTokens: 32000,
      });
      const json = lastJSON(r.text);
      c.better = { text: stripJSONBlocks(r.text), cases: json?.cases || [], propId: prop?.id || '', at: Date.now() };
      await save('cases', c);
      betterOut.innerHTML = md(c.better.text);
      betterCands.replaceChildren(candidateCards(p, c.better.cases, prop?.id));
    } catch {}
    done();
  }
}

/* ---- Support check ---- */

async function runSupportCheck(p, c, prop, outEl) {
  const r = await streamInto(outEl, {
    system: systemFor(p, c),
    messages: [{ role: 'user', content: `Does this case support this point in my brief?

MY POINT: ${prop.text}
SECTION: ${prop.section || ''}
${prop.bracket ? 'MY RESEARCH NOTE: ' + prop.bracket : ''}

Start your answer with exactly one line: "VERDICT: strong" or "VERDICT: partial" or "VERDICT: weak" or "VERDICT: none" or "VERDICT: against" (weak = only in dicta or only by analogy; against = it actually hurts us). Then:

## The short answer
## Why — step by step
(If the case says X, and my point is Y, here's how you get from X to Y — or where the chain breaks.)
## The exact language that helps
(Word-for-word quotes with star pages if shown.)
## Problems and gaps
(Different facts, different procedural posture, dicta, different jurisdiction, later limits.)
## How to phrase my point so it's accurate to this case
## Suggested citation
(Bluebook, with a short explanatory parenthetical.)` }],
  });
  const verdict = (r.text.match(/VERDICT:\s*(strong|partial|weak|none|against)/i)?.[1] || '').toLowerCase();
  const text = r.text.replace(/^\s*VERDICT:.*\n?/i, '').trim();
  outEl.innerHTML = md(text);
  const fresh = await db.get('cases', c.id);
  fresh.support = { ...(fresh.support || {}), [prop.id]: { verdict, text, at: Date.now() } };
  await save('cases', fresh);
  Object.assign(c, fresh);
  return { verdict, text };
}

function supportTab(main, c, p, prop) {
  const props = p.props || [];
  if (!props.length) {
    main.append(h('p', { class: 'muted' }, 'Add points to your project first (from your draft), then check this case against them.'));
    return;
  }
  const sel = h('select', {}, props.map((x) => h('option', { value: x.id, selected: prop ? x.id === prop.id : false }, (c.support?.[x.id] ? '✓ ' : '') + x.text.slice(0, 110))));
  const verdictEl = h('div', { class: 'row', style: 'margin:10px 0' });
  const out = h('div', { class: 'md' });
  const btn = h('button', { class: 'btn primary big' }, '⚖️ Does this case support my point?');
  const show = () => {
    const s = c.support?.[sel.value];
    verdictEl.replaceChildren(s ? verdictBadge(s.verdict) || '' : '');
    out.innerHTML = s ? md(s.text) : '';
    btn.textContent = s ? '↻ Check again' : '⚖️ Does this case support my point?';
  };
  sel.addEventListener('change', show);
  btn.addEventListener('click', async () => {
    const pr = props.find((x) => x.id === sel.value);
    const done = busy(btn, 'Checking…');
    try {
      const r = await runSupportCheck(p, c, pr, out);
      verdictEl.replaceChildren(verdictBadge(r.verdict) || '');
      const fresh = await db.get('projects', p.id);
      const fp = fresh.props.find((x) => x.id === pr.id);
      if (fp && !fp.caseIds.includes(c.id)) { fp.caseIds.push(c.id); await save('projects', fresh); }
    } catch {}
    done();
    btn.textContent = '↻ Check again';
  });
  main.append(h('div', { class: 'card' }, h('label', { class: 'f', style: 'margin-top:0' }, 'Which point in your brief?'), sel, verdictEl, out), btn);
  show();
}

/* ---- Compare: this case alongside the other cases for the same point ---- */

function otherCasesBlock(c, prop, cases) {
  const others = (prop.caseIds || []).filter((id) => id !== c.id).map((id) => cases.find((x) => x.id === id)).filter(Boolean);
  if (!others.length) return { others, block: null };
  const text = 'MY OTHER CASES FOR THIS POINT (full text where I have pulled it):\n\n' + others.map((x) => {
    const sup = x.support?.[prop.id];
    const head = `### ${caseTitle(x)}${x.citation ? ', ' + x.citation : ''}${sup?.verdict ? ` — my support check: ${sup.verdict}` : ''}${x.rec?.propId === prop.id ? ` — recommendation: ${x.rec.value}` : ''}`;
    return x.text ? `${head}\n<opinion>\n${x.text}\n</opinion>` : `${head}\n(Not pulled yet — I only have its name and citation.)`;
  }).join('\n\n');
  return { others, block: { type: 'text', text, cache_control: { type: 'ephemeral' } } };
}

/** A reusable chat with streaming answers and case cards. */
function chatBox({ main, history, persist, request, quick = [], placeholder, empty, p, propId, unverified = false }) {
  const list = h('div', { class: 'chat' });
  const draw = () => {
    list.replaceChildren(...history.map((m) => m.role === 'user'
      ? h('div', { class: 'msg user' }, m.display || m.content)
      : h('div', { class: 'msg assistant' }, mdEl(m.content), candidateCards(p, m.cases, propId, { unverified }))));
    if (!history.length && empty) list.append(h('p', { class: 'muted' }, empty));
  };
  draw();
  const input = h('textarea', { placeholder, rows: 1 });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
  const send = h('button', { class: 'btn primary', 'aria-label': 'Send' }, '↑');
  main.style.paddingBottom = '190px';
  main.append(list, h('div', { class: 'composer' },
    quick.length ? h('div', { class: 'quick' }, quick.map((q) => h('button', { class: 'chip', onclick: () => ask(q) }, q))) : null,
    h('div', { class: 'in' }, input, send)));
  send.addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); ask(input.value); } });
  let running = false;
  async function ask(text) {
    text = (text || '').trim();
    if (!text || running) return;
    running = true;
    input.value = ''; input.style.height = '';
    history.push({ role: 'user', content: text });
    draw();
    const bubble = h('div', { class: 'msg assistant' });
    const out = h('div', { class: 'md' });
    bubble.append(out);
    list.querySelector(':scope > p.muted')?.remove();
    list.append(bubble);
    bubble.scrollIntoView({ block: 'end', behavior: 'smooth' });
    try {
      const r = await streamInto(out, { ...request(), messages: history.map((m) => ({ role: m.role, content: m.content })) });
      const json = lastJSON(r.text);
      const msg = { role: 'assistant', content: stripJSONBlocks(r.text), cases: json?.cases || [] };
      history.push(msg);
      out.innerHTML = md(msg.content);
      bubble.append(candidateCards(p, msg.cases, propId, { unverified }));
      await persist(history);
    } catch {
      history.pop();
    }
    running = false;
  }
  return { ask };
}

async function compareTab(main, c, p, prop) {
  if (!prop) {
    main.append(h('div', { class: 'card stack' },
      h('h3', {}, 'Compare this case with your other cases'),
      h('p', { class: 'muted', style: 'margin:0' }, 'First connect this case to a point. Then I’ll read it alongside every other case you have for that point and show how they fit together.'),
      h('button', { class: 'btn primary big', onclick: () => connectSheet(p, c, null, 'compare') }, '🔗 Connect to a point')));
    return;
  }
  const cases = await projectCases(p.id);
  const { others, block } = otherCasesBlock(c, prop, cases);
  const system = () => [...systemFor(p, c), ...(block ? [block] : [])];

  // The line-up
  const lineup = h('div', { class: 'card' },
    h('div', { class: 'row small', style: 'margin-bottom:6px' }, h('strong', {}, `${others.length + 1} case${others.length ? 's' : ''} for this point`)),
    [c, ...others].map((x) => {
      const sup = x.support?.[prop.id];
      return h('div', { class: 'lineup' },
        h('div', { class: 'grow' },
          h('div', {}, caseTitle(x), x.id === c.id ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'reading now') : null),
          h('div', { class: 'small muted' }, [x.citation, x.text ? null : 'not pulled yet'].filter(Boolean).join(' · '))),
        sup ? verdictBadge(sup.verdict) : null,
        x.id === c.id ? null : h('button', { class: 'btn slim', onclick: () => go(`#/c/${x.id}?prop=${prop.id}&tab=${x.text ? 'compare' : 'read&pull=1'}`) }, x.text ? 'Open' : 'Pull'));
    }));
  main.append(h('div', { class: 'section-title' }, 'The line-up'), lineup);
  if (others.some((x) => !x.text)) main.append(h('p', { class: 'small muted' }, 'Cases that aren’t pulled yet are compared by name only — pull them for a real comparison.'));

  // Comparison
  c.compare ||= {}; c.compareResearch ||= {}; c.compareChat ||= {};
  const cmpOut = h('div', { class: 'md' });
  const cmpCards = h('div', {});
  const cmpBtn = h('button', { class: 'btn primary big', onclick: runCompare }, c.compare[prop.id] ? '↻ Redo comparison' : (others.length ? '🧩 Compare with my other cases' : '🧩 How does this case fit? (no other cases yet)'));
  const gapOut = h('div', { class: 'md' });
  const gapCards = h('div', {});
  const gapBtn = h('button', { class: 'btn big', onclick: runGaps }, c.compareResearch[prop.id] ? '🔎 Search again to fill the gaps' : '🔎 Research to fill the gaps');
  main.append(h('div', { class: 'section-title' }, 'How they fit together'), h('div', { class: 'card' }, cmpBtn, cmpOut, cmpCards),
    h('div', { class: 'card' }, gapBtn, gapOut, gapCards));
  if (c.compare[prop.id]) { cmpOut.innerHTML = md(c.compare[prop.id].text); cmpCards.replaceChildren(candidateCards(p, c.compare[prop.id].cases, prop.id, { unverified: true, title: 'Cases mentioned' })); }
  if (c.compareResearch[prop.id]) { gapOut.innerHTML = md(c.compareResearch[prop.id].text); gapCards.replaceChildren(candidateCards(p, c.compareResearch[prop.id].cases, prop.id)); }

  async function persistCase(mut) {
    const fresh = await db.get('cases', c.id);
    fresh.compare ||= {}; fresh.compareResearch ||= {}; fresh.compareChat ||= {};
    mut(fresh);
    await save('cases', fresh);
    Object.assign(c, { compare: fresh.compare, compareResearch: fresh.compareResearch, compareChat: fresh.compareChat });
  }

  async function runCompare() {
    const done = busy(cmpBtn, 'Reading all the cases…');
    cmpCards.replaceChildren();
    try {
      const r = await streamInto(cmpOut, {
        system: system(),
        messages: [{ role: 'user', content: `MY POINT: ${prop.text}

Compare THE CASE WE ARE READING (${caseTitle(c)}) with my other cases for this point${others.length ? '' : ' (I have none yet, so assess how this case would anchor the point on its own)'}. Judge everything against my facts and posture from my brief. Use these sections:

## How they fit together
(A short overview: together, how well do these cases prove my point?)
## Side by side
(A table: Case | What it holds (one line) | How close to our facts | Binding on ${p.court || 'my court'}? | Strength for our point (x/5))
## What each case adds
(A short paragraph per case: the role it plays — sets out the rule, applies it to facts like ours, binding authority, same industry or same motion, etc.)
## Overlap and weak links
(Redundant cases, cases the other side can easily distinguish, anything that cuts against us.)
## Gaps
(What's still missing — e.g., a binding case, a case with our motion / argument / industry — and what kind of case would fill each gap.)
## Recommended line-up
(Which cases to cite, in what order, and which to drop.)

${MENTIONED_RULE}` }],
      });
      const json = lastJSON(r.text);
      const entry = { text: stripJSONBlocks(r.text), cases: json?.cases || [], at: Date.now() };
      await persistCase((f) => { f.compare[prop.id] = entry; });
      cmpOut.innerHTML = md(entry.text);
      cmpCards.replaceChildren(candidateCards(p, entry.cases, prop.id, { unverified: true, title: 'Cases mentioned' }));
    } catch {}
    done();
    cmpBtn.textContent = '↻ Redo comparison';
  }

  async function runGaps() {
    const done = busy(gapBtn, 'Searching… (1–2 minutes)');
    gapCards.replaceChildren();
    const cmp = c.compare[prop.id]?.text || '';
    try {
      const r = await streamInto(gapOut, {
        system: system(),
        messages: [{ role: 'user', content: `MY POINT: ${prop.text}
JURISDICTION: ${p.court || 'infer from my brief'}
${cmp ? 'YOUR COMPARISON OF MY CURRENT CASES:\n' + cmp.slice(0, 8000) : 'You can see this case and my other cases for the point above.'}

Search the web for cases that fill the gaps in my line-up for this point. Prioritize, in order: binding authority in my jurisdiction; the same motion or procedural posture as mine; the same argument; the same industry, type of contract, or kind of parties; similar facts. Skip cases I already have.

For each case you find: what it held, which gap it fills, and how it compares to the cases I already have. Then say whether it should be added to my line-up or replace one of my cases.

${CASES_JSON_RULE}` }],
        tools: WEB_TOOLS(),
        maxTokens: 32000,
      });
      const json = lastJSON(r.text);
      const entry = { text: stripJSONBlocks(r.text), cases: json?.cases || [], at: Date.now() };
      await persistCase((f) => { f.compareResearch[prop.id] = entry; });
      gapOut.innerHTML = md(entry.text);
      gapCards.replaceChildren(candidateCards(p, entry.cases, prop.id));
    } catch {}
    done();
  }

  // Chat across all the cases for this point (can also search the web)
  main.append(h('div', { class: 'section-title' }, 'Ask about these cases together'));
  const history = c.compareChat[prop.id] ? [...c.compareChat[prop.id]] : [];
  chatBox({
    main, history, p, propId: prop.id,
    placeholder: 'Ask about how these cases fit…',
    empty: 'I can see this case, every other case you’ve connected to this point, and your draft. I can also search the web for new cases.',
    quick: ['Which of my cases is strongest for this point, and why?', 'Do any of my cases conflict with each other?', 'Which case is closest to our facts?', 'Find a case with our same motion and industry.'],
    persist: (hist) => persistCase((f) => { f.compareChat[prop.id] = hist; }),
    request: () => ({
      system: [...system(), { type: 'text', text: `You can see the case we are reading, all my other cases for the point "${prop.text}", and my draft brief. Answer questions about how these cases fit together. Use web search when I ask you to find new cases or check current law.\n\n${CASES_JSON_RULE}` }],
      tools: WEB_TOOLS(5, 3),
      maxTokens: 32000,
    }),
  });
}

/* ---- Chat ---- */

function chatTab(main, c, p, prop) {
  const list = h('div', { class: 'chat' });
  const draw = () => {
    list.replaceChildren(...(c.chat || []).map((m) => m.role === 'user'
      ? h('div', { class: 'msg user' }, m.display || m.content)
      : h('div', { class: 'msg assistant' }, mdEl(m.content), candidateCards(p, m.cases, prop?.id, { unverified: true, title: 'Cases mentioned' }))));
    if (!c.chat?.length) list.append(h('p', { class: 'muted' }, 'Ask anything about this case. I’ve read the whole opinion and your draft brief.'));
  };
  draw();
  const input = h('textarea', { placeholder: 'Ask about this case…', rows: 1 });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
  const send = h('button', { class: 'btn primary', 'aria-label': 'Send' }, '↑');
  const quick = [
    'What are the key facts?',
    'What’s the holding in one sentence?',
    'How could the other side distinguish this case?',
    `Is this case binding in ${p.court || 'my court'}?`,
    prop ? 'How exactly does this help my point?' : 'What is this case best cited for?',
    'Explain the standard of review here.',
  ];
  const composer = h('div', { class: 'composer' },
    h('div', { class: 'quick' }, quick.map((q) => h('button', { class: 'chip', onclick: () => ask(q) }, q))),
    h('div', { class: 'in' }, input, send));
  const clear = h('button', { class: 'btn slim', style: 'margin-top:14px', onclick: async () => { if (!confirm('Clear this conversation?')) return; c.chat = []; await save('cases', c); draw(); } }, 'Clear chat');
  main.style.paddingBottom = '190px';
  main.append(list, c.chat?.length ? clear : '', composer);
  send.addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); ask(input.value); } });

  let running = false;
  async function ask(text, context) {
    text = (text || '').trim();
    if (!text || running) return;
    running = true;
    input.value = ''; input.style.height = '';
    const content = (prop ? `(I'm working on this point: ${prop.text})\n\n` : '') + (context ? `Surrounding text from the opinion, for context:\n"""${context}"""\n\n` : '') + text;
    c.chat = [...(c.chat || []), { role: 'user', content, display: text }];
    draw();
    const out = h('div', { class: 'msg assistant md' });
    list.querySelector('p.muted')?.remove();
    list.append(out);
    out.scrollIntoView({ block: 'end', behavior: 'smooth' });
    try {
      const r = await streamInto(out, { system: [...systemFor(p, c), { type: 'text', text: MENTIONED_RULE }], messages: c.chat.map((m) => ({ role: m.role, content: m.content })) });
      const msg = { role: 'assistant', content: stripJSONBlocks(r.text), cases: lastJSON(r.text)?.cases || [] };
      c.chat.push(msg);
      out.innerHTML = md(msg.content);
      out.after(candidateCards(p, msg.cases, prop?.id, { unverified: true, title: 'Cases mentioned' }));
      await save('cases', c);
    } catch {
      c.chat.pop(); // drop the unanswered question so the conversation stays valid
      await save('cases', c);
    }
    running = false;
  }

  if (c.pendingQuestion) {
    const { q, context } = c.pendingQuestion;
    delete c.pendingQuestion;
    save('cases', c).then(() => ask(q, context));
  }
}

/* ---- Notes ---- */

function notesTab(main, c, propId) {
  const anns = [...(c.annotations || [])].sort((a, b) => a.start - b.start);
  if (!anns.length) {
    main.append(h('p', { class: 'muted' }, 'No highlights yet. In the Read tab, select words to highlight them or add a note.'));
    return;
  }
  const all = anns.map((a) => `“${a.quote}”${a.note ? '\n  — ' + a.note : ''}`).join('\n\n');
  main.append(h('button', { class: 'btn big', onclick: () => copyText(`${caseTitle(c)}${c.citation ? ', ' + c.citation : ''}\n\n${all}`) }, '📋 Copy all notes'));
  for (const kind of COLORS) {
    const group = anns.filter((a) => a.color === kind.key);
    if (!group.length) continue;
    main.append(h('div', { class: 'section-title row', style: 'gap:6px' }, h('span', { class: 'dot c-' + kind.key }), kind.label));
    for (const a of group) {
      main.append(h('div', { class: 'card tap', onclick: () => go(`#/c/${c.id}?tab=read&focus=${a.id}${propId ? '&prop=' + propId : ''}`) },
        h('div', { class: 'pre', style: 'font-size:15px' }, '“' + a.quote + '”'),
        a.note ? h('div', { class: 'small', style: 'margin-top:6px' }, '✎ ' + a.note) : null));
    }
  }
}

/* ============================== Brief-writing manual ============================== */

let MANUAL = null; // { key:'manual', name, text, at }
async function loadManual() {
  try { MANUAL = (await db.get('kv', 'manual')) || null; } catch { MANUAL = null; }
  return MANUAL;
}

function manualBlock() {
  if (!MANUAL?.text) return null;
  return {
    type: 'text',
    text: `MY BRIEF-WRITING MANUAL — standing instructions for every word you draft or revise (voice, sentence craft, paragraphs, tone, citations, punctuation, formatting). My explicit instructions in a request override it; it overrides your own defaults.\n<manual name="${MANUAL.name || 'manual'}">\n${MANUAL.text}\n</manual>`,
    cache_control: { type: 'ephemeral' },
  };
}

/** Add the manual to a system prompt (right after the explanation-style block). */
function withManual(blocks) {
  const m = manualBlock();
  if (!m) return blocks;
  return [blocks[0], m, ...blocks.slice(1)];
}

function manualCard() {
  const status = h('div', { class: 'small', style: 'margin:6px 0' });
  const draw = () => {
    status.replaceChildren(MANUAL?.text
      ? h('span', {}, '✓ ', h('strong', {}, MANUAL.name || 'Manual'), ` · ${Math.round(MANUAL.text.length / 1000)}k characters · added ${new Date(MANUAL.at).toLocaleDateString()}`)
      : h('span', { class: 'muted' }, 'No manual yet.'));
  };
  draw();
  const input = h('input', { type: 'file', accept: '.docx,.pdf,.txt,.md', style: 'display:none' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    status.textContent = 'Reading ' + f.name + '…';
    try {
      const text = await fileToText(f);
      if (text.length < 200) throw new Error('That file has almost no text.');
      MANUAL = { key: 'manual', name: f.name.replace(/\.\w+$/, ''), text, at: Date.now() };
      await db.put('kv', MANUAL);
      toast('Manual saved — every draft and revision will follow it');
    } catch (e) { toast('⚠️ ' + e.message, 5000); }
    draw();
  });
  return h('div', { class: 'card' },
    h('h3', {}, 'Brief-writing manual'),
    h('p', { class: 'small muted', style: 'margin-top:0' }, 'Upload your style manual once. It’s included in every drafting and revision request (and in “Write the paragraph”). It’s stored only on this phone.'),
    status,
    h('div', { class: 'row' },
      h('label', { class: 'btn slim' }, MANUAL?.text ? '↻ Replace' : '📎 Upload manual (Word, PDF, or text)', input),
      h('button', { class: 'btn slim', onclick: () => { if (!MANUAL?.text) return toast('No manual yet'); sheet(MANUAL.name || 'Manual', h('div', { class: 'pre', style: 'font-size:14px; max-height:65vh; overflow:auto' }, MANUAL.text), []); } }, 'View'),
      h('button', { class: 'btn slim danger', onclick: async () => { if (!MANUAL || !confirm('Remove the manual from this phone?')) return; await db.del('kv', 'manual'); MANUAL = null; draw(); } }, 'Remove')));
}

/* ============================== Research file (for drafting) ============================== */

const cap = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');

/** Everything already worked out for this project, as one document Claude can build on. */
function researchFile(p, cases) {
  const L = ['MY RESEARCH FILE — the analyses I have already run. They are settled work: build on them; do not redo them.', ''];
  const props = p.props || [];
  if (props.length) {
    L.push('POINTS IN MY BRIEF:');
    for (const x of props) {
      const cs = (x.caseIds || []).map((id) => cases.find((c) => c.id === id)).filter(Boolean)
        .map((c) => `${c.id} (${caseTitle(c)}${c.support?.[x.id]?.verdict ? ', support check: ' + c.support[x.id].verdict : ''})`);
      L.push(`<point id="${x.id}" section="${x.section || ''}"${x.kind === 'research_needed' ? ' needs_research="yes"' : ''}>`);
      L.push(x.text);
      if (x.bracket) L.push(`My research note: ${x.bracket}`);
      if (cs.length) L.push(`Cases for this point: ${cs.join('; ')}`);
      if (x.synthesis) L.push(`<comparison_of_cases>\n${x.synthesis}\n</comparison_of_cases>`);
      if (x.paragraph) L.push(`<paragraph_written_for_this_point>\n${x.paragraph}\n</paragraph_written_for_this_point>`);
      L.push('</point>', '');
    }
  }
  const relevant = cases.filter((c) => c.text || c.breakdown || Object.keys(c.support || {}).length || props.some((x) => (x.caseIds || []).includes(c.id)));
  if (relevant.length) L.push('CASES (use the id with read_case_text to open the full opinion):');
  for (const c of relevant) {
    const pts = props.filter((x) => (x.caseIds || []).includes(c.id)).map((x) => x.id).join(',');
    L.push(`<case id="${c.id}" name="${caseTitle(c)}" citation="${c.citation || ''}" court="${c.court || ''}" year="${c.year || ''}" full_text_available="${c.text ? 'yes' : 'no'}" points="${pts}">`);
    if (c.rec?.value) L.push(`Recommendation from my breakdown: ${c.rec.value}`);
    if (c.breakdown) L.push(`<breakdown>\n${c.breakdown}\n</breakdown>`);
    for (const [pid, sp] of Object.entries(c.support || {})) L.push(`<support point="${pid}" verdict="${sp.verdict || ''}">\n${sp.text}\n</support>`);
    for (const [pid, cm] of Object.entries(c.compare || {})) L.push(`<compare point="${pid}">\n${cm.text}\n</compare>`);
    for (const [pid, g] of Object.entries(c.compareResearch || {})) L.push(`<gap_research point="${pid}">\n${g.text}\n</gap_research>`);
    if (c.better?.text) L.push(`<better_case_search>\n${c.better.text}\n</better_case_search>`);
    const notes = (c.annotations || []).map((a) => `- [${({ yellow: 'important', green: 'helps us', red: 'hurts us', blue: 'the rule' })[a.color] || a.color}] “${cap(a.quote, 500)}”${a.note ? ` — my note: ${a.note}` : ''}`);
    if (notes.length) L.push(`<my_highlights>\n${notes.join('\n')}\n</my_highlights>`);
    const qa = [];
    for (let i = 0; i + 1 < (c.chat || []).length; i += 2) qa.push(`Q: ${cap(c.chat[i].display || c.chat[i].content, 300)}\nA: ${cap(c.chat[i + 1].content, 1500)}`);
    if (qa.length) L.push(`<ask_chat>\n${qa.slice(-6).join('\n\n')}\n</ask_chat>`);
    L.push('</case>', '');
  }
  return L.join('\n');
}

const DRAFT_RULES = `You are drafting and revising a legal brief with me, inside my case-research app.

1. Follow my brief-writing manual (below) for every word you write: voice, sentence structure, paragraph construction, tone, citations, punctuation, formatting. My explicit instructions in a request override the manual.
2. Consider the WHOLE brief every time, not just the part you are changing. Keep terms, defined names, party names, and record citations consistent. Use a full citation the first time a case appears in the brief and short forms after (check the whole brief to see what is already cited). Don't repeat what another section already says. Make every paragraph serve the overall argument, and keep transitions and cross-references accurate.
3. Build on my research file. My saved analyses (breakdowns, support checks, comparisons, gap research, highlights) are settled work — rely on them instead of re-analyzing. Use the read_case_text tool only to confirm a quotation or pin cite, or when the saved analyses don't cover what you need. Never redo an analysis unless I ask.
4. Never invent cases, quotations, holdings, pin cites, record cites, or facts. If something is missing, write a bracketed placeholder such as [cite], [pin], or [confirm holding].
5. Track sources: every sentence you write or change that relies on a case must be listed in "sources" with the case id and which saved analysis it came from.`;

const EDIT_FORMAT = `HOW TO RETURN YOUR WORK
The brief below has an id in [brackets] before every sentence, heading, and block quote. Do not retype the brief. Return only your changes, as edits that point at those ids; the app applies them and shows me the complete updated brief.

First write a short change log in Markdown: one bullet per flagged sentence, comment, or note (cite its id), saying what you changed and why — or why you left it alone. Then end your reply with ONE \`\`\`json block:
{"edits": [...], "sources": [...]}

Edit types (copy ids exactly):
- {"op":"replace_sentence","id":"Argument I.A ¶2 S1","text":"the new sentence (or sentences)"}
- {"op":"delete_sentence","id":"Argument I.A ¶2 S3"}
- {"op":"insert_sentence_after","id":"Argument I.A ¶2 S1","text":"..."}
- {"op":"replace_paragraph","id":"Argument I.A ¶2","text":"the whole new paragraph"} — only when restructuring a paragraph
- {"op":"insert_paragraph_after","id":"Argument I.A ¶2","text":"..."} — the id can also be a section label (e.g. "Argument I.A") to insert right after its heading; start the text with "> " for a block quote
- {"op":"delete_paragraph","id":"Argument I.A ¶3"}
- {"op":"replace_heading","id":"Argument I.A","text":"A. The new argumentative heading."}
- {"op":"insert_section_after","id":"Argument I.A","heading":"B. ...","paragraphs":["...","..."]}
- {"op":"add_footnote","id":"Argument I.A ¶2 S1","text":"the footnote text"}
Sources: {"text":"the exact final wording of the sentence","case_id":"<id from my research file>","analysis":"support|breakdown|compare|gaps|better|paragraph|chat|text","point_id":"<point id or empty>"}

Approved (GREEN) sentences are locked: the app rejects edits to them unless a comment on that sentence or a note on its section asks for a change. Prefer sentence-level edits over paragraph rewrites, so my approvals survive.`;

const CASE_TOOL = {
  name: 'read_case_text',
  description: 'Open the full text of a case in my research file, by its case id. Use it only to confirm a quotation or pin cite, or when the saved analyses don’t cover what you need.',
  input_schema: { type: 'object', properties: { case_id: { type: 'string', description: 'The id attribute of a <case> in my research file' } }, required: ['case_id'], additionalProperties: false },
  strict: true,
  eager_input_streaming: true,
};

function caseTool(cases) {
  return {
    read_case_text: async (input) => {
      if (!input || typeof input.case_id !== 'string') throw new Error('case_id must be a string');
      const c = cases.find((x) => x.id === input.case_id);
      if (!c) throw new Error(`No case with id ${input.case_id}. Use an id from the research file.`);
      if (!c.text) return `${caseTitle(c)} has not been pulled yet — only its saved analyses are available.`;
      return `${caseTitle(c)}${c.citation ? ', ' + c.citation : ''}\n\n${c.text}`;
    },
  };
}

async function draftSystem(p, cases) {
  await loadManual();
  const blocks = [{ type: 'text', text: DRAFT_RULES + `\n\nPROJECT: ${p.name}\nCOURT / JURISDICTION: ${p.court || 'not specified'}\nOUR SIDE: ${p.side || 'not specified'}` }];
  const m = manualBlock();
  if (m) blocks.push(m);
  blocks.push({ type: 'text', text: researchFile(p, cases), cache_control: { type: 'ephemeral' } });
  return blocks;
}

/* ============================== Versions & sources ============================== */

const versionsOf = async (pid) => (await db.byIndex('versions', 'projectId', pid)).sort((a, b) => a.n - b.n);
const reviewsOf = async (pid) => (await db.byIndex('reviews', 'projectId', pid)).sort((a, b) => (a.round || 1) - (b.round || 1));
const SOURCE_LABELS = { upload: 'Your upload', 'from-project-draft': 'The draft you added to this project', 'claude-first': 'Claude’s first draft', 'claude-revision': 'Revised from your review', 'claude-change': 'Your requested change' };

/** Link sentences that cite a project case (by citation or "X v." name) to that case's saved analysis. */
function citationSources(blocks, cases, props) {
  const out = [];
  const keys = cases.map((c) => {
    const k = [];
    const core = (c.citation || '').match(/\d+\s+[A-Za-z][A-Za-z.\d ]*?\s+\d+/);
    if (core) k.push(normalize(core[0]));
    const m = /^(.+?)\s+v\.\s/.exec(c.name || '');
    if (m && m[1].length >= 4) k.push(normalize(m[1] + ' v.'));
    if (/^(?:\d{4}-Ohio-\d+)/.test(c.citation || '')) k.push(normalize(c.citation.match(/\d{4}-Ohio-\d+/)[0]));
    return { c, k };
  }).filter((x) => x.k.length);
  for (const u of units(buildSections(blocks))) {
    const t = normalize(u.text);
    for (const { c, k } of keys) {
      if (!k.some((key) => t.includes(key))) continue;
      const prop = props.find((x) => (x.caseIds || []).includes(c.id) && c.support?.[x.id]);
      out.push({ text: u.text, caseId: c.id, caseName: caseTitle(c), kind: prop ? 'support' : c.breakdown ? 'breakdown' : 'text', propId: prop?.id || '' });
    }
  }
  return out;
}

/** Sources for a new version: unchanged sentences keep theirs; Claude's new ones are added; citations are linked. */
function mergeSources(blocks, prevSources, claudeSources, cases, props) {
  const present = new Set([...units(buildSections(blocks))].map((u) => normalize(u.text)));
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const key = normalize(s.text) + '|' + s.caseId + '|' + s.kind;
    if (!present.has(normalize(s.text)) || seen.has(key) || !cases.some((c) => c.id === s.caseId)) return;
    seen.add(key);
    out.push(s);
  };
  for (const s of prevSources || []) add(s);
  for (const s of claudeSources || []) {
    const c = cases.find((x) => x.id === s.case_id);
    if (c) add({ text: s.text, caseId: c.id, caseName: caseTitle(c), kind: s.analysis || 'text', propId: s.point_id || '' });
  }
  for (const s of citationSources(blocks, cases, props)) add(s);
  return out;
}

async function saveVersion(p, cases, fields) {
  const vs = await versionsOf(p.id);
  const prev = vs[vs.length - 1];
  const v = {
    id: uid(), projectId: p.id, n: (prev?.n || 0) + 1, createdAt: Date.now(),
    ...fields,
  };
  v.sources = mergeSources(v.blocks, fields.carrySources === false ? [] : prev?.sources, fields.claudeSources, cases, p.props || []);
  delete v.claudeSources; delete v.carrySources;
  await db.put('versions', v);
  return v;
}

/** Sentences locked by a review: green, with no comment of their own and no note on their section. */
function lockedFromReview(rv) {
  const locked = new Set();
  if (!rv) return locked;
  for (const sec of rv.sections) {
    if ((rv.notes[sec.label] || '').trim()) continue;
    for (const it of sec.items) (it.sids || []).forEach((sid) => { if (rv.marks[sid] === 'green' && !rv.comments[sid]) locked.add(sid); });
  }
  return locked;
}

/* ============================== Drafting jobs ============================== */

let draftJob = null; // { pid, label, el } while Claude is working

async function runDraftJob(p, kind, { version, review, instruction, outEl }) {
  if (draftJob) { toast('Claude is still working on the last request'); return null; }
  const cases = await projectCases(p.id);
  draftJob = { pid: p.id, label: kind };
  try {
    const system = await draftSystem(p, cases);
    let user;
    if (kind === 'first') {
      user = `Write a complete first draft of my brief.

WHAT IT IS / MY INSTRUCTIONS: ${instruction || 'A brief on the points in my research file.'}

Use the points in my research file as the backbone, in order, and build on the paragraphs I have already written for points (bring them in line with the manual and the whole brief). Use only cases from my research file; where a point still needs authority, write [cite] and say so in your notes.
${p.draft ? `\nMy earlier draft, for reference (keep what works):\n<earlier_draft>\n${p.draft}\n</earlier_draft>\n` : ''}
FORMAT: write the whole brief between <brief> and </brief>. Put "# " before every heading line, a blank line between paragraphs, "> " before each block quote, footnote markers like [^1] in the text, and the footnote bodies as "[^1]: text" lines at the end. Start with the first heading (no caption) unless I asked for one.
After </brief>, write "## Notes" with what is still missing ([cite] placeholders), assumptions you made, and suggestions. Then end with ONE \`\`\`json block: {"sources":[{"text":"exact sentence","case_id":"...","analysis":"support|breakdown|compare|gaps|better|paragraph|chat|text","point_id":"..."}]}`;
    } else {
      const header = `THE CURRENT BRIEF (version ${version.n}), with ids:\n<brief>\n${labeledBrief(version.blocks)}\n</brief>`;
      if (kind === 'revise') {
        user = `${header}\n\nMY REVIEW FEEDBACK (round ${review.round}):\n<feedback>\n${review.submitted.text}\n</feedback>\n\nRevise only what I flagged: RED sentences, YELLOW sentences, my sentence comments, and my section notes. Leave everything else exactly as it is, except small changes elsewhere that your edits require for consistency (list those in the change log too). Follow my manual. Consider the whole brief.\n\n${EDIT_FORMAT}`;
      } else {
        user = `${header}\n\nMY REQUEST: ${instruction}\n\nMake the changes this request needs, plus anything elsewhere that's needed to keep the brief consistent (list those in the change log). Leave the rest exactly as it is. Follow my manual. Consider the whole brief.\n\n${EDIT_FORMAT}`;
      }
    }
    const status = outEl.closest('.card')?.querySelector('.jobstatus');
    const r = await streamInto(outEl, {
      system,
      messages: [{ role: 'user', content: user }],
      tools: [CASE_TOOL],
      clientTools: caseTool(cases),
      maxTokens: 64000,
      onProgress: (phase) => { if (status) status.textContent = phase === 'tool' ? 'Reading a case from your research…' : phase === 'resume' ? 'Connection dropped — picking up where it left off…' : phase === 'retry' ? 'Reconnecting…' : 'Writing…'; },
    });
    const json = lastJSON(r.text) || {};
    let v;
    if (kind === 'first') {
      const m = r.text.match(/<brief>([\s\S]*?)(?:<\/brief>|$)/);
      if (!m) throw new Error('Claude’s reply didn’t include the brief. Try again.');
      const blocks = blocksFromMarkup(m[1]);
      const notes = stripJSONBlocks(r.text.slice(r.text.indexOf('</brief>') + 8)).trim();
      v = await saveVersion(p, cases, { source: 'claude-first', instruction, blocks, changeLog: notes, claudeSources: json.sources || [], carrySources: false });
    } else {
      if (!Array.isArray(json.edits)) throw new Error('Claude’s reply didn’t include a list of edits, so nothing was changed. Try again.');
      const locked = kind === 'revise' ? lockedFromReview(review) : new Set();
      const res = applyEdits(version.blocks, json.edits, { locked });
      v = await saveVersion(p, cases, {
        source: kind === 'revise' ? 'claude-revision' : 'claude-change',
        parentId: version.id, fromReviewId: review?.id || null, instruction: instruction || '',
        blocks: res.blocks, changeLog: stripJSONBlocks(r.text), applied: res.applied, skipped: res.skipped,
        claudeSources: json.sources || [],
      });
      if (review) { review.revisedVersionId = v.id; await db.put('reviews', review); }
    }
    return v;
  } finally {
    draftJob = null;
  }
}

/* ============================== Draft tab ============================== */

async function importBriefFile(f) {
  const name = f.name.toLowerCase();
  if (name.endsWith('.docx')) return extractDocxBlocks(await f.arrayBuffer());
  return blocksFromParagraphs(paragraphsFromText(await fileToText(f)));
}

async function newVersionSheet(p, title = 'Add a version of the brief') {
  const status = h('div', { class: 'small muted' });
  const state = { blocks: null, name: '' };
  const input = h('input', { type: 'file', accept: '.docx,.pdf,.txt,.md' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    status.textContent = 'Reading ' + f.name + '…';
    try {
      state.blocks = await importBriefFile(f);
      state.name = f.name;
      const heads = state.blocks.filter((b) => b.type === 'h').length;
      const fns = state.blocks.filter((b) => b.type === 'fn').length;
      status.textContent = `✓ ${f.name}: ${state.blocks.length} paragraphs, ${heads} headings${fns ? `, ${fns} footnotes` : ''}`;
    } catch (e) { status.textContent = '⚠️ ' + e.message; }
  });
  const paste = h('textarea', { placeholder: 'Or paste the brief here…' });
  const ok = await sheet(title, h('div', {},
    h('p', { class: 'small muted', style: 'margin-top:0' }, 'Word (.docx) keeps headings, block quotes, and footnotes best.'),
    h('label', { class: 'file' }, input, '📎 Upload the brief (Word, PDF, or text)'), status,
    h('label', { class: 'f' }, 'Paste instead'), paste),
  [{ label: 'Add version', run: () => !!(state.blocks || paste.value.trim()) || (toast('Upload a file or paste the brief'), false) }]);
  if (!ok) return null;
  const blocks = state.blocks || blocksFromParagraphs(paragraphsFromText(paste.value));
  const cases = await projectCases(p.id);
  return saveVersion(p, cases, { source: 'upload', note: state.name || 'Pasted', blocks, carrySources: false });
}

async function exportMenu(p, v) {
  const cases = await projectCases(p.id);
  const base = `${p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 50) || 'brief'}_v${v.n}`;
  const dl = (blob, name) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); };
  await sheet(`Export version ${v.n}`, h('div', { class: 'stack' },
    h('button', { class: 'btn big', onclick: () => copyText(blocksToPlainText(v.blocks)) }, '📋 Copy the brief'),
    h('button', { class: 'btn big', onclick: () => dl(new Blob([buildDocx(v.blocks, { caseNames: cases.map((c) => c.name).filter(Boolean) })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), base + '.docx') }, '⬇︎ Word (.docx)'),
    h('button', { class: 'btn big', onclick: () => dl(new Blob([blocksToPlainText(v.blocks)], { type: 'text/plain' }), base + '.txt') }, '⬇︎ Text (.txt)'),
    h('p', { class: 'small muted' }, 'The Word file uses Times New Roman 12, double spacing, real footnotes, and italic case names and “Id.” Check court formatting rules before filing.')), []);
}

async function draftTab(main, p, q) {
  await loadManual();
  const vs = await versionsOf(p.id);
  const rvs = await reviewsOf(p.id);
  const latest = vs[vs.length - 1];
  const reviewOf = (v) => rvs.find((r) => r.versionId === v.id);

  if (!MANUAL?.text) {
    main.append(h('div', { class: 'banner' }, h('strong', {}, 'Add your brief-writing manual. '), 'Every draft and revision follows it once it’s in. ', h('a', { href: '#/settings' }, 'Settings →')));
  }

  // Working card (shows Claude's progress)
  const jobOut = h('div', { class: 'md' });
  const jobCard = h('div', { class: 'card', style: 'display:none' }, h('div', { class: 'row small' }, h('span', { class: 'spin' }), h('strong', { class: 'jobstatus' }, 'Working…')),
    h('p', { class: 'small muted' }, 'Keep the app open. If the connection drops, it picks up where it left off.'), jobOut);
  const run = async (kind, opts) => {
    jobCard.style.display = '';
    jobCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
    try {
      const v = await runDraftJob(p, kind, { ...opts, outEl: jobOut });
      if (v) {
        toast(`Version ${v.n} is ready`);
        if (location.hash.includes(`/p/${p.id}`)) go(`#/p/${p.id}?tab=draft`);
        route();
      }
    } catch (e) {
      jobCard.querySelector('.jobstatus').textContent = 'Stopped';
      jobOut.append(h('div', { class: 'err' }, '⚠️ ' + friendlyError(e)));
      jobCard.querySelector('.spin')?.remove();
    }
  };

  if (!vs.length) {
    main.append(h('div', { class: 'card stack' },
      h('h3', {}, 'Start the draft'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Draft → review → revise → review again, all here. Every version is saved.'),
      h('button', { class: 'btn primary big', onclick: async () => { const v = await newVersionSheet(p, 'Upload your draft'); if (v) route(); } }, '📎 Upload my draft'),
      p.draft ? h('button', { class: 'btn big', onclick: async () => {
        const cases = await projectCases(p.id);
        await saveVersion(p, cases, { source: 'from-project-draft', blocks: blocksFromParagraphs(paragraphsFromText(p.draft)), carrySources: false });
        route();
      } }, `📄 Use the draft I added to this project${p.draftName ? ` (${p.draftName})` : ''}`) : null,
      h('button', { class: 'btn big', onclick: () => firstDraftSheet() }, '✍️ Have Claude write a first draft')), jobCard);
    return;
  }

  async function firstDraftSheet() {
    const t = h('textarea', { placeholder: 'e.g., Memorandum in support of Defendant’s motion to dismiss under Civ.R. 12(B)(6); about 15 pages; lead with the standing argument.' });
    const ok = await sheet('Claude’s first draft', h('div', {},
      h('p', { class: 'small muted', style: 'margin-top:0' }, 'Claude writes from your points, the paragraphs you’ve written, and your research file, following your manual.'),
      h('label', { class: 'f' }, 'What should it be?'), t), [{ label: 'Write it', run: () => true }]);
    if (ok) run('first', { instruction: t.value.trim() });
  }

  // ---- Current version
  const rv = reviewOf(latest);
  const pending = rvs.find((r) => r.submitted && !r.revisedVersionId);
  const cur = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, `Version ${latest.n}`), h('span', { class: 'badge' }, SOURCE_LABELS[latest.source] || latest.source)),
    h('div', { class: 'small muted', style: 'margin:4px 0 10px' }, new Date(latest.createdAt).toLocaleString(), rv ? ` · Round ${rv.round} review ${rv.submitted ? 'submitted' : 'in progress'}` : ' · not reviewed yet'));
  if (pending && pending.versionId === latest.id) {
    cur.append(h('button', { class: 'btn primary big', onclick: () => run('revise', { version: latest, review: pending }) }, `✏️ Revise from your Round ${pending.round} review`));
  } else {
    cur.append(h('a', { class: 'btn primary big', href: `review.html#v=${encodeURIComponent(latest.id)}` }, rv && !rv.submitted ? `🔍 Continue reviewing v${latest.n}` : `🔍 Review v${latest.n}`));
  }
  cur.append(h('div', { class: 'btns three', style: 'margin-top:8px' },
    h('button', { class: 'btn', onclick: () => go(`#/p/${p.id}/v/${latest.id}`) }, '📖 Read'),
    h('button', { class: 'btn', disabled: vs.length < 2, onclick: () => go(`#/p/${p.id}/diff/${vs[vs.length - 2]?.id}/${latest.id}`) }, '↔︎ Changes'),
    h('button', { class: 'btn', onclick: () => exportMenu(p, latest) }, '⬇︎ Export')));
  if (latest.changeLog) cur.append(h('details', { style: 'margin-top:10px' }, h('summary', {}, latest.source === 'claude-first' ? 'Claude’s notes' : 'What Claude changed'), mdEl(latest.changeLog)));
  if (latest.skipped?.length) {
    cur.append(h('details', { style: 'margin-top:6px' }, h('summary', {}, `⚠️ ${latest.skipped.length} edit${latest.skipped.length === 1 ? '' : 's'} not applied`),
      h('ul', { class: 'small' }, latest.skipped.map((s) => h('li', {}, `${s.edit?.op || '?'} ${s.edit?.id || ''}: ${s.reason}`)))));
  }
  main.append(cur, jobCard);

  // ---- Ask for a change
  const ask = h('textarea', { placeholder: 'e.g., Tighten the Introduction to one page. · Draft Section II.B from my research on the standing point. · Make the Conclusion two sentences.' });
  main.append(h('div', { class: 'card' },
    h('h3', {}, 'Ask for a change'),
    ask,
    h('button', { class: 'btn big', style: 'margin-top:8px', onclick: () => { if (!ask.value.trim()) return toast('Say what to change'); run('change', { version: latest, instruction: ask.value.trim() }); } }, '✨ Make this change (new version)')));

  // ---- History
  main.append(h('div', { class: 'section-title' }, 'All versions'));
  for (const v of [...vs].reverse()) {
    const r = reviewOf(v);
    const idx = vs.indexOf(v);
    main.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, `v${v.n} · ${SOURCE_LABELS[v.source] || v.source}`), r ? h('span', { class: 'badge' }, `Round ${r.round}${r.submitted ? ' ✓' : ''}`) : null),
      h('div', { class: 'small muted' }, new Date(v.createdAt).toLocaleString(), v.instruction ? ` · “${cap(v.instruction, 80)}”` : '', v.note ? ` · ${v.note}` : ''),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn slim', onclick: () => go(`#/p/${p.id}/v/${v.id}`) }, 'Read'),
        h('a', { class: 'btn slim', href: `review.html#v=${encodeURIComponent(v.id)}` }, r ? 'Open review' : 'Review'),
        idx > 0 ? h('button', { class: 'btn slim', onclick: () => go(`#/p/${p.id}/diff/${vs[idx - 1].id}/${v.id}`) }, 'Changes') : null,
        h('button', { class: 'btn slim', onclick: () => exportMenu(p, v) }, 'Export'))));
  }
  main.append(h('button', { class: 'btn big', onclick: async () => { const v = await newVersionSheet(p); if (v) route(); } }, '📎 Upload a new version'));

  // ---- Paragraphs written for points
  const paras = (p.props || []).filter((x) => x.paragraph);
  if (paras.length) {
    main.append(h('details', { class: 'card' }, h('summary', {}, `Paragraphs written for points (${paras.length})`),
      paras.map((prop) => h('div', { style: 'margin-top:10px' },
        h('div', { class: 'small muted' }, prop.section),
        h('div', { class: 'pre', style: 'margin:6px 0' }, prop.paragraph),
        h('div', { class: 'row' }, h('button', { class: 'btn slim', onclick: () => copyText(prop.paragraph) }, 'Copy'), h('button', { class: 'btn slim', onclick: () => go(`#/p/${p.id}/prop/${prop.id}`) }, 'Open point'))))));
  }

  // Coming back from the review screen with "Send to drafting assistant": revise right away.
  if (q.revise && !draftJob) {
    const r = rvs.find((x) => x.id === q.revise);
    const v = r && vs.find((x) => x.id === r.versionId);
    history.replaceState(null, '', `#/p/${p.id}?tab=draft`);
    if (r && v && r.submitted && !r.revisedVersionId) run('revise', { version: v, review: r });
  }
}

/* ============================== Read a version (with ⚖ sources) ============================== */

const ANALYSIS_LABELS = { support: 'Support check', breakdown: 'Break it down', compare: 'Compare', gaps: 'Gap research', better: 'Better-case search', paragraph: 'Paragraph written for the point', chat: 'Ask chat', text: 'Case text' };

async function sourceSheet(text, list) {
  const cases = await db.all('cases');
  const body = h('div', {}, h('blockquote', { class: 'quote' }, text));
  for (const s of list) {
    const c = cases.find((x) => x.id === s.caseId);
    let ex = '';
    if (c) {
      if (s.kind === 'support' && c.support?.[s.propId]) ex = c.support[s.propId].text;
      else if (s.kind === 'compare' && c.compare?.[s.propId]) ex = c.compare[s.propId].text;
      else if (s.kind === 'gaps' && c.compareResearch?.[s.propId]) ex = c.compareResearch[s.propId].text;
      else if (s.kind === 'better' && c.better) ex = c.better.text;
      else ex = c.breakdown || '';
    }
    const tab = s.kind === 'support' ? 'support' : ['compare', 'gaps'].includes(s.kind) ? 'compare' : ['breakdown', 'better'].includes(s.kind) ? 'breakdown' : 'read';
    body.append(h('div', { class: 'card' },
      h('strong', {}, c ? caseTitle(c) : s.caseName || 'Case'), c?.citation ? h('div', { class: 'small muted' }, c.citation) : null,
      h('div', { class: 'small muted' }, 'From: ' + (ANALYSIS_LABELS[s.kind] || s.kind)),
      ex ? h('details', { style: 'margin-top:6px' }, h('summary', {}, 'Show the saved analysis'), mdEl(ex)) : null,
      c ? h('button', { class: 'btn slim', style: 'margin-top:8px', onclick: () => { $('#sheet-root').innerHTML = ''; go(`#/c/${c.id}?tab=${tab}${s.propId ? '&prop=' + s.propId : ''}`); } }, 'Open the case') : null));
  }
  await sheet('Where this sentence comes from', body, []);
}

function briefView(blocks, sources) {
  const bySent = new Map();
  for (const s of sources || []) {
    const k = normalize(s.text);
    if (!bySent.has(k)) bySent.set(k, []);
    bySent.get(k).push(s);
  }
  const wrap = h('article', { class: 'reader briefview' });
  applyReader(wrap);
  const marker = (t) => t.split(/(\[\^\d+\])/).filter(Boolean).map((x) => { const m = /^\[\^(\d+)\]$/.exec(x); return m ? h('sup', {}, m[1]) : x; });
  const { sections } = buildSections(blocks);
  for (const sec of sections) {
    if (sec.kind === 'footnotes') wrap.append(h('h3', {}, 'Footnotes'));
    for (const it of sec.items) {
      if (it.type === 'h') { wrap.append(h('h3', { class: 'bh' }, it.text)); continue; }
      if (it.type === 'q') { wrap.append(h('blockquote', { class: 'bq' }, ...marker(it.text))); continue; }
      const para = h('p', { class: it.type === 'fn' ? 'fn' : null });
      if (it.type === 'fn') para.append(h('strong', {}, `${it.n}. `));
      it.sentences.forEach((s, j) => {
        if (j) para.append(' ');
        para.append(h('span', {}, ...marker(s)));
        const src = bySent.get(normalize(s));
        if (src) para.append(' ', h('button', { class: 'srcchip', onclick: () => sourceSheet(s, src) }, '⚖'));
      });
      wrap.append(para);
    }
  }
  return wrap;
}

async function viewVersion(pid, vid) {
  const p = await db.get('projects', pid);
  const v = await db.get('versions', vid);
  if (!p || !v) return go(`#/p/${pid}?tab=draft`);
  const main = h('main', { class: 'reading' });
  app.replaceChildren(header(`Version ${v.n}`, `#/p/${pid}?tab=draft`, `${p.name} · ${SOURCE_LABELS[v.source] || v.source}`, h('button', { class: 'iconbtn', 'aria-label': 'Export', onclick: () => exportMenu(p, v) }, '⬇︎')), main);
  const nSrc = (v.sources || []).length;
  main.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
    h('a', { class: 'btn slim primary', href: `review.html#v=${encodeURIComponent(v.id)}` }, '🔍 Review this version'),
    h('span', { class: 'small muted' }, nSrc ? `⚖ marks ${nSrc} sentence${nSrc === 1 ? '' : 's'} linked to your research — tap one to see the case and analysis.` : 'No sentences are linked to saved research yet.')));
  main.append(briefView(v.blocks, v.sources));
}

/* ============================== Redline between versions ============================== */

async function viewDiff(pid, aId, bId) {
  const p = await db.get('projects', pid);
  const vs = await versionsOf(pid);
  const A = vs.find((x) => x.id === aId) || vs[vs.length - 2];
  const B = vs.find((x) => x.id === bId) || vs[vs.length - 1];
  if (!p || !A || !B) return go(`#/p/${pid}?tab=draft`);
  const main = h('main', { class: 'reading' });
  app.replaceChildren(header('What changed', `#/p/${pid}?tab=draft`, `${p.name} · v${A.n} → v${B.n}`), main);
  const pick = (cur, onChange) => h('select', { onchange: (e) => onChange(e.target.value) }, vs.map((v) => h('option', { value: v.id, selected: v.id === cur.id }, `v${v.n}`)));
  let onlyChanges = true;
  const out = h('div', {});
  const draw = () => {
    const d = diffBlocks(A.blocks, B.blocks);
    const counts = { changed: 0, added: 0, removed: 0 };
    for (const x of d) if (counts[x.kind] != null) counts[x.kind]++;
    out.replaceChildren(h('p', { class: 'small muted' }, `${counts.changed} paragraphs changed · ${counts.added} added · ${counts.removed} removed`));
    const art = h('article', { class: 'reader redline' });
    applyReader(art);
    let skipped = 0;
    const flushSkip = () => { if (skipped) { art.append(h('p', { class: 'skipnote' }, `… ${skipped} unchanged paragraph${skipped === 1 ? '' : 's'} …`)); skipped = 0; } };
    for (const x of d) {
      if (x.kind === 'same') {
        if (onlyChanges) { skipped++; continue; }
        art.append(h(x.b.type === 'h' ? 'h3' : 'p', {}, x.b.text));
        continue;
      }
      flushSkip();
      if (x.kind === 'added') art.append(h('p', { class: 'rl-add' }, h('ins', {}, x.b.text)));
      else if (x.kind === 'removed') art.append(h('p', { class: 'rl-del' }, h('del', {}, x.a.text)));
      else art.append(h('p', {}, x.words.map((w) => (w.t === 'same' ? w.s : h(w.t === 'ins' ? 'ins' : 'del', {}, w.s)))));
    }
    flushSkip();
    out.append(art);
  };
  main.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
    pick(A, (id) => { go(`#/p/${pid}/diff/${id}/${B.id}`); }), h('span', {}, '→'), pick(B, (id) => { go(`#/p/${pid}/diff/${A.id}/${id}`); }),
    h('label', { class: 'small row', style: 'gap:6px' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { onlyChanges = e.target.checked; draw(); } }), 'Only show changes')),
    B.changeLog ? h('details', { class: 'card' }, h('summary', {}, 'What Claude says it changed'), mdEl(B.changeLog)) : null,
    out);
  draw();
}

/* ============================== Saved work for a case ============================== */

async function savedTab(main, c, p, propId) {
  const props = p.props || [];
  const section = (title, count, body) => h('details', { class: 'card' }, h('summary', {}, `${title}${count != null ? ` (${count})` : ''}`), body);
  const items = [];
  if (c.breakdown) items.push(section('Break it down', null, h('div', {}, c.rec ? recBadge(c.rec.value) : null, mdEl(c.breakdown))));
  const sup = Object.entries(c.support || {});
  if (sup.length) items.push(section('Support checks', sup.length, h('div', {}, sup.map(([pid, s]) => h('div', { style: 'margin-top:10px' }, h('div', { class: 'small muted' }, props.find((x) => x.id === pid)?.text || 'Point'), verdictBadge(s.verdict), mdEl(s.text))))));
  const cmp = Object.entries(c.compare || {});
  if (cmp.length) items.push(section('Compare', cmp.length, h('div', {}, cmp.map(([pid, s]) => h('div', { style: 'margin-top:10px' }, h('div', { class: 'small muted' }, props.find((x) => x.id === pid)?.text || 'Point'), mdEl(s.text))))));
  const gaps = Object.entries(c.compareResearch || {});
  if (gaps.length) items.push(section('Gap research', gaps.length, h('div', {}, gaps.map(([, s]) => mdEl(s.text)))));
  if (c.better?.text) items.push(section('Better-case search', null, mdEl(c.better.text)));
  const qa = Math.floor((c.chat || []).length / 2);
  if (qa) items.push(section('Ask chat', qa, h('div', {}, (c.chat || []).map((m) => (m.role === 'user' ? h('p', {}, h('strong', {}, 'Q: '), m.display || m.content) : mdEl(m.content))))));
  const paras = props.filter((x) => (x.caseIds || []).includes(c.id) && x.paragraph);
  if (paras.length) items.push(section('Paragraphs written for its points', paras.length, h('div', {}, paras.map((x) => h('div', { class: 'pre', style: 'margin-top:8px' }, x.paragraph)))));
  const vs = await versionsOf(p.id);
  const latest = vs[vs.length - 1];
  const used = (latest?.sources || []).filter((s) => s.caseId === c.id);
  if (used.length) items.push(section(`Used in draft v${latest.n}`, used.length, h('ul', {}, used.map((s) => h('li', { class: 'small' }, s.text, h('span', { class: 'muted' }, ` — ${ANALYSIS_LABELS[s.kind] || s.kind}`))))));
  main.append(h('p', { class: 'small muted' }, 'Everything you’ve worked out on this case. The drafting assistant reads all of it and builds on it instead of redoing it.'));
  if (items.length) main.append(...items); else main.append(h('p', { class: 'muted' }, 'No saved analyses yet.'));
  main.append(h('div', { class: 'section-title' }, 'Highlights & notes'));
  notesTab(main, c, propId);
}

/* ============================== Start ============================== */

marked.setOptions({ gfm: true, breaks: false });
loadManual().finally(route);
