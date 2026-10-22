/**
 * CLEARLY LABELLED DEFECT: BASELINE IMPLEMENTATION
 * 
 * Defects:
 * 1. Missing payload validation.
 * 2. N+1 database queries (one SELECT per item in loop).
 * 3. Serial, unbatched external HTTP calls for every item.
 * 4. Missing database transaction (each INSERT auto-commits individually, violating atomicity).
 * 5. Intra-batch duplicates cause unnecessary queries and potential race conditions.
 */

const express = require('express');
const { db } = require('./db');
const { enrichSingleLead, getExternalCallCount, resetExternalCallCount } = require('./enrichment');

const app = express();
app.use(express.json());

app.post('/api/leads/ingest', async (req, res) => {
  const startDbQueries = db.queryCount;
  const startExternalCalls = getExternalCallCount();

  const leads = req.body && req.body.leads ? req.body.leads : [];
  const totalReceived = leads.length;

  let skippedExisting = 0;
  let inserted = 0;

  // Anti-pattern: Iterating sequentially with per-item queries and unbatched network requests
  for (const lead of leads) {
    if (!lead || !lead.email) {
      continue;
    }

    // Per-item SELECT query
    const existing = db
      .prepare('SELECT id FROM leads WHERE email = ?')
      .get(lead.email);

    if (existing) {
      skippedExisting++;
      continue;
    }

    // Per-item unbatched external call
    const enrichment = await enrichSingleLead(lead.email);

    // Per-item un-transactioned INSERT
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

  const dbQueries = db.queryCount - startDbQueries;
  const externalCalls = getExternalCallCount() - startExternalCalls;

  return res.status(200).json({
    status: 'ok',
    total_received: totalReceived,
    skipped_existing: skippedExisting,
    inserted: inserted,
    metrics: {
      db_queries: dbQueries,
      external_calls: externalCalls,
    },
  });
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Baseline server running on port ${PORT}`);
  });
}

module.exports = app;
