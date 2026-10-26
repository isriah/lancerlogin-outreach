// Outreach's portable backup section. Plugin sections use module backup version 3. Backups made while Outreach was
// first-party (entire-installation schema 25 through 43) carried these tables in Core's section as module backup version 2;
// Core lifts those rows out and hands them to `normalize` with `source.coreSection` set, and this adapter applies exactly the
// historical shims and checks Core applied, keyed by the backup's schema version.
import { HttpError, type ModuleBackupAdapter, type ModuleBackupSource, type ModuleBackupTables } from "@lancerlogin/module-sdk/api";
import { parseOutreachPublicationEvent } from "./outreach-publication.ts";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** Portable tables in parent-first restore order with their exported columns. */
export const outreachBackupTables = {
  hours_categories: ["installation_id", "id", "name", "mode", "impact_default", "archived", "revision", "created_at", "updated_at"],
  hours_labels: ["installation_id", "id", "name", "archived", "revision", "created_by", "created_at", "updated_at"],
  hours_teams: ["installation_id", "id", "number", "name", "program", "historical_descriptors", "archived", "revision", "created_at", "updated_at"],
  hours_activities: ["installation_id", "id", "category_id", "mode", "service_date", "team_id", "title", "description", "location", "impact_relevant", "source_meeting_id", "source_snapshot", "archived", "revision", "created_at", "updated_at", "event_start_local", "event_end_local", "event_start_occurrence", "event_end_occurrence"],
  hours_activity_labels: ["installation_id", "activity_id", "label_id", "created_by", "created_at"],
  hours_entry_settings: ["installation_id", "reporting_days", "reopen_hours", "revision"],
  hours_entries: ["installation_id", "id", "member_id", "activity_id", "service_date", "time_zone", "start_local", "end_local", "start_occurrence", "end_occurrence", "start_ms", "end_ms", "start_offset_seconds", "end_offset_seconds", "duration_minutes", "task_notes", "status", "channel", "attribution", "actor_user_id", "revision", "created_at", "updated_at"],
  hours_entry_revisions: ["installation_id", "entry_id", "revision", "member_id", "activity_id", "action", "reason", "actor_user_id", "snapshot_json", "created_at"],
  hours_submission_keys: ["installation_id", "channel", "key_hash", "fingerprint", "entry_id", "receipt_json", "created_at"],
  hours_reopen_windows: ["installation_id", "id", "activity_id", "starts_ms", "expires_ms", "reason", "revoked", "revision", "actor_user_id", "created_at", "updated_at"],
  hours_correction_requests: ["installation_id", "id", "channel", "attribution", "requester_member_id", "entry_id", "claimed_service_date", "message", "key_hash", "fingerprint", "status", "revision", "created_at", "resolved_at", "activity_id"],
  hours_correction_resolutions: ["installation_id", "request_id", "action", "note", "actor_user_id", "entry_id", "entry_revision", "created_at"],
  hours_publication_settings: ["installation_id", "automatic", "revision", "created_at", "updated_at"],
  hours_activity_publications: ["installation_id", "activity_id", "time_zone", "start_local", "end_local", "start_occurrence", "end_occurrence", "start_ms", "end_ms", "google_calendar", "discord", "status", "revision", "actor_user_id", "reviewed_by_user_id", "reviewed_at", "created_at", "updated_at"],
  hours_publication_operations: ["installation_id", "activity_id", "publication_revision", "provider", "status", "attempts", "next_attempt_at", "external_id", "last_error", "lease_token", "lease_expires_at", "created_at", "updated_at", "action", "event_snapshot_json"],
  hours_public_form_settings: ["installation_id", "member_validation", "revision", "updated_at"],
} as const satisfies Record<string, readonly string[]>;
type Table = keyof typeof outreachBackupTables;
const tableNames = Object.keys(outreachBackupTables) as Table[];

/** First entire-installation backup schema that carried each table in Core's section. */
const firstCoreSchema: Readonly<Record<Table, number>> = {
  hours_categories: 25, hours_teams: 25, hours_activities: 25, hours_entry_settings: 25, hours_entries: 25, hours_entry_revisions: 25, hours_submission_keys: 25,
  hours_reopen_windows: 26, hours_correction_requests: 26, hours_correction_resolutions: 26,
  hours_activity_publications: 27, hours_publication_operations: 27,
  hours_labels: 29, hours_activity_labels: 29, hours_publication_settings: 29,
  hours_public_form_settings: 33,
};

/** Columns a Core-section table carried at a historical backup schema. */
function coreSectionColumns(table: Table, schema: number): readonly string[] {
  const columns: readonly string[] = outreachBackupTables[table];
  if (table === "hours_publication_operations" && schema < 36) return columns.slice(0, schema < 29 ? -2 : -1);
  if (table === "hours_correction_requests" && schema < 33) return columns.slice(0, -1);
  if (table === "hours_activities" && schema < 29) return columns.slice(0, -4);
  return columns;
}

const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
// The same check Core applied to restored timestamps.
const validTimestamp = (value: unknown) => typeof value === "string" && Boolean(value) && Number.isFinite(Date.parse(value));

/** Core-section rows of a historical backup, checked and converted exactly as Core did while Outreach was first-party. */
function normalizeCoreSection(input: ModuleBackupTables, source: ModuleBackupSource): Tables {
  const schema = source.backupSchemaVersion;
  // Core rejected undeclared columns from schema 31, when backups gained exact ownership metadata, and ignored them before.
  const strict = schema >= 31;
  const tables = Object.fromEntries(tableNames.map((table) => [table, [] as Row[]])) as Tables;
  for (const table of tableNames) {
    if (firstCoreSchema[table] > schema) continue;
    const rows = input[table];
    if (!Array.isArray(rows)) throw new HttpError(400, `Backup table ${table} is missing`);
    const columns = coreSectionColumns(table, schema);
    tables[table] = rows.map((row) => {
      if (!row || typeof row !== "object" || columns.some((column) => !scalar(row[column])) || strict && Object.keys(row).some((column) => !columns.includes(column))) throw new HttpError(400, `Backup table ${table} contains an invalid row`);
      return Object.fromEntries(columns.map((column) => [column, row[column]]));
    });
  }
  if (schema < 33) {
    tables.hours_correction_requests = tables.hours_correction_requests!.map((row) => ({ ...row, activity_id: null }));
    tables.hours_public_form_settings = [{ installation_id: "primary", member_validation: "off", revision: 0, updated_at: source.exportedAt }];
  }
  if (schema < 29) {
    tables.hours_activities = tables.hours_activities!.map((row) => ({ ...row, event_start_local: null, event_end_local: null, event_start_occurrence: null, event_end_occurrence: null }));
    tables.hours_publication_operations = tables.hours_publication_operations!.map((row) => ({ ...row, action: "publish" }));
    const createdAt = source.installationCreatedAt ?? source.exportedAt;
    tables.hours_publication_settings = [{ installation_id: "primary", automatic: 0, revision: 0, created_at: createdAt, updated_at: createdAt }];
  }
  if (schema < 36) tables.hours_publication_operations = tables.hours_publication_operations!.map((row) => ({ ...row, event_snapshot_json: null }));
  if (schema < 29) {
    tables.hours_labels = tables.hours_categories!.map((row) => ({ installation_id: row.installation_id, id: row.id, name: row.name, archived: row.archived, revision: row.revision, created_by: null, created_at: row.created_at, updated_at: row.updated_at }));
    tables.hours_activity_labels = tables.hours_activities!.map((row) => ({ installation_id: row.installation_id, activity_id: row.id, label_id: row.category_id, created_by: null, created_at: row.created_at }));
  }
  return tables;
}

function validate(tables: ModuleBackupTables) {
  const settings = tables.hours_public_form_settings ?? [];
  if (settings.length > 1 || settings.some((row) => !["off", "validity", "name"].includes(String(row.member_validation)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || Number(row.revision) >= Number.MAX_SAFE_INTEGER || !validTimestamp(row.updated_at))) throw new HttpError(400, "Backup public form privacy settings are invalid");
  const activities = tables.hours_activities ?? [];
  if ((tables.hours_correction_requests ?? []).some((row) => row.activity_id !== null && !activities.some((activity) => activity.id === row.activity_id && activity.installation_id === row.installation_id))) throw new HttpError(400, "Backup correction activity reference is invalid");
  try {
    for (const row of tables.hours_publication_operations ?? []) if (row.event_snapshot_json !== null) {
      const snapshot = parseOutreachPublicationEvent(JSON.parse(String(row.event_snapshot_json)));
      if (snapshot.activityId !== row.activity_id || snapshot.revision > Number(row.publication_revision)) throw new Error("Publication snapshot identity mismatch");
    }
  } catch { throw new HttpError(400, "Backup publication snapshots are invalid"); }
}

const pending = (row: Readonly<Row>) => ["pending", "processing"].includes(String(row.status));

export const outreachBackupAdapter: ModuleBackupAdapter = {
  version: 3,
  tables: outreachBackupTables,
  normalize(tables, fromVersion, source) {
    // Version 2 rows exist only in Core's section of historical backups; plugin sections start at version 3.
    if (!source.coreSection || fromVersion !== 2) throw new HttpError(400, `Backup data for Outreach Participation uses module backup version ${fromVersion}, which this plugin cannot upgrade`);
    return normalizeCoreSection(tables, source);
  },
  validate,
  /** Provider work never resumes from a backup: pending and leased publication operations wait for an explicit retry. */
  neutralize: (tables) => ({ ...tables, hours_publication_operations: (tables.hours_publication_operations ?? []).map((row) => pending(row) ? { ...row, status: "failed", next_attempt_at: null, last_error: "Restore requires explicit publication retry", lease_token: null, lease_expires_at: null } : row) }),
  pausedOperations: (tables) => (tables.hours_publication_operations ?? []).filter(pending).length,
};
