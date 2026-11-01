// Members log Team support and Other service from the public form without a Staff-created activity. All people, teams
// and dates here are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/sdk.mjs";
import { applyPluginMigrations, coreBaselineDatabase, d1, outreachDatabase } from "./helpers/d1.mjs";

const { outreachPublicRoute } = await import("../src/api/outreach-public.ts");
const { outreachEntryRoute } = await import("../src/api/outreach-entries.ts");
const { outreachReviewRoute } = await import("../src/api/outreach-review.ts");
const { outreachCatalogRoute } = await import("../src/api/outreach-catalogs.ts");
const { outreachReportHandlers } = await import("../src/api/outreach-reporting.ts");
const { outreachBackupAdapter, outreachBackupTables } = await import("../src/api/outreach-backup.ts");
const { ensureSupportedTeam } = await import("../src/api/outreach-team-support.ts");

const origin = "https://dashboard.example.test";
// 2026-10-31 12:00 in America/New_York. With the default 30-day window, 2026-10-02 is the earliest service date.
const now = Date.parse("2026-10-31T16:00:00.000Z");
const zone = "America/New_York";
const count = (db, sql, ...values) => db.raw.prepare(sql).get(...values).n;
const key = () => `synthetic-${crypto.randomUUID()}`;

function submit(db, input, at = now) {
  return outreachPublicRoute(db, new Request("https://api.example.test/public/hours/entries", { method: "POST", headers: { origin } }), origin, input, at);
}
const staff = (db, method, path, input, at = now) => outreachEntryRoute(db, "admin", new Request(`https://api.example.test${path}`, { method }), input, at);
const catalog = (db, method, path, input, at = now) => outreachCatalogRoute(db, "admin", new Request(`https://api.example.test${path}`, { method }), input, undefined, at);
const team = (overrides = {}) => ({ kind: "team", memberExternalId: "TEST-A", serviceDate: "2026-10-30", durationMinutes: 90, idempotencyKey: key(), expectedTimeZone: zone, ...overrides });
const other = (overrides = {}) => ({ kind: "other", memberExternalId: "TEST-A", serviceDate: "2026-10-30", durationMinutes: 45, taskNotes: "STEM tutoring", idempotencyKey: key(), expectedTimeZone: zone, ...overrides });
const entry = (db, id) => db.raw.prepare("SELECT * FROM hours_entries WHERE id=?").get(id);
const activityOf = (db, id) => db.raw.prepare("SELECT a.* FROM hours_entries e JOIN hours_activities a ON a.id=e.activity_id WHERE e.id=?").get(id);
async function supportedTeam(db, number = "1218", program = "FRC", name = "Test Robotics One") {
  return (await ensureSupportedTeam(db, { moduleId: "hour-tracking", userId: "admin" }, { number, program, name })).team;
}

test("team support for a team on the supported teams list counts immediately as a duration", async () => {
  const db = outreachDatabase(); const existing = await supportedTeam(db);
  const result = await submit(db, team({ teamId: existing.id, taskNotes: "Helped with swerve wiring" }));
  assert.equal(result.status, 201);
  assert.deepEqual({ ...result.body, id: undefined, createdAt: undefined }, { id: undefined, serviceDate: "2026-10-30", startLocal: "00:00", endLocal: "01:30", durationMinutes: 90, timing: "duration", channel: "public", createdAt: undefined });
  const row = entry(db, result.body.id);
  assert.deepEqual({ status: row.status, timing: row.timing, attribution: row.attribution, notes: row.task_notes, interval: row.end_ms - row.start_ms }, { status: "counted", timing: "duration", attribution: "self_asserted", notes: "Helped with swerve wiring", interval: 90 * 60_000 });
  // The duration is anchored at the first instant of the service day in the installation time zone.
  assert.equal(row.start_ms, Date.parse("2026-10-30T04:00:00.000Z"));
  const activity = activityOf(db, result.body.id);
  assert.deepEqual({ mode: activity.mode, category: activity.category_id, team: activity.team_id, title: activity.title, date: activity.service_date }, { mode: "team", category: "team-support", team: existing.id, title: "Team support: 1218 Test Robotics One", date: "2026-10-30" });
  // Another member, and a second block for the same member, reuse that one Team Support activity. Duration-only time never overlaps.
  const second = await submit(db, team({ teamId: existing.id, memberExternalId: "TEST-B", durationMinutes: 30 }));
  const third = await submit(db, team({ teamId: existing.id, durationMinutes: 60 }));
  assert.equal(activityOf(db, second.body.id).id, activity.id); assert.equal(activityOf(db, third.body.id).id, activity.id);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_activities"), 1);
  // A clock entry at the time the duration is anchored to is not an overlap either.
  db.raw.exec("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES ('primary','event-1','event','event','2026-10-30','Synthetic Expo','2026-10-01','2026-10-01')");
  const clock = await submit(db, { memberExternalId: "TEST-A", activityId: "event-1", serviceDate: "2026-10-30", startLocal: "00:00", endLocal: "01:00", idempotencyKey: key(), expectedTimeZone: zone });
  assert.equal(clock.status, 201); assert.equal(entry(db, clock.body.id).timing, "clock");
  // Revision history and the saved receipt both carry the timing.
  assert.equal(JSON.parse(db.raw.prepare("SELECT snapshot_json FROM hours_entry_revisions WHERE entry_id=?").get(result.body.id).snapshot_json).timing, "duration");
  const totals = await staff(db, "GET", "/admin/hours/totals");
  assert.deepEqual({ ...totals.body.summary }, { entries: 4, participants: 2, countedMinutes: 240 });
  assert.equal(totals.body.teams.find((item) => item.id === existing.id).countedMinutes, 180);
});

test("a new team is added to the supported teams list once, flagged as added by a member", async () => {
  const db = outreachDatabase();
  const first = await submit(db, team({ team: { number: " 9999 ", program: "FTC", name: "Test Robots" } }));
  assert.equal(first.status, 201);
  const added = db.raw.prepare("SELECT * FROM hours_teams").get();
  assert.deepEqual({ number: added.number, program: added.program, name: added.name, flagged: added.added_by_member, archived: added.archived }, { number: "9999", program: "FTC", name: "Test Robots", flagged: 1, archived: 0 });
  assert.equal(activityOf(db, first.body.id).team_id, added.id);
  const audit = db.raw.prepare("SELECT actor_user_id,metadata_json FROM audit_log WHERE action='outreach.teams.created'").get();
  assert.deepEqual({ actor: audit.actor_user_id, metadata: JSON.parse(audit.metadata_json) }, { actor: null, metadata: { number: "9999", program: "FTC", addedByMember: true, channel: "public" } });
  // The same number and program, in any letter case or spacing, is the same team; its first name is kept.
  const second = await submit(db, team({ memberExternalId: "TEST-B", serviceDate: "2026-10-29", team: { name: "Different Name", program: "FTC", number: "9999  " } }));
  assert.equal(second.status, 201); assert.equal(activityOf(db, second.body.id).team_id, added.id);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_teams"), 1);
  // The same number in another program is another team.
  await submit(db, team({ team: { number: "9999", program: "FRC", name: "Test Robots FRC" }, serviceDate: "2026-10-28" }));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_teams WHERE added_by_member=1"), 2);
  // A member who names an existing Staff-added team never flags it.
  const staffTeam = await supportedTeam(db, "254", "FRC", "Test Staff Team");
  await submit(db, team({ team: { number: "254", program: "FRC", name: "Whatever" } }));
  assert.equal(db.raw.prepare("SELECT added_by_member FROM hours_teams WHERE id=?").get(staffTeam.id).added_by_member, 0);

  // Outreach Settings > Supported teams shows the flag, filters to member-added teams and lets Staff mark one reviewed.
  const listed = await catalog(db, "GET", "/admin/hours/teams?archived=all&limit=100");
  assert.deepEqual(listed.body.items.map((item) => [item.number, item.program, item.addedByMember]).sort(), [["254", "FRC", false], ["9999", "FRC", true], ["9999", "FTC", true]]);
  assert.equal(listed.body.memberAddedCount, 2);
  const flagged = await catalog(db, "GET", "/admin/hours/teams?addedBy=member&limit=100");
  assert.deepEqual(flagged.body.items.map((item) => item.program).sort(), ["FRC", "FTC"]); assert.equal(flagged.body.total, 2);
  await assert.rejects(catalog(db, "GET", "/admin/hours/teams?addedBy=staff"), (error) => error.status === 400);
  const reviewed = await catalog(db, "PATCH", `/admin/hours/teams/${added.id}`, { revision: 0, addedByMember: false });
  assert.equal(reviewed.body.addedByMember, false); assert.equal(reviewed.body.revision, 1);
  assert.equal(JSON.parse(db.raw.prepare("SELECT metadata_json FROM audit_log WHERE action='outreach.teams.updated'").get().metadata_json).memberAdditionReviewed, true);
  await assert.rejects(catalog(db, "PATCH", `/admin/hours/teams/${added.id}`, { revision: 1, addedByMember: true }), (error) => error.status === 400);
  await assert.rejects(catalog(db, "POST", "/admin/hours/teams", { name: "Staff", number: "1", program: "FRC", addedByMember: true }), (error) => error.status === 400);
  // A team Staff archived is never revived or duplicated by a member.
  db.raw.prepare("UPDATE hours_teams SET archived=1 WHERE id=?").run(added.id);
  const refused = await submit(db, team({ team: { number: "9999", program: "FTC", name: "Test Robots" }, serviceDate: "2026-10-27" }));
  assert.equal(refused.status, 409); assert.match(refused.body.error, /no longer on the supported teams list/); assert.equal(refused.body.retryExact, false);
  const byId = await submit(db, team({ teamId: added.id, serviceDate: "2026-10-27" }));
  assert.equal(byId.status, 409); assert.match(byId.body.error, /no longer on the supported teams list/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_teams"), 3);
});

test("other service records a duration and a short description on an activity titled with it", async () => {
  const db = outreachDatabase();
  const first = await submit(db, other());
  assert.equal(first.status, 201); assert.equal(first.body.timing, "duration"); assert.equal(first.body.durationMinutes, 45);
  const activity = activityOf(db, first.body.id);
  assert.deepEqual({ mode: activity.mode, category: activity.category_id, title: activity.title, team: activity.team_id, location: activity.location }, { mode: "task", category: "other-service", title: "STEM tutoring", team: null, location: "" });
  assert.equal(entry(db, first.body.id).task_notes, "STEM tutoring");
  // The same description on that date, in any letter case, shares the activity. Another description gets its own.
  const same = await submit(db, other({ memberExternalId: "TEST-B", taskNotes: "  stem TUTORING " }));
  assert.equal(activityOf(db, same.body.id).id, activity.id); assert.equal(entry(db, same.body.id).task_notes, "stem TUTORING");
  const different = await submit(db, other({ taskNotes: "Library robotics demo" }));
  assert.notEqual(activityOf(db, different.body.id).id, activity.id);
  // A Staff-created Other service activity with that title on that date is reused.
  db.raw.exec("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES ('primary','staff-food','other-service','task','2026-10-29','Food drive','2026-10-01','2026-10-01')");
  assert.equal(activityOf(db, (await submit(db, other({ serviceDate: "2026-10-29", taskNotes: "food drive" }))).body.id).id, "staff-food");
  // One that Staff archived closes that description to members on that date.
  db.raw.exec("UPDATE hours_activities SET archived=1 WHERE id='staff-food'");
  const closed = await submit(db, other({ serviceDate: "2026-10-29", taskNotes: "Food drive" }));
  assert.equal(closed.status, 409); assert.match(closed.body.error, /Staff closed that activity/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_activities WHERE mode='task'"), 3);
});

test("self-logged submissions refuse invalid input without creating teams or activities", async () => {
  const db = outreachDatabase(); const existing = await supportedTeam(db);
  const refuse = async (input, status, pattern) => {
    const result = await submit(db, input);
    assert.equal(result.status, status, JSON.stringify(input)); assert.match(result.body.error, pattern, JSON.stringify(input)); assert.equal(result.body.retryExact, false);
  };
  await refuse(other({ taskNotes: undefined }), 400, /Describe the service in 1 to 150 characters/);
  await refuse(other({ taskNotes: "   " }), 400, /Describe the service/);
  await refuse(other({ taskNotes: "x".repeat(151) }), 400, /Describe the service/);
  for (const durationMinutes of [0, -5, 1441, 1.5, "60", null, undefined]) await refuse(other({ durationMinutes }), 400, /duration of 1 to 1440 whole minutes/);
  await refuse(other({ serviceDate: "2026-09-30" }), 409, /outside the current 30-day reporting window/);
  await refuse(team({ team: { number: "77", program: "FRC", name: "Test Late" }, serviceDate: "2026-10-01" }), 409, /outside the current 30-day reporting window/);
  await refuse(other({ serviceDate: "2026-11-01" }), 409, /future service date/);
  await refuse(team({ team: { number: "77", program: "VEX", name: "Test Wrong Program" } }), 400, /Choose Explore, Challenge, FTC, or FRC/);
  await refuse(team({ team: { number: "", program: "FRC", name: "Test No Number" } }), 400, /team's number/);
  await refuse(team({ team: { number: "77", program: "FRC", name: " " } }), 400, /team's name/);
  await refuse(team({ team: { number: "77", program: "FRC", name: "Test", city: "Nowhere" } }), 400, /number, program and name/);
  await refuse(team({}), 400, /Choose a supported team or enter a new one/);
  await refuse(team({ teamId: existing.id, team: { number: "77", program: "FRC", name: "Test" } }), 400, /Choose a supported team or enter a new one/);
  await refuse(team({ teamId: "missing-team" }), 400, /Choose a team from the supported teams list/);
  await refuse(team({ teamId: existing.id, taskNotes: "x".repeat(501) }), 400, /500 characters/);
  await refuse(other({ teamId: existing.id }), 400, /does not take a supported team/);
  await refuse(team({ teamId: existing.id, startLocal: "09:00", endLocal: "10:00" }), 400, /only supported Outreach entry fields/);
  await refuse(team({ teamId: existing.id, kind: "meeting" }), 400, /only supported Outreach entry fields/);
  // An unknown member is refused before a new team is added.
  const unknown = await submit(db, team({ memberExternalId: "NOBODY", team: { number: "78", program: "FRC", name: "Test Unknown" } }));
  assert.equal(unknown.status, 400); assert.equal(unknown.body.code, "identity_not_verified");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_teams"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_activities"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_entries"), 0);
  // Self-logging is a public form channel only: Staff and Discord entries still need an activity.
  await assert.rejects(staff(db, "POST", "/admin/hours/entries", { kind: "team", memberId: "member-a", teamId: existing.id, serviceDate: "2026-10-30", durationMinutes: 30, staffReason: "Synthetic", idempotencyKey: key(), expectedTimeZone: zone }), (error) => error.status === 400);
});

test("a reopening lets members self-log for an earlier date", async () => {
  const db = outreachDatabase();
  db.raw.prepare("INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,reason,actor_user_id,created_at,updated_at) VALUES ('primary','window-1',NULL,?,?,'Synthetic reopening','admin','2026-10-31','2026-10-31')").run(now - 1000, now + 3_600_000);
  const result = await submit(db, other({ serviceDate: "2026-09-15" }));
  assert.equal(result.status, 201); assert.equal(result.body.serviceDate, "2026-09-15");
});

test("retrying the exact submission returns the original receipt and creates nothing new", async () => {
  const db = outreachDatabase();
  const input = team({ team: { number: "4242", program: "Challenge", name: "Test Retry Team" } });
  const first = await submit(db, input);
  assert.equal(first.status, 201);
  const again = await submit(db, structuredClone(input));
  assert.equal(again.status, 200); assert.deepEqual(again.body, first.body);
  // The new team's fields may arrive in any order.
  const reordered = await submit(db, { ...input, team: { name: "Test Retry Team", program: "Challenge", number: "4242" } });
  assert.equal(reordered.status, 200); assert.equal(reordered.body.id, first.body.id);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_entries"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_teams"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_activities"), 1);
  // The same key with different input is refused.
  const changed = await submit(db, { ...input, durationMinutes: 91 });
  assert.equal(changed.status, 409); assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_entries"), 1);
  // Concurrent identical submissions record one entry.
  const otherInput = other();
  const raced = await Promise.all([1, 2, 3].map(() => submit(db, structuredClone(otherInput))));
  assert.equal(new Set(raced.map((item) => item.body.id)).size, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_entries WHERE timing='duration' AND task_notes='STEM tutoring'"), 1);
});

test("Staff edit, correct and void duration-only entries by their minutes", async () => {
  const db = outreachDatabase();
  const { body: receipt } = await submit(db, other());
  const edited = await staff(db, "PATCH", `/admin/hours/entries/${receipt.id}`, { revision: 0, action: "corrected", reason: "Synthetic fix", durationMinutes: 120, taskNotes: "STEM tutoring, two sessions" });
  assert.deepEqual({ timing: edited.body.timing, minutes: edited.body.durationMinutes, notes: edited.body.taskNotes, revision: edited.body.revision, mode: edited.body.activityMode }, { timing: "duration", minutes: 120, notes: "STEM tutoring, two sessions", revision: 1, mode: "task" });
  const row = entry(db, receipt.id); assert.equal(row.end_ms - row.start_ms, 120 * 60_000);
  await assert.rejects(staff(db, "PATCH", `/admin/hours/entries/${receipt.id}`, { revision: 1, action: "corrected", reason: "Synthetic", startLocal: "09:00", endLocal: "10:00" }), (error) => error.status === 400 && /duration only/.test(error.message));
  await assert.rejects(staff(db, "PATCH", `/admin/hours/entries/${receipt.id}`, { revision: 1, action: "corrected", reason: "Synthetic", durationMinutes: 0 }), (error) => error.status === 400);
  // A member's correction request is resolved with a corrected duration.
  const request = await outreachPublicRoute(db, new Request("https://api.example.test/public/hours/corrections", { method: "POST", headers: { origin } }), origin, { memberExternalId: "TEST-A", receiptId: receipt.id, message: "It was 100 minutes", idempotencyKey: key() }, now);
  assert.equal(request.status, 202);
  const requestId = db.raw.prepare("SELECT id FROM hours_correction_requests").get().id;
  const listed = await outreachReviewRoute(db, "admin", new Request("https://api.example.test/admin/hours/corrections?status=open"), undefined, now);
  assert.equal(listed.body.items[0].timing, "duration");
  const resolved = await outreachReviewRoute(db, "admin", new Request(`https://api.example.test/admin/hours/corrections/${requestId}/resolve`, { method: "POST" }), { action: "corrected", note: "Synthetic review", requestRevision: 0, entryRevision: 1, durationMinutes: 100 }, now);
  assert.equal(resolved.status, 200); assert.equal(entry(db, receipt.id).duration_minutes, 100);
  const voided = await staff(db, "PATCH", `/admin/hours/entries/${receipt.id}`, { revision: 2, action: "voided", reason: "Synthetic duplicate" });
  assert.equal(voided.body.status, "void");
  assert.deepEqual(db.raw.prepare("SELECT revision,action,json_extract(snapshot_json,'$.timing') AS timing,json_extract(snapshot_json,'$.duration_minutes') AS minutes FROM hours_entry_revisions WHERE entry_id=? ORDER BY revision").all(receipt.id).map((item) => ({ ...item })),
    [{ revision: 0, action: "created", timing: "duration", minutes: 45 }, { revision: 1, action: "corrected", timing: "duration", minutes: 120 }, { revision: 2, action: "corrected", timing: "duration", minutes: 100 }, { revision: 3, action: "voided", timing: "duration", minutes: 100 }]);
  // An entry never changes its timing.
  assert.throws(() => db.raw.prepare("UPDATE hours_entries SET timing='clock',revision=revision+1 WHERE id=?").run(receipt.id), /hours_entry_provenance/);
});

test("reports count self-logged team support toward supported teams and show no times for duration-only entries", async () => {
  const db = outreachDatabase(); const existing = await supportedTeam(db);
  await submit(db, team({ teamId: existing.id, durationMinutes: 90 }));
  await submit(db, team({ teamId: existing.id, memberExternalId: "TEST-B", serviceDate: "2026-10-29", durationMinutes: 30 }));
  const { body: added } = await submit(db, team({ team: { number: "5555", program: "Explore", name: "Test Explorers" }, durationMinutes: 15 }));
  await submit(db, other({ durationMinutes: 60 }));
  const context = { from: "2026-10-01", to: "2026-10-31", today: "2026-10-31" }; const definition = {};
  const teams = await outreachReportHandlers["outreach.teams"](db, definition, context);
  const cells = (row, ...fields) => fields.map((field) => row.values[field].text);
  assert.deepEqual(teams.map((row) => cells(row, "outreach.team.number", "outreach.team.participants", "outreach.team.activities", "outreach.team.entries", "outreach.team.minutes")).sort(),
    [["1218", "2", "2", "2", "120"], ["5555", "1", "1", "1", "15"]]);
  const activities = await outreachReportHandlers["outreach.activities"](db, definition, context);
  assert.deepEqual(activities.map((row) => cells(row, "outreach.activity.mode", "outreach.activity.title", "outreach.activity.minutes")).sort(),
    [["Other service", "STEM tutoring", "60"], ["Team support", "Team support: 1218 Test Robotics One", "30"], ["Team support", "Team support: 1218 Test Robotics One", "90"], ["Team support", "Team support: 5555 Test Explorers", "15"]]);
  const entries = await outreachReportHandlers["outreach.entries"](db, definition, context);
  const row = entries.find((item) => item.id === added.id);
  assert.deepEqual(cells(row, "outreach.entry.start", "outreach.entry.end", "outreach.entry.minutes", "outreach.entry.channel"), ["N/A", "N/A", "15", "public"]);
  // Member totals include it too.
  const totals = await staff(db, "GET", "/admin/hours/totals");
  assert.deepEqual(totals.body.members.map((item) => [item.externalId, item.countedMinutes]), [["TEST-A", 165], ["TEST-B", 30]]);
});

test("backups round-trip member-added teams and duration-only entries, and version 3 sections gain the defaults", async () => {
  const db = outreachDatabase();
  await submit(db, team({ team: { number: "6006", program: "FTC", name: "Test Backup Team" } }));
  await submit(db, other());
  const exported = Object.fromEntries(Object.entries(outreachBackupTables).map(([table, columns]) => [table, db.raw.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
  assert.equal(exported.hours_teams[0].added_by_member, 1);
  assert.deepEqual(exported.hours_entries.map((row) => row.timing), ["duration", "duration"]);
  outreachBackupAdapter.validate(structuredClone(exported));
  // Restore into a fresh installation in declared order, as Core does, and compare.
  const restored = d1(applyPluginMigrations(coreBaselineDatabase()));
  restored.raw.exec("INSERT INTO installations(id) VALUES ('primary'); INSERT INTO users VALUES ('admin'); INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES ('member-a','primary','TEST-A','Test Student','A'),('member-b','primary','TEST-B','Test Student','B')");
  for (const [table, rows] of Object.entries(outreachBackupAdapter.neutralize(structuredClone(exported), {}))) for (const row of rows) restored.raw.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  for (const [table, columns] of Object.entries(outreachBackupTables)) assert.deepEqual(restored.raw.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row })), exported[table], table);
  // A version 3 plugin section predates both columns: every team was Staff-added and every entry had clock times.
  const version3 = structuredClone(exported);
  for (const row of version3.hours_teams) delete row.added_by_member;
  for (const row of version3.hours_entries) delete row.timing;
  const upgraded = outreachBackupAdapter.normalize(version3, 3, { backupSchemaVersion: 44, coreSection: false, exportedAt: "2026-10-31T00:00:00.000Z" });
  assert.deepEqual(upgraded.hours_teams.map((row) => row.added_by_member), [0]);
  assert.deepEqual(upgraded.hours_entries.map((row) => row.timing), ["clock", "clock"]);
  assert.deepEqual(Object.keys(upgraded.hours_entries[0]).sort(), [...outreachBackupTables.hours_entries].sort());
  assert.throws(() => outreachBackupAdapter.normalize(version3, 2, { backupSchemaVersion: 44, coreSection: false, exportedAt: "2026-10-31T00:00:00.000Z" }), (error) => error.status === 400);
  // Invalid values are refused before anything is written.
  assert.throws(() => outreachBackupAdapter.validate({ ...exported, hours_entries: exported.hours_entries.map((row) => ({ ...row, timing: "hours" })) }), /timing is invalid/);
  assert.throws(() => outreachBackupAdapter.validate({ ...exported, hours_teams: exported.hours_teams.map((row) => ({ ...row, added_by_member: 2 })) }), /team sources are invalid/);
});

test("the migration keeps existing teams and entries and still refuses overlapping clock times", () => {
  const raw = coreBaselineDatabase();
  raw.exec(`INSERT INTO installations(id) VALUES ('primary'); INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES ('member-a','primary','TEST-A','Test Student','A');
    INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES ('primary','event','Event','event','2026-01-01','2026-01-01');
    INSERT INTO hours_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary','team-old','100','Test Old Team','FRC','2026-01-01','2026-01-01');
    INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES ('primary','event-old','event','event','2026-10-01','Synthetic Old Event','2026-01-01','2026-01-01');
    INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,channel,attribution,created_at,updated_at)
      VALUES ('primary','entry-old','member-a','event-old','2026-10-01','UTC','09:00','10:00',1000*3600*9,1000*3600*10,0,0,60,'public','self_asserted','2026-10-01','2026-10-01');`);
  applyPluginMigrations(raw);
  assert.deepEqual({ ...raw.prepare("SELECT added_by_member FROM hours_teams").get() }, { added_by_member: 0 });
  assert.deepEqual({ ...raw.prepare("SELECT timing,duration_minutes,start_local FROM hours_entries").get() }, { timing: "clock", duration_minutes: 60, start_local: "09:00" });
  const insert = (id, start, end, timing) => raw.prepare(`INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,channel,attribution,timing,created_at,updated_at)
    VALUES ('primary',?,'member-a','event-old','2026-10-01','UTC','09:30','10:30',?,?,0,0,?,'public','self_asserted',?,'2026-10-01','2026-10-01')`).run(id, start, end, (end - start) / 60_000, timing);
  assert.throws(() => insert("entry-overlap", 1000 * 3600 * 9.5, 1000 * 3600 * 10.5, "clock"), /hours_overlap/);
  insert("entry-duration", 1000 * 3600 * 9.5, 1000 * 3600 * 10.5, "duration");
  assert.throws(() => insert("entry-bad", 1000 * 3600 * 11, 1000 * 3600 * 12, "hours"), /CHECK constraint/);
  assert.throws(() => raw.exec("UPDATE hours_teams SET added_by_member=2"), /CHECK constraint/);
});
