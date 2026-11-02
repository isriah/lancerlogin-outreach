// The public form checks a new team's number with FIRST through Core's shared FIRST connection (`services.first`). These
// tests use a fake `services.first` only and never reach a FIRST server. All teams, members and dates are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/sdk.mjs";
import { outreachDatabase } from "./helpers/d1.mjs";

const { outreachPublicRoute } = await import("../src/api/outreach-public.ts");
const { checkFirstTeam } = await import("../src/api/outreach-first.ts");
const { ensureSupportedTeam } = await import("../src/api/outreach-team-support.ts");

const origin = "https://dashboard.example.test";
// 2026-10-31 12:00 in America/New_York; 2026-10-30 is inside the default 30-day reporting window.
const now = Date.parse("2026-10-31T16:00:00.000Z");
const zone = "America/New_York";
const key = () => `synthetic-${crypto.randomUUID()}`;
const alpha = { program: "FRC", number: "99901", name: "Test Team Alpha", location: "Testville, Example State, USA", season: 2026, source: "events-api" };

/** A stand-in for Core's `services.first`: answers by "program:number", records each lookup, and never fetches anything. */
function fakeFirst(answers = {}) {
  const calls = [];
  return {
    calls,
    async lookupTeam(input) {
      calls.push({ ...input });
      const answer = answers[`${input.program}:${input.number}`];
      if (answer instanceof Error) throw answer;
      return answer ?? { status: "not-found" };
    },
  };
}
const found = (team) => ({ status: "found", team });

function lookup(first, query) {
  return outreachPublicRoute(outreachDatabase(), new Request(`https://api.example.test/public/hours/team-lookup?${query}`), origin, undefined, now, first);
}
function submit(db, input, first) {
  return outreachPublicRoute(db, new Request("https://api.example.test/public/hours/entries", { method: "POST", headers: { origin } }), origin, input, now, first);
}
const newTeam = (team, overrides = {}) => ({ kind: "team", memberExternalId: "TEST-A", serviceDate: "2026-10-30", durationMinutes: 60, idempotencyKey: key(), expectedTimeZone: zone, team, ...overrides });
const teams = (db) => db.raw.prepare("SELECT number,program,name,added_by_member AS flagged FROM hours_teams ORDER BY program,number").all().map((row) => ({ ...row }));

test("a FIRST check answers found with FIRST's name and season, not found, or unavailable for anything else", async () => {
  const first = fakeFirst({ "FRC:99901": found(alpha), "FTC:99902": { status: "unavailable", reason: "rate-limited" }, "FRC:99903": new Error("synthetic failure"), "FTC:99904": found({ ...alpha, program: "FTC", name: "   " }) });
  assert.deepEqual(await checkFirstTeam(first, "FRC", " 99901 "), { status: "found", name: "Test Team Alpha", season: 2026 });
  assert.deepEqual(first.calls, [{ program: "FRC", number: "99901" }], "the number is trimmed before it is sent");
  assert.deepEqual(await checkFirstTeam(first, "FTC", "99999"), { status: "not-found" });
  assert.deepEqual(await checkFirstTeam(first, "FTC", "99902"), { status: "unavailable" });
  assert.deepEqual(await checkFirstTeam(first, "FRC", "99903"), { status: "unavailable" }, "a thrown error never escapes");
  assert.deepEqual(await checkFirstTeam(first, "FTC", "99904"), { status: "unavailable" }, "a found team needs a name");
  // A missing or implausible season is left out; the team is still found by name.
  for (const season of [undefined, null, "2026", 2026.5, 1999, 3000]) {
    const answer = found({ ...alpha, season }); if (season === undefined) delete answer.team.season;
    assert.deepEqual(await checkFirstTeam(fakeFirst({ "FRC:99901": answer }), "FRC", "99901"), { status: "found", name: "Test Team Alpha" }, `season ${season}`);
  }
  // Long names are cut to the supported-team limit.
  assert.equal((await checkFirstTeam(fakeFirst({ "FRC:1": found({ ...alpha, number: "1", name: "T".repeat(200) }) }), "FRC", "1")).name.length, 150);
  // FIRST is never asked about a number it cannot hold, an unknown program, or without a connection.
  const unused = fakeFirst();
  for (const [program, number] of [["FRC", "TEST-1"], ["FRC", "1234567"], ["FRC", ""], ["VEX", "99901"], ["FRC", 99901]]) assert.deepEqual(await checkFirstTeam(unused, program, number), { status: "unavailable" });
  assert.deepEqual(unused.calls, []);
  assert.deepEqual(await checkFirstTeam(undefined, "FRC", "99901"), { status: "unavailable" });
});

test("the public team lookup returns only what the form needs", async () => {
  const first = fakeFirst({ "FRC:99901": found(alpha), "FTC:99902": { status: "unavailable", reason: "not-configured" } });
  assert.deepEqual(await lookup(first, "program=FRC&number=99901"), { status: 200, body: { status: "found", name: "Test Team Alpha", season: 2026 } });
  // FIRST's other team details, such as the location, stay on the server; a team without a season answers without one.
  const { season: _season, ...seasonless } = alpha;
  assert.deepEqual(await lookup(fakeFirst({ "FRC:99901": found(seasonless) }), "program=FRC&number=99901"), { status: 200, body: { status: "found", name: "Test Team Alpha" } });
  assert.deepEqual(await lookup(first, "program=FTC&number=99999"), { status: 200, body: { status: "not-found" } });
  // The reason FIRST is unavailable stays on the server.
  assert.deepEqual(await lookup(first, "number=99902&program=FTC"), { status: 200, body: { status: "unavailable" } });
  // FLL programs are offered; Core reports them unavailable until FIRST's public search is turned on.
  const fll = fakeFirst({ "Challenge:99905": { status: "unavailable", reason: "provider-error" } });
  assert.deepEqual(await lookup(fll, "program=Challenge&number=99905"), { status: 200, body: { status: "unavailable" } });
  assert.deepEqual(fll.calls, [{ program: "Challenge", number: "99905" }]);
  assert.deepEqual(await lookup(undefined, "program=FRC&number=99901"), { status: 200, body: { status: "unavailable" } }, "a Core without the FIRST connection answers unavailable");
  const refused = fakeFirst();
  for (const query of ["program=FRC", "number=99901", "program=VEX&number=99901", "program=FRC&number=TEST-1", "program=FRC&number=1234567", "program=FRC&number=1&number=2", "program=FRC&number=1&extra=1"]) {
    await assert.rejects(lookup(refused, query), (error) => error.status === 400, query);
  }
  assert.deepEqual(refused.calls, []);
  await assert.rejects(outreachPublicRoute(outreachDatabase(), new Request("https://api.example.test/public/hours/team-lookup", { method: "POST", headers: { origin } }), origin, {}, now, first), (error) => error.status === 405);
});

test("a new team found by FIRST is stored with FIRST's name, not the typed one", async () => {
  const db = outreachDatabase(); const first = fakeFirst({ "FRC:99901": found(alpha) });
  const result = await submit(db, newTeam({ number: " 99901 ", program: "FRC", name: "test team alfa" }), first);
  assert.equal(result.status, 201);
  assert.deepEqual(teams(db), [{ number: "99901", program: "FRC", name: "Test Team Alpha", flagged: 1 }]);
  assert.equal(db.raw.prepare("SELECT title FROM hours_activities").get().title, "Team support: 99901 Test Team Alpha");
  assert.deepEqual(first.calls, [{ program: "FRC", number: "99901" }]);
  // Retrying the exact submission returns the saved receipt without asking FIRST again.
  const input = newTeam({ number: "99901", program: "FRC", name: "Typed" }, { serviceDate: "2026-10-29" });
  const saved = await submit(db, input, first); const retried = await submit(db, input, first);
  assert.deepEqual(retried.body, saved.body);
  // The team is on the supported teams list now, so later submissions reuse it and never ask FIRST.
  assert.equal(first.calls.length, 1);
});

test("a team FIRST cannot confirm is still added with the typed name", async () => {
  const db = outreachDatabase();
  const first = fakeFirst({ "FTC:99902": { status: "unavailable", reason: "timeout" }, "FRC:99903": new Error("synthetic failure") });
  const cases = [
    [{ number: "99999", program: "FTC", name: "Test Team Bravo" }, "not found"],
    [{ number: "99902", program: "FTC", name: "Test Team Charlie" }, "unavailable"],
    [{ number: "99903", program: "FRC", name: "Test Team Delta" }, "failing"],
    [{ number: "99904", program: "Explore", name: "Test Team Echo" }, "FLL, unavailable for now"],
  ];
  for (const [team, label] of cases) assert.equal((await submit(db, newTeam(team), first)).status, 201, label);
  // A number FIRST cannot hold is never sent.
  assert.equal((await submit(db, newTeam({ number: "TEST-7", program: "FRC", name: "Test Team Foxtrot" }), first)).status, 201);
  // Without Core's FIRST connection the typed name is kept too.
  assert.equal((await submit(db, newTeam({ number: "99906", program: "FRC", name: "Test Team Golf" }), undefined)).status, 201);
  assert.deepEqual(teams(db).map((row) => row.name).sort(), ["Test Team Bravo", "Test Team Charlie", "Test Team Delta", "Test Team Echo", "Test Team Foxtrot", "Test Team Golf"]);
  assert.deepEqual(first.calls.map((call) => `${call.program}:${call.number}`), ["FTC:99999", "FTC:99902", "FRC:99903", "Explore:99904"]);
});

test("FIRST is not asked about a team already on the supported teams list or a chosen team", async () => {
  const db = outreachDatabase(); const first = fakeFirst({ "FRC:99901": found(alpha) });
  const listed = (await ensureSupportedTeam(db, { moduleId: "hour-tracking", userId: "admin" }, { number: "99901", program: "FRC", name: "Test Staff Team" })).team;
  assert.equal((await submit(db, newTeam({ number: "99901", program: "FRC", name: "Anything" }), first)).status, 201);
  assert.equal((await submit(db, { ...newTeam(undefined), team: undefined, teamId: listed.id, serviceDate: "2026-10-29" }, first)).status, 201);
  assert.deepEqual(teams(db), [{ number: "99901", program: "FRC", name: "Test Staff Team", flagged: 0 }]);
  // An archived match is still refused, without asking FIRST.
  db.raw.prepare("UPDATE hours_teams SET archived=1").run();
  const refused = await submit(db, newTeam({ number: "99901", program: "FRC", name: "Anything" }, { serviceDate: "2026-10-28" }), first);
  assert.equal(refused.status, 409);
  assert.deepEqual(first.calls, []);
});
