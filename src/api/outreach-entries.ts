import { addCalendarDays, CivilTimeError, elapsedIntegerMinutes, instantToCivil, selectCivilTime, type CivilTimeOccurrence } from "@lancerlogin/module-sdk";
import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";

type Row = Record<string, unknown>;
type RouteResult = { status: number; body: unknown };
export type OutreachEntryContext =
  | { channel: "staff"; actor: string }
  | { channel: "public" }
  | { channel: "discord"; discordUserId: string };

const installationId = "primary";
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function serialize(row: Row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "installation_id").map(([key, value]) => [camel(key), value]));
}

function text(value: unknown, maximum = 128, required = true) {
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, "Provide valid Outreach entry fields");
  return value.trim();
}

function date(value: unknown) { return addCalendarDays(text(value, 10), 0); }

function occurrence(value: unknown): CivilTimeOccurrence | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "earlier" && value !== "later") throw new HttpError(400, "Choose the first or second occurrence of a repeated local time");
  return value;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new HttpError(400, "Provide a valid Outreach number");
  return Number(value);
}

function canonical(value: Row) { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))); }
async function sha256(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export function resolveOutreachTiming(input: Row, serviceDate: string, timeZone: string, now: number, allowFuture = false) {
  const startLocal = text(input.startLocal, 5); const endLocal = text(input.endLocal, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startLocal) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endLocal) || Number(startLocal.slice(3)) % 5 || Number(endLocal.slice(3)) % 5) throw new HttpError(400, "Choose start and end times in five-minute increments");
  try {
    const startOccurrence = occurrence(input.startOccurrence); const endOccurrence = occurrence(input.endOccurrence);
    const start = selectCivilTime({ date: serviceDate, time: startLocal, timeZone }, startOccurrence);
    const end = selectCivilTime({ date: serviceDate, time: endLocal, timeZone }, endOccurrence);
    const durationMinutes = elapsedIntegerMinutes(start.epochMilliseconds, end.epochMilliseconds);
    if (!allowFuture && end.epochMilliseconds > now) throw new HttpError(400, "Completed Outreach time cannot end in the future");
    return { startLocal, endLocal, startOccurrence: startOccurrence ?? null, endOccurrence: endOccurrence ?? null, startMs: start.epochMilliseconds, endMs: end.epochMilliseconds, startOffsetSeconds: start.offsetSeconds, endOffsetSeconds: end.offsetSeconds, durationMinutes };
  } catch (error) {
    if (error instanceof CivilTimeError) throw new HttpError(400, error.message);
    throw error;
  }
}

async function context(db: D1Database, now: number): Promise<RouteResult> {
  const row = await db.prepare(`SELECT e.reporting_days AS reportingDays,e.reopen_hours AS reopenHours,e.revision,s.time_zone AS timeZone
    FROM hours_entry_settings e JOIN organization_settings s ON s.installation_id=e.installation_id WHERE e.installation_id=?`).bind(installationId).first<Row>();
  if (!row) throw new HttpError(409, "Outreach entry rules are unavailable");
  const today = instantToCivil(now, String(row.timeZone)).date; let earliestServiceDate = "0000-01-01";
  try { earliestServiceDate = addCalendarDays(today, 1 - Number(row.reportingDays)); } catch { /* Four-digit date lower bound remains valid. */ }
  return { status: 200, body: { ...serialize(row), today, earliestServiceDate } };
}

async function memberChoices(db: D1Database, url: URL): Promise<RouteResult> {
  const allowed = new Set(["active", "q", "after", "limit"]);
  url.searchParams.forEach((_, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid roster choice filter"); });
  const active = url.searchParams.get("active") ?? "true";
  if (!["true", "false", "all"].includes(active)) throw new HttpError(400, "Invalid active-member filter");
  const limit = integer(Number(url.searchParams.get("limit") ?? 50), 1, 100); const after = text(url.searchParams.get("after") ?? "", 128, false); const query = text(url.searchParams.get("q") ?? "", 100, false);
  const rows = (await db.prepare(`SELECT id,external_id AS externalId,trim(first_name||' '||last_name) AS label,active FROM members
    WHERE installation_id=? AND id>? ${active === "all" ? "" : "AND active=?"} AND (?='' OR instr(lower(first_name||' '||last_name||' '||external_id),lower(?))>0)
    ORDER BY id LIMIT ?`).bind(installationId, after, ...(active === "all" ? [] : [Number(active === "true")]), query, query, limit + 1).all<Row>()).results ?? [];
  return { status: 200, body: { items: rows.slice(0, limit).map((row) => ({ ...serialize(row), active: Boolean(row.active) })), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null } };
}

async function savedReceipt(db: D1Database, channel: OutreachEntryContext["channel"], keyHash: string, fingerprint: string) {
  const row = await db.prepare("SELECT fingerprint,receipt_json AS receipt FROM hours_submission_keys WHERE installation_id=? AND channel=? AND key_hash=?").bind(installationId, channel, keyHash).first<{ fingerprint: string; receipt: string }>();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new HttpError(409, "This submission key was already used for different Outreach input");
  return JSON.parse(row.receipt) as Row;
}

const snapshotSql = `json_object(
  'id',id,'member_id',member_id,'activity_id',activity_id,'service_date',service_date,'time_zone',time_zone,
  'start_local',start_local,'end_local',end_local,'start_occurrence',start_occurrence,'end_occurrence',end_occurrence,
  'start_ms',start_ms,'end_ms',end_ms,'start_offset_seconds',start_offset_seconds,'end_offset_seconds',end_offset_seconds,
  'duration_minutes',duration_minutes,'task_notes',task_notes,'status',status,'channel',channel,'attribution',attribution,
  'actor_user_id',actor_user_id,'revision',revision,'created_at',created_at,'updated_at',updated_at)`;

async function resolveMember(db: D1Database, contextValue: OutreachEntryContext, input: Row) {
  if (contextValue.channel === "staff") return db.prepare("SELECT id,active,external_id AS externalId FROM members WHERE installation_id=? AND id=?").bind(installationId, text(input.memberId)).first<Row>();
  if (contextValue.channel === "public") return db.prepare("SELECT id,active,external_id AS externalId FROM members WHERE installation_id=? AND external_id=? AND active=1").bind(installationId, text(input.memberExternalId, 80)).first<Row>();
  const discordUserId = text(contextValue.discordUserId, 24);
  if (!/^\d{10,24}$/.test(discordUserId)) throw new HttpError(400, "Linked member identity is unavailable");
  return db.prepare("SELECT id,active,external_id AS externalId FROM members WHERE installation_id=? AND discord_user_id=? AND active=1").bind(installationId, discordUserId).first<Row>();
}

async function resolveActivity(db: D1Database, input: Row, serviceDate: string) {
  const activityId = text(input.activityId);
  const activity = await db.prepare("SELECT * FROM hours_activities WHERE installation_id=? AND id=?").bind(installationId, activityId).first<Row>();
  if (!activity || Number(activity.archived)) throw new HttpError(409, "Choose an active Outreach activity");
  if (String(activity.service_date) !== serviceDate) throw new HttpError(400, "Entry date must match the selected dated activity");
  if (input.teamId !== undefined && (input.teamId === null || input.teamId === "" ? null : text(input.teamId)) !== activity.team_id) throw new HttpError(400, "Activity team does not match");
  return activity;
}

export async function submitOutreachEntry(db: D1Database, contextValue: OutreachEntryContext, inputValue: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new HttpError(400, "Invalid current instant");
  if (!object(inputValue)) throw new HttpError(400, "Provide an Outreach entry");
  const allowed = new Set(["activityId", "teamId", "serviceDate", "startLocal", "endLocal", "startOccurrence", "endOccurrence", "taskNotes", "idempotencyKey", "expectedTimeZone",
    ...(contextValue.channel === "staff" ? ["memberId", "staffReason"] : contextValue.channel === "public" ? ["memberExternalId"] : [])]);
  if (Object.keys(inputValue).some((key) => !allowed.has(key))) throw new HttpError(400, "Provide only supported Outreach entry fields");
  const idempotencyKey = text(inputValue.idempotencyKey, 128);
  if (idempotencyKey.length < 16) throw new HttpError(400, "Use a submission key of 16 to 128 characters");
  const expectedTimeZone = text(inputValue.expectedTimeZone, 100); const serviceDate = date(inputValue.serviceDate); const notes = text(inputValue.taskNotes ?? "", 4000, false);
  const staffReason = contextValue.channel === "staff" ? text(inputValue.staffReason, 4000) : "";
  const identity = contextValue.channel === "staff" ? contextValue.actor : contextValue.channel === "discord" ? contextValue.discordUserId : "public";
  const fingerprint = await sha256(canonical({ ...inputValue, channel: contextValue.channel, identity })); const keyHash = await sha256(idempotencyKey);
  const saved = await savedReceipt(db, contextValue.channel, keyHash, fingerprint);
  if (saved) return { status: 200, body: serialize(saved) };
  const settings = await db.prepare(`SELECT e.reporting_days AS reportingDays,e.revision,s.time_zone AS timeZone FROM hours_entry_settings e JOIN organization_settings s ON s.installation_id=e.installation_id WHERE e.installation_id=?`).bind(installationId).first<{ reportingDays: number; revision: number; timeZone: string }>();
  if (!settings || settings.timeZone !== expectedTimeZone) throw new HttpError(409, "Outreach entry rules changed; reload before retrying");
  const today = instantToCivil(now, settings.timeZone).date; let earliest = "0000-01-01";
  try { earliest = addCalendarDays(today, 1 - settings.reportingDays); } catch { /* Four-digit date lower bound remains valid. */ }
  if (serviceDate > today) throw new HttpError(409, "Completed Outreach time cannot use a future service date");
  const inWindow = serviceDate >= earliest;
  const member = await resolveMember(db, contextValue, inputValue);
  if (!member || contextValue.channel !== "staff" && !Number(member.active)) throw new HttpError(400, "Member identity is unavailable");
  const nowText = new Date(now).toISOString(); const activity = await resolveActivity(db, inputValue, serviceDate);
  const reopened = contextValue.channel !== "staff" && !inWindow && Boolean(await db.prepare(`SELECT 1 FROM hours_reopen_windows WHERE installation_id=? AND revoked=0 AND starts_ms<=? AND expires_ms>? AND (activity_id IS NULL OR activity_id=?) LIMIT 1`).bind(installationId, now, now, activity.id).first());
  if (contextValue.channel !== "staff" && !inWindow && !reopened) throw new HttpError(409, `This service date is outside the current ${settings.reportingDays}-day reporting window`);
  const resolved = resolveOutreachTiming(inputValue, serviceDate, settings.timeZone, now); const id = crypto.randomUUID(); const actor = contextValue.channel === "staff" ? contextValue.actor : null;
  const attribution = contextValue.channel === "staff" ? "staff_recorded" : contextValue.channel === "public" ? "self_asserted" : "linked_discord";
  const entryValues = [String(member.id), String(activity.id), serviceDate, settings.timeZone, resolved.startLocal, resolved.endLocal, resolved.startOccurrence, resolved.endOccurrence, resolved.startMs, resolved.endMs, resolved.startOffsetSeconds, resolved.endOffsetSeconds, resolved.durationMinutes, notes];
  const auditId = crypto.randomUUID(); const channelIdentityGuard = contextValue.channel === "staff" ? "" : contextValue.channel === "public" ? "AND active=1 AND external_id=?" : "AND active=1 AND discord_user_id=?";
  const identityGuardValue = contextValue.channel === "public" ? text(inputValue.memberExternalId, 80) : contextValue.channel === "discord" ? contextValue.discordUserId : undefined;
  const reopenGuard = reopened ? "AND EXISTS(SELECT 1 FROM hours_reopen_windows WHERE installation_id=? AND revoked=0 AND starts_ms<=? AND expires_ms>? AND (activity_id IS NULL OR activity_id=?))" : "";
  const guardValues: unknown[] = [installationId, settings.revision, settings.reportingDays, installationId, settings.timeZone, installationId, member.id, ...(identityGuardValue === undefined ? [] : [identityGuardValue]), installationId, activity.id, activity.revision, ...(reopened ? [installationId, now, now, activity.id] : []), installationId, contextValue.channel, keyHash];
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_occurrence,end_occurrence,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,task_notes,status,channel,attribution,actor_user_id,revision,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'counted',?,?,?,0,?,? WHERE EXISTS(SELECT 1 FROM hours_entry_settings WHERE installation_id=? AND revision=? AND reporting_days=?)
        AND EXISTS(SELECT 1 FROM organization_settings WHERE installation_id=? AND time_zone=?) AND EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=? ${channelIdentityGuard})
        AND EXISTS(SELECT 1 FROM hours_activities a WHERE a.installation_id=? AND a.id=? AND a.revision=? AND a.archived=0)
        ${reopenGuard} AND NOT EXISTS(SELECT 1 FROM hours_submission_keys WHERE installation_id=? AND channel=? AND key_hash=?)`)
        .bind(installationId, id, ...entryValues, contextValue.channel, attribution, actor, nowText, nowText, ...guardValues),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?, 'outreach.entry_created','outreach_entry',?,?,? WHERE changes()=1").bind(auditId, installationId, actor, id, JSON.stringify({ channel: contextValue.channel, ...(contextValue.channel === "staff" ? { reason: staffReason } : {}) }), nowText),
      db.prepare(`INSERT INTO hours_entry_revisions(installation_id,entry_id,revision,member_id,activity_id,action,reason,actor_user_id,snapshot_json,created_at) SELECT installation_id,id,0,member_id,activity_id,'created',?,actor_user_id,${snapshotSql},? FROM hours_entries WHERE installation_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(staffReason, nowText, installationId, id, auditId),
      db.prepare(`INSERT INTO hours_submission_keys(installation_id,channel,key_hash,fingerprint,entry_id,receipt_json,created_at) SELECT installation_id,channel,?,?,id,${snapshotSql},? FROM hours_entries WHERE installation_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(keyHash, fingerprint, nowText, installationId, id, auditId),
    ]);
    if (results[0]?.meta?.changes !== 1 || results.slice(1).some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Outreach entry eligibility or access changed; reload before retrying");
  } catch (error) {
    if (String(error).includes("hours_overlap")) throw new HttpError(409, "This time overlaps already counted Outreach participation");
    const concurrent = await savedReceipt(db, contextValue.channel, keyHash, fingerprint).catch(() => null);
    if (concurrent) return { status: 200, body: serialize(concurrent) };
    if (error instanceof HttpError) throw error;
    if (/constraint|NOT NULL|FOREIGN KEY/i.test(String(error))) throw new HttpError(409, "Outreach entry references changed; reload before retrying");
    throw error;
  }
  const receipt = await savedReceipt(db, contextValue.channel, keyHash, fingerprint);
  if (!receipt) throw new HttpError(409, "The Outreach entry result could not be confirmed; retry the exact submission");
  return { status: 201, body: serialize(receipt) };
}

async function listEntries(db: D1Database, url: URL): Promise<RouteResult> {
  const allowed = new Set(["after", "limit", "memberId", "activityId", "from", "to", "status", "order"]);
  url.searchParams.forEach((_, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid Outreach entry filter"); });
  const limit = integer(Number(url.searchParams.get("limit") ?? 50), 1, 100); const after = text(url.searchParams.get("after") ?? "", 180, false);
  const status = url.searchParams.get("status") ?? "all"; if (!["all", "counted", "void"].includes(status)) throw new HttpError(400, "Invalid Outreach entry status");
  const order = url.searchParams.get("order") ?? "id";
  if (!["id", "logged-desc"].includes(order)) throw new HttpError(400, "Invalid Outreach entry order");
  const clauses = ["e.installation_id=?"]; const values: unknown[] = [installationId];
  if (order === "id") { clauses.push("e.id>?"); values.push(after); }
  else if (after) {
    const separator = after.indexOf("|"); const timestamp = after.slice(0, separator); const id = after.slice(separator + 1);
    if (separator < 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || !id || id.length > 128) throw new HttpError(400, "Invalid submission-log cursor");
    clauses.push("(e.created_at<? OR (e.created_at=? AND e.id<?))"); values.push(timestamp, timestamp, id);
  }
  if (status !== "all") { clauses.push("e.status=?"); values.push(status); }
  for (const [parameter, column, operator] of [["memberId", "e.member_id", "="], ["activityId", "e.activity_id", "="], ["from", "e.service_date", ">="], ["to", "e.service_date", "<="]] as const) {
    const value = url.searchParams.get(parameter); if (value === null) continue;
    if (parameter === "from" || parameter === "to") date(value); else text(value);
    clauses.push(`${column}${operator}?`); values.push(value);
  }
  const rows = (await db.prepare(`SELECT e.*,CASE WHEN e.channel='staff' THEN initial.reason ELSE NULL END AS staff_reason,
    trim(m.first_name||' '||m.last_name) AS member_name,m.external_id,a.title AS activity_title,t.name AS team_name
    FROM hours_entries e JOIN members m ON m.installation_id=e.installation_id AND m.id=e.member_id JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id
    LEFT JOIN hours_teams t ON t.installation_id=a.installation_id AND t.id=a.team_id
    LEFT JOIN hours_entry_revisions initial ON initial.installation_id=e.installation_id AND initial.entry_id=e.id AND initial.revision=0
    WHERE ${clauses.join(" AND ")} ORDER BY ${order === "logged-desc" ? "e.created_at DESC,e.id DESC" : "e.id"} LIMIT ?`).bind(...values, limit + 1).all<Row>()).results ?? [];
  return { status: 200, body: { items: rows.slice(0, limit).map(serialize), nextCursor: rows.length > limit ? order === "logged-desc" ? `${rows[limit - 1]!.created_at}|${rows[limit - 1]!.id}` : rows[limit - 1]!.id : null } };
}

async function reviseEntry(db: D1Database, actor: string, id: string, input: unknown, now: number): Promise<RouteResult> {
  if (!object(input) || !["corrected", "voided"].includes(String(input.action))) throw new HttpError(400, "Choose an entry edit or deletion");
  const voided = input.action === "voided";
  const allowed = ["revision", "action", "reason", ...(voided ? [] : ["memberId", "activityId", "startLocal", "endLocal", "startOccurrence", "endOccurrence", "taskNotes"])];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, "Provide only supported entry edit fields");
  const expected = integer(input.revision); const reason = text(input.reason, 4000);
  const entry = await db.prepare("SELECT * FROM hours_entries WHERE installation_id=? AND id=?").bind(installationId, id).first<Row>();
  if (!entry || entry.status !== "counted" || Number(entry.revision) !== expected) throw new HttpError(409, "Participation entry changed; reload before editing");
  const memberId = voided || input.memberId === undefined ? String(entry.member_id) : text(input.memberId);
  const activityId = voided || input.activityId === undefined ? String(entry.activity_id) : text(input.activityId);
  const [member, activity] = await Promise.all([
    db.prepare("SELECT id FROM members WHERE installation_id=? AND id=?").bind(installationId, memberId).first<Row>(),
    db.prepare("SELECT * FROM hours_activities WHERE installation_id=? AND id=?").bind(installationId, activityId).first<Row>(),
  ]);
  if (!member || !activity || activityId !== entry.activity_id && Number(activity.archived)) throw new HttpError(409, "Entry member or activity is unavailable");
  const serviceDate = String(activityId === entry.activity_id ? entry.service_date : activity.service_date);
  const timing = voided ? null : resolveOutreachTiming({ startLocal: input.startLocal ?? entry.start_local, endLocal: input.endLocal ?? entry.end_local,
    startOccurrence: input.startOccurrence === undefined ? entry.start_occurrence : input.startOccurrence,
    endOccurrence: input.endOccurrence === undefined ? entry.end_occurrence : input.endOccurrence }, serviceDate, String(entry.time_zone), now);
  const values = voided ? { status: "void" } : { member_id: memberId, activity_id: activityId, service_date: serviceDate,
    start_local: timing!.startLocal, end_local: timing!.endLocal, start_occurrence: timing!.startOccurrence, end_occurrence: timing!.endOccurrence,
    start_ms: timing!.startMs, end_ms: timing!.endMs, start_offset_seconds: timing!.startOffsetSeconds, end_offset_seconds: timing!.endOffsetSeconds,
    duration_minutes: timing!.durationMinutes, task_notes: input.taskNotes === undefined ? entry.task_notes : text(input.taskNotes, 4000, false) };
  const auditId = crypto.randomUUID(); const updatedAt = new Date(now).toISOString();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE hours_entries SET ${Object.keys(values).map(key => `${key}=?`).join(",")},revision=revision+1,updated_at=?
        WHERE installation_id=? AND id=? AND revision=? AND status='counted'
        AND EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=?)
        AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=? AND revision=?)`)
        .bind(...Object.values(values), updatedAt, installationId, id, expected, installationId, memberId, installationId, activityId, activity.revision),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'outreach_entry',?,?,? WHERE changes()=1")
        .bind(auditId, installationId, actor, voided ? "outreach.entry_voided" : "outreach.entry_corrected", id, JSON.stringify({ revision: expected + 1, direct: true }), updatedAt),
      db.prepare(`INSERT INTO hours_entry_revisions(installation_id,entry_id,revision,member_id,activity_id,action,reason,actor_user_id,snapshot_json,created_at)
        SELECT installation_id,id,revision,member_id,activity_id,?,?,?,${snapshotSql},? FROM hours_entries
        WHERE installation_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`)
        .bind(voided ? "voided" : "corrected", reason, actor, updatedAt, installationId, id, auditId),
    ]);
    if (results.some(result => result.meta?.changes !== 1)) throw new HttpError(409, "Participation entry changed; reload before editing");
  } catch (error) {
    if (String(error).includes("hours_overlap")) throw new HttpError(409, "The edited time overlaps counted Outreach participation");
    if (error instanceof HttpError) throw error;
    if (/constraint|FOREIGN KEY|NOT NULL|hours_entry_provenance/i.test(String(error))) throw new HttpError(409, "Entry references changed; reload before editing");
    throw error;
  }
  return entryDetail(db, id, false);
}

async function entryDetail(db: D1Database, id: string, history: boolean): Promise<RouteResult> {
  if (history) {
    const rows = (await db.prepare("SELECT * FROM hours_entry_revisions WHERE installation_id=? AND entry_id=? ORDER BY revision").bind(installationId, id).all<Row>()).results ?? [];
    if (!rows.length) throw new HttpError(404, "Outreach entry history is unavailable");
    return { status: 200, body: { items: rows.map((row) => ({ ...serialize(row), snapshot: serialize(JSON.parse(String(row.snapshot_json)) as Row) })) } };
  }
  const row = await db.prepare(`SELECT e.*,CASE WHEN e.channel='staff' THEN initial.reason ELSE NULL END AS staff_reason,
    trim(m.first_name||' '||m.last_name) AS member_name,m.external_id,a.title AS activity_title,t.name AS team_name
    FROM hours_entries e JOIN members m ON m.installation_id=e.installation_id AND m.id=e.member_id JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id
    LEFT JOIN hours_teams t ON t.installation_id=a.installation_id AND t.id=a.team_id
    LEFT JOIN hours_entry_revisions initial ON initial.installation_id=e.installation_id AND initial.entry_id=e.id AND initial.revision=0
    WHERE e.installation_id=? AND e.id=?`).bind(installationId, id).first<Row>();
  if (!row) throw new HttpError(404, "Outreach entry not found");
  return { status: 200, body: serialize(row) };
}

async function totals(db: D1Database): Promise<RouteResult> {
  const summary = await db.prepare("SELECT COUNT(*) AS entries,COUNT(DISTINCT member_id) AS participants,COALESCE(SUM(duration_minutes),0) AS countedMinutes FROM hours_entries WHERE installation_id=? AND status='counted'").bind(installationId).first<Row>();
  const members = (await db.prepare(`SELECT m.id,trim(m.first_name||' '||m.last_name) AS name,m.external_id AS externalId,COUNT(e.id) AS entries,COALESCE(SUM(e.duration_minutes),0) AS countedMinutes FROM members m JOIN hours_entries e ON e.installation_id=m.installation_id AND e.member_id=m.id AND e.status='counted' WHERE m.installation_id=? GROUP BY m.id,m.first_name,m.last_name,m.external_id ORDER BY countedMinutes DESC,m.id LIMIT 100`).bind(installationId).all<Row>()).results ?? [];
  const teams = (await db.prepare(`SELECT t.id,t.name,t.number,t.program,COUNT(DISTINCT e.member_id) AS participants,COUNT(e.id) AS entries,COALESCE(SUM(e.duration_minutes),0) AS countedMinutes FROM hours_teams t LEFT JOIN hours_activities a ON a.installation_id=t.installation_id AND a.team_id=t.id AND a.mode='team' LEFT JOIN hours_entries e ON e.installation_id=a.installation_id AND e.activity_id=a.id AND e.status='counted' WHERE t.installation_id=? GROUP BY t.id,t.name,t.number,t.program ORDER BY countedMinutes DESC,t.id LIMIT 100`).bind(installationId).all<Row>()).results ?? [];
  return { status: 200, body: { summary: serialize(summary ?? { entries: 0, participants: 0, countedMinutes: 0 }), members: members.map(serialize), teams: teams.map(serialize) } };
}

export async function outreachEntryRoute(db: D1Database, actor: string, request: Request, input?: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new HttpError(400, "Invalid current instant");
  const url = new URL(request.url); const path = url.pathname;
  if (path === "/admin/hours/context" && request.method === "GET") return context(db, now);
  if (path === "/admin/hours/member-choices" && request.method === "GET") return memberChoices(db, url);
  if (path === "/admin/hours/totals" && request.method === "GET") return totals(db);
  if (path === "/admin/hours/entries" && request.method === "POST") return submitOutreachEntry(db, { channel: "staff", actor }, input, now);
  if (path === "/admin/hours/entries" && request.method === "GET") return listEntries(db, url);
  const match = /^\/admin\/hours\/entries\/([^/]+)(?:\/(history))?$/.exec(path);
  if (match && !match[2] && request.method === "PATCH") return reviseEntry(db, actor, decodeURIComponent(match[1]!), input, now);
  if (match && request.method === "GET") return entryDetail(db, decodeURIComponent(match[1]!), match[2] === "history");
  throw new HttpError(404, "Outreach entry route not found");
}
