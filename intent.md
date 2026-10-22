# Intent & Problem Prioritization (`intent.md`)

> **Provenance & Data Disclosure:** This repository, service, and benchmark dataset were created specifically for this Quest using synthetic data (`user1@example.com`–`user500@example.com`). No confidential employer code, live customer data, or credentials are included. Total focused effort across service setup, refactoring, verification, and documentation: **6.5 hours**.

---

## 1. Why This Problem? (Context & Affected Users)
The system under evaluation is a **Webhook Lead Ingestion Microservice** (`POST /api/leads/ingest`) that receives batches of up to 50 B2B leads from upstream webhook providers, checks whether each lead already exists, enriches net-new leads via an external scoring service, and writes them to SQLite.

- **Affected Users & Systems:**
  1. **Upstream Webhook Producers & End Users:** Experience slow webhook acknowledgments (`>900ms` p95 latency for 50 leads), risking 1-second webhook delivery timeouts and retry storms.
  2. **Product Engineers On-Call:** Inherit fragile, AI-generated loop code where validation, database reads, external network calls, and database writes are interleaved inside a single `for...of` loop—causing partial state corruption whenever an error occurs mid-batch.

---

## 2. Comparison of Candidate Problems & Prioritization Matrix

We evaluated three recurring quality and maintainability problems in the ingestion codebase. Each candidate was scored from `1` (Low) to `5` (Critical) across the three required dimensions: **User Impact (40% weight)**, **Maintenance Effort / Cognitive Debt (35% weight)**, and **Operating / Infrastructure Cost (25% weight)**.

| Problem Candidate | Baseline Evidence (Measured on 50-Lead Batch) | User Impact (40%) | Maintenance Effort (35%) | Operating Cost (25%) | Weighted Score (out of 5.0) | Priority & Decision |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **Problem 1: Sequential N+1 DB Queries, Unbatched Enrichment & Non-Atomic Writes** | **Measured:** `77 DB queries` and `25 sequential network calls` per 50-lead batch; mean latency `822.08 ms` (`p95 902.72 ms`); partial rows remain committed if row #26 fails. | **5 / 5** (Timeouts & partial data corruption) | **5 / 5** (Interleaved I/O in loop; high cognitive load) | **5 / 5** ($O(N)$ DB & API calls per request) | **5.00 / 5.0** | **Ranked #1 — Selected for Quest Fix** |
| **Problem 2: Missing Request-Level Idempotency (`X-Idempotency-Key`)** | **Measured:** Replaying an identical 50-lead webhook re-executes all `SELECT` checks instead of returning a cached acknowledgement. | **3 / 5** (Duplicate compute on webhook retries) | **2 / 5** (Isolated middleware/table check) | **3 / 5** (Redundant read queries on retry) | **2.65 / 5.0** | **Ranked #2 — Scoped as Handoff Exercise** |
| **Problem 3: Permissive Email Format Validation** | **Measured:** Simple string check allows edge-case malformed domains (e.g., `user@localhost`) into the table. | **2 / 5** (Minor downstream sync rejections) | **1 / 5** (Single helper function) | **1 / 5** (Negligible storage impact) | **1.40 / 5.0** | **Ranked #3 — Out of Scope (Will Not Change)** |

---

## 3. Why Problem 1 Ranked First & Intended Value
Problem 1 is the textbook failure mode of unguided AI code generation: an AI assistant asked to *"build an endpoint that checks if leads exist, enriches new ones, and saves them"* defaults to an imperative `for...of` loop with `await` inside. It passes trivial 1-item unit tests, but creates three compounding production risks:
1. **Linear Latency Degradation ($O(N)$ I/O):** Latency scales directly with payload size.
2. **Non-Atomic Failure State:** If lead #20 triggers a constraint violation, leads #1–19 remain committed while the webhook returns HTTP 500, causing inconsistent state on retry.
3. **High Cost per Change:** Engineers modifying validation, enrichment, or persistence must untangle a single monolithic loop.

**Intended Value of the Fix:**
- Collapse database operations from $2N + 1$ (`77 queries` for 50 items) to a constant **$O(1)$ batch pattern (`2 operations` total)**: one batched `SELECT ... WHERE email IN (...)` and one atomic `db.transaction()` batch insert.
- Reduce external enrichment calls from $N$ sequential calls to bounded chunks of 10.
- Cut steps required to modify a pipeline stage from **4 interleaved loop touchpoints** to **1 isolated step**.

---

## 4. Explicit Non-Goals (What We Will Not Change)
To keep the change focused, reviewable, and low-risk, we explicitly will **not** change:
1. **External HTTP Request/Response Contract:** Upstream callers send the exact same JSON body (`{ leads: [...] }`) and receive the same core status fields.
2. **Storage Engine Migration:** We will not replace SQLite with PostgreSQL or introduce Redis/BullMQ background workers; the architectural fix is achieved via query batching and transactional boundaries.
3. **Problem 3 (RFC-5322 Email Regex Overhaul):** Excluded to prevent scope creep and keep the diff focused strictly on batch I/O, atomicity, and workflow repeatability.
