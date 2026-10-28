// A D1-shaped adapter over Node's built-in SQLite, with the Outreach tables these tests need. Batches run in one
// transaction, as D1 batches do.
import { DatabaseSync } from "node:sqlite";

export function outreachDatabase() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE installations (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO installations VALUES ('primary'); INSERT INTO users VALUES ('admin');
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id), actor_user_id TEXT REFERENCES users(id), action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE hours_categories (installation_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL, impact_default INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(installation_id,id));
    CREATE TABLE hours_teams (installation_id TEXT NOT NULL, id TEXT NOT NULL, number TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, program TEXT NOT NULL DEFAULT '', historical_descriptors TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(installation_id,id));
    CREATE TABLE hours_activities (installation_id TEXT NOT NULL, id TEXT NOT NULL, category_id TEXT NOT NULL, mode TEXT NOT NULL, service_date TEXT NOT NULL, team_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', impact_relevant INTEGER NOT NULL DEFAULT 1, source_meeting_id TEXT, source_snapshot TEXT, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,category_id) REFERENCES hours_categories(installation_id,id), FOREIGN KEY(installation_id,team_id) REFERENCES hours_teams(installation_id,id), CHECK((mode='team' AND team_id IS NOT NULL) OR (mode!='team' AND team_id IS NULL)));
    CREATE UNIQUE INDEX hours_canonical_activity ON hours_activities(installation_id,category_id,service_date,ifnull(team_id,'')) WHERE mode IN ('team','task');
    INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES ('primary','team-support','Team Support','team',1,'2026-01-01','2026-01-01');
  `);
  const prepare = (sql) => {
    let values = [];
    const statement = {
      sql,
      bind(...args) { values = args; return statement; },
      allSync: () => ({ results: raw.prepare(sql).all(...values) }),
      runSync: () => ({ meta: { changes: Number(raw.prepare(sql).run(...values).changes) } }),
      async first() { return raw.prepare(sql).get(...values) ?? null; },
      async all() { return statement.allSync(); },
      async run() { return statement.runSync(); },
    };
    return statement;
  };
  return {
    raw, prepare,
    // Synchronous inside, so concurrent callers are serialized the way D1 serializes batches.
    async batch(statements) {
      raw.exec("BEGIN");
      try { const results = statements.map((statement) => /^\s*(SELECT|WITH)\b/i.test(statement.sql) ? statement.allSync() : statement.runSync()); raw.exec("COMMIT"); return results; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    },
  };
}
