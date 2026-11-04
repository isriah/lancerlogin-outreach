import { addCalendarDays } from "@lancerlogin/module-sdk";
import { outreachDayStartsAt } from "../shared/outreach-reporting.ts";
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { resolveOutreachTiming } from "./outreach-entries.ts";

type Row = Record<string, unknown>;
type RouteResult = { status: number; body: unknown };
export type OutreachPublicationProvider = "google_calendar" | "discord";
export type OutreachPublicationEvent = { activityId: string; revision: number; title: string; description: string; location: string; startsAt: string; endsAt: string; timeZone: string; allDay?: boolean; serviceDate?: string };
/** How far one delivery has got: a first attempt has never reached the provider, so it cannot have created an event there. */
export type OutreachPublicationDelivery = { firstAttempt: boolean };
export type OutreachPublicationProviders = {
  status(): Promise<Record<OutreachPublicationProvider, boolean>>;
  publish(provider: OutreachPublicationProvider, event: OutreachPublicationEvent, externalId?: string, delivery?: OutreachPublicationDelivery): Promise<string>;
  remove(provider: OutreachPublicationProvider, externalId: string): Promise<void>;
};
export type OutreachPublicationQueueResult = { automatic: boolean; queuedProviders: OutreachPublicationProvider[]; revision: number | null; reason?: "disabled" | "no_providers" | "not_eligible" | "not_published" | "queue_failed"; message?: string };

export type OutreachPublicationDestinationSettings = Record<OutreachPublicationProvider, boolean> & { revision: number };
export type OutreachPublicationDestinationStatus = { provider: OutreachPublicationProvider; configured: boolean; automatic: boolean; waiting: number; failed: number; latestProblem: { message: string; activityTitle: string; at: string } | null };

const installationId = "primary";
const supportedProviders: OutreachPublicationProvider[] = ["google_calendar", "discord"];
const providerLabels: Record<OutreachPublicationProvider, string> = { google_calendar: "Google Calendar", discord: "Discord" };
const automaticColumns = { google_calendar: "google_calendar_automatic", discord: "discord_automatic" } as const;
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const serialize = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "installation_id").map(([key, value]) => [camel(key), value]));
function text(value: unknown, maximum = 128, required = true) { if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, "Provide valid Outreach publication fields"); return value.trim(); }
function integer(value: unknown, minimum = 0) { if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new HttpError(400, "Provide a valid Outreach publication revision"); return Number(value); }

/** Whether each destination publishes Events automatically. One revision covers both switches. */
export async function readOutreachPublicationDestinations(db: D1Database): Promise<OutreachPublicationDestinationSettings> {
  const row = await db.prepare("SELECT google_calendar_automatic,discord_automatic,revision FROM hours_publication_settings WHERE installation_id=?").bind(installationId).first<{ google_calendar_automatic: number; discord_automatic: number; revision: number }>();
  if (!row) throw new HttpError(409, "Outreach publication settings are unavailable");
  return { google_calendar: Boolean(row.google_calendar_automatic), discord: Boolean(row.discord_automatic), revision: Number(row.revision) };
}

/**
 * The original single setting, which callers from before per-destination switches read. Its column is kept on while either
 * switch is on, so this reads only the columns every Outreach schema has.
 */
export async function readOutreachPublicationSetting(db: D1Database) {
  const row = await db.prepare("SELECT automatic,revision FROM hours_publication_settings WHERE installation_id=?").bind(installationId).first<{ automatic: number; revision: number }>();
  if (!row) throw new HttpError(409, "Outreach publication settings are unavailable");
  return { automatic: Boolean(row.automatic), revision: Number(row.revision) };
}

/** Destinations an Event is published to now: its current publication revision holds a published event there, not a removal. */
async function publishedProviders(db: D1Database, activityId: string) {
  const rows = (await db.prepare(`SELECT o.provider FROM hours_publication_operations o JOIN hours_activity_publications p ON p.installation_id=o.installation_id AND p.activity_id=o.activity_id AND p.revision=o.publication_revision
    WHERE o.installation_id=? AND o.activity_id=? AND o.action='publish' AND o.external_id IS NOT NULL`).bind(installationId, activityId).all<{ provider: OutreachPublicationProvider }>()).results ?? [];
  return new Set(rows.map((row) => row.provider));
}

/** Destinations that saving this Event updates: those whose switch is on, and those it is already published to even when their switch is off. */
export async function outreachAutomaticDestinations(db: D1Database, activityId?: string) {
  const destinations = await readOutreachPublicationDestinations(db); const published = activityId ? await publishedProviders(db, activityId) : new Set<OutreachPublicationProvider>();
  return supportedProviders.filter((provider) => destinations[provider] || published.has(provider));
}

/**
 * A delivery failure a provider has classified, as Core classifies meeting calendar failures. `retry` is false for a failure
 * that repeats until someone acts, which waits for a manual Retry; `stopsBatch` ends this run's deliveries to that
 * destination, for a missing permission or a rate limit; `retryAfterMs` is the wait the provider asked for. A rate limit
 * (`rateLimited`) says nothing about the delivery itself, so it is not counted as an attempt.
 */
export class OutreachPublicationDeliveryError extends Error {
  readonly retry: boolean; readonly stopsBatch: boolean; readonly rateLimited: boolean; readonly retryAfterMs?: number;
  constructor(message: string, options: { retry: boolean; stopsBatch?: boolean; rateLimited?: boolean; retryAfterMs?: number }) { super(message); this.retry = options.retry; this.stopsBatch = options.stopsBatch ?? false; this.rateLimited = options.rateLimited ?? false; this.retryAfterMs = options.retryAfterMs; }
}

/** The automatic retry delay, as meetings use it: doubling from a minute, at least what the provider asked for, at most an hour. */
export function outreachPublicationBackoff(attempts: number, retryAfterMs = 0) { return Math.min(3_600_000, Math.max(60_000, 2 ** Math.min(attempts, 12) * 1_000, retryAfterMs)); }
/** A rate limit waits what the provider asked for, from a minute to an hour, without the attempt backoff. */
export function outreachRateLimitDelay(retryAfterMs = 0) { return Math.min(3_600_000, Math.max(60_000, retryAfterMs)); }

function deliveryFailure(error: unknown): { retry: boolean; stopsBatch: boolean; rateLimited: boolean; retryAfterMs?: number } {
  if (error instanceof OutreachPublicationDeliveryError) return error;
  // Outreach's own refusals, such as an Event title Discord cannot take or a snapshot that does not match, repeat on every attempt.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return { retry: false, stopsBatch: false, rateLimited: false };
  return { retry: true, stopsBatch: false, rateLimited: false };
}

function publicationTiming(activity: Row, timeZone: string, now: number, requireFuture = true) {
  if (Boolean(activity.event_start_local) !== Boolean(activity.event_end_local)) throw new HttpError(400, "Provide both an event start time and end time");
  const allDay = !activity.event_start_local && !activity.event_end_local;
  const timing = allDay ? { startLocal: "00:00", endLocal: "00:00", startOccurrence: null, endOccurrence: null,
    startMs: outreachDayStartsAt(String(activity.service_date), timeZone), endMs: outreachDayStartsAt(addCalendarDays(String(activity.service_date), 1), timeZone) } : resolveOutreachTiming({ startLocal: activity.event_start_local, endLocal: activity.event_end_local, startOccurrence: activity.event_start_occurrence, endOccurrence: activity.event_end_occurrence }, String(activity.service_date), timeZone, now, true);
  if (requireFuture && timing.endMs <= now) throw new HttpError(409, "Only an event whose scheduled end is still in the future can be published");
  return { ...timing, allDay };
}

export async function validateOutreachEventSchedule(db: D1Database, activity: Row, now: number, required: boolean, requireFuture = required) {
  const hasStart = Boolean(activity.event_start_local); const hasEnd = Boolean(activity.event_end_local);
  if (!hasStart && !hasEnd && !required) return null;
  if (hasStart !== hasEnd) throw new HttpError(400, "Provide both an event start time and end time");
  const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
  if (!settings) throw new HttpError(409, "Organization time zone is unavailable");
  return publicationTiming(activity, settings.timeZone, now, requireFuture);
}

async function list(db: D1Database, activityId?: string): Promise<RouteResult> {
  const rows = (await db.prepare(`SELECT p.*,a.title,a.description,a.location,a.service_date,
    g.status AS google_status,g.action AS google_action,g.attempts AS google_attempts,g.external_id AS google_external_id,g.last_error AS google_error,g.next_attempt_at AS google_next_attempt_at,
    d.status AS discord_status,d.action AS discord_action,d.attempts AS discord_attempts,d.external_id AS discord_external_id,d.last_error AS discord_error,d.next_attempt_at AS discord_next_attempt_at
    FROM hours_activity_publications p JOIN hours_activities a ON a.installation_id=p.installation_id AND a.id=p.activity_id
    LEFT JOIN hours_publication_operations g ON g.installation_id=p.installation_id AND g.activity_id=p.activity_id AND g.publication_revision=p.revision AND g.provider='google_calendar'
    LEFT JOIN hours_publication_operations d ON d.installation_id=p.installation_id AND d.activity_id=p.activity_id AND d.publication_revision=p.revision AND d.provider='discord'
    WHERE p.installation_id=? ${activityId ? "AND p.activity_id=?" : ""} ORDER BY a.service_date,a.title,a.id LIMIT 100`).bind(installationId, ...(activityId ? [activityId] : [])).all<Row>()).results ?? [];
  return { status: 200, body: { items: rows.map((row) => ({ ...serialize(row), googleCalendar: Boolean(row.google_calendar), discord: Boolean(row.discord) })), nextCursor: null } };
}

async function latestExternalIds(db: D1Database, activityId: string) {
  const rows = (await db.prepare(`SELECT provider,external_id FROM hours_publication_operations WHERE installation_id=? AND activity_id=? AND action='publish' AND external_id IS NOT NULL ORDER BY publication_revision DESC`).bind(installationId, activityId).all<{ provider: OutreachPublicationProvider; external_id: string }>()).results ?? [];
  const found = new Map<OutreachPublicationProvider, string>();
  for (const row of rows) if (!found.has(row.provider)) found.set(row.provider, row.external_id);
  return found;
}

export function outreachGoogleEventPayload(event: OutreachPublicationEvent) {
  return { summary: event.title, description: event.description, location: event.location,
    start: event.allDay ? { date: event.serviceDate, dateTime: null, timeZone: null } : { date: null, dateTime: event.startsAt, timeZone: event.timeZone },
    end: event.allDay ? { date: addCalendarDays(event.serviceDate!, 1), dateTime: null, timeZone: null } : { date: null, dateTime: event.endsAt, timeZone: event.timeZone } };
}

export function parseOutreachPublicationEvent(value: unknown): OutreachPublicationEvent {
  if (!object(value) || Object.keys(value).some(key => !["activityId", "revision", "title", "description", "location", "startsAt", "endsAt", "timeZone", "allDay", "serviceDate"].includes(key))) throw new HttpError(400, "Invalid publication snapshot");
  for (const [key, maximum, required] of [["activityId", 128, true], ["title", 150, true], ["description", 4000, false], ["location", 300, false], ["timeZone", 100, true]] as const) text(value[key], maximum, required);
  integer(value.revision);
  if (typeof value.startsAt !== "string" || typeof value.endsAt !== "string" || !Number.isFinite(Date.parse(value.startsAt)) || !Number.isFinite(Date.parse(value.endsAt)) || Date.parse(value.endsAt) <= Date.parse(value.startsAt)) throw new HttpError(400, "Invalid publication snapshot times");
  new Intl.DateTimeFormat("en-US", { timeZone: String(value.timeZone) });
  if (value.allDay !== undefined && typeof value.allDay !== "boolean") throw new HttpError(400, "Invalid all-day publication snapshot");
  if (value.allDay) {
    if (typeof value.serviceDate !== "string" || new Date(outreachDayStartsAt(value.serviceDate, String(value.timeZone))).toISOString() !== value.startsAt || new Date(outreachDayStartsAt(addCalendarDays(value.serviceDate, 1), String(value.timeZone))).toISOString() !== value.endsAt) throw new HttpError(400, "Invalid all-day publication date");
  }
  return value as OutreachPublicationEvent;
}

async function queuePublication(db: D1Database, providers: OutreachPublicationProviders, actor: string, activityId: string,
  options: { automatic: boolean; backfill?: boolean; expectedActivityRevision: number; expectedPublicationRevision?: number | null; providers?: OutreachPublicationProvider[]; remove?: boolean }, now: number): Promise<OutreachPublicationQueueResult> {
  const wanted = options.automatic ? await outreachAutomaticDestinations(db, activityId) : undefined;
  if (wanted && !wanted.length) return { automatic: true, queuedProviders: [], revision: null, reason: "disabled" };
  const activity = await db.prepare(`SELECT a.*,s.time_zone AS time_zone FROM hours_activities a JOIN organization_settings s ON s.installation_id=a.installation_id WHERE a.installation_id=? AND a.id=?`).bind(installationId, activityId).first<Row>();
  if (!activity || activity.mode !== "event" || activity.archived || Number(activity.revision) !== options.expectedActivityRevision) throw new HttpError(409, "Choose the current active Event activity before publishing");
  const existing = await db.prepare("SELECT * FROM hours_activity_publications WHERE installation_id=? AND activity_id=?").bind(installationId, activityId).first<Row>();
  if (options.expectedPublicationRevision !== undefined && (existing?.revision ?? null) !== options.expectedPublicationRevision) throw new HttpError(409, "Publication status changed; reload before publishing again");
  const available = await providers.status(); const selected = options.providers ?? (wanted ?? supportedProviders).filter(provider => available[provider]);
  if (selected.some(provider => !available[provider])) throw new HttpError(409, "The selected publication provider is not configured and verified");
  if (!selected.length) {
    if (!options.automatic) throw new HttpError(409, "Configure and verify Google Calendar or Discord before publishing");
    return { automatic: true, queuedProviders: [], revision: null, reason: "no_providers" };
  }
  const previous = existing ? (await db.prepare("SELECT * FROM hours_publication_operations WHERE installation_id=? AND activity_id=? AND publication_revision=?").bind(installationId, activityId, existing.revision).all<Row>()).results ?? [] : [];
  if (previous.some(row => row.status === "processing")) throw new HttpError(409, "Publication delivery is in progress; try again after it finishes");
  const externalIds = await latestExternalIds(db, activityId);
  if (options.remove && (!existing || selected.length !== 1 || !externalIds.has(selected[0]!))) throw new HttpError(409, "This destination has no published event to remove");
  const timing = options.remove ? { startLocal: existing!.start_local, endLocal: existing!.end_local, startOccurrence: existing!.start_occurrence, endOccurrence: existing!.end_occurrence, startMs: existing!.start_ms, endMs: existing!.end_ms, allDay: false } : publicationTiming(activity, String(activity.time_zone), now, options.automatic || Boolean(options.backfill) || selected.includes("discord"));
  const revision = existing ? Number(existing.revision) + 1 : 0; const nowText = new Date(now).toISOString(); const auditId = crypto.randomUUID();
  const event: OutreachPublicationEvent = { activityId, revision, title: String(activity.title), description: String(activity.description ?? ""), location: String(activity.location ?? ""),
    startsAt: new Date(Number(timing.startMs)).toISOString(), endsAt: new Date(Number(timing.endMs)).toISOString(), timeZone: String(activity.time_zone), allDay: timing.allDay, serviceDate: String(activity.service_date) };
  const googleCalendar = Number(selected.includes("google_calendar") || Boolean(existing?.google_calendar)); const discord = Number(selected.includes("discord") || Boolean(existing?.discord));
  const deliveryGuard = "NOT EXISTS(SELECT 1 FROM hours_publication_operations WHERE installation_id=? AND activity_id=? AND status='processing' AND publication_revision=?) AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=? AND revision=? AND mode='event' AND archived=0)";
  const guardValues = [installationId, activityId, existing?.revision ?? -1, installationId, activityId, options.expectedActivityRevision];
  const mutation = existing
    ? db.prepare(`UPDATE hours_activity_publications SET time_zone=?,start_local=?,end_local=?,start_occurrence=?,end_occurrence=?,start_ms=?,end_ms=?,google_calendar=?,discord=?,status='approved',revision=revision+1,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE installation_id=? AND activity_id=? AND revision=? AND ${deliveryGuard}`).bind(activity.time_zone, timing.startLocal, timing.endLocal, timing.startOccurrence, timing.endOccurrence, timing.startMs, timing.endMs, googleCalendar, discord, actor, nowText, nowText, installationId, activityId, existing.revision, ...guardValues)
    : db.prepare(`INSERT INTO hours_activity_publications(installation_id,activity_id,time_zone,start_local,end_local,start_occurrence,end_occurrence,start_ms,end_ms,google_calendar,discord,status,revision,actor_user_id,reviewed_by_user_id,reviewed_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,'approved',0,?,?,?,?,? WHERE ${deliveryGuard} AND NOT EXISTS(SELECT 1 FROM hours_activity_publications WHERE installation_id=? AND activity_id=?)`).bind(installationId, activityId, activity.time_zone, timing.startLocal, timing.endLocal, timing.startOccurrence, timing.endOccurrence, timing.startMs, timing.endMs, googleCalendar, discord, actor, actor, nowText, nowText, nowText, ...guardValues, installationId, activityId);
  const statements: D1Statement[] = [mutation,
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'outreach_activity',?,?,? WHERE changes()=1").bind(auditId, installationId, actor, options.remove ? "outreach.publication_cleanup_queued" : "outreach.publication_queued", activityId, JSON.stringify({ automatic: options.automatic, ...(options.backfill ? { backfill: true } : {}), providers: selected, revision }), nowText),
    ...selected.map(provider => db.prepare(`INSERT INTO hours_publication_operations(installation_id,activity_id,publication_revision,provider,status,attempts,next_attempt_at,external_id,created_at,updated_at,action,event_snapshot_json) SELECT ?,?,?,?,'pending',0,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(installationId, activityId, revision, provider, nowText, externalIds.get(provider) ?? null, nowText, nowText, options.remove ? "delete" : "publish", options.remove ? null : JSON.stringify(event), auditId)),
    ...previous.filter(row => !selected.includes(row.provider as OutreachPublicationProvider)).map(row => db.prepare(`INSERT INTO hours_publication_operations(installation_id,activity_id,publication_revision,provider,status,attempts,next_attempt_at,external_id,last_error,created_at,updated_at,action,event_snapshot_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(installationId, activityId, revision, row.provider, row.status, row.attempts, row.next_attempt_at, row.external_id, row.last_error, row.created_at, row.updated_at, row.action, row.event_snapshot_json ?? (row.action === "publish" ? JSON.stringify({ ...event, revision: Number(existing!.revision), startsAt: new Date(Number(existing!.start_ms)).toISOString(), endsAt: new Date(Number(existing!.end_ms)).toISOString(), timeZone: String(existing!.time_zone), allDay: false }) : null), auditId)),
  ];
  const results = await db.batch(statements); if (results.some(result => result.meta?.changes !== 1)) throw new HttpError(409, "Publication status changed; reload before publishing again");
  return { automatic: options.automatic, queuedProviders: selected, revision };
}

export async function queueAutomaticOutreachPublication(db: D1Database, providers: OutreachPublicationProviders, actor: string, activityId: string, activityRevision: number, now = Date.now()) { return queuePublication(db, providers, actor, activityId, { automatic: true, expectedActivityRevision: activityRevision }, now); }

export async function queueOutreachPublicationCleanup(db: D1Database, actor: string, activityId: string, now = Date.now()): Promise<OutreachPublicationQueueResult> {
  const existing = await db.prepare("SELECT * FROM hours_activity_publications WHERE installation_id=? AND activity_id=?").bind(installationId, activityId).first<Row>();
  if (!existing) return { automatic: true, queuedProviders: [], revision: null, reason: "not_published" };
  const nowText = new Date(now).toISOString();
  await db.prepare("UPDATE hours_publication_operations SET status='failed',next_attempt_at=NULL,last_error='Activity is no longer eligible for Event publication',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND action='publish' AND status IN ('pending','failed')").bind(nowText, installationId, activityId).run();
  const externalIds = await latestExternalIds(db, activityId); const selected = supportedProviders.filter((provider) => externalIds.has(provider));
  if (!selected.length) return { automatic: true, queuedProviders: [], revision: Number(existing.revision), reason: "not_published" };
  const revision = Number(existing.revision) + 1; const googleCalendar = Number(selected.includes("google_calendar")); const discord = Number(selected.includes("discord"));
  const statements: D1Statement[] = [db.prepare(`UPDATE hours_activity_publications SET google_calendar=?,discord=?,status='approved',revision=revision+1,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE installation_id=? AND activity_id=? AND revision=?`).bind(googleCalendar, discord, actor, nowText, nowText, installationId, activityId, existing.revision), ...selected.map((provider) => db.prepare(`INSERT INTO hours_publication_operations(installation_id,activity_id,publication_revision,provider,status,attempts,next_attempt_at,external_id,created_at,updated_at,action) VALUES(?,?,?,?,'pending',0,?,?,?,?, 'delete')`).bind(installationId, activityId, revision, provider, nowText, externalIds.get(provider), nowText, nowText)), db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.publication_cleanup_queued','outreach_activity',?,?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, activityId, JSON.stringify({ providers: selected, revision }), nowText)];
  const results = await db.batch(statements); if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Publication cleanup status changed; reload before retrying");
  return { automatic: true, queuedProviders: selected, revision };
}

async function retry(db: D1Database, providers: OutreachPublicationProviders, actor: string, activityId: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue) || Object.keys(inputValue).some((key) => !["revision", "provider"].includes(key))) throw new HttpError(400, "Choose one failed publication delivery");
  const revision = integer(inputValue.revision); const provider = text(inputValue.provider, 32) as OutreachPublicationProvider; if (!supportedProviders.includes(provider)) throw new HttpError(400, "Choose one supported publication destination");
  if (!(await providers.status())[provider]) throw new HttpError(409, "The selected publication provider is not configured and verified");
  const nowText = new Date(now).toISOString(); const results = await db.batch([db.prepare(`UPDATE hours_publication_operations SET status='pending',next_attempt_at=?,last_error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND status='failed' AND EXISTS(SELECT 1 FROM hours_activity_publications WHERE installation_id=? AND activity_id=? AND status='approved' AND revision=?)`).bind(nowText, nowText, installationId, activityId, revision, provider, installationId, activityId, revision), db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.publication_retried','outreach_activity',?,?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, activityId, JSON.stringify({ provider, revision }), nowText)]);
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Failed publication delivery changed; reload before retrying");
  return { status: 202, body: { activityId, revision, provider, status: "pending" } };
}

export async function processOutreachPublicationOperations(db: D1Database, providers: OutreachPublicationProviders, now = Date.now()): Promise<{ delivered: number; failed: number; pending: number }> {
  const nowText = new Date(now).toISOString(); const available = await providers.status();
  const rows = (await db.prepare(`SELECT o.*,p.time_zone,p.start_ms,p.end_ms,a.title,a.description,a.location FROM hours_publication_operations o JOIN hours_activity_publications p ON p.installation_id=o.installation_id AND p.activity_id=o.activity_id AND p.revision=o.publication_revision AND p.status='approved' JOIN hours_activities a ON a.installation_id=o.installation_id AND a.id=o.activity_id WHERE o.installation_id=? AND (o.action='delete' OR a.archived=0) AND (o.status='pending' OR (o.status='failed' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at<=?) OR (o.status='processing' AND o.lease_expires_at<=?)) ORDER BY o.updated_at,o.activity_id,o.provider LIMIT 10`).bind(installationId, nowText, nowText).all<Row>()).results ?? [];
  let delivered = 0; let failed = 0; let pending = 0;
  // A destination that refused a permission or rate limited this run gets no more requests until the next run.
  const stopped = new Set<OutreachPublicationProvider>();
  for (const row of rows) {
    const provider = String(row.provider) as OutreachPublicationProvider; if (!available[provider] || stopped.has(provider)) { pending += 1; continue; }
    const lease = crypto.randomUUID(); const leaseExpires = new Date(now + 300_000).toISOString();
    const claimed = await db.prepare(`UPDATE hours_publication_operations SET status='processing',lease_token=?,lease_expires_at=?,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND (status='pending' OR (status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?) OR (status='processing' AND lease_expires_at<=?)) AND EXISTS(SELECT 1 FROM hours_activities a WHERE a.installation_id=hours_publication_operations.installation_id AND a.id=hours_publication_operations.activity_id AND (hours_publication_operations.action='delete' OR (a.mode='event' AND a.archived=0)))`).bind(lease, leaseExpires, nowText, installationId, row.activity_id, row.publication_revision, provider, nowText, nowText).run();
    if (claimed.meta?.changes !== 1) continue;
    // A lease that expired mid-delivery is not a first attempt: the provider may have created the event before the Worker stopped.
    try {
      let externalId = row.external_id ? String(row.external_id) : undefined;
      if (row.action === "delete") { if (!externalId) throw new Error("Published provider identity is unavailable for cleanup"); await providers.remove(provider, externalId); }
      else { const event = row.event_snapshot_json ? parseOutreachPublicationEvent(JSON.parse(String(row.event_snapshot_json))) : { activityId: String(row.activity_id), revision: Number(row.publication_revision), title: String(row.title), description: String(row.description ?? ""), location: String(row.location ?? ""), startsAt: new Date(Number(row.start_ms)).toISOString(), endsAt: new Date(Number(row.end_ms)).toISOString(), timeZone: String(row.time_zone) }; if (event.activityId !== String(row.activity_id) || event.revision > Number(row.publication_revision)) throw new HttpError(409, "Publication snapshot does not match its owned operation"); externalId = await providers.publish(provider, event, externalId, { firstAttempt: Number(row.attempts ?? 0) === 0 && row.status !== "processing" }); }
      const completedAt = new Date().toISOString(); const result = await db.prepare(`UPDATE hours_publication_operations SET status='delivered',attempts=attempts+1,next_attempt_at=NULL,external_id=?,last_error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND lease_token=?`).bind(externalId ?? null, completedAt, installationId, row.activity_id, row.publication_revision, provider, lease).run();
      if (result.meta?.changes === 1) { delivered += 1; await db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,NULL,?,'outreach_activity',?,?,?)").bind(crypto.randomUUID(), installationId, row.action === "delete" ? "outreach.publication_removed" : "outreach.publication_delivered", row.activity_id, JSON.stringify({ provider, externalId, revision: row.publication_revision }), completedAt).run(); }
    } catch (error) {
      // A failure that can pass retries with backoff for as long as it lasts; one that repeats until someone acts waits for Retry.
      const failure = deliveryFailure(error); if (failure.stopsBatch) stopped.add(provider);
      // A rate limit waits what the provider asked for and leaves the attempt count, and so the backoff, where it was.
      const attempts = Number(row.attempts ?? 0) + (failure.rateLimited ? 0 : 1); const retryAt = failure.rateLimited ? new Date(now + outreachRateLimitDelay(failure.retryAfterMs)).toISOString() : failure.retry ? new Date(now + outreachPublicationBackoff(attempts, failure.retryAfterMs)).toISOString() : null; const message = (error instanceof Error ? error.message : "Publication delivery failed").replace(/\s+/g, " ").slice(0, 300); const result = await db.prepare(`UPDATE hours_publication_operations SET status='failed',attempts=?,next_attempt_at=?,last_error=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND lease_token=?`).bind(attempts, retryAt, message, nowText, installationId, row.activity_id, row.publication_revision, provider, lease).run(); if (result.meta?.changes === 1) { if (failure.rateLimited) pending += 1; else failed += 1; }
    }
  }
  return { delivered, failed, pending };
}

async function updateSetting(db: D1Database, actor: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue) || Object.keys(inputValue).some((key) => !["automatic", "revision"].includes(key)) || typeof inputValue.automatic !== "boolean") throw new HttpError(400, "Choose whether Event activities publish automatically");
  // The original single switch sets both destinations.
  const automatic = Number(inputValue.automatic); const revision = integer(inputValue.revision); const nowText = new Date(now).toISOString(); const results = await db.batch([db.prepare("UPDATE hours_publication_settings SET automatic=?,google_calendar_automatic=?,discord_automatic=?,revision=revision+1,updated_at=? WHERE installation_id=? AND revision=?").bind(automatic, automatic, automatic, nowText, installationId, revision), db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.publication_setting_updated','outreach','primary',?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, JSON.stringify({ automatic: inputValue.automatic }), nowText)]);
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Outreach publication settings changed; reload before saving");
  return { status: 200, body: { automatic: inputValue.automatic, revision: revision + 1 } };
}

/**
 * Each destination's switch and delivery, like Core's Calendar delivery panel: deliveries of each Event's current
 * publication that are waiting, those that need another attempt, and the newest problem. A publish delivery that stopped
 * because its activity was archived or stopped being an Event is not a problem.
 */
async function destinationStatus(db: D1Database, providers: OutreachPublicationProviders): Promise<{ revision: number; destinations: OutreachPublicationDestinationStatus[] }> {
  const [setting, available] = await Promise.all([readOutreachPublicationDestinations(db), providers.status()]);
  const current = `FROM hours_publication_operations o JOIN hours_activity_publications p ON p.installation_id=o.installation_id AND p.activity_id=o.activity_id AND p.revision=o.publication_revision
    JOIN hours_activities a ON a.installation_id=o.installation_id AND a.id=o.activity_id WHERE o.installation_id=? AND o.provider=? AND (o.action='delete' OR (a.mode='event' AND a.archived=0))`;
  const destinations: OutreachPublicationDestinationStatus[] = [];
  for (const provider of supportedProviders) {
    const counts = await db.prepare(`SELECT SUM(CASE WHEN o.status IN ('pending','processing') THEN 1 ELSE 0 END) AS waiting,SUM(CASE WHEN o.status='failed' THEN 1 ELSE 0 END) AS failed ${current}`).bind(installationId, provider).first<{ waiting: number | null; failed: number | null }>();
    const problem = await db.prepare(`SELECT o.last_error AS message,o.updated_at AS at,a.title AS activityTitle ${current} AND o.status='failed' AND o.last_error IS NOT NULL ORDER BY o.updated_at DESC,o.activity_id LIMIT 1`).bind(installationId, provider).first<{ message: string; at: string; activityTitle: string }>();
    destinations.push({ provider, configured: available[provider], automatic: setting[provider], waiting: Number(counts?.waiting ?? 0), failed: Number(counts?.failed ?? 0), latestProblem: problem ? { message: String(problem.message), activityTitle: String(problem.activityTitle), at: String(problem.at) } : null });
  }
  return { revision: setting.revision, destinations };
}

async function updateDestination(db: D1Database, providers: OutreachPublicationProviders, actor: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue) || Object.keys(inputValue).some((key) => !["provider", "automatic", "revision"].includes(key)) || !supportedProviders.includes(inputValue.provider as OutreachPublicationProvider) || typeof inputValue.automatic !== "boolean") throw new HttpError(400, "Choose a destination and whether Events publish there automatically");
  const provider = inputValue.provider as OutreachPublicationProvider; const revision = integer(inputValue.revision);
  if (inputValue.automatic && !(await providers.status())[provider]) throw new HttpError(409, `${providerLabels[provider]} is not set up. Set it up in Settings > Integrations first.`);
  const column = automaticColumns[provider]; const other = automaticColumns[provider === "discord" ? "google_calendar" : "discord"]; const nowText = new Date(now).toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE hours_publication_settings SET ${column}=?,automatic=CASE WHEN ?=1 OR ${other}=1 THEN 1 ELSE 0 END,revision=revision+1,updated_at=? WHERE installation_id=? AND revision=?`).bind(Number(inputValue.automatic), Number(inputValue.automatic), nowText, installationId, revision),
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.publication_setting_updated','outreach','primary',?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, JSON.stringify({ provider, automatic: inputValue.automatic }), nowText),
  ]);
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Outreach publication settings changed; reload before saving");
  return { status: 200, body: await destinationStatus(db, providers) };
}

// Publish upcoming Events pages like Core's Discord sync-all: 10 Events a request, and at most 100 in one run. The cursor
// carries how many Events the run has selected, so the server ends the run at the limit.
const backfillBatchLimit = 10; const backfillLimit = 100;
function backfillCursor(value: string | null): { serviceDate: string; id: string; selected: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed[0]) || typeof parsed[1] !== "string" || !parsed[1] || !Number.isSafeInteger(parsed[2]) || parsed[2] < 1 || parsed[2] > backfillLimit) throw new Error("invalid");
    return { serviceDate: parsed[0], id: parsed[1], selected: parsed[2] };
  } catch { throw new HttpError(400, "The publish upcoming Events cursor is invalid"); }
}

function localDate(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Queue the next page of active Events that have not ended yet to every destination whose switch is on and that is set up.
 * An Event already published or waiting there is skipped, so turning on a second destination publishes only to it.
 */
async function backfill(db: D1Database, providers: OutreachPublicationProviders, actor: string, request: Request, now: number): Promise<RouteResult> {
  const cursor = backfillCursor(new URL(request.url).searchParams.get("after"));
  const [setting, available] = await Promise.all([readOutreachPublicationDestinations(db), providers.status()]);
  const enabled = supportedProviders.filter((provider) => setting[provider] && available[provider]);
  if (!enabled.length) throw new HttpError(409, "Turn on automatic publication for a set-up destination before publishing upcoming Events");
  const organization = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
  if (!organization) throw new HttpError(409, "Organization time zone is unavailable");
  const take = Math.min(backfillBatchLimit, backfillLimit - (cursor?.selected ?? 0));
  const page = (await db.prepare(`SELECT * FROM hours_activities WHERE installation_id=? AND mode='event' AND archived=0 AND service_date>=? AND (? IS NULL OR service_date>? OR (service_date=? AND id>?)) ORDER BY service_date,id LIMIT ?`)
    .bind(installationId, localDate(now, organization.timeZone), cursor?.serviceDate ?? null, cursor?.serviceDate ?? null, cursor?.serviceDate ?? null, cursor?.id ?? null, take + 1).all<Row>()).results ?? [];
  const activities = page.slice(0, take); let queued = 0; let skipped = 0; let failed = 0;
  for (const activity of activities) {
    const activityId = String(activity.id);
    try { publicationTiming(activity, organization.timeZone, now, true); } catch { skipped += 1; continue; }
    const existing = await db.prepare("SELECT revision FROM hours_activity_publications WHERE installation_id=? AND activity_id=?").bind(installationId, activityId).first<{ revision: number }>();
    const operations = existing ? (await db.prepare("SELECT provider,action,status FROM hours_publication_operations WHERE installation_id=? AND activity_id=? AND publication_revision=?").bind(installationId, activityId, existing.revision).all<Row>()).results ?? [] : [];
    // Published, waiting or being delivered stays as it is; a removal or a failed delivery is queued again.
    const needed = enabled.filter((provider) => !operations.some((row) => row.provider === provider && row.action === "publish" && row.status !== "failed"));
    if (!needed.length) { skipped += 1; continue; }
    try { await queuePublication(db, providers, actor, activityId, { automatic: false, backfill: true, expectedActivityRevision: Number(activity.revision), expectedPublicationRevision: existing ? Number(existing.revision) : null, providers: needed }, now); queued += 1; }
    catch { failed += 1; }
  }
  const selected = (cursor?.selected ?? 0) + activities.length;
  const nextCursor = page.length > take && selected < backfillLimit ? btoa(JSON.stringify([String(activities.at(-1)!.service_date), String(activities.at(-1)!.id), selected])) : null;
  const nowText = new Date(now).toISOString();
  await db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,'outreach.publication_backfill_requested','outreach','primary',?,?)").bind(crypto.randomUUID(), installationId, actor, JSON.stringify({ providers: enabled, selected: activities.length, queued, skipped, failed, continued: Boolean(cursor), hasMore: Boolean(nextCursor) }), nowText).run();
  return { status: 200, body: { providers: enabled, selected: activities.length, queued, skipped, failed, nextCursor, limit: backfillLimit, batchLimit: backfillBatchLimit } };
}

export async function outreachPublicationRoute(db: D1Database, providers: OutreachPublicationProviders, actor: string, request: Request, input?: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new HttpError(400, "Invalid current instant"); const path = new URL(request.url).pathname;
  if (path === "/admin/hours/publication-providers" && request.method === "GET") return { status: 200, body: await providers.status() };
  if (path === "/admin/hours/publication-settings" && request.method === "GET") return { status: 200, body: await readOutreachPublicationSetting(db) };
  if (path === "/admin/hours/publication-settings" && request.method === "PATCH") return updateSetting(db, actor, input, now);
  if (path === "/admin/hours/publication-destinations" && request.method === "GET") return { status: 200, body: await destinationStatus(db, providers) };
  if (path === "/admin/hours/publication-destinations" && request.method === "PATCH") return updateDestination(db, providers, actor, input, now);
  if (path === "/admin/hours/publication-destinations/backfill" && request.method === "POST") { if (input !== undefined && (!object(input) || Object.keys(input).length)) throw new HttpError(400, "Publish upcoming Events takes no fields"); return backfill(db, providers, actor, request, now); }
  if (path === "/admin/hours/publications" && request.method === "GET") return list(db);
  const match = /^\/admin\/hours\/activities\/([^/]+)\/publication(?:\/(retry))?$/.exec(path); if (!match) throw new HttpError(404, "Outreach publication route not found"); const activityId = decodeURIComponent(match[1]!); const action = match[2];
  if (!action && request.method === "GET") { const result = await list(db, activityId); return { status: 200, body: (result.body as { items: unknown[] }).items[0] ?? null }; }
  if (!action && request.method === "POST") { if (!object(input) || Object.keys(input).some((key) => !["activityRevision", "publicationRevision", "provider", "action"].includes(key))) throw new HttpError(400, "Publish the current Event activity"); const activityRevision = integer(input.activityRevision); const publicationRevision = input.publicationRevision === null ? null : integer(input.publicationRevision); if (input.provider !== undefined && !supportedProviders.includes(input.provider as OutreachPublicationProvider) || input.action !== undefined && !["publish", "delete"].includes(String(input.action)) || input.action === "delete" && input.provider === undefined) throw new HttpError(400, "Choose one supported publication destination and action"); const result = await queuePublication(db, providers, actor, activityId, { automatic: false, expectedActivityRevision: activityRevision, expectedPublicationRevision: publicationRevision, providers: input.provider === undefined ? undefined : [input.provider as OutreachPublicationProvider], remove: input.action === "delete" }, now); return { status: 202, body: result }; }
  if (action === "retry" && request.method === "POST") return retry(db, providers, actor, activityId, input, now);
  throw new HttpError(405, "Unsupported Outreach publication operation");
}
