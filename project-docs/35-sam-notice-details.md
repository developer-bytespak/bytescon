# 35 — What Bytescon brings in from a SAM.gov notice

Who this is for: founders and developers. It covers which SAM.gov details Bytescon keeps and shows, how a notice's full description and solicitation documents arrive, and what still needs a person.

Code wins if it disagrees with this page. Main places:
- **Backend:**
  - `backend/src/services/samApi.ts` (the import);
  - `backend/src/services/samNoticeDetails.ts` (what the opportunity page gets);
  - `backend/src/services/samAttachmentImport.ts` (solicitation documents);
  - `backend/src/gb107/` (the description fetcher).
- **Frontend:** `frontend/src/pages/OpportunityDetail.tsx`, and the Compliance Matrix tab in `frontend/src/pages/ProposalWorkspace.tsx`.

---

## 1. Kept from the search result (no extra SAM.gov calls)

| SAM.gov field | Kept as | Shown on the opportunity page |
|---|---|---|
| Title, agency, NAICS, set-aside, response deadline, notice link | as before | as before |
| Solicitation number, notice type, posted date, PSC | as before | **Notice details** row (new) |
| Place of performance | `placeOfPerformance`, e.g. "Dallas, TX 75201" (new) | Place of Performance card |
| Points of contact | `pointOfContact` (new) | Contracting Officer panel: the primary contact |
| Attachment links | `resourceLinks` (new) | **Solicitation documents on SAM.gov**, as links (any `api_key` removed) |
| Description | only a **link** to the text | see §2 |

Notices imported before this change get these fields the next time the import sees them. Demo accounts copy them from the shared pool.

## 2. The full description

SAM.gov's search result has no description text, only a link to it. The fetcher (GB-107) swaps in the real text:
- **Background:** a batch every 6 hours, closest deadlines first.
- **On open (new):** opening a notice that still has only the link queues it, and the fetcher drains its queue every minute.

A notice is queued **once**. One that SAM.gov had no description for, or that failed, isn't retried on every view. Nothing is queued without a SAM.gov key.

The page never shows the raw link as a description. It says the text is being fetched, refreshes itself for about 5 minutes, then says it may be waiting on today's SAM.gov limit, or that SAM.gov has none. Either way it links to SAM.gov.

Everything shares the SAM.gov key's daily allowance, about 1,000 calls for a personal key; the fetcher keeps to 900. When SAM.gov answers 429, the fetcher stops for the day and queued notices wait until tomorrow.

**Fixed with this work:** an empty `ENRICHMENT_NOTICEDESC_URL=` (as in `.env.example`) used to be taken as the URL, so every fetch failed with "Invalid URL". An empty value now means SAM.gov's default.

## 3. Solicitation documents

**Starting a proposal** brings in the documents SAM.gov lists for the notice, in the background. **Get solicitation documents from SAM.gov (N)** on the Compliance Matrix tab does it on demand and reports each file.

Each file is added exactly as a person's upload would be: stored through `fileStorage`, with the solicitation-document event recorded.

| File | What happens |
|---|---|
| PDF | Added and queued for requirement extraction. Its requirements land in the Compliance Matrix **unverified**. |
| Word, Excel, other | Added, marked **Not read (PDFs only)**. Add their requirements by hand. |
| Restricted by SAM.gov (401/403, often controlled or export-controlled) | Not added: "download it from SAM.gov and upload it here". |
| Over 25 MB, or download failed | Not added, with the same advice. |
| Already added (same file name) | Skipped. |

At most 10 files per notice. SAM.gov's public file links usually need no key; the key is added only if a file is refused without it.

## 4. Still a person's job

- **Verify** extracted requirements. **Verify all (N)** verifies every unverified one at once after a confirmation; rejected ones stay rejected.
- Upload restricted files, and enter requirements from files that aren't PDFs.

## 5. Checking it

- **Tests:**
  - backend: `samNoticeDetails.test.ts`, `samAttachmentImport.integration.test.ts`, `opportunityDescriptionFetch.integration.test.ts`, `gb107/config.gb107.test.ts`, `samApiPaging.integration.test.ts`, `proposal.test.ts`;
  - frontend: `ProposalWorkspace.compliance.test.tsx`.
- **Checked locally 2026-11-13:** a real queued notice was picked up within 15 seconds. The first try failed on the empty-URL bug above. After the fix SAM.gov was reached, but answered 429 because the key's daily limit was used up. Not yet seen: a successful description fetch and a real attachment download, which need a day with allowance left.
