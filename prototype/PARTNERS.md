# PARTNERS

A "partner" is any third-party component, service, dataset or model. **Every one below is pending owner approval
(Jeff).** None is bundled, called or downloaded by this prototype. Licences come from
`/workspace/ideas/tc-integration-findings.md` (researched 2026-10-27); items marked **[unverified]** were not confirmed there.

## Runtime dependencies actually used
**None.** `package.json` has empty `dependencies` and `devDependencies`; a test enforces this. The extractor, HTML parser,
robots.txt parser, diff and hashing are small in-house code. Platform built-ins used (not packages): Node.js `node:sqlite`,
`node:test`, `node:http`, global `fetch`; browser `crypto.subtle`, IndexedDB, `chrome.scripting`/`activeTab`.
Google Chrome is used on this box only to run the optional e2e test (a local tool, not shipped).

## Candidate partners (not used)
| Partner | What for | Licence | Status |
|---------|----------|---------|--------|
| Mozilla Readability (github.com/mozilla/readability) | Better main-text extraction than the built-in extractor | Apache-2.0 | pending owner approval (not bundled) |
| turndown (github.com/mixmark-io/turndown) | HTML to Markdown | MIT | pending owner approval (not used) |
| poppler `pdftotext` (external tool) | PDF text extraction | GPL (external tool only) **[my analysis from findings]** | pending owner approval (not used). **Now actively needed:** the CLI and the extension detect PDFs and mark them "needs pdftotext" (exit 9, `needs_partner = pdftotext`); until approved, PDFs are not read |
| ToS;DR API / data (api.tosdr.org) | Community ratings of terms | Legacy data CC BY-SA 3.0 + AGPL-3.0 "larger program" exception; current API data licence **[unverified]**; their code is AGPL-3.0 | pending owner approval (not used; calling it would send the viewed domain to a third party) |
| Open Terms Archive (opentermsarchive.org) data, read-only lookup | History of documents | Data ODC-By 1.0 (database only, not the underlying text); other collections NOASSERTION, read each LICENSE | pending owner approval (not used) |
| Open Terms Archive engine | Server-side crawler | EUPL-1.2 | pending owner approval (not recommended: stealth plugin and no robots.txt handling found in findings) |
| Chrome built-in Summarizer API (Gemini Nano) | On-device summaries (later phase) | Part of Chrome; triggers a model download | pending owner approval (not used; this phase has no AI) |
| llama.cpp | Local inference (later phase) | MIT | pending owner approval (not used) |
| Ollama | Local inference (later phase) | MIT | pending owner approval (not used) |
| WebLLM | In-browser inference (later phase) | Apache-2.0 | pending owner approval (not used) |
| transformers.js | In-browser inference (later phase) | Apache-2.0 | pending owner approval (not used) |
| Model: Phi-3.5-mini-instruct | Summaries (later phase) | MIT | pending owner approval (no model bundled or downloaded) |
| Model: Qwen2.5-3B-Instruct | Summaries (later phase) | "qwen-research" custom licence, read before use | pending owner approval (no model bundled or downloaded) |

Rules applied: any model download counts as a partner needing Jeff's approval after a licence check; nothing here phones home.
