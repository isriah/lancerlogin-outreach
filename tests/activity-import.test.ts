// CSV import of Outreach activities: the shared CSV mapping, POST /admin/hours/activities/import (dry run, add, update, skip,
// error, matching, Team support, labels, Event publication, limits, the Workers Free plan budget and roles) and the dialog
// text. All teams, labels, titles and people here are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { D1Database, D1Result, D1Statement } from "@lancerlogin/module-sdk/api";
import type { OutreachPublicationProviders } from "../src/api/outreach-publication.ts";
import "./helpers/sdk.mjs";
import { coreSchemaDatabase } from "./helpers/d1.mjs";

const csv = await import("../src/shared/outreach-activity-csv.ts");
const { runOutreachActivityImport } = await import("../src/api/outreach-activity-import.ts");
const { outreachCatalogRoute } = await import("../src/api/outreach-catalogs.ts");
const { processOutreachPublicationOperations } = await import("../src/api/outreach-publication.ts");
const { resolveOutreachTiming } = await import("../src/api/outreach-entries.ts");
const text = await import("../src/dashboard/outreach-activity-import.ts");

class Statement implements D1Statement {
  readonly database: DatabaseSync; readonly sql: string; readonly counter: { queries: number }; values: unknown[] = [];
  constructor(database: DatabaseSync, sql: string, counter: { queries: number }) { this.database = database; this.sql = sql; this.counter = counter; }
  bind(...values: unknown[]) { const next = new Statement(this.database, this.sql, this.counter); next.values = values; return next; }
  native(): StatementSync { return this.database.prepare(this.sql); }
  async first<T>() { this.counter.queries += 1; return (this.native().get(...this.values as []) as T | undefined) ?? null; }
  async all<T>() { this.counter.queries += 1; return { results: this.native().all(...this.values as []) as T[], meta: { changes: 0 } } as D1Result<T>; }
  async run() { this.counter.queries += 1; const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
  batchResult(): D1Result { if (/^\s*(?:SELECT|WITH)\b/i.test(this.sql)) return { success: true, results: this.native().all(...this.values as []), meta: { changes: 0 } } as D1Result; const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
}

/** The Outreach schema as an installation has it, counting D1 queries the way the Workers Free plan does: a batch is one. */
class Database implements D1Database {
  readonly sqlite = coreSchemaDatabase(); readonly counter = { queries: 0 }; batches: number[] = []; beforeBatch?: () => void;
  constructor() {
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-28','local');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','America/New_York');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-09-28');
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES ('primary','hour-tracking',1,1,'enabled',1,0,0);
      INSERT INTO hours_entry_settings(installation_id) VALUES('primary');
      INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES('primary',0,0,'2026-09-28','2026-09-28');
      INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
        ('primary','event','Event','event',1,'2026-09-28','2026-09-28'),('primary','team-support','Team Support','team',1,'2026-09-28','2026-09-28'),('primary','other-service','Other Service','task',1,'2026-09-28','2026-09-28');
      INSERT INTO hours_labels(installation_id,id,name,archived,revision,created_at,updated_at) VALUES
        ('primary','label-a','Test Label A',0,0,'2026-09-28','2026-09-28'),('primary','label-b','Test Label B',0,0,'2026-09-28','2026-09-28'),('primary','label-old','Test Label Retired',1,0,'2026-09-28','2026-09-28');
      INSERT INTO hours_teams(installation_id,id,number,name,program,archived,revision,created_at,updated_at) VALUES
        ('primary','team-9999','9999','Test Team Robots','FTC',0,0,'2026-09-28','2026-09-28'),('primary','team-8888','8888','Test Team Archived','FRC',1,0,'2026-09-28','2026-09-28');`);
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql, this.counter); }
  async batch(statements: D1Statement[]) {
    this.counter.queries += 1; this.batches.push(statements.length); this.beforeBatch?.();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results = statements.map((statement) => (statement as Statement).batchResult()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  all<T>(sql: string, ...values: unknown[]) { return this.sqlite.prepare(sql).all(...values as []).map((row) => ({ ...row })) as T[]; }
  close() { this.sqlite.close(); }
}

const now = Date.parse("2026-11-03T15:00:00Z");
function providers(available = { google_calendar: true, discord: true }) {
  const calls: string[] = [];
  const value: OutreachPublicationProviders = {
    status: async () => { calls.push("status"); return available; },
    publish: async (provider, event, externalId) => { calls.push(`publish:${provider}`); return externalId ?? `${provider}-${event.activityId}`; },
    remove: async (provider) => { calls.push(`remove:${provider}`); },
  };
  return { value, calls };
}
const header = "Title,Date,Type,Start time,End time,Team,Labels,Location,Description,Impact relevant";
const rowsOf = (lines: string[]) => csv.parseOutreachActivityCsvText([header, ...lines].join("\n")).rows;
type Result = { rows: Array<{ rowNumber: number; action: string; error?: string; warnings?: string[]; changes?: string[]; existing?: { activityId: string }; publication?: { publish: string[]; update: string[] }; activity?: { team: string | null; labels: string[]; startTime: string | null } }>; summary: Record<string, number>; imported?: { added: number; updated: number; activityIds: string[] }; publication?: { queued: number } };
const run = (database: Database, body: unknown, available?: { google_calendar: boolean; discord: boolean }, at = now) => runOutreachActivityImport(database, "admin", body, providers(available).value, at) as Promise<Result>;
const setSwitches = (database: Database, google: number, discord: number) => database.sqlite.exec(`UPDATE hours_publication_settings SET automatic=${Number(google || discord)},google_calendar_automatic=${google},discord_automatic=${discord}`);

test("the activity CSV maps headers, aliases, dates, types and times, and checks rows as a saved activity is checked", () => {
  const parsed = csv.parseOutreachActivityCsvText("Activity,Service date,Mode,Start,End,Team number,Outreach labels,Venue,Notes,Counts toward impact,Owner\nTest Library Demo,11/14/2026,event,10:00 AM,1:00 PM,,Test Label A; test label a;Test Label B,Test Public Library,,no,Test Person");
  assert.deepEqual(parsed.recognised, ["title", "date", "type", "startTime", "endTime", "team", "labels", "location", "description", "impact"]);
  assert.deepEqual(parsed.ignored, ["Owner"]); assert.deepEqual(parsed.errors, []); assert.equal(parsed.rows[0]!.rowNumber, 2);
  assert.deepEqual(csv.resolveOutreachActivityCsvRow(parsed.rows[0]!.values).activity, { title: "Test Library Demo", serviceDate: "2026-11-14", mode: "event", startLocal: "10:00", endLocal: "13:00", teamRef: null, labelNames: ["Test Label A", "Test Label B"], location: "Test Public Library", description: "", impactRelevant: false });
  // Tab-separated spreadsheet rows may leave out the header when they follow the template order.
  const pasted = csv.parseOutreachActivityCsvText("Test Park Cleanup\t2026-11-21\tOther service");
  assert.equal(pasted.hasHeader, false); assert.deepEqual(pasted.rows[0], { rowNumber: 1, values: { title: "Test Park Cleanup", date: "2026-11-21", type: "Other service" } });
  assert.deepEqual(csv.parseOutreachActivityCsvText("Name,Type\nTest Only Title,Event").errors, ["Missing column: Date"]);
  // The template is the documented columns, in MM/DD/YYYY, with synthetic rows that import cleanly.
  const template = csv.parseOutreachActivityCsvText(csv.outreachActivityCsvTemplate);
  assert.deepEqual(template.recognised, csv.outreachActivityCsvFields); assert.match(csv.outreachActivityCsvTemplate, /^Title,Date,Type,Start time,End time,Supported team,Labels,Location,Description,Impact relevant\nTest Library Demo,11\/14\/2026,/);
  assert.ok(template.rows.every((row) => csv.resolveOutreachActivityCsvRow(row.values).activity));
  const errors = (values: Record<string, string>) => csv.resolveOutreachActivityCsvRow({ title: "Test Row", date: "11/14/2026", ...values }).errors ?? [];
  assert.deepEqual(errors({}), []);
  assert.deepEqual(errors({ title: "" }), ["Add a title"]); assert.deepEqual(errors({ title: "x".repeat(151) }), ["Title must be 150 characters or fewer"]);
  assert.deepEqual(errors({ date: "14/11/2026" }), ["14/11/2026 looks like day/month. Use MM/DD/YYYY, such as 11/14/2026"]);
  assert.deepEqual(errors({ type: "Meeting" }), ["Type must be Event, Team support or Other service, not Meeting"]);
  assert.deepEqual(errors({ startTime: "10:00", endTime: "" }), ["Add both a start time and an end time, or leave both blank for an all-day Event"]);
  assert.deepEqual(errors({ startTime: "10:02", endTime: "11:00" }), ["Choose start and end times in five-minute steps, such as 10:05"]);
  assert.deepEqual(errors({ startTime: "11:00", endTime: "10:00" }), ["End time must be after the start time on the same day"]);
  assert.deepEqual(errors({ type: "Other service", startTime: "10:00", endTime: "11:00" }), ["Only Event activities take a start and end time"]);
  assert.deepEqual(errors({ type: "Team support" }), ["Team support needs a Supported team"]);
  assert.deepEqual(errors({ type: "Event", team: "9999" }), ["Only Team support activities take a supported team"]);
  assert.deepEqual(errors({ location: "x".repeat(301), description: "x".repeat(4001) }), ["Location must be 300 characters or fewer", "Description must be 4,000 characters or fewer"]);
  assert.deepEqual(errors({ impact: "maybe" }), ["Impact relevant must be yes or no, not maybe"]);
  assert.deepEqual(errors({ labels: Array.from({ length: 101 }, (_, index) => `Test Label ${index}`).join(";") }), ["Choose at most 100 Outreach labels"]);
  assert.deepEqual(errors({ description: "x".repeat(5001) }), ["Each cell must be text of at most 5,000 characters"]);
  // Absent columns stay undefined, so an update keeps the activity's value; blank cells are the defaults.
  assert.deepEqual(csv.resolveOutreachActivityCsvRow({ title: "Test Row", date: "2026-11-14", impact: "" }).activity, { title: "Test Row", serviceDate: "2026-11-14", mode: "event", startLocal: undefined, endLocal: undefined, teamRef: null, labelNames: undefined, location: undefined, description: undefined, impactRelevant: true });
});

test("the import clock places Event times as the activity editor does, across daylight-saving changes", () => {
  const clock = csv.outreachCsvClock("America/New_York");
  for (const [date, start, end] of [["2026-11-14", "10:00", "13:00"], ["2026-03-08", "01:00", "03:30"], ["2026-11-01", "00:30", "03:00"], ["2026-07-04", "18:00", "23:55"]] as const) {
    const placed = csv.placeOutreachEventTimes(clock, date, start, end); assert.equal(placed.error, undefined);
    const editor = resolveOutreachTiming({ startLocal: start, endLocal: end, startOccurrence: (placed as { startOccurrence: string | null }).startOccurrence, endOccurrence: (placed as { endOccurrence: string | null }).endOccurrence }, date, "America/New_York", now, true);
    assert.deepEqual([(placed as { startMs: number }).startMs, (placed as { endMs: number }).endMs], [editor.startMs, editor.endMs]);
  }
  // Clocks skip 2:30 AM on 03/08/2026 and repeat 1:30 AM on 11/01/2026.
  assert.match(String(csv.placeOutreachEventTimes(clock, "2026-03-08", "02:30", "04:00").error), /^2:30 AM on 03\/08\/2026 in America\/New_York doesn't exist/);
  const repeated = csv.placeOutreachEventTimes(clock, "2026-11-01", "01:30", "03:00") as { startOccurrence: string; startMs: number; warnings: string[] };
  assert.equal(repeated.startOccurrence, "earlier"); assert.equal(repeated.startMs, Date.parse("2026-11-01T05:30:00Z"));
  assert.deepEqual(repeated.warnings, ["1:30 AM on 11/01/2026 in America/New_York happens twice: clocks move back for daylight saving time. The first 1:30 AM is used"]);
  assert.deepEqual([csv.placeOutreachEventTimes(clock, "2026-11-14", null, null)].map((item) => [(item as { startMs: number }).startMs, (item as { endMs: number }).endMs]), [[Date.parse("2026-11-14T05:00:00Z"), Date.parse("2026-11-15T05:00:00Z")]]);
});

test("a dry run classifies add, matching, Team support, labels and errors; the commit writes the rest in one batch", async () => {
  const database = new Database();
  try {
    const existing = await outreachCatalogRoute(database, "admin", new Request("https://synthetic.test/admin/hours/activities", { method: "POST" }), { mode: "event", serviceDate: "2026-11-30", teamId: null, title: "Test STEM Night", description: "", location: "", impactRelevant: true, labelIds: ["label-b"], eventStartLocal: "17:00", eventEndLocal: "20:00", archived: false }, undefined, now);
    const existingId = String((existing.body as { id: string }).id);
    const rows = rowsOf([
      "Test Library Demo,11/14/2026,,10:00,13:00,,Test Label A,Test Public Library,,",
      "Test Mentoring Visit,11/18/2026,Team support,,,9999,,,,",
      "test stem night,11/30/2026,Event,17:00,20:00,,Test Label A;Test Label B,,,",
      "Test Robot Showcase,11/21/2026,Team support,,,12345,,,,",
      "Test Archived Team Visit,11/21/2026,Team support,,,8888,,,,",
      "Test Unknown Label,11/22/2026,Other service,,,,Test Label Missing,,,",
      "Test Retired Label,11/22/2026,Other service,,,,Test Label Retired,,,",
      "Test Library Demo,2026-11-14,Event,10:00,13:00,,,,,",
      "Test Team By Name,11/19/2026,Team support,,,test team robots,,,,",
      ",11/22/2026,,,,,,,,",
    ]);
    const dry = await run(database, { rows, dryRun: true, actions: {} });
    assert.deepEqual(dry.rows.map((row) => [row.rowNumber, row.action, row.error ?? row.changes?.join(",") ?? ""]), [
      [2, "add", ""], [3, "add", ""], [4, "skip", "title,labels"],
      [5, "error", "Unknown team number 12345"], [6, "error", "Supported team 8888 Test Team Archived is archived"],
      [7, "error", "Unknown Outreach label Test Label Missing"], [8, "error", "Outreach label Test Label Retired is archived"],
      [9, "error", "Repeats row 2"], [10, "add", ""], [11, "error", "Add a title"],
    ]);
    assert.deepEqual(dry.summary, { add: 3, update: 0, skip: 1, error: 6 });
    assert.equal(dry.rows[2]!.existing?.activityId, existingId); assert.equal(dry.rows[1]!.activity?.team, "9999"); assert.equal(dry.rows[8]!.activity?.team, "9999");
    assert.equal(database.all("SELECT id FROM hours_activities").length, 1, "a dry run writes nothing");
    // Update all: the matching row becomes an update; error rows are listed and skipped.
    const committed = await run(database, { rows, dryRun: false, actions: { 4: "update" } });
    assert.deepEqual(committed.summary, { add: 3, update: 1, skip: 0, error: 6 }); assert.deepEqual([committed.imported?.added, committed.imported?.updated], [3, 1]);
    assert.equal(database.batches.length, 2, "the existing activity's save and the import are one batch each");
    const stored = database.all<{ id: string; title: string; mode: string; team_id: string | null; revision: number; location: string; event_start_local: string | null }>("SELECT id,title,mode,team_id,revision,location,event_start_local FROM hours_activities ORDER BY service_date,title");
    assert.deepEqual(stored.map((row) => [row.title, row.mode, row.team_id, row.revision]), [["Test Library Demo", "event", null, 0], ["Test Mentoring Visit", "team", "team-9999", 0], ["Test Team By Name", "team", "team-9999", 0], ["test stem night", "event", null, 1]]);
    assert.deepEqual(database.all("SELECT label_id FROM hours_activity_labels WHERE activity_id=? ORDER BY label_id", existingId).map((row) => (row as { label_id: string }).label_id), ["label-a", "label-b"]);
    const audits = database.all<{ action: string; metadata_json: string }>("SELECT action,metadata_json FROM audit_log WHERE action LIKE 'outreach.activities.%' ORDER BY created_at");
    assert.deepEqual(audits.map((row) => row.action), ["outreach.activities.created", "outreach.activities.imported"]);
    assert.deepEqual(JSON.parse(audits[1]!.metadata_json).updatedIds, [existingId]);
    // Importing the same file again matches every row; skipping all writes nothing and says so.
    const again = await run(database, { rows: rows.slice(0, 3), dryRun: true, actions: {} });
    assert.deepEqual(again.rows.map((row) => [row.action, row.changes]), [["skip", []], ["skip", []], ["skip", []]]);
    await assert.rejects(run(database, { rows: rows.slice(0, 3), dryRun: false, actions: {} }), /No rows can be imported/);
  } finally { database.close(); }
});

test("an update goes through the activity's revision; absent columns keep values and a change between reads and batch rolls back", async () => {
  const database = new Database();
  try {
    const created = await outreachCatalogRoute(database, "admin", new Request("https://synthetic.test/admin/hours/activities", { method: "POST" }), { mode: "task", serviceDate: "2026-11-20", teamId: null, title: "Test Park Cleanup", description: "Synthetic details", location: "Test Park", impactRelevant: false, labelIds: ["label-a"], archived: false }, undefined, now);
    const id = String((created.body as { id: string }).id);
    const rows = csv.parseOutreachActivityCsvText("Title,Date,Type,Location\nTest Park Cleanup,11/20/2026,Other service,Test Riverside Park").rows;
    const dry = await run(database, { rows, dryRun: true, actions: { 2: "update" } });
    assert.deepEqual(dry.rows[0]!.changes, ["location"]); assert.deepEqual(dry.rows[0]!.activity?.labels, ["Test Label A"]);
    // Another save lands between the import's reads and its batch: nothing is written.
    database.beforeBatch = () => { database.sqlite.prepare("UPDATE hours_activities SET revision=revision+1 WHERE id=?").run(id); database.beforeBatch = undefined; };
    await assert.rejects(run(database, { rows, dryRun: false, actions: { 2: "update" } }), /changed during the import/);
    assert.equal(database.all("SELECT * FROM audit_log WHERE action='outreach.activities.imported'").length, 0);
    await run(database, { rows, dryRun: false, actions: { 2: "update" } });
    assert.deepEqual(database.all("SELECT location,description,impact_relevant,revision FROM hours_activities WHERE id=?", id), [{ location: "Test Riverside Park", description: "Synthetic details", impact_relevant: 0, revision: 2 }]);
    assert.deepEqual(database.all("SELECT label_id FROM hours_activity_labels WHERE activity_id=?", id), [{ label_id: "label-a" }]);
    // The activity editor sees the new revision.
    const edited = await outreachCatalogRoute(database, "admin", new Request(`https://synthetic.test/admin/hours/activities/${id}`, { method: "PATCH" }), { revision: 2, title: "Test Park Cleanup Day" }, undefined, now);
    assert.equal((edited.body as { revision: number }).revision, 3);
  } finally { database.close(); }
});

test("future Events queue to each destination whose switch is on, and updates reach destinations they are published to", async () => {
  const database = new Database();
  try {
    const rows = rowsOf(["Test Library Demo,11/14/2026,Event,10:00,13:00,,,,,", "Test Past Fair,10/01/2026,Event,10:00,13:00,,,,,", "Test All Day Expo,11/03/2026,Event,,,,,,,", "Test Park Cleanup,11/21/2026,Other service,,,,,,,"]);
    // Both switches off: nothing is queued and no destination status is read.
    const tracked = providers(); let dry = await runOutreachActivityImport(database, "admin", { rows, dryRun: true }, tracked.value, now) as Result;
    assert.deepEqual(dry.rows.map((row) => row.publication), [undefined, undefined, undefined, undefined]); assert.deepEqual(tracked.calls, []);
    setSwitches(database, 0, 1);
    dry = await run(database, { rows, dryRun: true });
    assert.deepEqual(dry.rows.map((row) => row.publication), [{ publish: ["discord"], update: [] }, undefined, { publish: ["discord"], update: [] }, undefined]);
    setSwitches(database, 1, 1);
    // A destination that is not set up is not queued.
    dry = await run(database, { rows, dryRun: true }, { google_calendar: false, discord: true });
    assert.deepEqual(dry.rows[0]!.publication, { publish: ["discord"], update: [] });
    const committing = providers(); const committed = await runOutreachActivityImport(database, "admin", { rows, dryRun: false }, committing.value, now) as Result;
    assert.equal(committed.publication?.queued, 2); assert.deepEqual(committing.calls, ["status"], "no provider request is made inline");
    const operations = database.all<{ title: string; provider: string; status: string; publication_revision: number }>("SELECT a.title,o.provider,o.status,o.publication_revision FROM hours_publication_operations o JOIN hours_activities a ON a.id=o.activity_id ORDER BY a.title,o.provider");
    assert.deepEqual(operations.map((row) => [row.title, row.provider, row.status, row.publication_revision]), [["Test All Day Expo", "discord", "pending", 0], ["Test All Day Expo", "google_calendar", "pending", 0], ["Test Library Demo", "discord", "pending", 0], ["Test Library Demo", "google_calendar", "pending", 0]]);
    // The publication job delivers them, five a pass, with the same snapshot an edit queues.
    const job = providers(); assert.deepEqual(await processOutreachPublicationOperations(database, job.value, now + 60_000), { delivered: 4, failed: 0, pending: 0 });
    // Discord off: an update still reaches Discord, where the Event is published, and Google Calendar, whose switch is on.
    setSwitches(database, 1, 0);
    const changed = rowsOf(["Test Library Demo,11/14/2026,Event,10:00,14:00,,,,,"]);
    const update = await run(database, { rows: changed, dryRun: true, actions: { 2: "update" } });
    assert.deepEqual([update.rows[0]!.changes, update.rows[0]!.publication], [["time"], { publish: [], update: ["discord", "google_calendar"] }]);
    await run(database, { rows: changed, dryRun: false, actions: { 2: "update" } });
    const latest = database.all<{ provider: string; external_id: string; event_snapshot_json: string; publication_revision: number }>("SELECT o.provider,o.external_id,o.event_snapshot_json,o.publication_revision FROM hours_publication_operations o JOIN hours_activities a ON a.id=o.activity_id WHERE a.title='Test Library Demo' AND o.publication_revision=1 ORDER BY o.provider");
    assert.deepEqual(latest.map((row) => [row.provider, row.publication_revision, row.external_id.split("-")[0]]), [["discord", 1, "discord"], ["google_calendar", 1, "google_calendar"]]);
    assert.equal(JSON.parse(latest[0]!.event_snapshot_json).endsAt, "2026-11-14T19:00:00.000Z");
    assert.deepEqual(database.all("SELECT p.revision,p.google_calendar,p.discord FROM hours_activity_publications p JOIN hours_activities a ON a.id=p.activity_id WHERE a.title='Test Library Demo'"), [{ revision: 1, google_calendar: 1, discord: 1 }]);
  } finally { database.close(); }
});

test("an imported Event update queues the same publication rows as editing it", async () => {
  const edited = new Database(); const imported = new Database();
  try {
    for (const database of [edited, imported]) { setSwitches(database, 1, 0); await run(database, { rows: rowsOf(["Test Library Demo,11/14/2026,Event,10:00,13:00,,,Test Public Library,,"]), dryRun: false }); await processOutreachPublicationOperations(database, providers().value, now + 1); setSwitches(database, 0, 1); }
    const id = edited.all<{ id: string }>("SELECT id FROM hours_activities")[0]!.id;
    await outreachCatalogRoute(edited, "admin", new Request(`https://synthetic.test/admin/hours/activities/${id}`, { method: "PATCH" }), { revision: 0, location: "Test Branch Library" }, providers().value, now + 2);
    await run(imported, { rows: rowsOf(["Test Library Demo,11/14/2026,Event,10:00,13:00,,,Test Branch Library,,"]), dryRun: false, actions: { 2: "update" } }, undefined, now + 2);
    const shape = (database: Database) => ({
      activity: database.all("SELECT title,location,revision,event_start_local,event_end_local FROM hours_activities"),
      publication: database.all("SELECT time_zone,start_local,end_local,start_ms,end_ms,google_calendar,discord,status,revision FROM hours_activity_publications"),
      operations: database.all<Record<string, unknown>>("SELECT publication_revision,provider,status,attempts,action,external_id IS NOT NULL AS published,event_snapshot_json FROM hours_publication_operations ORDER BY publication_revision,provider").map((row) => ({ ...row, event_snapshot_json: JSON.parse(String(row.event_snapshot_json)), ...{ event_snapshot_json: { ...JSON.parse(String(row.event_snapshot_json)), activityId: "same" } } })),
    });
    assert.deepEqual(shape(imported), shape(edited));
  } finally { edited.close(); imported.close(); }
});

test("a repeated daylight-saving time uses the first one with a warning; a skipped time is an error", async () => {
  const database = new Database();
  try {
    const result = await run(database, { rows: rowsOf(["Test Night Hike,11/01/2026,Event,01:30,03:00,,,,,", "Test Spring Hike,03/08/2026,Event,02:30,04:00,,,,,"]), dryRun: true });
    assert.equal(result.rows[0]!.action, "add"); assert.match(String(result.rows[0]!.warnings?.[0]), /happens twice/);
    assert.equal(result.rows[1]!.action, "error"); assert.match(String(result.rows[1]!.error), /doesn't exist: clocks move forward/);
    await run(database, { rows: rowsOf(["Test Night Hike,11/01/2026,Event,01:30,03:00,,,,,"]), dryRun: false });
    assert.deepEqual(database.all("SELECT event_start_occurrence,event_end_occurrence FROM hours_activities"), [{ event_start_occurrence: "earlier", event_end_occurrence: null }]);
  } finally { database.close(); }
});

test("requests are bounded at 200 rows with known text cells", async () => {
  const database = new Database();
  try {
    const row = (index: number) => ({ rowNumber: index + 2, values: { title: `Test Activity ${index}`, date: "11/14/2026" } });
    await assert.rejects(run(database, { rows: Array.from({ length: 201 }, (_, index) => row(index)), dryRun: true }), /no more than 200 activities/);
    await assert.rejects(run(database, { rows: [], dryRun: true }), /at least one/);
    await assert.rejects(run(database, { rows: [row(0), row(0)], dryRun: true }), /distinct row number/);
    await assert.rejects(run(database, { rows: [{ rowNumber: 2, values: { owner: "Test Person" } }], dryRun: true }), /known columns/);
    await assert.rejects(run(database, { rows: [row(0)], dryRun: true, actions: { 2: "replace" } }), /skip or update/);
    await assert.rejects(run(database, { rows: [row(0)], dryRun: "yes" }), /dryRun/);
  } finally { database.close(); }
});

test("a 200-row commit with Events, updates and publication stays far inside the Workers Free plan", async () => {
  const database = new Database();
  try {
    setSwitches(database, 1, 1);
    const lines = (location: string) => Array.from({ length: 200 }, (_, index) => index % 2
      ? `Test Event ${index},11/${String(10 + index % 20).padStart(2, "0")}/2026,Event,10:00,12:00,,Test Label A;Test Label B,${location},,`
      : `Test Visit ${index},11/${String(10 + index % 20).padStart(2, "0")}/2026,Team support,,,9999,Test Label A,${location},,`);
    database.counter.queries = 0; const first = await run(database, { rows: rowsOf(lines("Test Hall")), dryRun: false });
    assert.equal(first.summary.add, 200); const addQueries = database.counter.queries;
    await processOutreachPublicationOperations(database, providers().value, now + 1);
    database.counter.queries = 0;
    const started = performance.now(); const dry = await run(database, { rows: rowsOf(lines("Test Annex")), dryRun: true, actions: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [index + 2, "update"])) }); const dryMs = performance.now() - started;
    const dryQueries = database.counter.queries; database.counter.queries = 0;
    const second = await run(database, { rows: rowsOf(lines("Test Annex")), dryRun: false, actions: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [index + 2, "update"])) });
    assert.equal(dry.summary.update, 200); assert.equal(second.summary.update, 200); assert.equal(second.publication?.queued, 100);
    const updateQueries = database.counter.queries;
    // A batch counts once: six reads, the updated Events' publications and deliveries, then one batch. Destination status is
    // Core's own read of its Google Calendar and Discord connections, not counted here.
    assert.equal(addQueries, 7); assert.equal(dryQueries, 8); assert.equal(updateQueries, 9);
    assert.ok(Math.max(...database.batches) <= 210, `${Math.max(...database.batches)} statements in one batch`);
    console.log(`200-row import: ${addQueries} D1 queries to add, ${updateQueries} to update with publication, a ${Math.round(dryMs)} ms dry run in Node`);
    // Each updated Event has a pending delivery to both destinations at its new publication revision.
    assert.deepEqual(database.all("SELECT COUNT(*) AS n FROM hours_publication_operations o JOIN hours_activity_publications p ON p.activity_id=o.activity_id AND p.revision=o.publication_revision WHERE o.status='pending' AND p.revision=1"), [{ n: 200 }]);
  } finally { database.close(); }
});

test("only Staff who can create activities can import them", async () => {
  const { default: api } = await import("../src/api.ts");
  const route = api.routes["/admin/hours"]!;
  const context = (role: "admin" | "operator" | "member", method = "POST") => ({
    url: new URL("https://synthetic.test/admin/hours/activities/import"), request: new Request("https://synthetic.test/admin/hours/activities/import", { method }),
    db: new Database(), services: { googleCalendar: { ready: async () => false, providerStatus: () => undefined }, discord: { ready: async () => false, providerStatus: () => undefined } } as never,
    async requireRole(roles: string[]) { if (!roles.includes(role)) throw Object.assign(new Error("Forbidden"), { status: 403 }); return { userId: "admin", role }; },
    async body() { return { rows: [{ rowNumber: 2, values: { title: "Test Library Demo", date: "11/14/2026" } }], dryRun: true }; },
    respond: (body: unknown, status = 200) => ({ body, status }),
  });
  for (const role of ["admin", "operator"] as const) { const response = await route(context(role) as never) as unknown as { status: number; body: Result }; assert.equal(response.status, 200); assert.equal(response.body.rows[0]!.action, "add"); }
  await assert.rejects(route(context("member") as never) as Promise<unknown>, /Forbidden/);
  await assert.rejects(route(context("admin", "GET") as never) as Promise<unknown>, /Use POST/);
});

test("the import dialog's text matches the approved preview", () => {
  const activity = (overrides = {}) => ({ title: "Test Library Demo", date: "2026-11-14", mode: "event" as const, startTime: "10:00", endTime: "13:00", team: null, labels: ["Test Label A"], location: "", description: "", impactRelevant: true, ...overrides });
  assert.equal(text.timeText(activity()), "10:00 AM–1:00 PM"); assert.equal(text.timeText(activity({ startTime: null, endTime: null })), "All day"); assert.equal(text.timeText(activity({ mode: "team", startTime: null, endTime: null })), "—");
  assert.equal(text.labelsText(activity({ labels: ["Test Label A", "Test Label B"] })), "Test Label A; Test Label B"); assert.equal(text.labelsText(activity({ labels: [] })), "—");
  assert.equal(text.publicationNoteText({ publish: ["google_calendar", "discord"], update: [] }), "Will publish to Discord and Google Calendar");
  assert.equal(text.publicationNoteText({ publish: ["google_calendar"], update: ["discord"] }), "Will publish to Google Calendar and update on Discord");
  assert.equal(text.publicationNoteText(undefined), "");
  const matched = { rowNumber: 4, action: "update" as const, activity: activity(), existing: { ...activity(), activityId: "a" }, changes: ["labels" as const] };
  assert.equal(text.issueText(matched), "Matches existing · changes labels"); assert.equal(text.issueText({ ...matched, changes: [] }), "Matches existing · no changes");
  assert.equal(text.issueText({ ...matched, changes: ["title", "time", "impact"] }), "Matches existing · changes title, time and impact relevant");
  assert.equal(text.issueText({ rowNumber: 5, action: "error", error: "Unknown team number 12345" }), "Unknown team number 12345");
  assert.equal(text.problemHeading(1), "1 row has a problem and won't be imported."); assert.equal(text.problemHeading(2), "2 rows have a problem and won't be imported.");
  assert.equal(text.problemText({ rowNumber: 5, action: "error", activity: activity({ title: "Test Robot Showcase" }), error: "Unknown team number 12345" }), "Row 5, Test Robot Showcase: unknown team number 12345.");
  assert.equal(text.summaryText({ add: 2, update: 1, skip: 0, error: 1 }), "2 to add, 1 to update, 1 with a problem.");
  assert.equal(text.importButtonText({ add: 2, update: 1, skip: 0, error: 1 }), "Import 3 activities (skip 1 row with a problem)"); assert.equal(text.importButtonText({ add: 1, update: 0, skip: 0, error: 0 }), "Import 1 activity");
  const rows = [matched, { ...matched, rowNumber: 6 }];
  assert.equal(text.choosable({ ...matched, action: "error", error: "Unknown Outreach label Test Label C" }), false, "a matching row with a problem shows Error, not a choice");
  assert.equal(text.bulkChoice(rows, {}), "skip"); assert.equal(text.bulkChoice(rows, { 4: "update", 6: "update" }), "update"); assert.equal(text.bulkChoice(rows, { 4: "update" }), "mixed"); assert.equal(text.bulkChoice([], {}), undefined);
  assert.equal(text.importedText({ rows: [], summary: { add: 2, update: 1, skip: 0, error: 1 }, imported: { added: 2, updated: 1, activityIds: [] }, publication: { queued: 1, providers: ["discord"] } }), "3 activities imported: 2 added, 1 updated. Event publication is queued and delivered a few at a time every five minutes.");
});

test("Import CSV opens the dialog from the Outreach page, which renders Core's import preview markup", () => {
  const workspace = readFileSync(new URL("../src/dashboard/outreach-workspace.tsx", import.meta.url), "utf8");
  const dialog = readFileSync(new URL("../src/dashboard/outreach-activity-import-dialog.tsx", import.meta.url), "utf8");
  // Just left of + Create activity, in both views, with the toolbar's third column for it.
  assert.match(workspace, /const importButton = <button className="ui-button" type="button" aria-haspopup="dialog" onClick=\{\(\) => setImporting\(true\)\}>Import CSV<\/button>/);
  assert.match(workspace, /compact-table-controls outreach-activity-browser-controls has-import-action ui-card/);
  assert.match(workspace, /\{importButton\}<button className="ui-button ui-button--primary" type="button" aria-haspopup="dialog" data-walkthrough="outreach-submission-sources" onClick=\{\(\) => setCreating\(true\)\}><span aria-hidden="true">\+ <\/span>Create activity/);
  // In the calendar it is MonthCalendar's secondaryAction: beside Create activity on desktop, below the month navigation on phones.
  assert.match(workspace, /secondaryAction=\{importButton\} action=\{<button className="ui-button ui-button--primary"/);
  assert.match(workspace, /<OutreachActivityImportDialog open=\{importing\} timeZone=\{context\.timeZone\}/);
  assert.match(dialog, /<h2 id="outreach-import-title">Import Outreach activities<\/h2>/);
  for (const marker of ['className="roster-import-dialog outreach-activity-import-dialog"', 'className="import-preview-bar"', 'className="meeting-view-toggle import-match-choice"', 'className="data-table roster-preview-table import-preview-table"', "import-row-select ${choice}", "change-badge ${row.action}", 'className="import-row-note"', 'className="import-arrow"', "import-issue-error", 'className="field-help import-preview-summary"', "Matching rows:", '"Skip all" : "Update all"', "Mixed"]) assert.ok(dialog.includes(marker), marker);
  // Every dialog control uses Core's shared UI classes, as Core's reviewed UI inventory asks.
  assert.deepEqual([...dialog.matchAll(/<button[^>]*>/g)].filter((tag) => !/className="ui-button[ "]/.test(tag[0])), []);
  assert.equal([...dialog.matchAll(/<button className="ui-button ui-button--primary"/g)].length, 2);
  assert.doesNotMatch(dialog, /primary-button/);
  assert.match(dialog, /<textarea className="ui-control code-textarea"/);
  // The preview's columns, in the approved order; each row is one fixed-height line (Core's import-preview-table rules).
  assert.match(dialog, /<th scope="col">Change<\/th><th scope="col">Title<\/th><th scope="col">Date<\/th><th scope="col">Type<\/th><th scope="col">Time<\/th><th scope="col">Team<\/th><th scope="col">Labels<\/th><th scope="col">Issues<\/th>/);
  assert.doesNotMatch(dialog, /<br|white-space|style=/, "no row-height overrides");
  assert.match(dialog, /"\/admin\/hours\/activities\/import"/);
});
