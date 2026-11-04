// Event publication controls in the Outreach dashboard, checked in their source as Core's dashboard tests check it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the Discord publication button uses Discord's current Clyde mark, filled", () => {
  const publication = source("dashboard/outreach-activity-publication.tsx");
  // Discord's brand-asset path, as simple-icons publishes it at viewBox 0 0 24 24.
  assert.match(publication, /"M20\.317 4\.3698a19\.7913 19\.7913 0 00-4\.8851-1\.5152[^"]*2\.4189Z"/);
  assert.match(publication, /<path d=\{discordMarkPath\} fill="currentColor" stroke="none" \/>/);
  assert.doesNotMatch(publication, /M7 6c3-2 7-2 10 0/, "the hand-drawn outline is gone");
});

const text = await import("../src/dashboard/outreach-publication-destinations.ts");
const destination = (provider, overrides = {}) => ({ provider, configured: true, automatic: false, waiting: 0, failed: 0, latestProblem: null, ...overrides });

test("the automatic publication card names one switch per destination and how each is doing", () => {
  assert.equal(text.switchLabel("discord"), "Publish Events to Discord automatically");
  assert.equal(text.switchLabel("google_calendar"), "Publish Events to Google Calendar automatically");
  assert.deepEqual(text.publicationProviderOrder, ["discord", "google_calendar"]);
  assert.equal(`${text.notSetUpText} ${text.integrationsLinkText}.`, "Not set up. Set it up in Settings > Integrations.");
  assert.equal(text.integrationsHref, "/settings/integrations");
  assert.equal(text.deliveryText({ waiting: 3, failed: 1 }), "3 waiting · 1 need another attempt");
  assert.equal(text.latestProblemText({ message: "Discord is rate limiting publishing. LancerLogin will try again automatically.", activityTitle: "Test Open House", at: "2026-11-03T12:00:00.000Z" }), "Latest problem: Discord is rate limiting publishing. LancerLogin will try again automatically. (Test Open House)");
  assert.equal(text.switchNotice("discord", true), "Discord: automatic Event publication is on.");
  assert.equal(text.switchNotice("google_calendar", false), "Google Calendar: automatic Event publication is off.");
  // A destination that is not set up shows its switch disabled, unless it is still on, so it can be turned off.
  assert.equal(text.switchDisabled(destination("discord", { configured: false }), false), true);
  assert.equal(text.switchDisabled(destination("discord", { configured: false, automatic: true }), false), false);
  assert.equal(text.switchDisabled(destination("discord"), false), false);
  assert.equal(text.switchDisabled(destination("discord"), true), true);
});

test("Publish upcoming Events goes to the destinations that are on and set up, after a confirmation", () => {
  const status = (destinations) => ({ revision: 0, destinations });
  assert.deepEqual(text.backfillDestinations(status([destination("google_calendar", { automatic: true }), destination("discord", { automatic: true })])), ["discord", "google_calendar"]);
  assert.deepEqual(text.backfillDestinations(status([destination("google_calendar", { automatic: true, configured: false }), destination("discord")])), []);
  assert.equal(text.backfillButtonText, "Publish upcoming Events");
  assert.equal(text.backfillConfirmText(["discord"]), "Publish upcoming Events to Discord now? Up to 100 active Events that have not ended yet are queued. Events already published or waiting there are skipped.");
  assert.equal(text.backfillConfirmText(["discord", "google_calendar"]), "Publish upcoming Events to Discord and Google Calendar now? Up to 100 active Events that have not ended yet are queued. Events already published or waiting there are skipped.");
  assert.equal(text.backfillHelp, "Queues active Events that have not ended yet, up to 100, to each destination that is on. Events already published or waiting there are skipped.");
  assert.equal(text.noBackfillDestinationText, "Turn on a set-up destination to publish upcoming Events.");
  assert.equal(text.backfillResultText({ selected: 26, queued: 24, skipped: 2, failed: 0 }), "Publish upcoming Events: 24 queued, 2 skipped. 26 upcoming Events checked. Queued Events publish within 5 minutes.");
  assert.equal(text.backfillResultText({ selected: 1, queued: 0, skipped: 0, failed: 1 }), "Publish upcoming Events: 0 queued, 1 could not be queued. 1 upcoming Event checked.");
});

test("the card reads only a real destination status, and failed deliveries say when they retry", () => {
  const valid = { revision: 2, destinations: [destination("discord", { automatic: true, waiting: 1 })] };
  assert.equal(text.parsePublicationDestinations(valid), valid);
  // Stand-ins that answer every route with a page, and older APIs, are not mistaken for settings.
  for (const value of [{ items: [], nextCursor: null }, { automatic: false, revision: 0 }, null, { revision: 1, destinations: [{ provider: "email" }] }]) assert.equal(text.parsePublicationDestinations(value), undefined);
  assert.equal(text.retryingAtText("2026-11-03T17:05:00.000Z", "en-US").startsWith("Retrying automatically at Nov 3,"), true);
  assert.equal(text.retryingAtText(null), null); assert.equal(text.retryingAtText("not a time"), null);
});

test("the settings card and activity controls use those texts", () => {
  const publication = source("dashboard/outreach-activity-publication.tsx");
  // Core's own dashboard test still checks the card's title and that it is off by default.
  assert.match(publication, /Automatic activity publication/); assert.match(publication, /Off by default\./);
  assert.doesNotMatch(publication, /Automatically publish Events|draft|approve/i);
  assert.match(publication, /"\/admin\/hours\/publication-destinations"/);
  assert.match(publication, /role="switch" checked=\{destination\.automatic\} disabled=\{switchDisabled\(destination, busy\)\}/);
  assert.match(publication, /<AppLink href=\{integrationsHref\} navigate=\{navigate\}>\{integrationsLinkText\}<\/AppLink>/);
  assert.match(publication, /if \(automatic\) setOffer\(true\);/, "turning a switch on offers Publish upcoming Events once");
  assert.match(publication, />Not now<\/button>/);
  assert.match(publication, /retryingAtText\(current\?\.\[provider\.nextAttemptAt\]\)/);
  assert.match(publication, /Team Support and Other Service activities are never published\./);
});
