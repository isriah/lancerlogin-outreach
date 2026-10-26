import { addCalendarDays, instantToCivil } from "@lancerlogin/module-sdk";
import { outreachReportingState } from "../shared/outreach-reporting.ts";
import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { resolveOutreachTiming } from "./outreach-entries.ts";

type Row = Record<string, unknown>;
type RouteResult = { status: number; body: unknown };
export type OutreachCorrectionContext = { channel: "public" } | { channel: "discord"; discordUserId: string };
const installationId = "primary";
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const serialize = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "installation_id").map(([key, value]) => [camel(key), value]));

function text(value: unknown, maximum = 128, required = true) {
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, "Provide valid Outreach review fields");
  return value.trim();
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new HttpError(400, "Provide a valid Outreach revision or duration");
  return Number(value);
}

function canonical(value: Row) { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))); }
async function sha256(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

async function correctionReceipt(db: D1Database, channel: OutreachCorrectionContext["channel"], keyHash: string, fingerprint: string) {
  const row = await db.prepare("SELECT id AS reference,status,created_at AS createdAt,fingerprint FROM hours_correction_requests WHERE installation_id=? AND channel=? AND key_hash=?").bind(installationId, channel, keyHash).first<Row>();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new HttpError(409, "This correction key was already used for different input");
  const { fingerprint: _, ...receipt } = row;
  return receipt;
}

export async function requestOutreachCorrection(db: D1Database, context: OutreachCorrectionContext, inputValue: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()) || !object(inputValue)) throw new HttpError(400, "Provide an Outreach correction request");
  const allowed = new Set(["idempotencyKey", "receiptId", "activityId", "serviceDate", "message", ...(context.channel === "public" ? ["memberExternalId"] : [])]);
  if (Object.keys(inputValue).some((key) => !allowed.has(key))) throw new HttpError(400, "Provide only supported correction fields");
  const idempotencyKey = text(inputValue.idempotencyKey, 128); if (idempotencyKey.length < 16) throw new HttpError(400, "Use a correction key of 16 to 128 characters");
  const message = text(inputValue.message, 4000); const receiptId = inputValue.receiptId ? text(inputValue.receiptId) : null;
  const activityId = inputValue.activityId ? text(inputValue.activityId) : null;
  if (context.channel === "public" && !receiptId && !activityId) throw new HttpError(400, "Provide the selected Outreach activity");
  const serviceDate = inputValue.serviceDate ? addCalendarDays(text(inputValue.serviceDate, 10), 0) : null;
  const identity = context.channel === "public" ? text(inputValue.memberExternalId, 80) : text(context.discordUserId, 24);
  if (context.channel === "discord" && !/^\d{10,24}$/.test(identity)) throw new HttpError(400, "Linked member identity is unavailable");
  const keyHash = await sha256(idempotencyKey); const fingerprint = await sha256(canonical({ ...inputValue, channel: context.channel, identity }));
  const saved = await correctionReceipt(db, context.channel, keyHash, fingerprint); if (saved) return { status: 200, body: saved };
  const member = context.channel === "public"
    ? await db.prepare("SELECT id FROM members WHERE installation_id=? AND external_id=? AND active=1").bind(installationId, identity).first<{ id: string }>()
    : await db.prepare("SELECT id FROM members WHERE installation_id=? AND discord_user_id=? AND active=1").bind(installationId, identity).first<{ id: string }>();
  if (!member) throw new HttpError(400, "Member identity is unavailable");
  const entry = receiptId ? await db.prepare(`SELECT id,member_id AS memberId,service_date AS serviceDate FROM hours_entries
    WHERE installation_id=? AND id=? ${context.channel === "public" ? "AND channel='public'" : ""}`).bind(installationId, receiptId).first<{ id: string; memberId: string; serviceDate: string }>() : null;
  if (receiptId && (!entry || entry.memberId !== member.id)) throw new HttpError(400, "Receipt identity is unavailable");
  if (entry && serviceDate && entry.serviceDate !== serviceDate) throw new HttpError(400, "Receipt and service date do not match");
  const activity = activityId ? await db.prepare("SELECT id,service_date AS serviceDate FROM hours_activities WHERE installation_id=? AND id=?")
    .bind(installationId, activityId).first<{ id: string; serviceDate: string }>() : null;
  if (activityId) {
    const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
    if (!activity || activity.serviceDate > instantToCivil(now, settings?.timeZone ?? "UTC").date) throw new HttpError(400, "Choose a valid Outreach activity for this correction");
  }
  if (activity && serviceDate && activity.serviceDate !== serviceDate) throw new HttpError(400, "Entry date must match the selected dated activity");
  if (entry && activityId) {
    const entryActivity = await db.prepare("SELECT activity_id AS activityId FROM hours_entries WHERE installation_id=? AND id=?").bind(installationId, entry.id).first<{ activityId: string }>();
    if (entryActivity?.activityId !== activityId) throw new HttpError(400, "Receipt and activity do not match");
  }
  const id = crypto.randomUUID(); const createdAt = new Date(now).toISOString(); const attribution = context.channel === "public" ? "self_asserted" : "linked_discord"; const auditId = crypto.randomUUID();
  const identityGuard = context.channel === "public" ? "external_id=?" : "discord_user_id=?";
  const receiptChannelGuard = context.channel === "public" ? "AND channel='public'" : "";
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO hours_correction_requests(installation_id,id,channel,attribution,requester_member_id,entry_id,claimed_service_date,message,key_hash,fingerprint,status,revision,created_at,activity_id)
        SELECT ?,?,?,?,?,?,?,?,?,?,'open',0,?,? WHERE EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=? AND active=1 AND ${identityGuard})
          AND (? IS NULL OR EXISTS(SELECT 1 FROM hours_entries WHERE installation_id=? AND id=? AND member_id=? ${receiptChannelGuard}))
          AND (? IS NULL OR EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=?))
          AND NOT EXISTS(SELECT 1 FROM hours_correction_requests WHERE installation_id=? AND channel=? AND key_hash=?)`)
        .bind(installationId, id, context.channel, attribution, member.id, receiptId, serviceDate ?? activity?.serviceDate ?? entry?.serviceDate ?? null, message, keyHash, fingerprint, createdAt, activityId,
          installationId, member.id, identity, receiptId, installationId, receiptId, member.id, activityId, installationId, activityId, installationId, context.channel, keyHash),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,NULL,'outreach.correction_requested','outreach_correction',?,?,? WHERE changes()=1").bind(auditId, installationId, id, JSON.stringify({ channel: context.channel, hasReceipt: Boolean(receiptId) }), createdAt),
    ]);
    if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Correction identity or eligibility changed; retry the exact request");
  } catch (error) {
    const concurrent = await correctionReceipt(db, context.channel, keyHash, fingerprint).catch(() => null); if (concurrent) return { status: 200, body: concurrent };
    if (error instanceof HttpError) throw error;
    if (/constraint|FOREIGN KEY|NOT NULL/i.test(String(error))) throw new HttpError(409, "Correction references changed; retry the exact request");
    throw error;
  }
  const receipt = await correctionReceipt(db, context.channel, keyHash, fingerprint);
  if (!receipt) throw new HttpError(409, "The correction request result could not be confirmed; retry the exact request");
  return { status: 202, body: receipt };
}

async function listWindows(db: D1Database, url: URL, now: number): Promise<RouteResult> {
  const allowed = new Set(["after", "limit"]); url.searchParams.forEach((_, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid reopen-window filter"); });
  const after = text(url.searchParams.get("after") ?? "", 128, false); const limit = integer(Number(url.searchParams.get("limit") ?? 50), 1, 100);
  const rows = (await db.prepare(`SELECT w.*,a.title AS activity_title,a.service_date AS activity_service_date FROM hours_reopen_windows w
    LEFT JOIN hours_activities a ON a.installation_id=w.installation_id AND a.id=w.activity_id WHERE w.installation_id=? AND w.id>? ORDER BY w.id LIMIT ?`).bind(installationId, after, limit + 1).all<Row>()).results ?? [];
  return { status: 200, body: { items: rows.slice(0, limit).map((row) => ({ ...serialize(row), revoked: Boolean(row.revoked), active: !Number(row.revoked) && Number(row.starts_ms) <= now && Number(row.expires_ms) > now })), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null } };
}

async function createWindow(db: D1Database, actor: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue) || Object.keys(inputValue).some((key) => !["activityId", "hours", "reason", "settingsRevision"].includes(key))) throw new HttpError(400, "Provide a reopen window");
  const activityId = text(inputValue.activityId);
  const hours = integer(inputValue.hours, 1, 168); const reason = text(inputValue.reason, 4000); const settingsRevision = integer(inputValue.settingsRevision); const id = crypto.randomUUID(); const createdAt = new Date(now).toISOString();
  const settings = await db.prepare(`SELECT e.revision,e.reporting_days AS reportingDays,s.time_zone AS timeZone FROM hours_entry_settings e JOIN organization_settings s ON s.installation_id=e.installation_id WHERE e.installation_id=?`).bind(installationId).first<{ revision: number; reportingDays: number; timeZone: string }>();
  if (!settings || settings.revision !== settingsRevision) throw new HttpError(409, "Reporting-window settings changed; reload before reopening activities");
  const today = instantToCivil(now, settings.timeZone).date;
  const activity = await db.prepare("SELECT service_date AS serviceDate,archived,revision FROM hours_activities WHERE installation_id=? AND id=?").bind(installationId, activityId).first<{ serviceDate: string; archived: number; revision: number }>();
  const windows = (await db.prepare("SELECT starts_ms AS startsMs,expires_ms AS expiresMs,revoked FROM hours_reopen_windows WHERE installation_id=? AND revoked=0 AND starts_ms<=? AND expires_ms>? AND (activity_id=? OR activity_id IS NULL)").bind(installationId, now, now, activityId).all<{ startsMs: number; expiresMs: number; revoked: boolean }>()).results ?? [];
  if (!activity || !outreachReportingState({ ...activity, archived: Boolean(activity.archived) }, settings, windows, now).canReopen) throw new HttpError(409, "Reporting can reopen when closed or fewer than 24 hours remain");
  const auditId = crypto.randomUUID(); const expiresMs = now + hours * 3_600_000;
  const results = await db.batch([
    db.prepare(`INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,reason,actor_user_id,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hours_entry_settings WHERE installation_id=? AND revision=?)
        AND EXISTS(SELECT 1 FROM hours_activities a WHERE a.installation_id=? AND a.id=? AND a.archived=0 AND a.service_date<=? AND a.revision=?)
        AND (SELECT COUNT(*) FROM hours_reopen_windows WHERE installation_id=? AND revoked=0 AND expires_ms>?)<64`)
      .bind(installationId, id, activityId, now, expiresMs, reason, actor, createdAt, createdAt, installationId, settingsRevision,
        installationId, activityId, today, activity.revision, installationId, now),
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.reopen_created','outreach_reopen_window',?,?,? WHERE changes()=1").bind(auditId, installationId, actor, id, JSON.stringify({ activityId, expiresMs }), createdAt),
  ]);
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Reporting activity or settings changed; reload before reopening");
  return { status: 201, body: { id, activityId, startsMs: now, expiresMs, reason, revoked: false, revision: 0, active: true } };
}

async function revokeWindow(db: D1Database, actor: string, id: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue) || Object.keys(inputValue).some((key) => !["revision", "revoked"].includes(key)) || inputValue.revoked !== true) throw new HttpError(400, "Revoke the current window explicitly");
  const revision = integer(inputValue.revision); const updatedAt = new Date(now).toISOString(); const results = await db.batch([
    db.prepare("UPDATE hours_reopen_windows SET revoked=1,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=? AND revoked=0").bind(updatedAt, installationId, id, revision),
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,?,'outreach.reopen_revoked','outreach_reopen_window',?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, id, updatedAt),
  ]);
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Reopen window changed; reload before revoking");
  return { status: 200, body: { id, revoked: true, revision: revision + 1, active: false } };
}

async function listCorrections(db: D1Database, url: URL): Promise<RouteResult> {
  const allowed = new Set(["status", "after", "limit"]); url.searchParams.forEach((_, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid correction filter"); });
  const status = url.searchParams.get("status") ?? "open"; if (!["open", "resolved", "all"].includes(status)) throw new HttpError(400, "Invalid correction status");
  const after = text(url.searchParams.get("after") ?? "", 128, false); const limit = integer(Number(url.searchParams.get("limit") ?? 50), 1, 100);
  const rows = (await db.prepare(`SELECT r.*,trim(m.first_name||' '||m.last_name) AS member_name,m.external_id,
    e.revision AS entry_revision,e.status AS entry_status,e.member_id AS entry_member_id,e.activity_id AS entry_activity_id,e.service_date AS entry_service_date,
    e.start_local,e.end_local,e.start_occurrence,e.end_occurrence,e.duration_minutes,e.task_notes,COALESCE(a.title,requested.title) AS activity_title,
    x.action AS resolution_action,x.note AS resolution_note,x.created_at AS resolution_created_at
    FROM hours_correction_requests r JOIN members m ON m.installation_id=r.installation_id AND m.id=r.requester_member_id
    LEFT JOIN hours_entries e ON e.installation_id=r.installation_id AND e.id=r.entry_id LEFT JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id
    LEFT JOIN hours_activities requested ON requested.installation_id=r.installation_id AND requested.id=r.activity_id
    LEFT JOIN hours_correction_resolutions x ON x.installation_id=r.installation_id AND x.request_id=r.id
    WHERE r.installation_id=? AND r.id>? ${status === "all" ? "" : "AND r.status=?"} ORDER BY r.id LIMIT ?`).bind(installationId, after, ...(status === "all" ? [] : [status]), limit + 1).all<Row>()).results ?? [];
  return { status: 200, body: { items: rows.slice(0, limit).map(serialize), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null } };
}

const entrySnapshotSql = `json_object('id',id,'member_id',member_id,'activity_id',activity_id,'service_date',service_date,'time_zone',time_zone,
  'start_local',start_local,'end_local',end_local,'start_occurrence',start_occurrence,'end_occurrence',end_occurrence,'start_ms',start_ms,'end_ms',end_ms,
  'start_offset_seconds',start_offset_seconds,'end_offset_seconds',end_offset_seconds,'duration_minutes',duration_minutes,'task_notes',task_notes,
  'status',status,'channel',channel,'attribution',attribution,'actor_user_id',actor_user_id,'revision',revision,'created_at',created_at,'updated_at',updated_at)`;

async function resolveCorrection(db: D1Database, actor: string, requestId: string, inputValue: unknown, now: number): Promise<RouteResult> {
  if (!object(inputValue)) throw new HttpError(400, "Provide a correction decision");
  const action = text(inputValue.action, 20); if (!["acknowledged", "dismissed", "corrected", "voided"].includes(action)) throw new HttpError(400, "Choose a supported correction decision");
  const allowed = new Set(["action", "note", "requestRevision", ...(action === "corrected" ? ["entryId", "entryRevision", "memberId", "activityId", "startLocal", "endLocal", "startOccurrence", "endOccurrence", "taskNotes"] : action === "voided" ? ["entryId", "entryRevision"] : [])]);
  if (Object.keys(inputValue).some((key) => !allowed.has(key))) throw new HttpError(400, "Provide only fields used by this correction decision");
  const note = text(inputValue.note, 4000); const requestRevision = integer(inputValue.requestRevision); const nowText = new Date(now).toISOString();
  const request = await db.prepare("SELECT * FROM hours_correction_requests WHERE installation_id=? AND id=?").bind(installationId, requestId).first<Row>();
  if (!request || request.status !== "open" || Number(request.revision) !== requestRevision) throw new HttpError(409, "Correction request changed; reload before resolving");
  if (action === "acknowledged" || action === "dismissed") {
    const results = await db.batch([
      db.prepare("UPDATE hours_correction_requests SET status='resolved',revision=1,resolved_at=? WHERE installation_id=? AND id=? AND revision=? AND status='open'").bind(nowText, installationId, requestId, requestRevision),
      db.prepare("INSERT INTO hours_correction_resolutions(installation_id,request_id,action,note,actor_user_id,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1").bind(installationId, requestId, action, note, actor, nowText),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.correction_resolved','outreach_correction',?,?,? WHERE EXISTS(SELECT 1 FROM hours_correction_resolutions WHERE installation_id=? AND request_id=?)").bind(crypto.randomUUID(), installationId, actor, requestId, JSON.stringify({ action }), nowText, installationId, requestId),
    ]);
    if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Correction request changed; reload before resolving");
    return { status: 200, body: { id: requestId, status: "resolved", revision: 1, action, resolvedAt: nowText } };
  }
  const selectedEntryId = request.entry_id ? String(request.entry_id) : inputValue.entryId ? text(inputValue.entryId) : null;
  if (!selectedEntryId) throw new HttpError(409, "Select the affected participation entry, or acknowledge or dismiss this request after review");
  if (request.entry_id && inputValue.entryId !== undefined && inputValue.entryId !== request.entry_id) throw new HttpError(409, "Use the participation entry already associated with this request");
  const entryRevision = integer(inputValue.entryRevision); const entry = await db.prepare("SELECT * FROM hours_entries WHERE installation_id=? AND id=?").bind(installationId, selectedEntryId).first<Row>();
  if (!entry || entry.status !== "counted" || Number(entry.revision) !== entryRevision) throw new HttpError(409, "Counted entry changed; reload before resolving");
  if (!request.entry_id && (!request.activity_id || entry.member_id !== request.requester_member_id || entry.activity_id !== request.activity_id)) throw new HttpError(409, "Choose an entry for the requesting member and selected activity");
  const memberId = action === "corrected" && inputValue.memberId !== undefined ? text(inputValue.memberId) : String(entry.member_id);
  const activityId = action === "corrected" && inputValue.activityId !== undefined ? text(inputValue.activityId) : String(entry.activity_id);
  const [member, activity] = await Promise.all([
    db.prepare("SELECT id FROM members WHERE installation_id=? AND id=?").bind(installationId, memberId).first<Row>(),
    db.prepare("SELECT * FROM hours_activities WHERE installation_id=? AND id=?").bind(installationId, activityId).first<Row>(),
  ]);
  if (!member || !activity || activityId !== entry.activity_id && Number(activity.archived)) throw new HttpError(409, "Correction member or activity changed; reload before resolving");
  const serviceDate = String(activityId === entry.activity_id ? entry.service_date : activity.service_date); const nextRevision = entryRevision + 1;
  const timing = action === "voided" ? null : resolveOutreachTiming({
    startLocal: inputValue.startLocal ?? entry.start_local,
    endLocal: inputValue.endLocal ?? entry.end_local,
    startOccurrence: inputValue.startOccurrence ?? entry.start_occurrence,
    endOccurrence: inputValue.endOccurrence ?? entry.end_occurrence,
  }, serviceDate, String(entry.time_zone), now);
  const values = action === "voided" ? {
    member_id: entry.member_id, activity_id: entry.activity_id, service_date: entry.service_date, start_local: entry.start_local, end_local: entry.end_local,
    start_occurrence: entry.start_occurrence, end_occurrence: entry.end_occurrence, start_ms: entry.start_ms, end_ms: entry.end_ms,
    start_offset_seconds: entry.start_offset_seconds, end_offset_seconds: entry.end_offset_seconds, duration_minutes: entry.duration_minutes, task_notes: entry.task_notes, status: "void",
  } : {
    member_id: memberId, activity_id: activityId, service_date: serviceDate, start_local: timing!.startLocal, end_local: timing!.endLocal,
    start_occurrence: timing!.startOccurrence, end_occurrence: timing!.endOccurrence, start_ms: timing!.startMs, end_ms: timing!.endMs,
    start_offset_seconds: timing!.startOffsetSeconds, end_offset_seconds: timing!.endOffsetSeconds, duration_minutes: timing!.durationMinutes,
    task_notes: inputValue.taskNotes === undefined ? entry.task_notes : text(inputValue.taskNotes, 4000, false), status: "counted",
  };
  const auditId = crypto.randomUUID(); const keys = Object.keys(values); const valueData = Object.values(values);
  try {
    const results = await db.batch([
      db.prepare(`UPDATE hours_entries SET ${keys.map((key) => `${key}=?`).join(",")},revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=? AND status='counted'
        AND EXISTS(SELECT 1 FROM hours_correction_requests WHERE installation_id=? AND id=? AND revision=? AND status='open')
        AND EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=?) AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=? AND revision=?)`)
        .bind(...valueData, nowText, installationId, entry.id, entryRevision, installationId, requestId, requestRevision, installationId, memberId, installationId, activityId, activity.revision),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'outreach_entry',?,?,? WHERE changes()=1").bind(auditId, installationId, actor, action === "voided" ? "outreach.entry_voided" : "outreach.entry_corrected", entry.id, JSON.stringify({ requestId, revision: nextRevision }), nowText),
      db.prepare(`INSERT INTO hours_entry_revisions(installation_id,entry_id,revision,member_id,activity_id,action,reason,actor_user_id,snapshot_json,created_at) SELECT installation_id,id,revision,member_id,activity_id,?,?,?,${entrySnapshotSql},? FROM hours_entries WHERE installation_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(action === "voided" ? "voided" : "corrected", note, actor, nowText, installationId, entry.id, auditId),
      db.prepare("UPDATE hours_correction_requests SET status='resolved',revision=1,resolved_at=? WHERE installation_id=? AND id=? AND revision=? AND status='open' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(nowText, installationId, requestId, requestRevision, auditId),
      db.prepare("INSERT INTO hours_correction_resolutions(installation_id,request_id,action,note,actor_user_id,entry_id,entry_revision,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1").bind(installationId, requestId, action, note, actor, entry.id, nextRevision, nowText),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'outreach.correction_resolved','outreach_correction',?,?,? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, requestId, JSON.stringify({ action, entryId: entry.id, entryRevision: nextRevision }), nowText),
    ]);
    if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Entry, request, or Outreach authority changed; reload before resolving");
  } catch (error) {
    if (String(error).includes("hours_overlap")) throw new HttpError(409, "The corrected time overlaps counted Outreach participation");
    if (error instanceof HttpError) throw error;
    if (/constraint|FOREIGN KEY|NOT NULL|hours_entry_provenance/i.test(String(error))) throw new HttpError(409, "Correction references changed; reload before resolving");
    throw error;
  }
  return { status: 200, body: { id: requestId, status: "resolved", revision: 1, action, entryId: entry.id, entryRevision: nextRevision, resolvedAt: nowText } };
}

async function correctionEntries(db: D1Database, requestId: string, url: URL): Promise<RouteResult> {
  const allowed = new Set(["after", "limit"]);
  url.searchParams.forEach((_, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid correction entry filter"); });
  const after = text(url.searchParams.get("after") ?? "", 128, false); const limit = integer(Number(url.searchParams.get("limit") ?? 50), 1, 100);
  const correction = await db.prepare("SELECT requester_member_id,activity_id,status FROM hours_correction_requests WHERE installation_id=? AND id=?")
    .bind(installationId, requestId).first<Row>();
  if (!correction) throw new HttpError(404, "Correction request not found");
  if (!correction.activity_id) return { status: 200, body: { items: [], nextCursor: null } };
  const rows = (await db.prepare(`SELECT id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_occurrence,end_occurrence,duration_minutes,task_notes,status,revision
    FROM hours_entries WHERE installation_id=? AND member_id=? AND activity_id=? AND id>? ORDER BY id LIMIT ?`)
    .bind(installationId, correction.requester_member_id, correction.activity_id, after, limit + 1).all<Row>()).results ?? [];
  return { status: 200, body: { items: rows.slice(0, limit).map(serialize), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null } };
}

export async function outreachReviewRoute(db: D1Database, actor: string, request: Request, input?: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new HttpError(400, "Invalid current instant");
  const url = new URL(request.url); const path = url.pathname;
  if (path === "/admin/hours/reopen-windows" && request.method === "GET") return listWindows(db, url, now);
  if (path === "/admin/hours/reopen-windows" && request.method === "POST") return createWindow(db, actor, input, now);
  const windowMatch = /^\/admin\/hours\/reopen-windows\/([^/]+)$/.exec(path);
  if (windowMatch && request.method === "PATCH") return revokeWindow(db, actor, decodeURIComponent(windowMatch[1]!), input, now);
  if (path === "/admin/hours/corrections" && request.method === "GET") return listCorrections(db, url);
  const entriesMatch = /^\/admin\/hours\/corrections\/([^/]+)\/entries$/.exec(path);
  if (entriesMatch && request.method === "GET") return correctionEntries(db, decodeURIComponent(entriesMatch[1]!), url);
  const correctionMatch = /^\/admin\/hours\/corrections\/([^/]+)\/resolve$/.exec(path);
  if (correctionMatch && request.method === "POST") return resolveCorrection(db, actor, decodeURIComponent(correctionMatch[1]!), input, now);
  throw new HttpError(404, "Outreach review route not found");
}
