// Per-destination automatic Event publication: the switches and their migration, keeping published Events in sync,
// Publish upcoming Events, delivery status, and retries that match Core's meeting calendar sync. Every person, Event and
// server here is synthetic; no provider is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/sdk.mjs";
import { applyPluginMigrations, coreBaselineDatabase, d1, outreachDatabase } from "./helpers/d1.mjs";

const { outreachCatalogRoute } = await import("../src/api/outreach-catalogs.ts");
const { outreachPublicationRoute, processOutreachPublicationOperations, outreachPublicationBackoff, OutreachPublicationDeliveryError } = await import("../src/api/outreach-publication.ts");
const { outreachPublicationProviders, outreachDiscordDeliveryError, outreachDiscordEventLimitMessage, outreachDiscordRateLimitMessage } = await import("../src/api/outreach-publication-providers.ts");
const { outreachBackupAdapter, outreachBackupTables } = await import("../src/api/outreach-backup.ts");
const { HttpError } = await import("./helpers/module-sdk-stub.mjs");

// 2026-10-31 12:00 in America/New_York.
const now = Date.parse("2026-10-31T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/** Provider stand-ins that record every delivery; `fail` decides per call whether and how one fails. */
function stubProviders({ configured = { google_calendar: true, discord: true }, fail } = {}) {
  const calls = [];
  return {
    calls,
    status: async () => ({ ...configured }),
    publish: async (provider, event, externalId, delivery) => {
      calls.push({ provider, action: "publish", activityId: event.activityId, title: event.title, externalId, delivery });
      const error = fail?.(provider, event); if (error) throw error;
      return externalId ?? `synthetic-${provider}-${event.activityId}`;
    },
    remove: async (provider, externalId) => { calls.push({ provider, action: "delete", externalId }); },
  };
}

const publication = (db, providers, method, path, input, at = now) => outreachPublicationRoute(db, providers, "admin", new Request(`https://api.example.test${path}`, { method }), input, at);
const catalog = (db, providers, method, path, input, at = now) => outreachCatalogRoute(db, "admin", new Request(`https://api.example.test${path}`, { method }), input, providers, at);
async function createEvent(db, providers, serviceDate, title, extra = {}) {
  return (await catalog(db, providers, "POST", "/admin/hours/activities", { mode: "event", serviceDate, teamId: null, title, description: "Synthetic outreach", location: "Test Hall", impactRelevant: true, archived: false, eventStartLocal: "17:00", eventEndLocal: "18:00", ...extra })).body;
}
async function setDestination(db, providers, provider, automatic, at = now) {
  const { revision } = (await publication(db, providers, "GET", "/admin/hours/publication-destinations")).body;
  return (await publication(db, providers, "PATCH", "/admin/hours/publication-destinations", { provider, automatic, revision }, at)).body;
}
const operations = (db, activityId) => db.raw.prepare("SELECT o.publication_revision AS revision,o.provider,o.action,o.status,o.attempts,o.next_attempt_at AS nextAttemptAt,o.last_error AS lastError FROM hours_publication_operations o JOIN hours_activity_publications p ON p.installation_id=o.installation_id AND p.activity_id=o.activity_id AND p.revision=o.publication_revision WHERE o.activity_id=? ORDER BY o.provider").all(activityId).map((row) => ({ ...row }));
const destination = (status, provider) => status.destinations.find((item) => item.provider === provider);
const day = (offset) => iso(Date.parse("2026-11-01T12:00:00.000Z") + offset * 86_400_000).slice(0, 10);

test("migration 0002 turns the single switch into both destination switches", () => {
  const raw = coreBaselineDatabase();
  raw.exec(`INSERT INTO installations(id) VALUES ('primary'),('second');
    INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES ('primary',1,4,'2026-01-01','2026-02-01'),('second',0,2,'2026-01-01','2026-02-01');`);
  applyPluginMigrations(raw);
  assert.deepEqual(raw.prepare("SELECT installation_id,automatic,google_calendar_automatic,discord_automatic,revision,updated_at FROM hours_publication_settings ORDER BY installation_id").all().map((row) => ({ ...row })), [
    { installation_id: "primary", automatic: 1, google_calendar_automatic: 1, discord_automatic: 1, revision: 4, updated_at: "2026-02-01" },
    { installation_id: "second", automatic: 0, google_calendar_automatic: 0, discord_automatic: 0, revision: 2, updated_at: "2026-02-01" },
  ]);
  assert.throws(() => raw.exec("UPDATE hours_publication_settings SET discord_automatic=2"), /CHECK constraint/);
  // A fresh installation's settings row, as freshEnable writes it, starts with both off.
  raw.exec("INSERT INTO installations(id) VALUES ('third'); INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES ('third',0,0,'2026-03-01','2026-03-01')");
  assert.deepEqual({ ...raw.prepare("SELECT google_calendar_automatic,discord_automatic FROM hours_publication_settings WHERE installation_id='third'").get() }, { google_calendar_automatic: 0, discord_automatic: 0 });
});

test("each destination has its own switch, and the original settings route keeps working", async () => {
  const db = outreachDatabase(); const providers = stubProviders({ configured: { google_calendar: false, discord: true } });
  assert.deepEqual((await publication(db, providers, "GET", "/admin/hours/publication-settings")).body, { automatic: false, revision: 0 });
  const initial = (await publication(db, providers, "GET", "/admin/hours/publication-destinations")).body;
  assert.deepEqual(initial, { revision: 0, destinations: [
    { provider: "google_calendar", configured: false, automatic: false, waiting: 0, failed: 0, latestProblem: null },
    { provider: "discord", configured: true, automatic: false, waiting: 0, failed: 0, latestProblem: null },
  ] });
  // A destination that is not set up cannot be turned on.
  await assert.rejects(publication(db, providers, "PATCH", "/admin/hours/publication-destinations", { provider: "google_calendar", automatic: true, revision: 0 }), /Google Calendar is not set up\. Set it up in Settings > Integrations first\./);
  await assert.rejects(publication(db, providers, "PATCH", "/admin/hours/publication-destinations", { provider: "email", automatic: true, revision: 0 }), (error) => error.status === 400);
  const on = await setDestination(db, providers, "discord", true);
  assert.equal(on.revision, 1); assert.equal(destination(on, "discord").automatic, true); assert.equal(destination(on, "google_calendar").automatic, false);
  assert.deepEqual((await publication(db, providers, "GET", "/admin/hours/publication-settings")).body, { automatic: true, revision: 1 });
  await assert.rejects(publication(db, providers, "PATCH", "/admin/hours/publication-destinations", { provider: "discord", automatic: false, revision: 0 }), /settings changed/);
  // The original switch sets both destinations, as it always published to every destination.
  await publication(db, providers, "PATCH", "/admin/hours/publication-settings", { automatic: false, revision: 1 });
  assert.deepEqual({ ...db.raw.prepare("SELECT automatic,google_calendar_automatic,discord_automatic,revision FROM hours_publication_settings").get() }, { automatic: 0, google_calendar_automatic: 0, discord_automatic: 0, revision: 2 });
  await publication(db, providers, "PATCH", "/admin/hours/publication-settings", { automatic: true, revision: 2 });
  assert.deepEqual({ ...db.raw.prepare("SELECT automatic,google_calendar_automatic,discord_automatic FROM hours_publication_settings").get() }, { automatic: 1, google_calendar_automatic: 1, discord_automatic: 1 });
  // Turning one switch off leaves the single setting on while the other is on, and a switch can be turned off when its destination is not set up.
  await setDestination(db, providers, "discord", false);
  assert.equal((await publication(db, providers, "GET", "/admin/hours/publication-settings")).body.automatic, true);
  await setDestination(db, providers, "google_calendar", false);
  assert.equal((await publication(db, providers, "GET", "/admin/hours/publication-settings")).body.automatic, false);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='outreach.publication_setting_updated'").get().n, 5);
});

test("saving a future Event queues only the destinations whose switch is on", async () => {
  const db = outreachDatabase(); const providers = stubProviders();
  const off = await createEvent(db, providers, day(1), "Synthetic switches off");
  assert.equal(off.publicationQueue, undefined, "nothing is queued, or reported, with both switches off");
  await setDestination(db, providers, "discord", true);
  const event = await createEvent(db, providers, day(2), "Synthetic Discord only");
  assert.deepEqual(event.publicationQueue.queuedProviders, ["discord"]);
  assert.deepEqual(await processOutreachPublicationOperations(db, providers, now + 1_000), { delivered: 1, failed: 0, pending: 0 });
  assert.deepEqual(providers.calls.map((call) => [call.provider, call.title]), [["discord", "Synthetic Discord only"]]);
  await setDestination(db, providers, "google_calendar", true);
  const both = await createEvent(db, providers, day(3), "Synthetic both destinations");
  assert.deepEqual(both.publicationQueue.queuedProviders, ["google_calendar", "discord"]);
  // A switch that is on for a destination that is no longer set up queues nothing there.
  const discordOnly = stubProviders({ configured: { google_calendar: false, discord: true } });
  const partial = await createEvent(db, discordOnly, day(4), "Synthetic Google not set up");
  assert.deepEqual(partial.publicationQueue.queuedProviders, ["discord"]);
  // Team Support and Other Service activities are never published.
  const task = (await catalog(db, providers, "POST", "/admin/hours/activities", { mode: "task", serviceDate: day(1), teamId: null, title: "Synthetic other service", description: "", location: "", impactRelevant: true, archived: false })).body;
  assert.equal("publicationQueue" in task, false);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM hours_activity_publications WHERE activity_id=?").get(task.id).n, 0);
});

test("an Event published to a destination stays in sync there with that switch off", async () => {
  const db = outreachDatabase(); const providers = stubProviders();
  const event = await createEvent(db, providers, day(2), "Synthetic published by hand");
  await publication(db, providers, "POST", `/admin/hours/activities/${event.id}/publication`, { activityRevision: 0, publicationRevision: null, provider: "discord" });
  await processOutreachPublicationOperations(db, providers, now + 1_000);
  const edited = (await catalog(db, providers, "PATCH", `/admin/hours/activities/${event.id}`, { revision: 0, title: "Synthetic published, renamed" }, now + 2_000)).body;
  assert.deepEqual(edited.publicationQueue.queuedProviders, ["discord"], "only the destination it is published to, not Google Calendar");
  await processOutreachPublicationOperations(db, providers, now + 3_000);
  assert.deepEqual(providers.calls.at(-1), { provider: "discord", action: "publish", activityId: event.id, title: "Synthetic published, renamed", externalId: `synthetic-discord-${event.id}`, delivery: { firstAttempt: true } });
  // After it is unpublished there, edits leave it alone again.
  await publication(db, providers, "POST", `/admin/hours/activities/${event.id}/publication`, { activityRevision: 1, publicationRevision: 1, provider: "discord", action: "delete" }, now + 4_000);
  await processOutreachPublicationOperations(db, providers, now + 5_000);
  assert.deepEqual(providers.calls.at(-1), { provider: "discord", action: "delete", externalId: `synthetic-discord-${event.id}` });
  const quiet = (await catalog(db, providers, "PATCH", `/admin/hours/activities/${event.id}`, { revision: 1, title: "Synthetic unpublished, renamed" }, now + 6_000)).body;
  assert.equal(quiet.publicationQueue, undefined);
  // Archiving a published Event still removes it with the switch off.
  const second = await createEvent(db, providers, day(3), "Synthetic archived later");
  await publication(db, providers, "POST", `/admin/hours/activities/${second.id}/publication`, { activityRevision: 0, publicationRevision: null, provider: "discord" });
  await processOutreachPublicationOperations(db, providers, now + 7_000);
  const archived = (await catalog(db, providers, "PATCH", `/admin/hours/activities/${second.id}`, { revision: 0, archived: true }, now + 8_000)).body;
  assert.deepEqual(archived.publicationQueue.queuedProviders, ["discord"]);
  assert.deepEqual(operations(db, second.id).map((row) => [row.provider, row.action, row.status]), [["discord", "delete", "pending"]]);
});

test("Publish upcoming Events pages 10 at a time, skips what is published or over, and needs a switch on", async () => {
  const db = outreachDatabase(); const providers = stubProviders();
  await assert.rejects(publication(db, providers, "POST", "/admin/hours/publication-destinations/backfill"), /Turn on automatic publication/);
  const ids = [];
  for (let index = 0; index < 25; index++) ids.push((await createEvent(db, providers, day(index % 9), `Synthetic upcoming ${index}`)).id);
  const ended = await createEvent(db, providers, "2026-10-31", "Synthetic ended this morning", { eventStartLocal: "09:00", eventEndLocal: "10:00" });
  await createEvent(db, providers, "2026-10-30", "Synthetic yesterday");
  await createEvent(db, providers, day(1), "Synthetic archived", { archived: true });
  await catalog(db, providers, "POST", "/admin/hours/activities", { mode: "task", serviceDate: day(1), teamId: null, title: "Synthetic other service", description: "", location: "", impactRelevant: true, archived: false });
  // One Event is already published to Discord by hand.
  await publication(db, providers, "POST", `/admin/hours/activities/${ids[0]}/publication`, { activityRevision: 0, publicationRevision: null, provider: "discord" });
  await processOutreachPublicationOperations(db, providers, now);
  await setDestination(db, providers, "discord", true);
  const pages = []; let cursor = null;
  do { const page = (await publication(db, providers, "POST", `/admin/hours/publication-destinations/backfill${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, {})).body; pages.push(page); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(pages.map((page) => [page.selected, page.failed, page.limit, page.batchLimit]), [[10, 0, 100, 10], [10, 0, 100, 10], [6, 0, 100, 10]]);
  // 26 upcoming Events: 24 queued, and the one already published and the one that ended this morning skipped.
  assert.equal(pages.reduce((total, page) => total + page.queued, 0), 24); assert.equal(pages.reduce((total, page) => total + page.skipped, 0), 2);
  assert.deepEqual(pages.map((page) => page.providers), [["discord"], ["discord"], ["discord"]]);
  assert.deepEqual(operations(db, ended.id), []);
  assert.deepEqual(operations(db, ids[1]).map((row) => [row.provider, row.action, row.status]), [["discord", "publish", "pending"]]);
  // A second run finds every Event waiting or published, and turning Google Calendar on adds only Google Calendar.
  const again = (await publication(db, providers, "POST", "/admin/hours/publication-destinations/backfill", {})).body;
  assert.deepEqual([again.queued, again.skipped], [0, 10]);
  await setDestination(db, providers, "google_calendar", true);
  const google = (await publication(db, providers, "POST", "/admin/hours/publication-destinations/backfill", {})).body;
  assert.deepEqual(google.providers, ["google_calendar", "discord"]); assert.deepEqual([google.queued, google.skipped], [9, 1], "the first page holds the Event that ended this morning");
  assert.deepEqual(operations(db, ids[1]).map((row) => [row.provider, row.status]), [["discord", "pending"], ["google_calendar", "pending"]]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='outreach.publication_backfill_requested'").get().n, 5);
  // Bad requests are refused.
  await assert.rejects(publication(db, providers, "POST", "/admin/hours/publication-destinations/backfill?after=not-a-cursor", {}), /cursor is invalid/);
  await assert.rejects(publication(db, providers, "POST", `/admin/hours/publication-destinations/backfill?after=${btoa(JSON.stringify(["2026-11-01", "x", 101]))}`, {}), /cursor is invalid/);
  await assert.rejects(publication(db, providers, "POST", "/admin/hours/publication-destinations/backfill", { provider: "discord" }), /takes no fields/);
});

test("Publish upcoming Events stops at 100 Events in one run", async () => {
  const db = outreachDatabase(); const providers = stubProviders();
  for (let index = 0; index < 105; index++) await createEvent(db, providers, day(index % 30), `Synthetic limit ${String(index).padStart(3, "0")}`);
  await setDestination(db, providers, "discord", true);
  const pages = []; let cursor = null;
  do { const page = (await publication(db, providers, "POST", `/admin/hours/publication-destinations/backfill${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, {})).body; pages.push(page); cursor = page.nextCursor; } while (cursor);
  assert.equal(pages.length, 10); assert.ok(pages.every((page) => page.selected === 10));
  assert.equal(pages.at(-1).nextCursor, null, "the server ends the run at its limit");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM hours_publication_operations").get().n, 100);
  // A later run picks up the rest.
  assert.equal((await publication(db, providers, "POST", "/admin/hours/publication-destinations/backfill", {})).body.queued, 0);
});

/** Queue one future Event to both destinations for each title. */
async function queuedEvents(db, providers, count) {
  await setDestination(db, providers, "discord", true); await setDestination(db, providers, "google_calendar", true);
  const ids = []; for (let index = 0; index < count; index++) ids.push((await createEvent(db, providers, day(index), `Synthetic batch ${index}`)).id);
  return ids;
}
const statuses = (db, provider) => db.raw.prepare("SELECT status,attempts,next_attempt_at AS nextAttemptAt,last_error AS lastError FROM hours_publication_operations WHERE provider=? ORDER BY updated_at DESC,activity_id").all(provider).map((row) => ({ ...row }));

test("a Discord permission error stops Discord's deliveries in that run and waits for Retry; Google Calendar continues", async () => {
  const db = outreachDatabase();
  const denied = Object.assign(new Error("Discord denied this request because the bot is missing a required permission. Confirm it is in the selected server and has the Create Events permission."), { status: 502 });
  let discordCalls = 0;
  const providers = stubProviders({ fail: (provider) => provider === "discord" ? (discordCalls++, outreachDiscordDeliveryError(denied, undefined)) : undefined });
  await queuedEvents(db, providers, 4);
  assert.deepEqual(await processOutreachPublicationOperations(db, providers, now + 1_000), { delivered: 4, failed: 1, pending: 3 });
  assert.equal(discordCalls, 1, "Discord got one request, not four");
  const discord = statuses(db, "discord");
  assert.deepEqual(discord.map((row) => row.status).sort(), ["failed", "pending", "pending", "pending"]);
  const failure = discord.find((row) => row.status === "failed");
  assert.equal(failure.nextAttemptAt, null, "a missing permission waits for Retry, as meetings do"); assert.equal(failure.attempts, 1); assert.match(failure.lastError, /Create Events permission/);
  assert.ok(statuses(db, "google_calendar").every((row) => row.status === "delivered"));
});

test("a rate limit stops Discord's deliveries, waits what Discord asked for, and is not counted as an attempt", async () => {
  const db = outreachDatabase(); let retryAfterMs = 7_000; let calls = 0;
  const providers = stubProviders({ fail: (provider) => provider === "discord" ? (calls++, outreachDiscordDeliveryError(new Error("Too Many Requests"), 429, retryAfterMs)) : undefined });
  await queuedEvents(db, providers, 3);
  assert.deepEqual(await processOutreachPublicationOperations(db, providers, now + 1_000), { delivered: 3, failed: 0, pending: 3 });
  assert.equal(calls, 1);
  let limited = statuses(db, "discord").find((row) => row.status === "failed");
  assert.deepEqual(limited, { status: "failed", attempts: 0, nextAttemptAt: iso(now + 1_000 + 60_000), lastError: outreachDiscordRateLimitMessage }, "at least a minute, and no attempt counted");
  // A longer retry_after is used as given; a later rate limit still counts no attempt.
  retryAfterMs = 600_000;
  assert.deepEqual(await processOutreachPublicationOperations(db, providers, now + 120_000), { delivered: 0, failed: 0, pending: 3 });
  assert.equal(calls, 2);
  limited = statuses(db, "discord").filter((row) => row.status === "failed");
  assert.equal(limited.filter((row) => row.nextAttemptAt === iso(now + 120_000 + 600_000)).length, 1); assert.ok(limited.every((row) => row.attempts === 0));
  // Discord's wait is capped at an hour.
  retryAfterMs = 7_200_000;
  await processOutreachPublicationOperations(db, providers, now + 800_000);
  assert.equal(statuses(db, "discord").filter((row) => row.nextAttemptAt === iso(now + 800_000 + 3_600_000)).length, 1);
});

test("Discord rate limits are recognized from SDK 1.3.0, SDK 1.2.0 and Core's older error text", () => {
  for (const [error, status, wait, expected] of [
    [new Error("Too Many Requests"), 429, 12_000, 12_000],
    [new Error("Too Many Requests"), 429, undefined, 60_000],
    // Core before the fix labelled every long wait "role sync" and froze it in its text.
    [Object.assign(new Error("Discord is rate limiting role sync. Wait 9 seconds before trying again."), { status: 503, retryAfterMs: 9_000 }), undefined, undefined, 9_000],
    [Object.assign(new Error("Discord is rate limiting calendar sync. Wait 2 seconds before trying again."), { status: 503 }), undefined, undefined, 60_000],
  ]) {
    const classified = outreachDiscordDeliveryError(error, status, wait);
    assert.ok(classified instanceof OutreachPublicationDeliveryError);
    assert.deepEqual([classified.message, classified.retry, classified.stopsBatch, classified.rateLimited, classified.retryAfterMs], [outreachDiscordRateLimitMessage, true, true, true, expected]);
  }
  const limit = outreachDiscordDeliveryError(Object.assign(new Error("Discord rejected the request (400): Maximum number of guild scheduled events reached (100)"), { status: 502, discordCode: 30038 }), 400);
  assert.deepEqual([limit.message, limit.retry, limit.stopsBatch], [outreachDiscordEventLimitMessage, false, false]);
  assert.equal(outreachDiscordEventLimitMessage, "Discord's limit of 100 scheduled events for this server is reached. End or delete some Discord events, then retry.");
  const invalid = outreachDiscordDeliveryError(Object.assign(new Error("Discord rejected the request (400): Invalid Form Body"), { status: 502 }), 400);
  assert.deepEqual([invalid.retry, invalid.stopsBatch], [false, false]);
  const outage = outreachDiscordDeliveryError(Object.assign(new Error("Discord rejected the request (503)"), { status: 502 }), 503);
  assert.deepEqual([outage.retry, outage.stopsBatch], [true, false]);
});

test("failures that can pass retry with backoff capped at an hour, without giving up; repeating failures wait for Retry", async () => {
  const db = outreachDatabase(); let failure = () => new Error("Synthetic Discord outage");
  const providers = stubProviders({ fail: (provider) => provider === "discord" ? failure() : undefined });
  await setDestination(db, providers, "discord", true);
  const event = await createEvent(db, providers, "2026-12-15", "Synthetic outage");
  let at = now;
  for (let attempt = 1; attempt <= 14; attempt++) {
    await processOutreachPublicationOperations(db, providers, at);
    const [row] = operations(db, event.id);
    assert.equal(row.attempts, attempt); assert.equal(row.status, "failed");
    assert.equal(row.nextAttemptAt, iso(at + outreachPublicationBackoff(attempt)), `attempt ${attempt}`);
    at = Date.parse(row.nextAttemptAt);
  }
  assert.deepEqual([1, 6, 7, 12, 14].map((attempts) => outreachPublicationBackoff(attempts)), [60_000, 64_000, 128_000, 3_600_000, 3_600_000]);
  // The next attempt time is in the activity's publication status, for "Retrying automatically at".
  const listed = (await publication(db, providers, "GET", `/admin/hours/activities/${event.id}/publication`)).body;
  assert.equal(listed.discordNextAttemptAt, operations(db, event.id)[0].nextAttemptAt); assert.equal(listed.discordError, "Synthetic Discord outage");
  // A refusal that repeats, such as Discord's event limit or a title Discord cannot take, waits for Retry.
  failure = () => outreachDiscordDeliveryError(Object.assign(new Error("Discord rejected the request (400): Maximum number of guild scheduled events reached (100)"), { status: 502, discordCode: 30038 }), 400);
  await processOutreachPublicationOperations(db, providers, at);
  let [row] = operations(db, event.id);
  assert.deepEqual([row.status, row.nextAttemptAt, row.lastError], ["failed", null, outreachDiscordEventLimitMessage]);
  assert.equal((await publication(db, providers, "GET", `/admin/hours/activities/${event.id}/publication`)).body.discordNextAttemptAt, null);
  // The per-activity Retry still works, and a plain HTTP refusal from Outreach itself waits for Retry too.
  await publication(db, providers, "POST", `/admin/hours/activities/${event.id}/publication/retry`, { revision: row.revision, provider: "discord" }, at);
  failure = () => new HttpError(400, "Discord event names are limited to 100 characters");
  await processOutreachPublicationOperations(db, providers, at + 1_000);
  [row] = operations(db, event.id);
  assert.deepEqual([row.status, row.nextAttemptAt], ["failed", null]);
});

test("delivery status counts each destination's waiting and failed deliveries and names the newest problem", async () => {
  const db = outreachDatabase();
  const providers = stubProviders({ fail: (provider, event) => provider === "discord" && event.title.includes("fails") ? new Error(`Synthetic outage for ${event.title}`) : undefined });
  await setDestination(db, providers, "discord", true);
  await createEvent(db, providers, day(1), "Synthetic fails first");
  await processOutreachPublicationOperations(db, providers, now + 1_000);
  await createEvent(db, providers, day(2), "Synthetic fails second");
  await processOutreachPublicationOperations(db, providers, now + 2_000);
  await createEvent(db, providers, day(3), "Synthetic waiting");
  const status = (await publication(db, providers, "GET", "/admin/hours/publication-destinations")).body;
  assert.deepEqual(destination(status, "discord"), { provider: "discord", configured: true, automatic: true, waiting: 1, failed: 2, latestProblem: { message: "Synthetic outage for Synthetic fails second", activityTitle: "Synthetic fails second", at: iso(now + 2_000) } });
  assert.deepEqual(destination(status, "google_calendar"), { provider: "google_calendar", configured: true, automatic: false, waiting: 0, failed: 0, latestProblem: null });
  // A delivery that stopped because its Event was archived is not a problem.
  const archivedId = db.raw.prepare("SELECT id FROM hours_activities WHERE title='Synthetic fails first'").get().id;
  await catalog(db, providers, "PATCH", `/admin/hours/activities/${archivedId}`, { revision: 0, archived: true }, now + 3_000);
  assert.equal(destination((await publication(db, providers, "GET", "/admin/hours/publication-destinations")).body, "discord").failed, 1);
});

/** Core's module services as the providers see them, with a Discord server that records requests. */
function services({ events = [], rateLimit, retryAfterMs } = {}) {
  const requests = [];
  const discord = {
    ready: async () => true,
    providerStatus: (error) => error?.syntheticStatus,
    client: async () => ({ guildId: "synthetic-guild", request: async (path, init) => {
      requests.push(`${init.method} ${path}`);
      if (rateLimit) throw Object.assign(new Error("Too Many Requests"), { syntheticStatus: 429 });
      if (init.method === "GET") return { body: events };
      return { body: { id: init.method === "POST" ? "synthetic-created" : path.split("/").at(-1) } };
    } }),
  };
  if (retryAfterMs) discord.retryAfterMs = () => retryAfterMs;
  const googleCalendar = { ready: async () => false, providerStatus: () => undefined };
  return { requests, services: { discord, googleCalendar } };
}
const syntheticEvent = { activityId: "synthetic-activity", revision: 0, title: "Synthetic fair", description: "", location: "Test Hall", startsAt: "2026-11-05T21:00:00.000Z", endsAt: "2026-11-05T22:00:00.000Z", timeZone: "America/New_York" };

test("a first Discord delivery creates its event directly; a retry looks for one it may have created", async () => {
  let server = services(); const providers = outreachPublicationProviders(server.services);
  assert.equal(await providers.publish("discord", syntheticEvent, undefined, { firstAttempt: true }), "synthetic-created");
  assert.deepEqual(server.requests, ["POST /guilds/synthetic-guild/scheduled-events"]);
  server = services(); assert.equal(await outreachPublicationProviders(server.services).publish("discord", syntheticEvent, undefined, { firstAttempt: false }), "synthetic-created");
  assert.deepEqual(server.requests, ["GET /guilds/synthetic-guild/scheduled-events", "POST /guilds/synthetic-guild/scheduled-events"]);
  // A saved event is updated in place either way.
  server = services(); assert.equal(await outreachPublicationProviders(server.services).publish("discord", syntheticEvent, "synthetic-saved", { firstAttempt: true }), "synthetic-saved");
  assert.deepEqual(server.requests, ["PATCH /guilds/synthetic-guild/scheduled-events/synthetic-saved"]);
  // A rate limit becomes Outreach's own error, with SDK 1.3.0's wait or a minute without it.
  for (const [retryAfterMs, expected] of [[15_000, 15_000], [undefined, 60_000]]) {
    server = services({ rateLimit: true, retryAfterMs });
    await assert.rejects(outreachPublicationProviders(server.services).publish("discord", syntheticEvent, undefined, { firstAttempt: true }), (error) => error instanceof OutreachPublicationDeliveryError && error.rateLimited && error.retryAfterMs === expected && error.message === outreachDiscordRateLimitMessage);
    await assert.rejects(outreachPublicationProviders(server.services).remove("discord", "synthetic-saved"), (error) => error.rateLimited && error.stopsBatch);
  }
});

test("the worker passes whether a delivery is a first attempt", async () => {
  const db = outreachDatabase(); let fail = true;
  const providers = stubProviders({ fail: (provider) => provider === "discord" && fail ? new Error("Synthetic outage") : undefined });
  await setDestination(db, providers, "discord", true);
  const event = await createEvent(db, providers, day(2), "Synthetic first attempt");
  await processOutreachPublicationOperations(db, providers, now);
  fail = false; await processOutreachPublicationOperations(db, providers, now + 3_600_000);
  assert.deepEqual(providers.calls.map((call) => call.delivery), [{ firstAttempt: true }, { firstAttempt: false }]);
  // A lease that expired mid-delivery is not a first attempt.
  const second = await createEvent(db, providers, day(3), "Synthetic expired lease");
  db.raw.prepare("UPDATE hours_publication_operations SET status='processing',lease_token='synthetic-lease',lease_expires_at=? WHERE activity_id=?").run(iso(now), second.id);
  await processOutreachPublicationOperations(db, providers, now + 60_000);
  assert.deepEqual(providers.calls.at(-1).delivery, { firstAttempt: false });
});

test("backups round-trip both switches, and older sections set them from the single switch", async () => {
  const db = outreachDatabase(); const providers = stubProviders();
  await setDestination(db, providers, "discord", true);
  const exported = Object.fromEntries(Object.entries(outreachBackupTables).map(([table, columns]) => [table, db.raw.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
  assert.deepEqual(exported.hours_publication_settings.map((row) => [row.automatic, row.google_calendar_automatic, row.discord_automatic]), [[1, 0, 1]]);
  outreachBackupAdapter.validate(structuredClone(exported));
  assert.equal(outreachBackupAdapter.version, 5);
  const restored = d1(applyPluginMigrations(coreBaselineDatabase()));
  restored.raw.exec("INSERT INTO installations(id) VALUES ('primary'); INSERT INTO users VALUES ('admin'); INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES ('member-a','primary','TEST-A','Test Student','A'),('member-b','primary','TEST-B','Test Student','B')");
  for (const [table, rows] of Object.entries(outreachBackupAdapter.neutralize(structuredClone(exported), {}))) for (const row of rows) restored.raw.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  assert.deepEqual(restored.raw.prepare(`SELECT ${outreachBackupTables.hours_publication_settings.join(",")} FROM hours_publication_settings`).all().map((row) => ({ ...row })), exported.hours_publication_settings);
  // Version 4 and version 3 plugin sections, and Core's section of first-party backups, predate the switches.
  const source = { backupSchemaVersion: 44, coreSection: false, exportedAt: "2026-10-31T00:00:00.000Z" };
  for (const automatic of [0, 1]) {
    const version4 = structuredClone(exported); version4.hours_publication_settings = version4.hours_publication_settings.map(({ google_calendar_automatic: _g, discord_automatic: _d, ...row }) => ({ ...row, automatic }));
    assert.deepEqual(outreachBackupAdapter.normalize(version4, 4, source).hours_publication_settings.map((row) => [row.automatic, row.google_calendar_automatic, row.discord_automatic]), [[automatic, automatic, automatic]]);
    const version3 = structuredClone(version4); for (const row of version3.hours_teams) delete row.added_by_member; for (const row of version3.hours_entries) delete row.timing;
    assert.deepEqual(outreachBackupAdapter.normalize(version3, 3, source).hours_publication_settings.map((row) => [row.google_calendar_automatic, row.discord_automatic]), [[automatic, automatic]]);
    const coreSection = structuredClone(version3);
    const normalized = outreachBackupAdapter.normalize(coreSection, 2, { backupSchemaVersion: 43, coreSection: true, exportedAt: "2026-10-31T00:00:00.000Z" });
    assert.deepEqual(Object.keys(normalized.hours_publication_settings[0]).sort(), [...outreachBackupTables.hours_publication_settings].sort());
    assert.deepEqual(normalized.hours_publication_settings.map((row) => [row.google_calendar_automatic, row.discord_automatic]), [[automatic, automatic]]);
  }
  // Core's section never carried the new columns, so a row that has them is refused like any undeclared column.
  assert.throws(() => outreachBackupAdapter.normalize(structuredClone(exported), 2, { backupSchemaVersion: 43, coreSection: true, exportedAt: "2026-10-31T00:00:00.000Z" }), (error) => error.status === 400);
  assert.throws(() => outreachBackupAdapter.validate({ ...exported, hours_publication_settings: exported.hours_publication_settings.map((row) => ({ ...row, discord_automatic: 2 })) }), /automatic publication settings are invalid/);
});
