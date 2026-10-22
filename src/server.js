const express = require('express');
const { db } = require('./db');
const {
  enrichLeadBatch,
  enrichSingleLead,
  getExternalCallCount,
} = require('./enrichment');

const app = express();
app.use(express.json());

// Email validation helper: non-empty string with standard email format
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed);
}

app.post('/api/leads/ingest', async (req, res, next) => {
  const startDbQueries = db.queryCount;
  const startExternalCalls = getExternalCallCount();

  // Mode check: support routing to baseline if explicitly requested via header or env
  const isBaselineMode =
    process.env.MODE === 'baseline' || req.headers['x-mode'] === 'baseline';

  if (isBaselineMode) {
    const leads = req.body && req.body.leads ? req.body.leads : [];
    const totalReceived = leads.length;
    let skippedExisting = 0;
    let inserted = 0;

    for (const lead of leads) {
      if (!lead || !lead.email) continue;
      const existing = db
        .prepare('SELECT id FROM leads WHERE email = ?')
        .get(lead.email);

      if (existing) {
        skippedExisting++;
        continue;
      }

      const enrichment = await enrichSingleLead(lead.email);
      db.prepare(`
        INSERT INTO leads (email, name, company, enriched_score, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        lead.email,
        lead.name || null,
        lead.company || null,
        enrichment.score,
        new Date().toISOString()
      );
      inserted++;
    }

    return res.status(200).json({
      status: 'ok',
      total_received: totalReceived,
      skipped_existing: skippedExisting,
      inserted: inserted,
      metrics: {
        db_queries: db.queryCount - startDbQueries,
        external_calls: getExternalCallCount() - startExternalCalls,
      },
    });
  }

  // Idempotency check (ready for handoff exercise)
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey) {
    const cached = db
      .prepare('SELECT response_json FROM idempotency_keys WHERE key = ?')
      .get(idempotencyKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached.response_json));
    }
  }

  try {
    // a) Validate payload
    const { leads } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({
        error: 'Invalid payload: "leads" must be a non-empty array',
      });
    }

    for (const lead of leads) {
      if (!lead || !isValidEmail(lead.email)) {
        return res.status(400).json({
          error: 'Invalid payload: each lead must contain a valid email string',
        });
      }
    }

    const totalReceived = leads.length;

    // b) Deduplicate incoming leads by lowercase email in memory
    const uniqueLeadsMap = new Map();
    for (const lead of leads) {
      const normalizedEmail = lead.email.toLowerCase().trim();
      if (!uniqueLeadsMap.has(normalizedEmail)) {
        uniqueLeadsMap.set(normalizedEmail, {
          ...lead,
          email: normalizedEmail,
        });
      }
    }

    const uniqueEmails = Array.from(uniqueLeadsMap.keys());

    // c) Execute 1 batched query: SELECT email FROM leads WHERE email IN (...)
    const placeholders = uniqueEmails.map(() => '?').join(',');
    const existingRows = db
      .prepare(`SELECT email FROM leads WHERE email IN (${placeholders})`)
      .all(...uniqueEmails);

    const existingEmailSet = new Set(
      existingRows.map((row) => row.email.toLowerCase())
    );

    // d) Filter down to only net-new emails
    const newEmails = uniqueEmails.filter(
      (email) => !existingEmailSet.has(email)
    );
    const newLeads = newEmails.map((email) => uniqueLeadsMap.get(email));

    // e) Call enrichLeadBatch(newEmails, 10) with bounded concurrency
    const scoreMap = new Map();
    if (newEmails.length > 0) {
      const batchResults = await enrichLeadBatch(newEmails, 10);
      for (const item of batchResults) {
        scoreMap.set(item.email, item.score);
      }
    }

    // f) Wrap all inserts in a single atomic db.transaction(...) block
    let insertedCount = 0;
    if (newLeads.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO leads (email, name, company, enriched_score, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const executeInserts = db.transaction((leadsToInsert) => {
        const now = new Date().toISOString();
        for (const item of leadsToInsert) {
          const score = scoreMap.get(item.email) ?? null;
          insertStmt.run(
            item.email,
            item.name || null,
            item.company || null,
            score,
            now
          );
          insertedCount++;
        }
      });

      executeInserts(newLeads);
    }

    // g) Calculate metrics and return response
    const skippedExisting = totalReceived - insertedCount;
    const dbQueries = db.queryCount - startDbQueries;
    const externalCalls = getExternalCallCount() - startExternalCalls;

    const responsePayload = {
      status: 'ok',
      total_received: totalReceived,
      skipped_existing: skippedExisting,
      inserted: insertedCount,
      metrics: {
        db_queries: dbQueries,
        external_calls: externalCalls,
      },
    };

    // Store idempotency key if present
    if (idempotencyKey) {
      db.prepare(`
        INSERT INTO idempotency_keys (key, response_json, created_at)
        VALUES (?, ?, ?)
      `).run(idempotencyKey, JSON.stringify(responsePayload), Date.now());
    }

    return res.status(200).json(responsePayload);
  } catch (err) {
    return res.status(500).json({
      error: 'Ingestion failed',
      details: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ingest service running on port ${PORT}`);
  });
}

module.exports = app;
