# Fix report: uploaded files disappear after a restart

**Date:** 2026-11-03 · **Bug:** B1 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md), R1 in [10-status-done-and-remaining.md](10-status-done-and-remaining.md)
**Status:** ✅ Fixed in code. ⚠️ **Takes effect in production only after a storage bucket is connected** (section 5).

---

## 1. What was the issue?

**Simple version:** Bytescon kept every uploaded file in a drawer inside the server. Our hosting company (Render)
empties that drawer every time the server restarts, which on the free plan is many times a day. The database still
said "the file is in the drawer", but the drawer was empty, so the download failed.

**Technical version:**
- Uploads were written by `multer.diskStorage` to `backend/uploads/` (`backend/src/middleware/upload.ts`).
- The server's own generated files were also written there: proposal PDFs, client review packets, anonymized
  templates and files extracted from ZIPs.
- About 25 places read files back from that folder: downloads, AI document analysis, compliance matrix, e-sign,
  pre-submission checks, the partner portal and logos on PDFs.
- Render's disk is temporary and is wiped on every restart and redeploy. Render logs showed 6 restarts on 2026-11-02.
- **Who was affected:** every feature that stores a file.
  - Opportunity documents and RFPs.
  - Contracts.
  - Templates and client documents.
  - Deliverables and client-portal uploads.
  - Proposal attachments and saved proposal PDFs.
  - Submission checklist files.
  - Teaming agreements and past-performance files.
  - Résumés, partner-portal files and e-sign documents.
  - Firm and client logos.
- **What users saw:**
  - "File not found" on download.
  - A missing logo on proposals and the client-portal login page.
  - "Required file is missing" in pre-submission checks.
  - Compliance matrices silently built without the uploaded RFP text.

## 2. How to reproduce it (before the fix, or today in production)

### In the live app
1. Log in at https://bytescon.vercel.app and upload any file, for example a template in the Templates library.
2. Download it straight away. ✅ It works.
3. Wait for the server to restart. On the free plan it sleeps after about 15 minutes idle, and every push to `main`
   redeploys it.
4. Download it again. ❌ You get **"Template file not found"** (HTTP 404).

### Locally, in 2 minutes (no waiting)
1. Start the app ([run-bytescon skill](../.claude/skills/run-bytescon/SKILL.md)) and **do not** set
   `UPLOADS_S3_BUCKET`.
2. Upload a template.
3. Delete the file from `backend/uploads/`. This is exactly what a Render restart does.
4. Download the template. ❌ **HTTP 404 "Template file not found"**.

This was run on 2026-11-03 and returned exactly that 404.

## 3. What was changed

The local folder is now only a **cache**. The real copy of every file lives in a cloud **bucket**: Cloudflare R2,
AWS S3, or anything S3-compatible.

| When | What happens now |
|------|------------------|
| A user uploads a file | Saved to disk **and** to the bucket before the request continues. If the bucket can't be reached, the upload is refused (HTTP 500), so it is never "accepted" and then lost |
| The server generates a file (PDF, anonymized copy, ZIP contents) | Same: saved to disk and the bucket |
| Any feature reads a file that's missing on disk | It's downloaded from the bucket first, then used as before |
| A file is deleted | Removed from disk and the bucket |
| No bucket is configured | Behaves exactly as before. This is fine for local development; in production the server logs a warning at startup |

**Code:**
- New `backend/src/services/fileStorage.ts`, the one place that knows where files live:
  - `restoreUpload` brings a file back from the bucket;
  - `writeUpload` saves a file the server generated;
  - `persistUpload` copies a file to the bucket;
  - `removeUpload` deletes from disk and bucket.
- `backend/src/middleware/upload.ts`: every multer upload also goes to the bucket.
- Download and read sites switched to `restoreUpload`:
  - 15 route files;
  - 2 workers;
  - the PDF builder;
  - pre-submission validation;
  - the partner-portal file helper;
  - the public logo route in `server.ts`.
- **Unchanged:** security checks, including tenant scoping, the authorize-then-read rule and path-traversal guards.
  Keys that try to escape the uploads folder are refused.
- New dependency: `@aws-sdk/client-s3`.
- New settings, documented in `backend/.env.example` and `.env.prod.example`:
  - `UPLOADS_S3_BUCKET`
  - `UPLOADS_S3_ENDPOINT`
  - `UPLOADS_S3_REGION`
  - `UPLOADS_S3_ACCESS_KEY_ID`
  - `UPLOADS_S3_SECRET_ACCESS_KEY`
  - optionally `UPLOADS_S3_PREFIX`

## 4. How to test it

### A. Automated tests (any time)
```bash
cd backend && npx vitest run src/services/fileStorage.unit.test.ts   # 14 tests, no network needed
cd backend && npm test                                               # full suite
```
The new tests use an in-memory stand-in for the bucket. They cover:
- **Restore:** a file is restored after the disk copy is wiped.
- **The original bug:** the same flow fails without a bucket.
- **Failed bucket write:** the upload is refused and nothing is left on disk.
- **Bucket outage on read:** the file is reported missing; the app doesn't crash.
- **Path traversal:** such keys are refused.
- **Partner-portal downloads:** they still send their `no-store` security headers.

**Result on 2026-11-03:** 14/14 new tests passed, the full backend suite passed 4,336/4,336, and type-check was clean.

### B. Real end-to-end check (done on 2026-11-03 against a local S3 server)
1. Start a throwaway S3-compatible server:
   ```bash
   docker run -d --rm --name s3-test -p 19090:9090 -e initialBuckets=bytescon-uploads adobe/s3mock:3.12.0
   ```
2. Start the backend with:
   ```
   UPLOADS_S3_BUCKET=bytescon-uploads UPLOADS_S3_ENDPOINT=http://localhost:19090 UPLOADS_S3_REGION=us-east-1 UPLOADS_S3_ACCESS_KEY_ID=x UPLOADS_S3_SECRET_ACCESS_KEY=y
   ```
   The startup log shows `File storage: local cache + bucket`.
3. Upload a template, then delete its file from `backend/uploads/`.
4. Download it. ✅ **HTTP 200** with the original content, and the file is back in `backend/uploads/`.
5. Stop the test server: `docker stop s3-test`.

### C. In production, once the bucket is connected (section 5)
1. Upload a template, then download it. ✅
2. In the Render dashboard, open `bytescon-api` → **Manual Deploy → Restart service**. This wipes the disk.
3. Download the same template. ✅ It must still work.
4. Optional: confirm the file appears under `uploads/` in the bucket's file browser.

## 5. What's needed to switch it on in production (owner action)

The code is live after the push, but production has **no bucket yet**, so it behaves as before. The startup log
says so. To turn the fix on:

1. **Create a bucket.** Cloudflare R2 is recommended: there are no download (egress) fees, and the free tier
   includes 10 GB. In Cloudflare go to **R2 → Create bucket**, for example `bytescon-uploads`, and keep it
   **private**.
2. **Create an API token.** Go to **R2 → Manage API tokens → Create**, choose "Object Read & Write" scoped to that
   bucket, and copy the Access Key ID and Secret.
3. **Add these settings** in Render → `bytescon-api` → **Environment**:

   | Variable | Value |
   |---|---|
   | `UPLOADS_S3_BUCKET` | `bytescon-uploads` |
   | `UPLOADS_S3_ENDPOINT` | `https://<your-account-id>.r2.cloudflarestorage.com` |
   | `UPLOADS_S3_REGION` | `auto` |
   | `UPLOADS_S3_ACCESS_KEY_ID` | from step 2 |
   | `UPLOADS_S3_SECRET_ACCESS_KEY` | from step 2 |

4. Save. Render redeploys, and the log line should read `File storage: local cache + bucket`.
5. Run test C above.

## 6. Known limits

- **Files lost before the bucket is connected can't be recovered.** They're already gone. Users must re-upload them.
- **Winners Intel data files** (`uploads/winners/`) are not covered. They are generated data, not user uploads, and
  are rebuilt by their sync job.
- **The disk copy is a cache with no size limit.** On a small, temporary disk this is fine, because restarts clear
  it.
- **Node version:** AWS SDK releases after January 2027 require Node 22, and the backend runs Node 20. The lockfile
  pins the current version, so nothing breaks now. Upgrade the backend to Node 22 before upgrading the SDK.

## 7. Re-validation (2026-11-04)

**Independent code review:** fully fixed. Every read, write, delete and serve of `uploads/` goes through the storage
module or uses a file that was just uploaded. Path traversal is safe.

**Live check against a local S3 server:**
- **Template:** uploaded, wiped from disk, and downloaded byte-identical (HTTP 200).
- **Client document:** the same, and deleting it removed it from **both** disk and bucket.
- **Public logo:** uploaded, wiped, and served byte-identical.

**Hardening added on 2026-11-04** (`backend/src/server.ts`):
- **Bucket lookups:** the public logo route only looks up names in the server's own upload format, so anonymous
  requests for made-up names never reach the bucket.
- **Status codes:** a missing logo now returns **404**, and a refused path such as `..%2F..%2F.env` returns **403**.
  Both used to return **500**. This was an older bug, from the route's `fallthrough: false` setting.

**Known, not changed:**
- **Orphaned uploads:** when a route rejects a request *after* the upload, its bucket copy is left behind. This is a
  storage-cost and retention issue, not a correctness one.
- **No backfill:** files on disk from before the bucket is connected are not copied to it.
