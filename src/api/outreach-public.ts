import { addCalendarDays, instantToCivil } from "@lancerlogin/module-sdk";
import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { submitOutreachEntry } from "./outreach-entries.ts";
import { requestOutreachCorrection } from "./outreach-review.ts";
import { readPublicFormSettings, validatePublicMember } from "./outreach-public-settings.ts";

type Row = Record<string, unknown>;
type RouteResult = { status: number; body: unknown };
const installationId = "primary";
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
function serialize(row: Row) {
  const result = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "installation_id").map(([key, value]) => [camel(key), value])) as Row;
  if (typeof result.labelsJson === "string") {
    result.labels = (JSON.parse(result.labelsJson) as Array<{ id: string; name: string; archived: number | boolean }>).map((label) => ({ ...label, archived: Boolean(label.archived) }));
    result.labelIds = (result.labels as Array<{ id: string }>).map((label) => label.id);
    delete result.labelsJson;
  }
  return result;
}

function text(value: unknown, maximum = 128, required = true) {
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, "Invalid Outreach request");
  return value.trim();
}

function page(url: URL, allowed: string[]) {
  const accepted = new Set(["after", "limit", ...allowed]);
  url.searchParams.forEach((_, key) => { if (!accepted.has(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid Outreach catalog filter"); });
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "Invalid Outreach catalog limit");
  return { after: text(url.searchParams.get("after") ?? "", 128, false), limit };
}

async function clockContext(db: D1Database, now: number) {
  const row = await db.prepare(`SELECT e.reporting_days AS reportingDays,e.reopen_hours AS reopenHours,e.revision,s.time_zone AS timeZone,
    s.organization_name AS organizationName,s.subtitle,s.logo_data AS logoData,s.primary_color AS primaryColor,s.secondary_color AS secondaryColor,s.logo_backdrop AS logoBackdrop
    FROM hours_entry_settings e JOIN organization_settings s ON s.installation_id=e.installation_id WHERE e.installation_id=?`).bind(installationId).first<Row>();
  if (!row) throw new HttpError(409, "Outreach Participation is unavailable");
  const today = instantToCivil(now, String(row.timeZone)).date; let earliestServiceDate = "0000-01-01";
  try { earliestServiceDate = addCalendarDays(today, 1 - Number(row.reportingDays)); } catch { /* Four-digit date lower bound remains valid. */ }
  return { ...serialize(row), today, earliestServiceDate, memberValidation: (await readPublicFormSettings(db)).memberValidation };
}

function publicReceipt(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(409, "The Outreach submission result could not be confirmed");
  const row = value as Row;
  return { id: row.id, serviceDate: row.serviceDate, startLocal: row.startLocal, endLocal: row.endLocal, durationMinutes: row.durationMinutes, channel: row.channel, createdAt: row.createdAt };
}

function requireSameOrigin(request: Request, allowedOrigin: string) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== allowedOrigin) throw new HttpError(403, "Use the published LancerLogin submission page");
}

export async function outreachPublicRoute(db: D1Database, request: Request, allowedOrigin: string, input?: unknown, now = Date.now()): Promise<RouteResult> {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new HttpError(400, "Invalid current instant");
  const url = new URL(request.url); const kind = url.pathname.slice("/public/hours/".length);
  if (request.method === "POST") {
    requireSameOrigin(request, allowedOrigin);
    if (url.search) throw new HttpError(400, "Provide public form input in the request body only");
  }
  if (kind === "member-validation" && request.method === "POST") return validatePublicMember(db, input, now);
  if (kind === "entries" && request.method === "POST") {
    try {
      const result = await submitOutreachEntry(db, { channel: "public" }, input, now);
      return { status: result.status, body: publicReceipt(result.body) };
    } catch (error) {
      if (error instanceof HttpError && [400, 409].includes(error.status)) return publicInputError(db, error, false);
      throw error;
    }
  }
  if (kind === "corrections" && request.method === "POST") {
    try { return await requestOutreachCorrection(db, { channel: "public" }, input, now); }
    catch (error) {
      if (error instanceof HttpError && [400, 409].includes(error.status)) return publicInputError(db, error, true);
      throw error;
    }
  }
  if (request.method !== "GET") throw new HttpError(405, "Unsupported public Outreach operation");
  if (kind === "context") {
    let filtered = false; url.searchParams.forEach(() => { filtered = true; });
    if (filtered) throw new HttpError(400, "Invalid Outreach context filter");
    return { status: 200, body: await clockContext(db, now) };
  }
  const correctionCatalog = kind === "correction-activities";
  const activityCatalog = kind === "activities" || kind === "events" || correctionCatalog;
  const context = await clockContext(db, now); const { after, limit } = page(url, activityCatalog ? ["mode", "teamId", "labelIds", "labelMatch"] : []); let rows: Row[];
  if (kind === "labels") {
    rows = (await db.prepare("SELECT id,name FROM hours_labels WHERE installation_id=? AND archived=0 AND id>? ORDER BY id LIMIT ?").bind(installationId, after, limit + 1).all<Row>()).results ?? [];
  } else if (kind === "teams") {
    rows = (await db.prepare("SELECT id,name,number,program FROM hours_teams WHERE installation_id=? AND archived=0 AND id>? ORDER BY id LIMIT ?").bind(installationId, after, limit + 1).all<Row>()).results ?? [];
  } else if (activityCatalog) {
    const clauses = ["a.installation_id=?", "a.id>?", "a.service_date<=?", ...(correctionCatalog ? [] : ["a.archived=0", `(a.service_date>=? OR EXISTS(SELECT 1 FROM hours_reopen_windows w WHERE w.installation_id=a.installation_id AND w.revoked=0 AND w.starts_ms<=? AND w.expires_ms>? AND (w.activity_id IS NULL OR w.activity_id=a.id)))`])];
    const values: unknown[] = [installationId, after, context.today, ...(correctionCatalog ? [] : [context.earliestServiceDate, now, now])];
    const mode = url.searchParams.get("mode");
    if (mode !== null) { if (!["event", "team", "task"].includes(mode)) throw new HttpError(400, "Invalid Outreach activity type"); clauses.push("a.mode=?"); values.push(mode); }
    const teamId = url.searchParams.get("teamId");
    if (teamId !== null) { clauses.push("a.team_id=?"); values.push(text(teamId)); }
    const selectedLabelIds = (url.searchParams.get("labelIds") ?? "").split(",").filter(Boolean);
    const labelMatch = url.searchParams.get("labelMatch") ?? "any";
    if (!selectedLabelIds.length && url.searchParams.has("labelMatch") || selectedLabelIds.some((id) => !id.length || id.length > 128) || !["any", "all"].includes(labelMatch)) throw new HttpError(400, "Invalid Outreach label filter");
    if (selectedLabelIds.length) {
      const unique = [...new Set(selectedLabelIds)]; const placeholders = unique.map(() => "?").join(",");
      clauses.push(labelMatch === "all"
        ? `(SELECT COUNT(DISTINCT al.label_id) FROM hours_activity_labels al WHERE al.installation_id=a.installation_id AND al.activity_id=a.id AND al.label_id IN (${placeholders}))=?`
        : `EXISTS(SELECT 1 FROM hours_activity_labels al WHERE al.installation_id=a.installation_id AND al.activity_id=a.id AND al.label_id IN (${placeholders}))`);
      values.push(...unique); if (labelMatch === "all") values.push(unique.length);
    }
    rows = (await db.prepare(`SELECT a.id,a.mode,a.team_id AS teamId,a.title,a.service_date AS serviceDate,a.location,
      CASE WHEN a.service_date<? THEN 1 ELSE 0 END AS reopened
      ,COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name,'archived',json(labels.archived))) FROM
        (SELECT l.id,l.name,l.archived FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id
         WHERE al.installation_id=a.installation_id AND al.activity_id=a.id ORDER BY l.name,l.id) labels),'[]') AS labels_json
      FROM hours_activities a WHERE ${clauses.join(" AND ")}
      ORDER BY a.id LIMIT ?`).bind(context.earliestServiceDate, ...values, limit + 1).all<Row>()).results ?? [];
  } else throw new HttpError(404, "Public Outreach route not found");
  return { status: 200, body: { items: rows.slice(0, limit).map((row) => ({ ...serialize(row), ...(Object.hasOwn(row, "reopened") ? { reopened: Boolean(row.reopened) } : {}) })), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null } };
}

async function publicInputError(db: D1Database, error: HttpError, correction: boolean): Promise<RouteResult> {
  const operation = correction ? "correction request" : "hours";
  if (["Member identity is unavailable", "Receipt identity is unavailable"].includes(error.message)) {
    const permitted = error.message === "Member identity is unavailable" && (await readPublicFormSettings(db)).memberValidation !== "off";
    return { status: 400, body: { error: permitted ? "No active roster member matches that ID. Check the member ID and try again." : "Unable to verify the member ID and selected activity. Check both or contact Staff.", code: "identity_not_verified", retryExact: false } };
  }
  const safe = [
    "Choose start and end times in five-minute increments", "Completed Outreach time cannot end in the future",
    "Completed Outreach time cannot use a future service date", "Choose an active Outreach activity",
    "Entry date must match the selected dated activity", "Outreach entry rules changed; reload before retrying",
    "This time overlaps already counted Outreach participation",
    "Choose a valid Outreach activity for this correction", "Provide the selected Outreach activity", "Receipt and activity do not match",
    "Provide only supported Outreach entry fields", "Provide only supported correction fields",
  ];
  const known = safe.includes(error.message) || error.message.startsWith("This service date is outside the current ") || error.status === 400 && !error.message.includes("identity");
  if (known) return { status: error.status, body: { error: error.message, code: "input_not_accepted", retryExact: false } };
  return { status: 409, body: { error: `The ${operation} result could not be confirmed. Retry the exact request before entering a replacement.`, code: "result_uncertain", retryExact: true } };
}
