import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { outreachPrograms } from "../shared/outreach-programs.ts";
import { queueAutomaticOutreachPublication, queueOutreachPublicationCleanup, readOutreachPublicationSetting, validateOutreachEventSchedule, type OutreachPublicationProviders, type OutreachPublicationQueueResult } from "./outreach-publication.ts";

type Row = Record<string, unknown>;
type CatalogKind = "labels" | "teams" | "activities";
type RouteResult = { status: number; body: unknown };
const installationId = "primary";
const tables = { labels: "hours_labels", teams: "hours_teams", activities: "hours_activities" } as const;
const categoryByMode = { event: "event", team: "team-support", task: "other-service" } as const;
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function serialize(row: Row) {
  const value: Row = {};
  for (const [key, item] of Object.entries(row)) if (key !== "installation_id") value[camel(key)] = ["archived", "impact_default", "impact_relevant"].includes(key) ? Boolean(item) : item;
  if (typeof value.sourceSnapshot === "string") value.sourceSnapshot = JSON.parse(value.sourceSnapshot);
  if (typeof value.labelsJson === "string") {
    value.labels = (JSON.parse(value.labelsJson) as Array<{ id: string; name: string; archived: number | boolean }>).map((label) => ({ ...label, archived: Boolean(label.archived) }));
    value.labelIds = (value.labels as Array<{ id: string }>).map((label) => label.id);
    delete value.labelsJson;
  }
  delete value.categoryId;
  return value;
}

function labelIds(value: unknown) {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.length || item.length > 128)) throw new HttpError(400, "Provide valid Outreach label IDs");
  return [...new Set(value as string[])];
}

function text(value: unknown, maximum: number, required = false) {
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, "Provide valid Outreach text fields");
  return value.trim();
}

function flag(value: unknown) {
  if (typeof value !== "boolean") throw new HttpError(400, "Outreach flags must be true or false");
  return Number(value);
}

function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "Provide the current Outreach revision");
  return Number(value);
}

function serviceDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new HttpError(400, "Provide a valid service date");
  return value;
}

function optionalTime(value: unknown) {
  if (value == null || value === "") return null;
  const result = text(value, 5, true);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new HttpError(400, "Provide event times in HH:MM format");
  return result;
}

function optionalOccurrence(value: unknown) {
  if (value == null || value === "") return null;
  if (value !== "earlier" && value !== "later") throw new HttpError(400, "Choose an earlier or later repeated event time");
  return value;
}

function localDate(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function pageInput(url: URL, extra: string[] = []) {
  const allowed = new Set(["limit", "after", "archived", ...extra]);
  url.searchParams.forEach((_, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid Outreach catalog filter"); });
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "Limit must be from 1 to 100");
  const after = url.searchParams.get("after") ?? "";
  if (after.length > 128) throw new HttpError(400, "Invalid pagination cursor");
  const archived = url.searchParams.get("archived") ?? "false";
  if (!["false", "true", "all"].includes(archived)) throw new HttpError(400, "Invalid archive filter");
  return { limit, after, archived };
}

async function list(db: D1Database, kind: CatalogKind, url: URL): Promise<RouteResult> {
  const extra = kind === "activities" ? ["from", "to", "mode", "teamId", "labelIds", "labelMatch"] : ["q"];
  const { limit, after, archived } = pageInput(url, extra);
  const clauses = ["installation_id=?", "id>?"]; const values: unknown[] = [installationId, after];
  if (archived !== "all") { clauses.push("archived=?"); values.push(Number(archived === "true")); }
  if (kind !== "activities") {
    const query = text(url.searchParams.get("q") ?? "", 100);
    const fields = kind === "teams" ? "name||' '||number||' '||program" : "name";
    clauses.push(`(?='' OR instr(lower(${fields}),lower(?))>0)`); values.push(query, query);
  }
  if (kind === "activities") {
    for (const [parameter, column, operator] of [["from", "service_date", ">="], ["to", "service_date", "<="], ["mode", "mode", "="], ["teamId", "team_id", "="]] as const) {
      const value = url.searchParams.get(parameter);
      if (value === null) continue;
      if (parameter === "from" || parameter === "to") serviceDate(value);
      else if (parameter === "mode" && !["event", "team", "task"].includes(value)) throw new HttpError(400, "Invalid activity mode");
      else text(value, 128, true);
      clauses.push(`${column}${operator}?`); values.push(value);
    }
    const selectedLabelIds = (url.searchParams.get("labelIds") ?? "").split(",").filter(Boolean);
    const labelMatch = url.searchParams.get("labelMatch") ?? "any";
    if (!selectedLabelIds.length && url.searchParams.has("labelMatch") || selectedLabelIds.some((id) => !id.length || id.length > 128) || !["any", "all"].includes(labelMatch)) throw new HttpError(400, "Invalid Outreach label filter");
    if (selectedLabelIds.length) {
      const unique = [...new Set(selectedLabelIds)];
      const placeholders = unique.map(() => "?").join(",");
      clauses.push(labelMatch === "all"
        ? `(SELECT COUNT(DISTINCT al.label_id) FROM hours_activity_labels al WHERE al.installation_id=hours_activities.installation_id AND al.activity_id=hours_activities.id AND al.label_id IN (${placeholders}))=?`
        : `EXISTS(SELECT 1 FROM hours_activity_labels al WHERE al.installation_id=hours_activities.installation_id AND al.activity_id=hours_activities.id AND al.label_id IN (${placeholders}))`);
      values.push(...unique);
      if (labelMatch === "all") values.push(unique.length);
    }
  }
  const selection = kind === "teams" ? `SELECT t.installation_id,t.id,t.number,t.name,t.program,t.archived,t.revision,t.created_at,t.updated_at,
    COALESCE((SELECT COUNT(DISTINCT e.member_id) FROM hours_activities a JOIN hours_entries e ON e.installation_id=a.installation_id AND e.activity_id=a.id WHERE a.installation_id=t.installation_id AND a.team_id=t.id AND a.mode='team' AND e.status='counted'),0) AS participant_count,
    COALESCE((SELECT SUM(e.duration_minutes) FROM hours_activities a JOIN hours_entries e ON e.installation_id=a.installation_id AND e.activity_id=a.id WHERE a.installation_id=t.installation_id AND a.team_id=t.id AND a.mode='team' AND e.status='counted'),0) AS counted_minutes
    FROM hours_teams t` : kind === "activities" ? `SELECT hours_activities.*,
    COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name,'archived',json(labels.archived))) FROM
      (SELECT l.id,l.name,l.archived FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id
       WHERE al.installation_id=hours_activities.installation_id AND al.activity_id=hours_activities.id ORDER BY l.name,l.id) labels),'[]') AS labels_json
    FROM hours_activities` : `SELECT * FROM ${tables[kind]}`;
  const rows = (await db.prepare(`${selection} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`).bind(...values, limit + 1).all<Row>()).results ?? [];
  let counts: { total: number; activeCount: number; archivedCount: number } | undefined;
  if (kind !== "activities") {
    const total = await db.prepare(`SELECT COUNT(*) AS total FROM ${tables[kind]} WHERE ${clauses.filter(clause => clause !== "id>?").join(" AND ")}`).bind(...values.filter((_, index) => index !== 1)).first<{ total: number }>();
    const all = await db.prepare(`SELECT SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) AS activeCount,SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) AS archivedCount FROM ${tables[kind]} WHERE installation_id=?`).bind(installationId).first<{ activeCount: number; archivedCount: number }>();
    counts = { total: total?.total ?? 0, activeCount: all?.activeCount ?? 0, archivedCount: all?.archivedCount ?? 0 };
  }
  return { status: 200, body: { items: rows.slice(0, limit).map(serialize), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null, ...counts } };
}

async function detail(db: D1Database, kind: CatalogKind, id: string): Promise<RouteResult> {
  const selection = kind === "activities" ? `SELECT hours_activities.*,
    COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name,'archived',json(labels.archived))) FROM
      (SELECT l.id,l.name,l.archived FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id
       WHERE al.installation_id=hours_activities.installation_id AND al.activity_id=hours_activities.id ORDER BY l.name,l.id) labels),'[]') AS labels_json
    FROM hours_activities` : kind === "teams" ? "SELECT installation_id,id,number,name,program,archived,revision,created_at,updated_at FROM hours_teams" : `SELECT * FROM ${tables[kind]}`;
  const row = await db.prepare(`${selection} WHERE installation_id=? AND id=?`).bind(installationId, id).first<Row>();
  if (!row) throw new HttpError(404, "Outreach record not found");
  return { status: 200, body: serialize(row) };
}

async function write(db: D1Database, actor: string, kind: CatalogKind, id: string | undefined, input: unknown, publicationProviders?: OutreachPublicationProviders, nowMs = Date.now()): Promise<RouteResult> {
  if (!object(input)) throw new HttpError(400, "Provide an Outreach record");
  const table = tables[kind]; const existing = id ? await db.prepare(`SELECT * FROM ${table} WHERE installation_id=? AND id=?`).bind(installationId, id).first<Row>() : null;
  if (id && !existing) throw new HttpError(404, "Outreach record not found");
  const current = existing ? serialize(existing) : {}; const next = { ...current, ...input }; const now = new Date(nowMs).toISOString(); const target = id ?? crypto.randomUUID();
  const common = ["revision", "archived"];
  const fields = kind === "labels" ? ["name"] : kind === "teams" ? ["number", "name", "program"] : ["mode", "labelIds", "serviceDate", "teamId", "title", "description", "location", "impactRelevant", "eventStartLocal", "eventEndLocal", "eventStartOccurrence", "eventEndOccurrence"];
  if (Object.keys(input).some((key) => ![...common, ...fields].includes(key)) || !id && "revision" in input) throw new HttpError(400, "Unknown Outreach catalog field");
  const expected = id ? revision(input.revision) : 0; const row: Row = { archived: flag(next.archived ?? false) };
  let additional = ""; let additionalValues: unknown[] = []; let publicationQueue: OutreachPublicationQueueResult | undefined; let queueAutomatically = false;
  if (kind === "labels") {
    row.name = text(next.name, 100, true);
    const duplicate = await db.prepare("SELECT id FROM hours_labels WHERE installation_id=? AND lower(name)=lower(?) AND id!=?").bind(installationId, row.name, target).first<Row>();
    if (duplicate) throw new HttpError(409, "An Outreach label with that name already exists");
  } else if (kind === "teams") {
    if ((!id || "program" in input) && !outreachPrograms.includes(next.program as typeof outreachPrograms[number])) throw new HttpError(400, "Choose Explore, Challenge, FTC, or FRC as the team program");
    row.name = text(next.name, 150, true); row.number = text(next.number ?? "", 32); row.program = text(next.program ?? "", 100);
  } else {
    const mode = text(next.mode, 10, true) as keyof typeof categoryByMode;
    if (!(mode in categoryByMode)) throw new HttpError(400, "Invalid activity mode");
    const selectedLabelIds = labelIds(id && !("labelIds" in input) ? [] : next.labelIds ?? []);
    if (selectedLabelIds.length) {
      const placeholders = selectedLabelIds.map(() => "?").join(",");
      const found = await db.prepare(`SELECT id,archived FROM hours_labels WHERE installation_id=? AND id IN (${placeholders})`).bind(installationId, ...selectedLabelIds).all<Row>();
      const currentIds = id ? new Set((await db.prepare("SELECT label_id AS id FROM hours_activity_labels WHERE installation_id=? AND activity_id=?").bind(installationId, id).all<Row>()).results?.map((item) => String(item.id)) ?? []) : new Set<string>();
      if ((found.results ?? []).length !== selectedLabelIds.length || (found.results ?? []).some((item) => item.archived && !currentIds.has(String(item.id)))) throw new HttpError(400, "Select active Outreach labels");
    }
    row.category_id = categoryByMode[mode]; row.mode = mode;
    row.team_id = next.teamId == null ? null : text(next.teamId, 128, true);
    if ((row.mode === "team") !== Boolean(row.team_id)) throw new HttpError(400, "Team support requires a supported team; other activities do not take one");
    row.service_date = serviceDate(next.serviceDate);
    row.title = text(next.title, 150, true);
    row.description = text(next.description ?? "", 4000); row.location = text(next.location ?? "", 300); row.impact_relevant = flag(next.impactRelevant ?? true);
    const suppliedSchedule = [input.eventStartLocal, input.eventEndLocal, input.eventStartOccurrence, input.eventEndOccurrence].some((value) => value != null && value !== "");
    if (row.mode !== "event" && suppliedSchedule) throw new HttpError(400, "Only Event activities take a publication schedule");
    row.event_start_local = row.mode === "event" ? optionalTime(next.eventStartLocal) : null;
    row.event_end_local = row.mode === "event" ? optionalTime(next.eventEndLocal) : null;
    row.event_start_occurrence = row.mode === "event" ? optionalOccurrence(next.eventStartOccurrence) : null;
    row.event_end_occurrence = row.mode === "event" ? optionalOccurrence(next.eventEndOccurrence) : null;
    row.source_meeting_id = existing?.source_meeting_id ?? null;
    row.source_snapshot = existing?.source_snapshot ?? null;
    if (row.mode === "event") {
      const timing = await validateOutreachEventSchedule(db, row, nowMs, false, false);
      const setting = await readOutreachPublicationSetting(db);
      if (setting.automatic && !row.archived) {
        if (timing && timing.endMs > nowMs) queueAutomatically = true;
        else if (!timing) {
          const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
          if (!settings) throw new HttpError(409, "Organization time zone is unavailable");
          if (String(row.service_date) >= localDate(nowMs, settings.timeZone)) { await validateOutreachEventSchedule(db, row, nowMs, true, true); queueAutomatically = true; }
          else publicationQueue = { automatic: true, queuedProviders: [], revision: null, reason: "not_eligible" };
        } else publicationQueue = { automatic: true, queuedProviders: [], revision: null, reason: "not_eligible" };
      }
    }
    additional = ` AND EXISTS(SELECT 1 FROM hours_categories WHERE installation_id=? AND id=? AND archived=0) AND (? IS NULL OR EXISTS(SELECT 1 FROM hours_teams WHERE installation_id=? AND id=? ${id && row.team_id === existing?.team_id ? "" : "AND archived=0"}))`;
    additionalValues = [installationId, row.category_id, row.team_id, installationId, row.team_id];
    if (id && (mode !== existing?.mode || Boolean(row.archived) && !Boolean(existing?.archived))) additional += " AND NOT EXISTS(SELECT 1 FROM hours_publication_operations WHERE installation_id=hours_activities.installation_id AND activity_id=hours_activities.id AND status='processing')";
  }
  const columns = Object.keys(row); const values = Object.values(row); const auditId = crypto.randomUUID();
  const statement = id ? db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column}=?`).join(",")},revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?${additional}`)
    .bind(...values, now, installationId, id, expected, ...additionalValues) : db.prepare(`INSERT INTO ${table}(installation_id,id,${columns.join(",")},revision,created_at,updated_at) SELECT ?,?,${columns.map(() => "?").join(",")},0,?,? WHERE 1=1${additional}`)
    .bind(installationId, target, ...values, now, now, ...additionalValues);
  let results;
  try {
    const changesLabels = kind === "activities" && (!id || "labelIds" in input);
    const statements = [statement, db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'outreach_catalog',?,?,? WHERE changes()=1").bind(auditId, installationId, actor, `outreach.${kind}.${id ? "updated" : "created"}`, target, JSON.stringify({ revision: id ? expected + 1 : 0, archived: Boolean(row.archived), ...(changesLabels ? { labelIds: labelIds(next.labelIds ?? []) } : {}) }), now)];
    if (kind === "activities" && existing?.mode === "event" && (row.mode !== "event" || row.archived)) statements.push(db.prepare("UPDATE hours_publication_operations SET status='failed',next_attempt_at=NULL,last_error='Activity is no longer eligible for Event publication',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE installation_id=? AND activity_id=? AND action='publish' AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM audit_log WHERE installation_id=? AND id=?)").bind(now, installationId, target, installationId, auditId));
    if (changesLabels) {
      const selectedLabelIds = labelIds(next.labelIds ?? []);
      statements.push(db.prepare(`DELETE FROM hours_activity_labels WHERE installation_id=? AND activity_id=? ${selectedLabelIds.length ? `AND label_id NOT IN (${selectedLabelIds.map(() => "?").join(",")})` : ""} AND EXISTS(SELECT 1 FROM audit_log WHERE installation_id=? AND id=?)`).bind(installationId, target, ...selectedLabelIds, installationId, auditId));
      for (const labelId of selectedLabelIds) statements.push(db.prepare("INSERT OR IGNORE INTO hours_activity_labels(installation_id,activity_id,label_id,created_by,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE installation_id=? AND id=?)").bind(installationId, target, labelId, actor, now, installationId, auditId));
    }
    results = await db.batch(statements);
  } catch (error) {
    if (/UNIQUE|FOREIGN KEY|CHECK constraint/i.test(String(error))) throw new HttpError(409, "Outreach catalog identity or reference changed; reload before retrying");
    throw error;
  }
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) throw new HttpError(409, "Outreach record changed; reload before retrying");
  const result = await detail(db, kind, target);
  if (kind === "activities" && publicationProviders) {
    const operation = existing?.mode === "event" && (row.mode !== "event" || Boolean(row.archived) && !Boolean(existing?.archived)) ? "cleanup" : queueAutomatically ? "automatic" : null;
    if (operation) {
      try {
        publicationQueue = operation === "cleanup" ? await queueOutreachPublicationCleanup(db, actor, target, nowMs) : await queueAutomaticOutreachPublication(db, publicationProviders, actor, target, id ? expected + 1 : 0, nowMs);
      } catch {
        publicationQueue = { automatic: operation === "automatic", queuedProviders: [], revision: null, reason: "queue_failed", message: "Activity saved, but publication was not queued. Use the publication icons in the activity details." };
        await db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,'outreach.publication_queue_failed','outreach_activity',?,?,?)").bind(crypto.randomUUID(), installationId, actor, target, JSON.stringify({ operation }), now).run().catch(() => undefined);
      }
    }
  }
  return { status: id ? 200 : 201, body: publicationQueue ? { ...(result.body as Row), publicationQueue } : result.body };
}

export async function outreachCatalogRoute(db: D1Database, actor: string, request: Request, input?: unknown, publicationProviders?: OutreachPublicationProviders, now = Date.now()): Promise<RouteResult> {
  const url = new URL(request.url);
  const match = /^\/admin\/hours\/(labels|teams|activities)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, "Outreach route not found");
  const kind = match[1] as CatalogKind; const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  if (id && (!id.length || id.length > 128)) throw new HttpError(400, "Invalid Outreach identity");
  if (request.method === "GET") return id ? detail(db, kind, id) : list(db, kind, url);
  if (request.method === "POST" && !id || request.method === "PATCH" && id) return write(db, actor, kind, id, input, publicationProviders, now);
  throw new HttpError(405, "Use GET, POST, or PATCH for Outreach catalogs");
}

export async function outreachSetupRoute(db: D1Database, actor: string, request: Request, input?: unknown): Promise<RouteResult> {
  const path = new URL(request.url).pathname;
  if (path === "/module-setup/hour-tracking/rules") {
    const row = await db.prepare("SELECT reporting_days AS reportingDays,reopen_hours AS reopenHours,revision FROM hours_entry_settings WHERE installation_id=?").bind(installationId).first<Record<string, number>>();
    if (!row) throw new HttpError(409, "Outreach entry rules are unavailable");
    if (request.method === "GET") return { status: 200, body: { values: row } };
    if (request.method !== "PUT" || !object(input) || Object.keys(input).some((key) => !["reportingDays", "reopenHours", "revision"].includes(key))) throw new HttpError(400, "Provide Outreach entry rules and their current revision");
    const days = Number(input.reportingDays); const hours = Number(input.reopenHours); const expected = revision(input.revision);
    if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, "Outreach entry rules are outside their supported range");
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare("UPDATE hours_entry_settings SET reporting_days=?,reopen_hours=?,revision=revision+1 WHERE installation_id=? AND revision=?").bind(days, hours, installationId, expected),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,?,'outreach.rules_updated','outreach','primary',? WHERE changes()=1").bind(crypto.randomUUID(), installationId, actor, now),
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) throw new HttpError(409, "Outreach entry rules changed; reload before retrying");
    return { status: 200, body: { values: { reportingDays: days, reopenHours: hours, revision: expected + 1 } } };
  }
  if (path === "/module-setup/hour-tracking/catalog") {
    if (request.method === "GET") {
      const [labels, teams] = await Promise.all([
        db.prepare("SELECT * FROM hours_labels WHERE installation_id=? AND archived=0 ORDER BY name,id").bind(installationId).all<Row>(),
        db.prepare("SELECT installation_id,id,number,name,program,archived,revision,created_at,updated_at FROM hours_teams WHERE installation_id=? AND archived=0 ORDER BY id LIMIT 100").bind(installationId).all<Row>(),
      ]);
      return { status: 200, body: { labels: (labels.results ?? []).map(serialize), teams: (teams.results ?? []).map(serialize) } };
    }
    if (request.method === "POST") {
      if (!object(input) || Object.keys(input).some((key) => !["name", "number", "program"].includes(key))) throw new HttpError(400, "Provide a supported team");
      return write(db, actor, "teams", undefined, { ...input, archived: false });
    }
  }
  throw new HttpError(404, "Outreach setup route not found");
}
