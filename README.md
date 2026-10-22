# MUST Company Quest: High-Throughput Lead Ingestion Microservice

Production-grade, resilient lead ingestion microservice built with Node.js, Express, and `better-sqlite3`.

---

## 🚀 Quickstart & Reproduction Steps

Run the entire suite with these 3 exact commands:

```bash
# 1. Install dependencies
npm install

# 2. Run unit and integration tests
npm test

# 3. Run side-by-side performance & unit cost benchmarks
npm run benchmark:baseline && npm run benchmark:optimized
```

---

## 📊 Architectural Defect Analysis: Baseline vs. Refactored

### Baseline Anti-Patterns (`src/server.baseline.js`)
1. **N+1 Database Queries**: Sequential `SELECT id FROM leads WHERE email = ?` query executed inside a `for...of` loop for every single inbound lead (50+ queries per request).
2. **Serial Network Saturation**: Unbatched HTTP lookups (`await enrichSingleLead(email)`) invoked per item with 20ms round-trip latency, choking Node.js event-loop throughput.
3. **No Database Transactions**: Each `INSERT INTO leads ...` auto-commits individually. If the process crashes or a constraint fails at item 45/50, partial corrupted data is committed.
4. **No In-Memory Deduplication**: Intra-batch duplicate records trigger duplicate SELECT checks and duplicate external API calls.
5. **Missing Request Validation**: Ingests malformed payloads without schema verification.

### Refactored High-Performance Pipeline (`src/server.js`)
1. **Zero-Cost Payload Guard**: Validates structure and email formats immediately; rejects malformed requests with `HTTP 400` and 0 database writes.
2. **In-Memory Deduplication**: Normalizes lowercase emails into a deduplicated `Map` in $O(N)$ time before any database interaction.
3. **Single Batched Query**: Issues exactly 1 batched lookup: `SELECT email FROM leads WHERE email IN (...)` using dynamic SQL placeholders.
4. **Chunked Enrichment with Bounded Concurrency**: `enrichLeadBatch(newEmails, 10)` bundles lookups into batches of 10 items processed via controlled concurrency workers.
5. **Atomic Transaction Guarantees**: Inserts all verified, enriched leads inside a single `db.transaction(...)` block. Rolls back completely (0 rows committed) if any error occurs.
6. **Query & Cost Cap**: Limits database query preparations to $\le 2$ queries per batch request regardless of batch size.

---

## 📈 Benchmark Comparison

Benchmark configuration: 5 iterations of 52 leads per request (25 existing seeded leads, 25 net-new leads, and 2 intra-batch duplicates).

Estimated unit cost assumes:
- **$0.001** per database query
- **$0.005** per external enrichment call

| Metric | Baseline Mode | Optimized Mode | Improvement |
|---|---|---|---|
| **DB Queries / Request** | ~75 queries | **2 queries** | **97.3% reduction** |
| **External Calls / Request** | ~25 calls | **3 calls** | **88.0% reduction** |
| **Average Latency** | ~550 ms | **~35 ms** | **~15x faster** |
| **Estimated Cost / 1k Requests** | **$200.00** | **$17.00** | **91.5% cost savings** |

---

## 🛠️ Project Structure

```text
├── package.json               # Scripts & dependencies (express, better-sqlite3, jest, supertest)
├── .npmrc                     # Shell configuration for cross-platform POSIX script execution
├── src/
│   ├── db.js                  # In-memory SQLite with seedDatabase and queryCount tracker
│   ├── enrichment.js          # Single and batched enrichment simulators (20ms/item vs 25ms/batch)
│   ├── server.js              # Refactored production Express microservice (atomic, batched)
│   └── server.baseline.js     # Unoptimized baseline with clearly labeled defects
├── scripts/
│   └── benchmark.js           # 5-iteration benchmark measuring latency, queries, calls, & cost
└── tests/
    └── ingest.test.js         # Jest + Supertest test suite (mixed batch, validation, atomic rollback)
```

---

## 🧩 Handoff Exercise: Idempotency Key Caching

The `idempotency_keys` table schema is pre-provisioned in `src/db.js`:
```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  response_json TEXT,
  created_at INTEGER
);
```

To complete the handoff exercise:
1. Open `tests/ingest.test.js`.
2. Change `test.skip('Handoff Exercise: X-Idempotency-Key...', ...)` to `test('Handoff Exercise: X-Idempotency-Key...', ...)`.
3. Verify that requests carrying `X-Idempotency-Key` return identical cached payloads within 1 single database lookup without re-enriching or re-inserting leads.
