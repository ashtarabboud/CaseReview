// Word (.docx) reading and writing, entirely in the browser.
// Reading is ported from ReviewBuddy's docx.js (built-in DecompressionStream + DOMParser, no libraries),
// extended to keep headings, block quotes, and footnotes. Writing builds a small .docx by hand.

import { looksLikeHeading, headingInfo, caseNameSpans } from './brief.mjs';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot open .docx files (it needs iOS/Safari 16.4 or newer). Try pasting the text instead.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(buffer, wanted, { optional = false } = {}) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like a Word (.docx) file. If it is password-protected, remove the password and try again.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('The .docx file appears to be damaged.');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const xlen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
    if (name === wanted) {
      const lnlen = dv.getUint16(local + 26, true);
      const lxlen = dv.getUint16(local + 28, true);
      const start = local + 30 + lnlen + lxlen;
      const data = u8.subarray(start, start + csize);
      if (method === 0) return dec.decode(data);
      if (method === 8) return dec.decode(await inflateRaw(data));
      throw new Error('Unsupported compression in .docx file.');
    }
    off += 46 + nlen + xlen + clen;
  }
  if (optional) return null;
  throw new Error('No document body found in this .docx file.');
}

const wAttr = (el, name) => (el ? el.getAttributeNS(W_NS, name) ?? el.getAttribute('w:' + name) : null);
const child = (el, name) => (el ? [...el.children].find((c) => c.localName === name) : null);

function paragraphText(p, fnMap) {
  let out = '';
  const visit = (node) => {
    for (const el of node.children) {
      const n = el.localName;
      if (n === 't') out += el.textContent;
      else if (n === 'tab' || n === 'br' || n === 'cr') out += ' ';
      else if (n === 'noBreakHyphen') out += '-';
      else if (n === 'softHyphen') continue;
      else if (n === 'footnoteReference' && fnMap) {
        const id = wAttr(el, 'id');
        if (!fnMap.has(id)) fnMap.set(id, fnMap.size + 1);
        out += `[^${fnMap.get(id)}]`;
      } else if (n === 'txbxContent' || n === 'Fallback' || n === 'del' || n === 'moveFrom') continue;
      else if (n === 'p') continue;
      else visit(el);
    }
  };
  visit(p);
  return out.replace(/\s+/g, ' ').trim();
}

function paragraphInfo(p) {
  const pPr = child(p, 'pPr');
  const style = wAttr(child(pPr, 'pStyle'), 'val') || '';
  const jc = wAttr(child(pPr, 'jc'), 'val') || '';
  const ind = child(pPr, 'ind');
  const left = +(wAttr(ind, 'left') || wAttr(ind, 'start') || 0);
  const right = +(wAttr(ind, 'right') || wAttr(ind, 'end') || 0);
  const numPr = child(pPr, 'numPr');
  const numId = wAttr(child(numPr, 'numId'), 'val');
  const ilvl = +(wAttr(child(numPr, 'ilvl'), 'val') || 0);
  // all text runs bold or underlined?
  const runs = [...p.getElementsByTagNameNS(W_NS, 'r')].filter((r) => [...r.children].some((c) => c.localName === 't' && c.textContent.trim()));
  const on = (rPr, name) => { const e = child(rPr, name); return e && !['0', 'false', 'none'].includes(wAttr(e, 'val') || ''); };
  const emph = runs.length > 0 && runs.every((r) => { const rPr = child(r, 'rPr'); return on(rPr, 'b') || on(rPr, 'u'); });
  return { style, jc, left, right, numId: numId && numId !== '0' ? numId : null, ilvl, emph };
}

const ROMAN = (n) => { const m = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; };
const autoPrefix = (ilvl, n) => (ilvl === 0 ? ROMAN(n) : ilvl === 1 ? String.fromCharCode(64 + n) : ilvl === 2 ? String(n) : String.fromCharCode(96 + n)) + '. ';

/** Read a .docx into brief blocks (headings, paragraphs, block quotes, footnotes). */
export async function extractDocxBlocks(arrayBuffer) {
  const xml = await readZipEntry(arrayBuffer, 'word/document.xml');
  const fnXml = await readZipEntry(arrayBuffer, 'word/footnotes.xml', { optional: true });
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read the Word document contents.');
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('No document body found in this .docx file.');

  const paras = [];
  const collect = (node) => {
    for (const el of node.children) {
      if (el.namespaceURI !== W_NS) { if (el.localName !== 'AlternateContent') collect(el); continue; }
      if (el.localName === 'p') paras.push(el);
      else if (el.localName !== 'sectPr') collect(el);
    }
  };
  collect(body);

  const fnMap = new Map(); // docx footnote id -> our number
  const blocks = [];
  let seen = false;
  const counters = new Map();
  for (const p of paras) {
    const text = paragraphText(p, fnMap);
    if (!text) continue;
    const info = paragraphInfo(p);
    const styleHeading = /heading|title|subtitle/i.test(info.style) && !/toc/i.test(info.style);
    const styleQuote = /quote|block/i.test(info.style);
    let isHeading = styleHeading || looksLikeHeading(text, { seenHeading: seen });
    if (!isHeading && seen && info.emph && text.length < 400 && !/^\(?[a-z]\)/.test(text)) isHeading = true;
    if (/toc/i.test(info.style)) isHeading = false;
    if (isHeading) {
      let t = text;
      if (info.numId != null && headingInfo(t).level === 0 && !/^(?:[IVXL]+|[A-Z]|\d{1,2})[.)]\s/.test(t)) {
        const key = info.numId;
        const c = counters.get(key) || [];
        c[info.ilvl] = (c[info.ilvl] || 0) + 1;
        c.length = info.ilvl + 1;
        counters.set(key, c);
        t = autoPrefix(info.ilvl, c[info.ilvl]) + t;
      }
      blocks.push({ type: 'h', text: t });
      seen = true;
      continue;
    }
    if (styleQuote || (!info.numId && ((info.left >= 720 && info.right >= 360) || info.left >= 1080))) {
      blocks.push({ type: 'q', text });
      continue;
    }
    blocks.push({ type: 'p', text });
  }

  if (fnXml && fnMap.size) {
    const fdoc = new DOMParser().parseFromString(fnXml, 'application/xml');
    const byId = new Map();
    for (const fn of fdoc.getElementsByTagNameNS(W_NS, 'footnote')) {
      if (wAttr(fn, 'type')) continue; // separators
      const id = wAttr(fn, 'id');
      const text = [...fn.getElementsByTagNameNS(W_NS, 'p')].map((p) => paragraphText(p, null)).filter(Boolean).join(' ');
      byId.set(id, text);
    }
    for (const [id, n] of [...fnMap.entries()].sort((a, b) => a[1] - b[1])) {
      blocks.push({ type: 'fn', n, text: byId.get(id) || '' });
    }
  }
  return blocks;
}

// ------------------------------------------------------------------ writing .docx

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Minimal "stored" (uncompressed) zip. files: [{name, data: Uint8Array}] */
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runsFor(text, names) {
  // split on footnote markers, italicise case names
  const out = [];
  const parts = String(text).split(/(\[\^\d+\])/);
  for (const part of parts) {
    const fm = /^\[\^(\d+)\]$/.exec(part);
    if (fm) { out.push(`<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fm[1]}"/></w:r>`); continue; }
    if (!part) continue;
    const spans = caseNameSpans(part, names);
    let pos = 0;
    const run = (s, it) => { if (s) out.push(`<w:r>${it ? '<w:rPr><w:i/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(s)}</w:t></w:r>`); };
    for (const [a, b] of spans) { run(part.slice(pos, a), false); run(part.slice(a, b), true); pos = b; }
    run(part.slice(pos), false);
  }
  return out.join('');
}

/** Build a .docx (Uint8Array) from brief blocks. Case names and "Id." are italicised; footnotes are real Word footnotes. */
export function buildDocx(blocks, { caseNames = [] } = {}) {
  const enc = new TextEncoder();
  const body = [];
  for (const b of blocks) {
    if (b.type === 'fn') continue;
    if (b.type === 'h') {
      const lvl = headingInfo(b.text).level;
      body.push(`<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/>${lvl === 0 ? '<w:jc w:val="center"/>' : `<w:ind w:left="${Math.min(lvl, 3) * 360}" w:hanging="360"/>`}</w:pPr>${runsFor(b.text, caseNames).replace(/<w:r>(?!<w:rPr>)/g, '<w:r><w:rPr><w:b/></w:rPr>').replace(/<w:rPr><w:i\/><\/w:rPr>/g, '<w:rPr><w:b/><w:i/></w:rPr>')}</w:p>`);
    } else if (b.type === 'q') {
      body.push(`<w:p><w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:ind w:left="1440" w:right="1440"/><w:jc w:val="both"/></w:pPr>${runsFor(b.text, caseNames)}</w:p>`);
    } else {
      body.push(`<w:p><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/><w:jc w:val="both"/></w:pPr>${runsFor(b.text, caseNames)}</w:p>`);
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const fns = blocks.filter((b) => b.type === 'fn').map((f) => `<w:footnote w:id="${f.n}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>${runsFor(f.text, caseNames)}</w:p></w:footnote>`).join('');
  const footnotes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W_NS}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${fns}</w:footnotes>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(document) },
    { name: 'word/styles.xml', data: enc.encode(styles) },
    { name: 'word/footnotes.xml', data: enc.encode(footnotes) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) },
  ]);
}
