const { performance } = require('perf_hooks');
const request = require('supertest');
const { db, seedDatabase } = require('../src/db');
const { resetExternalCallCount } = require('../src/enrichment');

// Determine execution mode from environment
const mode = (process.env.MODE || 'optimized').toLowerCase();
const app =
  mode === 'baseline'
    ? require('../src/server.baseline')
    : require('../src/server');

function generatePayload(iteration) {
  const leads = [];

  // 25 existing emails from initial database seed
  for (let i = 1; i <= 25; i++) {
    leads.push({
      email: `user${i}@example.com`,
      name: `User ${i}`,
      company: `Company ${((i - 1) % 50) + 1}`,
    });
  }

  // 25 net-new emails unique to this iteration
  for (let i = 1; i <= 25; i++) {
    leads.push({
      email: `new_lead_iter${iteration}_${i}@example.com`,
      name: `New Lead ${i}`,
      company: `Startup ${i}`,
    });
  }

  // 2 intra-batch duplicate emails
  leads.push({
    email: `new_lead_iter${iteration}_1@example.com`,
    name: `New Lead 1 Duplicate A`,
    company: `Startup 1 Dup`,
  });
  leads.push({
    email: `new_lead_iter${iteration}_2@example.com`,
    name: `New Lead 2 Duplicate B`,
    company: `Startup 2 Dup`,
  });

  return leads;
}

function calculateP95(latencies) {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runBenchmark() {
  console.log(`\n============================================================`);
  console.log(` Starting Benchmark: MODE = ${mode.toUpperCase()}`);
  console.log(` Iterations: 5 | Batch Size: 52 leads (25 existing, 25 new, 2 duplicates)`);
  console.log(`============================================================\n`);

  // Seed baseline 500 records
  seedDatabase(db);
  resetExternalCallCount();
  db.resetQueryCount();

  const iterations = 5;
  const latencies = [];
  const dbQueriesList = [];
  const externalCallsList = [];

  for (let i = 1; i <= iterations; i++) {
    const payload = { leads: generatePayload(i) };

    const start = performance.now();
    const response = await request(app)
      .post('/api/leads/ingest')
      .send(payload);
    const duration = performance.now() - start;

    if (response.status !== 200) {
      console.error(`Iteration ${i} failed with status ${response.status}:`, response.body);
      process.exit(1);
    }

    latencies.push(duration);
    dbQueriesList.push(response.body.metrics.db_queries);
    externalCallsList.push(response.body.metrics.external_calls);

    console.log(
      `Iteration ${i}: ${duration.toFixed(2)} ms | DB Queries: ${response.body.metrics.db_queries} | External Calls: ${response.body.metrics.external_calls} | Inserted: ${response.body.inserted}`
    );
  }

  const meanLatency = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);
  const p95Latency = calculateP95(latencies);
  const meanDbQueries =
    dbQueriesList.reduce((sum, val) => sum + val, 0) / dbQueriesList.length;
  const meanExternalCalls =
    externalCallsList.reduce((sum, val) => sum + val, 0) / externalCallsList.length;

  // Unit cost estimation formula:
  // Assumes $0.001 per DB query + $0.005 per external enrichment API call
  const costPerRequest = meanDbQueries * 0.001 + meanExternalCalls * 0.005;
  const costPer1kRequests = costPerRequest * 1000;

  console.log('\n### Benchmark Results (Markdown Format)\n');
  console.log(`| Metric | Value (${mode.toUpperCase()} Mode) | Unit / Details |`);
  console.log(`|---|---|---|`);
  console.log(`| **Iterations** | ${iterations} | Iterations executed |`);
  console.log(`| **Batch Size per Request** | 52 leads | 25 existing + 25 new + 2 duplicates |`);
  console.log(`| **Mean Execution Time** | ${meanLatency.toFixed(2)} ms | Average wall-clock latency |`);
  console.log(`| **Max Latency** | ${maxLatency.toFixed(2)} ms | Worst single request latency |`);
  console.log(`| **p95 Latency** | ${p95Latency.toFixed(2)} ms | 95th percentile latency |`);
  console.log(`| **Measured DB Queries / req** | ${meanDbQueries.toFixed(1)} | sqlite .prepare() & .exec() calls |`);
  console.log(`| **Measured External API Calls / req** | ${meanExternalCalls.toFixed(1)} | External enrichment calls |`);
  console.log(`| **Estimated Unit Cost / 1k requests** | $${costPer1kRequests.toFixed(3)} | Estimated assuming $0.001/query + $0.005/external call |`);
  console.log(`\n============================================================\n`);
}

runBenchmark().catch((err) => {
  console.error('Benchmark execution error:', err);
  process.exit(1);
});
