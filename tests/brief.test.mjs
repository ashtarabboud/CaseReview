import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, buildSections, blocksFromParagraphs, labeledBrief, applyEdits, diffBlocks, blocksFromMarkup, blocksToMarkup, caseNameSpans, units, ranges } from '../shared/brief.mjs';

test('the four required sentences each stay one sentence', () => {
  for (const s of [
    'Plaintiff objects under Fed. R. Civ. P. 34(b)(2)(C).',
    'See Cal. Code Civ. Proc. § 2031.030.',
    'Smith v. Jones, 123 F.3d 456 (9th Cir. 2001).',
    'See Request No. 5.',
  ]) assert.deepEqual(splitSentences(s), [s]);
  assert.deepEqual(splitSentences('Plaintiff objects under Fed. R. Civ. P. 34(b)(2)(C). See Cal. Code Civ. Proc. § 2031.030. Smith v. Jones, 123 F.3d 456 (9th Cir. 2001). See Request No. 5.').length, 4);
});

test('brief citations and abbreviations', () => {
  assert.deepEqual(splitSentences('See Bell Atl. Corp. v. Twombly, 550 U.S. 544, 555 (2007). It does.'), ['See Bell Atl. Corp. v. Twombly, 550 U.S. 544, 555 (2007).', 'It does.']);
  assert.deepEqual(splitSentences('Cardinal Minerals, L.L.C. v. Miller, 2024-Ohio-5104, appeal not allowed sub nom. Cardinal Minerals, L.L.C. v. Miller. That is improper.'), ['Cardinal Minerals, L.L.C. v. Miller, 2024-Ohio-5104, appeal not allowed sub nom. Cardinal Minerals, L.L.C. v. Miller.', 'That is improper.']);
  assert.deepEqual(splitSentences('The claim fails.[^2] Nor could it.'), ['The claim fails.[^2]', 'Nor could it.']);
  assert.deepEqual(splitSentences('Id. at 5. The Court should deny the motion.'), ['Id. at 5.', 'The Court should deny the motion.']);
});

const SAMPLE = [
  'IN THE COURT OF COMMON PLEAS',
  'DEFENDANT’S MOTION TO DISMISS',
  'TABLE OF CONTENTS',
  'INTRODUCTION ........ 1',
  'I. PLAINTIFF FAILS TO STATE A CLAIM ........ 3',
  'MEMORANDUM IN SUPPORT',
  'INTRODUCTION',
  'This case is about a policy. It does.',
  'STATEMENT OF FACTS',
  'Plaintiff bought a policy. The policy names Acme.',
  'ARGUMENT',
  'I. Plaintiff Fails to State a Claim.',
  'A. The Policy Limits Coverage to the Named Insured.',
  'The policy is clear. It says so.',
  '> "The insured means only the named insured." Policy § 1.',
  'Here, Plaintiff is not named. That ends the inquiry.',
  '1. The loss payee clause does not help.',
  'Nor does the loss payee clause change the result.',
  'B. Plaintiff Lacks Standing.',
  'Standing is required.',
  'II. The Claims Are Time-Barred.',
  'The limitations period ran.',
  'CONCLUSION',
  'The Court should dismiss.',
  'Respectfully submitted,',
  '/s/ Ashtar',
  '[^1]: A footnote.',
];

test('brief sections and labels', () => {
  const blocks = blocksFromParagraphs(SAMPLE);
  const { structured, sections } = buildSections(blocks);
  assert.equal(structured, true);
  assert.deepEqual(sections.map((s) => s.label), ['Opening', 'Memorandum in Support', 'Introduction', 'Statement of Facts', 'Argument', 'Argument I', 'Argument I.A', 'Argument I.A.1', 'Argument I.B', 'Argument II', 'Conclusion', 'Footnotes', 'Closing']);
  const ia = sections.find((s) => s.label === 'Argument I.A');
  assert.deepEqual(ia.items.map((i) => i.id), ['Argument I.A Heading', 'Argument I.A ¶1', 'Argument I.A Q1', 'Argument I.A ¶2']);
  assert.deepEqual(ia.items[3].sids, ['Argument I.A ¶2 S1', 'Argument I.A ¶2 S2']);
  // TOC lines and caption stay in the Opening
  assert.equal(sections[0].items.length, 5);
  const fn = sections.find((s) => s.label === 'Footnotes');
  assert.equal(fn.items[0].id, 'Footnote 1');
});

test('no headings -> one section', () => {
  const { structured, sections } = buildSections(blocksFromParagraphs(['Just a memo.', 'Second paragraph. Two sentences.']));
  assert.equal(structured, false);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].items[1].sids[1], 'Brief ¶2 S2');
});

test('labeled brief shows ids', () => {
  const lb = labeledBrief(blocksFromParagraphs(SAMPLE));
  assert.match(lb, /\[Argument I\.A ¶2 S2\] That ends the inquiry\./);
  assert.match(lb, /\[Argument I\.A Q1\] > "The insured/);
});

test('applyEdits: sentence, paragraph, section, footnote, and green lock', () => {
  const blocks = blocksFromParagraphs(SAMPLE);
  const locked = new Set(['Argument I.A ¶1 S1']);
  const r = applyEdits(blocks, [
    { op: 'replace_sentence', id: '[Argument I.A ¶2 S2]', text: 'That ends it.' },
    { op: 'replace_sentence', id: 'Argument I.A ¶1 S1', text: 'CHANGED' },
    { op: 'insert_sentence_after', id: 'Argument I.A ¶1 S2', text: 'Indeed, it does.' },
    { op: 'delete_sentence', id: 'Introduction ¶1 S2' },
    { op: 'replace_paragraph', id: 'Argument I.A ¶1', text: 'Totally new.' },
    { op: 'insert_paragraph_after', id: 'Argument I.B ¶1', text: 'New paragraph one.\n\nNew paragraph two.' },
    { op: 'replace_heading', id: 'Argument II', text: 'II. The Claims Are Untimely.' },
    { op: 'insert_section_after', id: 'Argument I', heading: 'C. A New Point.', paragraphs: ['New point text.'] },
    { op: 'add_footnote', id: 'Conclusion ¶1 S1', text: 'Second footnote.' },
    { op: 'delete_paragraph', id: 'Argument I.A Q1' },
    { op: 'replace_sentence', id: 'Nope ¶9 S9', text: 'x' },
  ], { locked });
  const text = r.blocks.map((b) => b.text).join('\n');
  assert.match(text, /That ends it\./);
  assert.match(text, /The policy is clear\. It says so\. Indeed, it does\./); // green kept, insert applied
  assert.doesNotMatch(text, /CHANGED|Totally new/);
  assert.match(text, /This case is about a policy\.\n/);
  assert.match(text, /Standing is required\.\nNew paragraph one\.\nNew paragraph two\.\nC\. A New Point\.\nNew point text\.\nII\. The Claims Are Untimely\./);
  assert.match(text, /The Court should dismiss\.\[\^2\]/);
  assert.equal(r.blocks.filter((b) => b.type === 'fn').map((b) => b.n).join(','), '1,2');
  assert.equal(r.blocks.filter((b) => b.type === 'q').length, 0);
  assert.equal(r.skipped.length, 3);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['approved (green) sentence', 'would change an approved (green) sentence', 'no sentence Nope ¶9 S9']);
});

test('markup round trip', () => {
  const blocks = blocksFromParagraphs(SAMPLE);
  const again = blocksFromMarkup(blocksToMarkup(blocks));
  assert.deepEqual(again.map((b) => b.type + ':' + b.text), blocks.map((b) => b.type + ':' + b.text));
});

test('redline', () => {
  const a = [{ type: 'p', text: 'One two three.' }, { type: 'p', text: 'Same.' }, { type: 'p', text: 'Gone.' }];
  const b = [{ type: 'p', text: 'One TWO three.' }, { type: 'p', text: 'Same.' }, { type: 'p', text: 'Gone.' }, { type: 'p', text: 'Added.' }];
  const d = diffBlocks(a, b);
  assert.deepEqual(d.map((x) => x.kind), ['changed', 'same', 'same', 'added']);
  assert.deepEqual(d[0].words.filter((w) => w.t !== 'same').map((w) => w.t + w.s), ['deltwo', 'insTWO']);
});

test('case names for italics', () => {
  const t = 'See Bell Atl. Corp. v. Twombly, 550 U.S. 544 (2007); In re Smith, 1 F.3d 1. Id. at 5.';
  const spans = caseNameSpans(t).map(([a, b]) => t.slice(a, b));
  assert.deepEqual(spans, ['Bell Atl. Corp. v. Twombly', 'In re Smith', 'Id.']);
});

test('ranges', () => { assert.equal(ranges([1, 2, 3, 5]), 'S1–S3, S5'); });
