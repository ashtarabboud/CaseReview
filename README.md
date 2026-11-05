# Case Review

A phone-friendly app for reading and understanding case law, built around your draft brief.

- **Upload your draft motion** (Word, PDF, or paste it). The app goes through it point by point: each legal proposition, the cases you cited for it, and every `[bracket]` where you still need authority.
- **Pull each case.** The app looks for the full opinion on free sources (CourtListener, Justia, and others). If a case isn't free online, download it from Westlaw and upload the PDF.
- **Read and annotate.** Select text to highlight it (*Important / Helps us / Hurts us / The rule*), add notes, or tap **Explain** to get a plain-English explanation of a term or passage.
- **Break it down.** You get a plain-English walkthrough of the case: the facts, the question, the rule, the reasoning step by step, legal terms defined, a hypothetical, and watch-outs.
- **Ask questions.** Chat about the case. Claude has read the whole opinion and your whole draft.
- **Check support.** For each point, see whether a case supports it (strong, partial, weak, doesn't, or cuts against you), with quotes and suggested wording.
- **Find more cases.** For bracketed points, Claude searches the web for supporting authority in your jurisdiction.
- **Build the paragraph.** Compare the cases for a point, then draft the motion paragraph using only cases you've reviewed.

The instructions for how things get explained are built in, and you can edit them under **Settings → How to explain things to me**.

## Drafting and review

- **Your brief-writing manual** (Settings → Brief-writing manual): upload it once. Every drafting and revision request includes it, as does "Write the paragraph."
- **Draft & review tab** in each project: upload your draft (Word keeps headings, block quotes, and footnotes), use the draft you added to the project, or have Claude write a first draft from your points and research. Every version is saved.
- **Review screen** (a port of ReviewBuddy): one continuous page; tap sentences green/yellow/red, comment, rate each section, add notes. ⚖ shows which case and saved analysis a sentence relies on. Submit → **Send to drafting assistant**.
- **Revisions:** Claude sees the whole brief, your manual, and your research file (every saved breakdown, support check, comparison, highlight, and paragraph), and opens a case's full text only when it must confirm something. It returns targeted edits; the app applies them, so approved (green) sentences stay word-for-word. The new version opens as the next review round, with approvals carried forward.
- **Ask for a change** at any time, see **Changes** (a redline between any two versions), and **Export** to Word (.docx with real footnotes and italic case names) or text.

## Setup (one time)

1. **Turn on GitHub Pages:** in this repo, go to **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, choose the branch that holds this code and the **/(root)** folder, then save. After a minute the app is live at `https://<your-username>.github.io/CaseReview/`. (On a free GitHub plan, Pages requires the repo to be public. That's safe here: no keys or documents are stored in the repo.)
2. **Add it to your home screen:** open that link in Safari (iPhone) and tap **Share → Add to Home Screen**. On Android, use Chrome's menu → **Add to Home screen / Install app**.
3. **Get a Claude API key:** go to [console.anthropic.com](https://console.anthropic.com), add some credit under **Billing** ($10–20 lasts a while), and create a key under **API Keys**. Paste it into the app's **Settings**.
4. **Optional, free:** create a [CourtListener](https://www.courtlistener.com/sign-in/) account and paste your API token (Profile → Developer Tools) into Settings. With it, the app pulls cases faster and checks that suggested citations are real.

## What it costs

You pay Anthropic per use. This is separate from any Claude or Copilot subscription. These are rough figures for the default model (Claude Opus 5.5):

| Action | Approx. cost |
|---|---|
| Go through a 20-page draft | $0.10–0.25 |
| Pull a case through web search (free when CourtListener has it) | $0.05–0.20 |
| Full "break it down" of a 30-page opinion | $0.15–0.30 |
| Each follow-up question on the same case | $0.02–0.06 (the case text is cached) |
| "Find cases that support this" (web research) | $0.20–0.60 |

To cut costs about in half, switch to **Claude Sonnet 5.5** in Settings.

## Good to know

- **Westlaw can't be connected.** Westlaw has no API that individuals can use, so the app can't log in or pull from it for you. It uses free public sources instead, and you can upload a Westlaw PDF any time.
- **Always verify before filing.** Suggested cases come from web searches and are labeled as AI suggestions. Read the case, and KeyCite it on Westlaw before you cite it. Pincites show as `[pin]` when the free copy has no page numbers.
- **Privacy.** Your API key, manual, drafts, every version, reviews, cases, and notes are stored only on your device (the app's browser storage). The review screen is locked so it can't connect to anything; drafting sends the manual, brief, and research file only to Claude's API. Nothing is stored in this GitHub repo. When you ask for an explanation, the relevant text is sent to Anthropic's API, which doesn't train on API data by default. Check your firm's policy on client-confidential material.
- **Back up your work** with Settings → Export backup. Data lives in the browser on your phone, so deleting the home-screen app or clearing Safari data erases it.

## For developers

This is a static site with no build step. `app.js` contains the app logic, `review.html` + `review/` is the review screen, `shared/` holds the brief engine (sentences, sections, edits, redlines), Word import/export, and storage, `vendor/` holds pinned copies of the Anthropic SDK (`@anthropic-ai/sdk@0.137.0`, bundled with esbuild), marked, DOMPurify, mammoth, and pdf.js, and `sw.js` lets the app work offline. To run it locally:

```
python3 -m http.server 8000
node --test tests/brief.test.mjs   # brief engine unit tests
```
