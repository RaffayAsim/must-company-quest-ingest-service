const Database = require('better-sqlite3');

function createDatabase(dbPath = process.env.DB_PATH || ':memory:') {
  const db = new Database(dbPath);

  // Enable WAL mode if file-based, or default pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Query counter wrapper
  db.queryCount = 0;
  db.resetQueryCount = function () {
    this.queryCount = 0;
  };

  const origPrepare = db.prepare.bind(db);
  db.prepare = function (sql) {
    this.queryCount++;
    return origPrepare(sql);
  };

  const origExec = db.exec.bind(db);
  db.exec = function (sql) {
    this.queryCount++;
    return origExec(sql);
  };

  initSchema(db);
  return db;
}

function initSchema(targetDb) {
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      name TEXT,
      company TEXT,
      enriched_score INTEGER,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      response_json TEXT,
      created_at INTEGER
    );
  `);
}

function seedDatabase(targetDb = db) {
  targetDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS idempotency_keys;
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      name TEXT,
      company TEXT,
      enriched_score INTEGER,
      created_at TEXT
    );
    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      response_json TEXT,
      created_at INTEGER
    );
  `);

  const insert = targetDb.prepare(`
    INSERT INTO leads (email, name, company, enriched_score, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const seedAll = targetDb.transaction((count) => {
    const now = new Date().toISOString();
    for (let i = 1; i <= count; i++) {
      const email = `user${i}@example.com`;
      const name = `User ${i}`;
      const company = `Company ${((i - 1) % 50) + 1}`;
      const enriched_score = (i * 17) % 100;
      insert.run(email, name, company, enriched_score, now);
    }
  });

  seedAll(500);
  targetDb.resetQueryCount();
  return targetDb;
}

// Default singleton instance
const db = createDatabase();
seedDatabase(db);

module.exports = {
  db,
  createDatabase,
  initSchema,
  seedDatabase,
};
