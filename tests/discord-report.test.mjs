// /outreach-report: a linked member's private Outreach participation summary in Discord. All people, Discord accounts,
// activities and dates here are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/sdk.mjs";
import { outreachDatabase } from "./helpers/d1.mjs";

const { outreachDiscordHandlers } = await import("../src/api/outreach-discord.ts");
const { outreachDiscordReport, outreachReportLengthGuard, outreachReportUnlinked } = await import("../src/shared/outreach-discord-report.ts");
const manifest = (await import("../src/manifest.ts")).default;

const discordUser = "100000000000000001";
const now = Date.parse("2026-11-20T17:00:00.000Z");
const hint = "Use /outreach-submit to record participation or /outreach-correction to ask Staff to review an entry.";
const interaction = (overrides = {}) => ({ id: "200000000000000001", type: 2, data: { name: "outreach-report" }, member: { user: { id: discordUser } }, ...overrides });
const report = (db, value = interaction()) => outreachDiscordHandlers["outreach-report"](db, value, now);

function linkedDatabase() {
  const db = outreachDatabase();
  db.raw.prepare("UPDATE members SET discord_user_id=? WHERE id='member-a'").run(discordUser);
  return db;
}
const setStartDate = (db, startsOn) => db.raw.prepare("INSERT INTO module_report_baselines(installation_id,module_id,starts_on,revision,updated_at) VALUES ('primary','hour-tracking',?,0,'2026-01-01T00:00:00.000Z')").run(startsOn);
const categories = { event: "event", team: "team-support", task: "other-service" };
function activity(db, id, mode, serviceDate, title = `Test ${id}`) {
  let team = null;
  if (mode === "team") {
    team = `team-${id}`;
    db.raw.prepare("INSERT INTO hours_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary',?,'99999','Test Robotics Team','FTC','2026-01-01','2026-01-01')").run(team);
  }
  db.raw.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,team_id,title,created_at,updated_at) VALUES ('primary',?,?,?,?,?,?,'2026-01-01','2026-01-01')")
    .run(id, categories[mode], mode, serviceDate, team, title);
  return id;
}
let sequence = 0;
/** A counted entry, at a distinct time of its service day so clock-timed entries never overlap. */
function entry(db, { id = `entry-${++sequence}`, member = "member-a", activityId, serviceDate, minutes, status = "counted", timing = "clock", notes = "" }) {
  const start = Date.parse(`${serviceDate}T00:00:00.000Z`) + (sequence % 6) * 4 * 3_600_000;
  db.raw.prepare(`INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,
    start_offset_seconds,end_offset_seconds,duration_minutes,task_notes,status,channel,attribution,created_at,updated_at,timing)
    VALUES ('primary',?,?,?,?,'America/New_York','12:00','13:00',?,?,0,0,?,?,?,'staff','staff_recorded','2026-01-01','2026-01-01',?)`)
    .run(id, member, activityId, serviceDate, start, start + minutes * 60_000, minutes, notes, status, timing);
  return id;
}
function correction(db, status, member = "member-a") {
  const id = `correction-${++sequence}`;
  db.raw.prepare(`INSERT INTO hours_correction_requests(installation_id,id,channel,attribution,requester_member_id,message,key_hash,fingerprint,status,revision,created_at,resolved_at)
    VALUES ('primary',?,'discord','linked_discord',?,'Please review my synthetic entry.',?,?,?,?,'2026-11-01',?)`)
    .run(id, member, `key-${id}`, `fp-${id}`, status, status === "open" ? 0 : 1, status === "open" ? null : "2026-11-02");
}

test("handler keys equal the declared Discord command names, and /outreach-report takes no options", () => {
  assert.deepEqual(Object.keys(outreachDiscordHandlers).sort(), manifest.discordCommands.map((command) => command.name).sort());
  const command = manifest.discordCommands.find((item) => item.name === "outreach-report");
  assert.deepEqual(command, { name: "outreach-report", type: 1, description: "Privately view your Outreach participation summary" });
});

test("an account that is not linked to exactly one active member gets the roster-link reply", async () => {
  const unlinked = outreachDatabase();
  assert.equal(await report(unlinked), outreachReportUnlinked);
  assert.match(outreachReportUnlinked, /Use \/pair with your member ID, or ask an Operator to check your roster link\.$/);

  const inactive = linkedDatabase();
  inactive.raw.prepare("UPDATE members SET active=0 WHERE id='member-a'").run();
  assert.equal(await report(inactive), outreachReportUnlinked);

  // Core's members index allows one member per Discord account; the reply still refuses if two ever share one.
  const shared = linkedDatabase();
  shared.raw.prepare("UPDATE members SET discord_user_id=? WHERE id='member-b'").run(discordUser);
  entry(shared, { activityId: activity(shared, "shared-event", "event", "2026-11-10"), serviceDate: "2026-11-10", minutes: 60 });
  assert.equal(await report(shared), outreachReportUnlinked);
});

test("options and malformed Discord identities are refused as other Outreach commands refuse them", async () => {
  const db = linkedDatabase();
  await assert.rejects(report(db, interaction({ data: { name: "outreach-report", options: [{ name: "member", value: "TEST-B" }] } })), { status: 400, message: "This Outreach command is malformed. Try it again." });
  await assert.rejects(report(db, interaction({ member: { user: { id: "not-a-snowflake" } } })), { status: 400, message: "Use this command from a linked Discord account." });
  assert.match(await report(db, interaction({ member: undefined, user: { id: discordUser } })), /^\*\*Your Outreach participation\*\*/);
});

test("no counted participation, with and without a reporting start date", async () => {
  const db = linkedDatabase();
  assert.equal(await report(db), `**Your Outreach participation**\nNo counted Outreach participation yet.\n\n${hint}`);
  correction(db, "open");
  setStartDate(db, "2026-09-01");
  assert.equal(await report(db), `**Your Outreach participation**\nNo counted Outreach participation since 2026-09-01.\n\nOpen correction requests: 1. Totals change only after Staff review.\n${hint}`);
});

test("voided entries, other members' entries and task notes never appear", async () => {
  const db = linkedDatabase();
  const event = activity(db, "void-event", "event", "2026-11-10", "Test Library Night");
  const kept = entry(db, { activityId: event, serviceDate: "2026-11-10", minutes: 90, notes: "Synthetic private note" });
  const voided = entry(db, { activityId: event, serviceDate: "2026-11-10", minutes: 60, status: "void" });
  entry(db, { member: "member-b", activityId: event, serviceDate: "2026-11-10", minutes: 30 });
  const content = await report(db);
  assert.match(content, /All time: \*\*1\.50 hours\*\* across \*\*1 activity\*\* \(1 entry\)\./);
  assert.match(content, new RegExp(`receipt \`${kept}\``));
  assert.doesNotMatch(content, new RegExp(voided));
  assert.doesNotMatch(content, /Synthetic private note/);
});

test("totals split at the reporting start date, inclusive, with distinct activities by type and two-decimal hours", async () => {
  const db = linkedDatabase();
  setStartDate(db, "2026-09-01");
  const before = activity(db, "event-before", "event", "2026-08-31", "Test Summer Camp");
  const onStart = activity(db, "event-on-start", "event", "2026-09-01", "Test Kickoff");
  const team = activity(db, "team-support", "team", "2026-10-05", "Team support: 99999 Test Robotics Team");
  const task = activity(db, "task", "task", "2026-10-06", "Test Tutoring");
  entry(db, { activityId: before, serviceDate: "2026-08-31", minutes: 120 });
  entry(db, { activityId: onStart, serviceDate: "2026-09-01", minutes: 7 });
  entry(db, { activityId: onStart, serviceDate: "2026-09-01", minutes: 8 });
  entry(db, { activityId: team, serviceDate: "2026-10-05", minutes: 10 });
  entry(db, { activityId: task, serviceDate: "2026-10-06", minutes: 60, timing: "duration" });
  const content = await report(db);
  assert.equal(content.split("\n\n")[0], [
    "**Your Outreach participation**",
    "Since 2026-09-01 (Outreach reporting start date): **1.42 hours** across **3 activities** (4 entries).",
    "• Event: 0.25 hours (1 activity)",
    "• Team Support: 0.17 hours (1 activity)",
    "• Other Service: 1.00 hours (1 activity)",
    "All time: 3.42 hours across 4 activities.",
  ].join("\n"));

  // 7 + 8 + 10 minutes is 0.4166... hours, shown as the dashboard shows it.
  const rounding = linkedDatabase();
  const one = activity(rounding, "round-1", "event", "2026-11-01"); const two = activity(rounding, "round-2", "event", "2026-11-02");
  entry(rounding, { activityId: one, serviceDate: "2026-11-01", minutes: 7 });
  entry(rounding, { activityId: one, serviceDate: "2026-11-01", minutes: 8 });
  entry(rounding, { activityId: two, serviceDate: "2026-11-02", minutes: 10 });
  const rounded = await report(rounding);
  assert.match(rounded, /All time: \*\*0\.42 hours\*\* across \*\*2 activities\*\* \(3 entries\)\.\n• Event: 0\.42 hours \(2 activities\)\n\n/);
  assert.doesNotMatch(rounded, /Team Support:|Other Service:/, "types without activities are left out");
});

test("a start date with participation only before it says so, then gives the all-time line", async () => {
  const db = linkedDatabase();
  setStartDate(db, "2026-09-01");
  entry(db, { activityId: activity(db, "old", "event", "2026-08-01", "Test Old Event"), serviceDate: "2026-08-01", minutes: 30 });
  const content = await report(db);
  assert.match(content, /^\*\*Your Outreach participation\*\*\nNo counted Outreach participation since 2026-09-01\.\nAll time: 0\.50 hours across 1 activity\.\n\n\*\*Recent participation\*\*\n/);
});

test("recent participation lists the 5 latest counted entries, newest first, duration-only entries included", async () => {
  const db = linkedDatabase();
  const ids = [];
  for (let day = 1; day <= 7; day++) {
    const date = `2026-11-0${day}`;
    ids.push(entry(db, { activityId: activity(db, `recent-${day}`, day === 7 ? "task" : "event", date, `Test Night ${day}`), serviceDate: date, minutes: 30 * day, timing: day === 7 ? "duration" : "clock" }));
  }
  const recent = (await report(db)).split("**Recent participation**\n")[1].split("\n").filter((line) => line.startsWith("• "));
  assert.deepEqual(recent, [7, 6, 5, 4, 3].map((day) => `• 2026-11-0${day} - Test Night ${day} - ${(30 * day / 60).toFixed(2)} hours (receipt \`${ids[day - 1]}\`)`));
});

test("only open correction requests are counted", async () => {
  const db = linkedDatabase();
  correction(db, "resolved");
  assert.doesNotMatch(await report(db), /Open correction requests/);
  correction(db, "open"); correction(db, "open"); correction(db, "open", "member-b");
  assert.match(await report(db), /\nOpen correction requests: 2\. Totals change only after Staff review\.\n/);
});

test("titles lose Discord markdown and the reply stays within Discord's limit", async () => {
  const db = linkedDatabase();
  setStartDate(db, "2026-01-01");
  for (let day = 1; day <= 6; day++) {
    const date = `2026-10-1${day}`;
    entry(db, { activityId: activity(db, `long-${day}`, "event", date, `**Bold** _${day}_ @everyone ${"x".repeat(150)}`.slice(0, 150)), serviceDate: date, minutes: 45 });
  }
  correction(db, "open");
  const content = await report(db);
  assert.ok(content.length <= 2000, `${content.length} characters`);
  assert.doesNotMatch(content.split("**Recent participation**")[1], /\*\*|_|@/);
  assert.equal((content.match(/^• 2026-10-1/gm) ?? []).length, 5);

  // The formatter itself stops adding entries at the guard, keeping the footer.
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `${crypto.randomUUID()}-${index}`, serviceDate: "2026-10-01", title: "y".repeat(150), mode: "event", durationMinutes: 60 }));
  const capped = outreachDiscordReport({ startsOn: null, totals: [{ mode: "event", entries: 20, activities: 1, minutes: 1200, periodEntries: 0, periodActivities: 0, periodMinutes: 0 }], recent: many, openCorrections: 3 });
  assert.ok(capped.length <= 2000, `${capped.length} characters`);
  assert.match(capped, /\nMore entries omitted to fit Discord\.\nOpen correction requests: 3\. Totals change only after Staff review\.\nUse \/outreach-submit/);
  assert.ok(capped.split("\nMore entries omitted")[0].length + "\nOpen correction requests: 3. Totals change only after Staff review.\n".length + hint.length <= outreachReportLengthGuard);
});

/**
 * Core's module-scoped database: first() and all() reads started in the same tick go out as one D1 batch
 * (apps/api/src/d1-coalesce.ts readCoalescer). This records each batch so a test can count them.
 */
function coalescing(db) {
  const batches = []; let queue;
  const flush = async (items) => {
    batches.push(items.map((item) => item.statement.sql));
    try { const results = await db.batch(items.map((item) => item.statement)); items.forEach((item, index) => item.resolve(results[index])); }
    catch (error) { for (const item of items) item.reject(error); }
  };
  const read = (statement) => new Promise((resolve, reject) => {
    if (!queue) { const items = queue = []; queueMicrotask(() => { queue = undefined; void flush(items); }); }
    queue.push({ statement, resolve, reject });
  });
  const wrap = (statement) => ({
    bind: (...values) => wrap(statement.bind(...values)),
    async first() { return (await read(statement)).results?.[0] ?? null; },
    async all() { return read(statement); },
    async run() { throw new Error("/outreach-report must not write"); },
  });
  return { batches, prepare: (sql) => wrap(db.prepare(sql)), batch: () => { throw new Error("unexpected explicit batch"); } };
}

test("the handler issues its four reads together, as one D1 batch", async () => {
  const db = linkedDatabase();
  setStartDate(db, "2026-09-01");
  entry(db, { activityId: activity(db, "batched", "event", "2026-11-10", "Test Batched Event"), serviceDate: "2026-11-10", minutes: 60 });
  correction(db, "open");
  const scoped = coalescing(db);
  const content = await report(scoped);
  assert.equal(scoped.batches.length, 1);
  assert.equal(scoped.batches[0].length, 4);
  assert.match(content, /Since 2026-09-01 \(Outreach reporting start date\): \*\*1\.00 hours\*\* across \*\*1 activity\*\* \(1 entry\)\./);
  assert.match(content, /Open correction requests: 1\./);
});
