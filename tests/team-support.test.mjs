import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { outreachDatabase } from "./helpers/d1.mjs";

const stub = new URL("./helpers/module-sdk-stub.mjs", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: stub, shortCircuit: true } : next(specifier, context) });
const { ensureSupportedTeam, ensureTeamSupportActivity, findSupportedTeams } = await import("../src/api/outreach-team-support.ts");
const viaGrant = { moduleId: "visits", grantId: "grant-1" };
const count = (db, sql) => db.raw.prepare(sql).get().n;

test("supported teams are found by number and program, and created once", async () => {
  const db = outreachDatabase();
  assert.deepEqual(await findSupportedTeams(db, { number: "321", program: "FRC" }), { teams: [] });
  const first = await ensureSupportedTeam(db, viaGrant, { number: " 321 ", name: "Lancers", program: "FRC" });
  assert.equal(first.created, true); assert.equal(first.team.number, "321"); assert.equal(first.team.program, "FRC");
  assert.deepEqual(await ensureSupportedTeam(db, viaGrant, { number: "321", name: "Other name", program: "FRC" }), { team: first.team, created: false });
  // The same number in another program is a different team.
  assert.equal((await ensureSupportedTeam(db, viaGrant, { number: "321", name: "Lancers FTC", program: "FTC" })).created, true);
  assert.equal((await findSupportedTeams(db, { number: "321", program: "FRC" })).teams.length, 1);
  // Each creation is audited with the calling module and grant, and no user.
  const audits = db.raw.prepare("SELECT actor_user_id, action, metadata_json FROM audit_log ORDER BY created_at").all();
  assert.equal(audits.length, 2);
  assert.deepEqual({ ...audits[0], metadata_json: JSON.parse(audits[0].metadata_json) }, { actor_user_id: null, action: "outreach.teams.created", metadata_json: { number: "321", program: "FRC", viaModule: "visits", grantId: "grant-1" } });
});

test("an archived supported team is never revived or duplicated", async () => {
  const db = outreachDatabase();
  const { team } = await ensureSupportedTeam(db, viaGrant, { number: "5000", name: "Retired", program: "FTC" });
  db.raw.prepare("UPDATE hours_teams SET archived=1 WHERE id=?").run(team.id);
  await assert.rejects(ensureSupportedTeam(db, viaGrant, { number: "5000", name: "Retired", program: "FTC" }), (error) => error.status === 409 && /archived/.test(error.message));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_teams"), 1);
  assert.deepEqual((await findSupportedTeams(db, { number: "5000", program: "FTC" })).teams.map((item) => item.archived), [true]);
});

test("one Team Support activity per team and date, created idempotently", async () => {
  const db = outreachDatabase();
  const { team } = await ensureSupportedTeam(db, { moduleId: "visits", userId: "admin" }, { number: "1218", name: "Vulcan Robotics", program: "FRC" });
  const first = await ensureTeamSupportActivity(db, viaGrant, { teamId: team.id, serviceDate: "2026-11-02" });
  assert.equal(first.created, true);
  const row = db.raw.prepare("SELECT mode, category_id, title, impact_relevant, team_id FROM hours_activities").get();
  assert.deepEqual({ ...row }, { mode: "team", category_id: "team-support", title: "Team support: 1218 Vulcan Robotics", impact_relevant: 1, team_id: team.id });
  assert.deepEqual(await ensureTeamSupportActivity(db, viaGrant, { teamId: team.id, serviceDate: "2026-11-02", title: "Ignored" }), { activityId: first.activityId, created: false });
  const second = await ensureTeamSupportActivity(db, viaGrant, { teamId: team.id, serviceDate: "2026-11-04", title: "Swerve help" });
  assert.notEqual(second.activityId, first.activityId);
  assert.equal(db.raw.prepare("SELECT title FROM hours_activities WHERE id=?").get(second.activityId).title, "Swerve help");
  // Concurrent calls for the same team and date still produce one activity and one audit entry.
  const raced = await Promise.all([1, 2, 3].map(() => ensureTeamSupportActivity(db, viaGrant, { teamId: team.id, serviceDate: "2026-11-09" })));
  assert.equal(new Set(raced.map((item) => item.activityId)).size, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_activities WHERE service_date='2026-11-09'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action='outreach.activities.created'"), 3);
});

test("team support refuses archived teams, a retired activity type and invalid input", async () => {
  const db = outreachDatabase();
  const { team } = await ensureSupportedTeam(db, viaGrant, { number: "100", name: "Wildhats", program: "FRC" });
  await assert.rejects(ensureTeamSupportActivity(db, viaGrant, { teamId: "missing", serviceDate: "2026-11-02" }), (error) => error.status === 404);
  db.raw.exec("UPDATE hours_categories SET archived=1");
  await assert.rejects(ensureTeamSupportActivity(db, viaGrant, { teamId: team.id, serviceDate: "2026-11-02" }), (error) => error.status === 409 && /Team Support is unavailable/.test(error.message));
  db.raw.exec("UPDATE hours_categories SET archived=0");
  db.raw.prepare("UPDATE hours_teams SET archived=1 WHERE id=?").run(team.id);
  await assert.rejects(ensureTeamSupportActivity(db, viaGrant, { teamId: team.id, serviceDate: "2026-11-02" }), (error) => error.status === 409 && /archived/.test(error.message));
  for (const input of [null, {}, { teamId: team.id, serviceDate: "2026-02-30" }, { teamId: team.id, serviceDate: "Nov 2" }, { teamId: team.id, serviceDate: "2026-11-02", title: "" }]) await assert.rejects(ensureTeamSupportActivity(db, viaGrant, input), (error) => error.status === 400, JSON.stringify(input));
  for (const input of [null, { number: "1", name: "A", program: "Other" }, { number: "", name: "A", program: "FRC" }, { number: "1", name: " ", program: "FRC" }, { number: "x".repeat(33), name: "A", program: "FRC" }]) await assert.rejects(ensureSupportedTeam(db, viaGrant, input), (error) => error.status === 400, JSON.stringify(input));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM hours_activities"), 0);
});
