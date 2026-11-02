// A D1-shaped adapter over Node's built-in SQLite. The database has the Core tables Outreach reads, the hours_* schema
// Core's adopted Outreach migrations produce (tests/fixtures/core-hours-schema.sql), and then this plugin's own migrations,
// applied in order as an installation applies them. Batches run in one transaction, as D1 batches do.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../../", import.meta.url);
export const pluginMigrations = () => JSON.parse(readFileSync(new URL("migrations/reviewed.json", root), "utf8")).map(({ name }) => ({ name, sql: readFileSync(new URL(`migrations/${name}`, root), "utf8") }));

const coreTables = `
  CREATE TABLE installations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE meetings (id TEXT PRIMARY KEY);
  CREATE TABLE members (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id), external_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, discord_user_id TEXT);
  CREATE TABLE organization_settings (installation_id TEXT PRIMARY KEY REFERENCES installations(id), time_zone TEXT NOT NULL, organization_name TEXT NOT NULL DEFAULT 'Synthetic Robotics', subtitle TEXT, logo_data TEXT, primary_color TEXT NOT NULL DEFAULT '#123456', secondary_color TEXT NOT NULL DEFAULT '#654321', logo_backdrop TEXT NOT NULL DEFAULT 'auto');
  CREATE TABLE audit_log (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id), actor_user_id TEXT REFERENCES users(id), action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
`;

/** Rows a freshly enabled installation has (the plugin's freshEnable), plus synthetic members and an admin. */
const installationRows = `
  INSERT INTO installations(id) VALUES ('primary'); INSERT INTO users VALUES ('admin');
  INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','America/New_York');
  INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES ('member-a','primary','TEST-A','Test Student','A'),('member-b','primary','TEST-B','Test Student','B');
  INSERT INTO hours_entry_settings(installation_id) VALUES ('primary');
  INSERT INTO hours_public_form_settings(installation_id,updated_at) VALUES ('primary','2026-01-01T00:00:00.000Z');
  INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES ('primary',0,0,'2026-01-01','2026-01-01');
  INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
    ('primary','event','Event','event',1,'2026-01-01','2026-01-01'),
    ('primary','team-support','Team Support','team',1,'2026-01-01','2026-01-01'),
    ('primary','other-service','Other Service','task',1,'2026-01-01','2026-01-01');
`;

/** The database as Core's adopted migrations left it, before this plugin's migrations. */
export function coreBaselineDatabase() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(coreTables);
  raw.exec(readFileSync(new URL("tests/fixtures/core-hours-schema.sql", root), "utf8"));
  return raw;
}

/**
 * Core's own tables as Core defines them (tests/fixtures/core-tables.sql) in place of the minimal stand-ins above, then
 * the adopted hours_* schema and this plugin's migrations. The tests that mirror Core's Outreach tests use it: they need
 * Core's real users, members, meetings and platform_modules columns. Rows are left to the caller.
 */
export function coreSchemaDatabase() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("tests/fixtures/core-tables.sql", root), "utf8"));
  raw.exec(readFileSync(new URL("tests/fixtures/core-hours-schema.sql", root), "utf8"));
  return applyPluginMigrations(raw);
}

export function applyPluginMigrations(raw) {
  // Each migration applies atomically, as Core's ledger applies one D1 batch per migration.
  for (const { sql } of pluginMigrations()) { raw.exec("BEGIN"); try { raw.exec(sql); raw.exec("COMMIT"); } catch (error) { raw.exec("ROLLBACK"); throw error; } }
  return raw;
}

export function d1(raw) {
  const prepare = (sql) => {
    let values = [];
    const statement = {
      sql,
      bind(...args) { values = args; return statement; },
      allSync: () => ({ results: raw.prepare(sql).all(...values), meta: { changes: 0 } }),
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

/** A migrated Outreach database for one synthetic installation. */
export function outreachDatabase() {
  const raw = applyPluginMigrations(coreBaselineDatabase());
  raw.exec(installationRows);
  return d1(raw);
}

export const migrationNames = () => readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
