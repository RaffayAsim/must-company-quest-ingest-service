const request = require('supertest');
const app = require('../src/server');
const { db, seedDatabase } = require('../src/db');
const { resetExternalCallCount } = require('../src/enrichment');

describe('POST /api/leads/ingest Test Suite', () => {
  beforeEach(() => {
    seedDatabase(db);
    resetExternalCallCount();
    db.resetQueryCount();
  });

  test('Test 1: Ingests mixed batch (existing + new + intra-batch duplicate) accurately and asserts db_queries <= 2', async () => {
    // 5 existing leads (seeded: user1@example.com to user5@example.com)
    const existingLeads = [
      { email: 'user1@example.com', name: 'User 1', company: 'Company 1' },
      { email: 'user2@example.com', name: 'User 2', company: 'Company 2' },
      { email: 'user3@example.com', name: 'User 3', company: 'Company 3' },
      { email: 'user4@example.com', name: 'User 4', company: 'Company 4' },
      { email: 'user5@example.com', name: 'User 5', company: 'Company 5' },
    ];

    // 5 brand new leads
    const newLeads = [
      { email: 'fresh_lead_1@example.com', name: 'Fresh 1', company: 'Acme 1' },
      { email: 'fresh_lead_2@example.com', name: 'Fresh 2', company: 'Acme 2' },
      { email: 'fresh_lead_3@example.com', name: 'Fresh 3', company: 'Acme 3' },
      { email: 'fresh_lead_4@example.com', name: 'Fresh 4', company: 'Acme 4' },
      { email: 'fresh_lead_5@example.com', name: 'Fresh 5', company: 'Acme 5' },
    ];

    // 2 intra-batch duplicates of new leads (with casing variation to test normalization)
    const duplicates = [
      { email: 'FRESH_LEAD_1@example.com', name: 'Fresh 1 Duplicate', company: 'Acme 1' },
      { email: 'fresh_lead_2@example.com', name: 'Fresh 2 Duplicate', company: 'Acme 2' },
    ];

    const batch = [...existingLeads, ...newLeads, ...duplicates];
    expect(batch.length).toBe(12);

    const response = await request(app)
      .post('/api/leads/ingest')
      .send({ leads: batch });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.total_received).toBe(12);
    expect(response.body.inserted).toBe(5);
    expect(response.body.skipped_existing).toBe(7); // 5 existing + 2 intra-batch duplicates

    // Critical architectural assertion: batched SELECT + batched transactional INSERT
    expect(response.body.metrics.db_queries).toBeLessThanOrEqual(2);

    // Verify persisted rows in SQLite
    for (const lead of newLeads) {
      const row = db
        .prepare('SELECT email, enriched_score FROM leads WHERE email = ?')
        .get(lead.email);
      expect(row).toBeDefined();
      expect(row.email).toBe(lead.email);
      expect(typeof row.enriched_score).toBe('number');
    }
  });

  test('Test 2: Rejects malformed payloads with HTTP 400 and 0 DB writes', async () => {
    const initialCount = db
      .prepare('SELECT count(*) as count FROM leads')
      .get().count;

    const malformedPayloads = [
      {}, // missing leads property
      { leads: [] }, // empty leads array
      { leads: 'not-an-array' }, // invalid type
      { leads: [{ name: 'Missing Email' }] }, // item without email
      { leads: [{ email: 'not-a-valid-email' }] }, // invalid email string
      { leads: [{ email: '' }] }, // empty email
      { leads: [{ email: '   ' }] }, // whitespace only
      { leads: [{ email: null }] }, // null email
    ];

    for (const payload of malformedPayloads) {
      const res = await request(app)
        .post('/api/leads/ingest')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();

      // Verify zero database writes occurred
      const currentCount = db
        .prepare('SELECT count(*) as count FROM leads')
        .get().count;
      expect(currentCount).toBe(initialCount);
    }
  });

  test('Test 3: Atomic rollback verification — if a lead mid-batch violates a constraint or throws during insert, 0 rows from that batch are persisted', async () => {
    const initialCount = db
      .prepare('SELECT count(*) as count FROM leads')
      .get().count;

    // Install a SQLite trigger that fails specifically on a designated error email
    db.exec(`
      CREATE TRIGGER fail_mid_batch
      BEFORE INSERT ON leads
      WHEN NEW.email = 'trigger_error_lead@example.com'
      BEGIN
        SELECT RAISE(ABORT, 'Simulated mid-batch DB constraint violation');
      END;
    `);

    const atomicBatch = [
      { email: 'atomic_lead_before_1@example.com', name: 'Before 1' },
      { email: 'atomic_lead_before_2@example.com', name: 'Before 2' },
      { email: 'trigger_error_lead@example.com', name: 'Fail Lead' }, // causes SQLite ABORT mid-transaction
      { email: 'atomic_lead_after_1@example.com', name: 'After 1' },
    ];

    const response = await request(app)
      .post('/api/leads/ingest')
      .send({ leads: atomicBatch });

    // Expect server error due to transaction failure
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Ingestion failed');

    // Clean up trigger
    db.exec('DROP TRIGGER IF EXISTS fail_mid_batch;');

    // Verify 0 rows from the entire batch were persisted (full atomic rollback)
    const countAfter = db
      .prepare('SELECT count(*) as count FROM leads')
      .get().count;
    expect(countAfter).toBe(initialCount);

    const checkBefore1 = db
      .prepare('SELECT id FROM leads WHERE email = ?')
      .get('atomic_lead_before_1@example.com');
    const checkBefore2 = db
      .prepare('SELECT id FROM leads WHERE email = ?')
      .get('atomic_lead_before_2@example.com');
    const checkAfter1 = db
      .prepare('SELECT id FROM leads WHERE email = ?')
      .get('atomic_lead_after_1@example.com');

    expect(checkBefore1).toBeUndefined();
    expect(checkBefore2).toBeUndefined();
    expect(checkAfter1).toBeUndefined();
  });

  test('Handoff Exercise: X-Idempotency-Key returns cached response in 1 query', async () => {
    const idempotencyKey = 'idemp-key-test-abc-123';
    const payload = {
      leads: [
        { email: 'idemp_lead_1@example.com', name: 'Idemp 1' },
        { email: 'idemp_lead_2@example.com', name: 'Idemp 2' },
      ],
    };

    // First request: processes and caches response
    const firstResponse = await request(app)
      .post('/api/leads/ingest')
      .set('x-idempotency-key', idempotencyKey)
      .send(payload);

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body.status).toBe('ok');
    expect(firstResponse.body.inserted).toBe(2);

    // Reset query count to measure cached retrieval
    db.resetQueryCount();

    // Second request with same idempotency key
    const secondResponse = await request(app)
      .post('/api/leads/ingest')
      .set('x-idempotency-key', idempotencyKey)
      .send(payload);

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual(firstResponse.body);

    // Exactly 1 query was executed to fetch the cached idempotency record
    expect(db.queryCount).toBe(1);
  });
});
