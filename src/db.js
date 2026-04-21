import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'stickerbot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  agenda TEXT,
  max_emails INTEGER NOT NULL,
  max_usd REAL NOT NULL,
  status TEXT NOT NULL,
  sent_count INTEGER DEFAULT 0,
  spent_usd REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  company TEXT NOT NULL,
  domain TEXT,
  to_address TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL,
  message_id TEXT,
  verified INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT
);

INSERT OR IGNORE INTO preferences (id, content) VALUES (1, '');

CREATE INDEX IF NOT EXISTS idx_emails_company ON emails(company);
CREATE INDEX IF NOT EXISTS idx_log_run ON log(run_id, ts);
`);

export function createRun({ agenda, maxEmails, maxUsd }) {
  const stmt = db.prepare(
    'INSERT INTO runs (started_at, agenda, max_emails, max_usd, status) VALUES (?, ?, ?, ?, ?)'
  );
  const info = stmt.run(Date.now(), agenda || null, maxEmails, maxUsd, 'running');
  return info.lastInsertRowid;
}

export function updateRun(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => fields[k]);
  db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...vals, id);
}

export function getRun(id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

export function listRuns(limit = 20) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}

export function logEvent(runId, level, message) {
  db.prepare('INSERT INTO log (run_id, level, message, ts) VALUES (?, ?, ?, ?)').run(
    runId,
    level,
    message,
    Date.now()
  );
}

export function getLog(runId, sinceId = 0) {
  return db
    .prepare('SELECT * FROM log WHERE run_id = ? AND id > ? ORDER BY id ASC')
    .all(runId, sinceId);
}

export function recentLog(limit = 200) {
  return db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

export function recordEmail(row) {
  const stmt = db.prepare(
    `INSERT INTO emails (run_id, company, domain, to_address, subject, body, status, message_id, verified, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    row.runId,
    row.company,
    row.domain || null,
    row.to,
    row.subject || null,
    row.body || null,
    row.status,
    row.messageId || null,
    row.verified ? 1 : 0,
    row.error || null,
    Date.now()
  );
  return info.lastInsertRowid;
}

export function updateEmail(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => fields[k]);
  db.prepare(`UPDATE emails SET ${sets} WHERE id = ?`).run(...vals, id);
}

export function listEmails(runId) {
  if (runId) {
    return db.prepare('SELECT * FROM emails WHERE run_id = ? ORDER BY id DESC').all(runId);
  }
  return db.prepare('SELECT * FROM emails ORDER BY id DESC LIMIT 200').all();
}

export function hasEmailedCompany(company) {
  const row = db
    .prepare("SELECT 1 FROM emails WHERE LOWER(company) = LOWER(?) AND status IN ('sent', 'verified')")
    .get(company);
  return !!row;
}

export function getPreferences() {
  return db.prepare('SELECT content FROM preferences WHERE id = 1').get()?.content || '';
}

export function setPreferences(content) {
  db.prepare('UPDATE preferences SET content = ? WHERE id = 1').run(content);
}

export default db;
