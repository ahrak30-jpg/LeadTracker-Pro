const Database = require('better-sqlite3');
const db = new Database('leadtracker.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT UNIQUE NOT NULL,
    tech_name TEXT NOT NULL,
    commission_pct REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tech_locations (
    tech_name TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    tech_name TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    closed_at DATETIME,
    sale_amount REAL DEFAULT 0,
    cash_collected REAL DEFAULT 0,
    parts_tech REAL DEFAULT 0,
    parts_company REAL DEFAULT 0,
    follow_up_1_sent INTEGER DEFAULT 0,
    boss_alerted INTEGER DEFAULT 0,
    progress_asked INTEGER DEFAULT 0,
    scheduled_time TEXT,
    cancel_reason TEXT
  );
`);

module.exports = db;
