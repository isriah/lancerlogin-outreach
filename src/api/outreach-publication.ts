import { addCalendarDays } from "@lancerlogin/module-sdk";
import { outreachDayStartsAt } from "../shared/outreach-reporting.ts";
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { resolveOutreachTiming } from "./outreach-entries.ts";

type Row = Record<string, unknown>;
type RouteResult = { status: number; body: unknown };
export type OutreachPublicationProvider = "google_calendar" | "discord";
export type OutreachPublicationEvent = { activityId: string; revision: number; title: string; description: string; location: string; startsAt: string; endsAt: string; timeZone: string; allDay?: boolean; serviceDate?: string };
export type OutreachPublicationProviders = {
  status(): Promise<Record<OutreachPublicationProvider, boolean>>;
  publish(provider: OutreachPublicationProvider, event: OutreachPublicationEvent, externalId?: string): Promise<string>;
  remove(provider: OutreachPublicationProvider, externalId: string): Promise<void>;
};
export type OutreachPublicationQueueResult = { automatic: boolean; queuedProviders: OutreachPublicationProvider[]; revision: number | null; reason?: "disabled" | "no_providers" | "not_eligible" | "not_published" | "queue_failed"; message?: string };

const installationId = "primary";
const supportedProviders: OutreachPublicationProvider[] = ["google_calendar", "discord"];
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const serialize = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "installation_id").map(([key, value]) => [camel(key), value]));
function text(value: unknown, maximum = 128, required = true) { if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, "Provide valid Outreach publication fields"); return value.trim(); }
function integer(value: unknown, minimum = 0) { if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new HttpError(400, "Provide a valid Outreach publication revision"); return Number(value); }

export async function readOutreachPublicationSetting(db: D1Database) {
  const row = await db.prepare("SELECT automatic,revision FROM hours_publication_settings WHERE installation_id=?").bind(installationId).first<{ automatic: number; revision: number }>();
  if (!row) throw new HttpError(409, "Outreach publication settings are unavailable");
  return { automatic: Boolean(row.automatic), revision: Number(row.revision) };
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
    g.status AS google_status,g.action AS google_action,g.attempts AS google_attempts,g.external_id AS google_external_id,g.last_error AS google_error,
    d.status AS discord_status,d.action AS discord_action,d.attempts AS discord_attempts,d.external_id AS discord_external_id,d.last_error AS discord_error
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
  options: { automatic: boolean; expectedActivityRevision: number; expectedPublicationRevision?: number | null; provider?: OutreachPublicationProvider; remove?: boolean }, now: number): Promise<OutreachPublicationQueueResult> {
  const setting = await readOutreachPublicationSetting(db);
  if (options.automatic && !setting.automatic) return { automatic: true, queuedProviders: [], revision: null, reason: "disabled" };
  const activity = await db.prepare(`SELECT a.*,s.time_zone AS time_zone FROM hours_activities a JOIN organization_settings s ON s.installation_id=a.installation_id WHERE a.installation_id=? AND a.id=?`).bind(installationId, activityId).first<Row>();
  if (!activity || activity.mode !== "event" || activity.archived || Number(activity.revision) !== options.expectedActivityRevision) throw new HttpError(409, "Choose the current active Event activity before publishing");
  const existing = await db.prepare("SELECT * FROM hours_activity_publications WHERE installation_id=? AND activity_id=?").bind(installationId, activityId).first<Row>();
  if (options.expectedPublicationRevision !== undefined && (existing?.revision ?? null) !== options.expectedPublicationRevision) throw new HttpError(409, "Publication status changed; reload before publishing again");
  const available = await providers.status(); const selected = options.provider ? [options.provider] : supportedProviders.filter(provider => available[provider]);
  if (selected.some(provider => !available[provider])) throw new HttpError(409, "The selected publication provider is not configured and verified");
  if (!selected.length) {
    if (!options.automatic) throw new HttpError(409, "Configure and verify Google Calendar or Discord before publishing");
    return { automatic: true, queuedProviders: [], revision: null, reason: "no_providers" };
  }
  const previous = existing ? (await db.prepare("SELECT * FROM hours_publication_operations WHERE installation_id=? AND activity_id=? AND publication_revision=?").bind(installationId, activityId, existing.revision).all<Row>()).results ?? [] : [];
  if (previous.some(row => row.status === "processing")) throw new HttpError(409, "Publication delivery is in progress; try again after it finishes");
  const externalIds = await latestExternalIds(db, activityId);
  if (options.remove && (!existing || !options.provider || !externalIds.has(options.provider))) throw new HttpError(409, "This destination has no published event to remove");
  const timing = options.remove ? { startLocal: existing!.start_local, endLocal: existing!.end_local, startOccurrence: existing!.start_occurrence, endOccurrence: existing!.end_occurrence, startMs: existing!.start_ms, endMs: existing!.end_ms, allDay: false } : publicationTiming(activity, String(activity.time_zone), now, options.automatic || selected.includes("discord"));
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
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'outreach_activity',?,?,? WHERE changes()=1").bind(auditId, installationId, actor, options.remove ? "outreach.publication_cleanup_queued" : "outreach.publication_queued", activityId, JSON.stringify({ automatic: options.automatic, providers: selected, revision }), nowText),
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
  for (const row of rows) {
    const provider = String(row.provider) as OutreachPublicationProvider; if (!available[provider]) { pending += 1; continue; }
    const lease = crypto.randomUUID(); const leaseExpires = new Date(now + 300_000).toISOString();
    const claimed = await db.prepare(`UPDATE hours_publication_operations SET status='processing',lease_token=?,lease_expires_at=?,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND (status='pending' OR (status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?) OR (status='processing' AND lease_expires_at<=?)) AND EXISTS(SELECT 1 FROM hours_activities a WHERE a.installation_id=hours_publication_operations.installation_id AND a.id=hours_publication_operations.activity_id AND (hours_publication_operations.action='delete' OR (a.mode='event' AND a.archived=0)))`).bind(lease, leaseExpires, nowText, installationId, row.activity_id, row.publication_revision, provider, nowText, nowText).run();
    if (claimed.meta?.changes !== 1) continue;
    try {
      let externalId = row.external_id ? String(row.external_id) : undefined;
      if (row.action === "delete") { if (!externalId) throw new Error("Published provider identity is unavailable for cleanup"); await providers.remove(provider, externalId); }
      else { const event = row.event_snapshot_json ? parseOutreachPublicationEvent(JSON.parse(String(row.event_snapshot_json))) : { activityId: String(row.activity_id), revision: Number(row.publication_revision), title: String(row.title), description: String(row.description ?? ""), location: String(row.location ?? ""), startsAt: new Date(Number(row.start_ms)).toISOString(), endsAt: new Date(Number(row.end_ms)).toISOString(), timeZone: String(row.time_zone) }; if (event.activityId !== String(row.activity_id) || event.revision > Number(row.publication_revision)) throw new HttpError(409, "Publication snapshot does not match its owned operation"); externalId = await providers.publish(provider, event, externalId); }
      const completedAt = new Date().toISOString(); const result = await db.prepare(`UPDATE hours_publication_operations SET status='delivered',attempts=attempts+1,next_attempt_at=NULL,external_id=?,last_error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND lease_token=?`).bind(externalId ?? null, completedAt, installationId, row.activity_id, row.publication_revision, provider, lease).run();
      if (result.meta?.changes === 1) { delivered += 1; await db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,NULL,?,'outreach_activity',?,?,?)").bind(crypto.randomUUID(), installationId, row.action === "delete" ? "outreach.publication_removed" : "outreach.publication_delivered", row.activity_id, JSON.stringify({ provider, externalId, revision: row.publication_revision }), completedAt).run(); }
    } catch (error) {
      const attempts = Number(row.attempts ?? 0) + 1; const retryAt = attempts >= 6 ? null : new Date(now + Math.min(3_600_000, 2 ** attempts * 30_000)).toISOString(); const message = (error instanceof Error ? error.message : "Publication delivery failed").replace(/\s+/g, " ").slice(0, 300); const result = await db.prepare(`UPDATE hours_publication_operations SET status='failed',attempts=?,next_attempt_at=?,last_error=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND publication_revision=? AND provider=? AND lease_token=?`).bind(attempts, retryAt, message, nowText, installationId, row.activity_id, row.publication_revision, provider, lease).run(); if (result.meta?.changes === 1) failed += 1;
    }
  }
  return { delivered, failed, pending };
}

async function updateSetting(db: D1Database, actor: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue) || Object.keys(inputValue).some((key) => !["automatic", "revision"].includes(key)) || typeof inputValue.automatic !== "boolean") throw new HttpError(400, "Choose whether Event activities publish automatically");
  const revision = integer(inputValue.revision); const nowText = new Date(now).toISOString(); const results = await db.batch([db.prepare("UPDATE hours_publication_settings SET automatic=?,revision=revision+1,updated_at=? WHERE installation_id=? AND revision=?").bind(Number(inputValue.automatic), nowText, installationId, revision), db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.publication_setting_updated','outreach','primary',?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, JSON.stringify({ automatic: inputValue.automatic }), nowText)]);
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Outreach publication settings changed; reload before saving");
  return { status: 200, body: { automatic: inputValue.automatic, revision: revision + 1 } };
}

export async function outreachPublicationRoute(db: D1Database, providers: OutreachPublicationProviders, actor: string, request: Request, input?: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new HttpError(400, "Invalid current instant"); const path = new URL(request.url).pathname;
  if (path === "/admin/hours/publication-providers" && request.method === "GET") return { status: 200, body: await providers.status() };
  if (path === "/admin/hours/publication-settings" && request.method === "GET") return { status: 200, body: await readOutreachPublicationSetting(db) };
  if (path === "/admin/hours/publication-settings" && request.method === "PATCH") return updateSetting(db, actor, input, now);
  if (path === "/admin/hours/publications" && request.method === "GET") return list(db);
  const match = /^\/admin\/hours\/activities\/([^/]+)\/publication(?:\/(retry))?$/.exec(path); if (!match) throw new HttpError(404, "Outreach publication route not found"); const activityId = decodeURIComponent(match[1]!); const action = match[2];
  if (!action && request.method === "GET") { const result = await list(db, activityId); return { status: 200, body: (result.body as { items: unknown[] }).items[0] ?? null }; }
  if (!action && request.method === "POST") { if (!object(input) || Object.keys(input).some((key) => !["activityRevision", "publicationRevision", "provider", "action"].includes(key))) throw new HttpError(400, "Publish the current Event activity"); const activityRevision = integer(input.activityRevision); const publicationRevision = input.publicationRevision === null ? null : integer(input.publicationRevision); if (input.provider !== undefined && !supportedProviders.includes(input.provider as OutreachPublicationProvider) || input.action !== undefined && !["publish", "delete"].includes(String(input.action)) || input.action === "delete" && input.provider === undefined) throw new HttpError(400, "Choose one supported publication destination and action"); const result = await queuePublication(db, providers, actor, activityId, { automatic: false, expectedActivityRevision: activityRevision, expectedPublicationRevision: publicationRevision, provider: input.provider as OutreachPublicationProvider | undefined, remove: input.action === "delete" }, now); return { status: 202, body: result }; }
  if (action === "retry" && request.method === "POST") return retry(db, providers, actor, activityId, input, now);
  throw new HttpError(405, "Unsupported Outreach publication operation");
}
