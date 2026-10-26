import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";

export type MemberValidationMode = "off" | "validity" | "name";
const installationId = "primary";
const modes = new Set<MemberValidationMode>(["off", "validity", "name"]);

export async function readPublicFormSettings(db: D1Database) {
  const row = await db.prepare("SELECT member_validation AS memberValidation,revision FROM hours_public_form_settings WHERE installation_id=?")
    .bind(installationId).first<{ memberValidation: MemberValidationMode; revision: number }>();
  return row ?? { memberValidation: "off" as const, revision: 0 };
}

// The caller must require current Administrator authority.
export async function publicFormSettingsRoute(db: D1Database, actor: string, request: Request, input?: unknown, now = Date.now()) {
  if (request.method === "GET") {
    const settings = await db.prepare(`SELECT COALESCE(s.member_validation,'off') AS memberValidation,COALESCE(s.revision,0) AS revision
      FROM users u LEFT JOIN hours_public_form_settings s ON s.installation_id=u.installation_id
      WHERE u.installation_id=? AND u.id=? AND u.active=1 AND u.role='admin' LIMIT 1`)
      .bind(installationId, actor).first<{ memberValidation: MemberValidationMode; revision: number }>();
    if (!settings) throw new HttpError(403, "Current Administrator access is required");
    return { status: 200, body: { memberValidation: settings.memberValidation, revision: settings.revision } };
  }
  if (request.method !== "PUT") throw new HttpError(405, "Unsupported public form settings operation");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Choose a public member-ID validation mode");
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some(key => !["memberValidation", "revision"].includes(key)) || !modes.has(fields.memberValidation as MemberValidationMode)
    || !Number.isSafeInteger(fields.revision) || Number(fields.revision) < 0 || Number(fields.revision) >= Number.MAX_SAFE_INTEGER - 1) throw new HttpError(400, "Choose a valid public member-ID validation mode and revision");
  const current = await readPublicFormSettings(db);
  if (current.revision !== fields.revision) throw new HttpError(409, "Public form settings changed. Reload before saving.");
  const updatedAt = new Date(now).toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO hours_public_form_settings(installation_id,member_validation,revision,updated_at)
      SELECT ?,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM hours_public_form_settings WHERE installation_id=? AND revision=?))
        AND EXISTS(SELECT 1 FROM users WHERE installation_id=? AND id=? AND active=1 AND role='admin')
      ON CONFLICT(installation_id) DO UPDATE SET member_validation=excluded.member_validation,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE hours_public_form_settings.revision=excluded.revision-1`)
      .bind(installationId, fields.memberValidation, Number(fields.revision) + 1, updatedAt, fields.revision, installationId, fields.revision, installationId, actor),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?,'outreach.public_form_privacy_updated','outreach_public_form','primary',?,?
      WHERE changes()=1`)
      .bind(crypto.randomUUID(), installationId, actor, JSON.stringify({ memberValidation: fields.memberValidation }), updatedAt),
  ]);
  if (results.some(result => result.meta?.changes !== 1)) throw new HttpError(409, "Public form settings changed. Reload before saving.");
  return { status: 200, body: { memberValidation: fields.memberValidation, revision: Number(fields.revision) + 1 } };
}

export async function validatePublicMember(db: D1Database, input: unknown, now: number) {
  const settings = await readPublicFormSettings(db);
  if (settings.memberValidation === "off") return { status: 200, body: { mode: "off" } };
  const module = await db.prepare("SELECT generation FROM platform_modules WHERE installation_id=? AND module_id='hour-tracking' AND phase='enabled'").bind(installationId).first<{ generation: number }>();
  if (!module) return { status: 200, body: { mode: "off" } };
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "memberExternalId")) throw new HttpError(400, "Enter one roster member ID");
  const memberExternalId = (input as Record<string, unknown>).memberExternalId;
  if (typeof memberExternalId !== "string" || !memberExternalId.trim() || memberExternalId.length > 80) throw new HttpError(400, "Enter a roster member ID of up to 80 characters");
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const allowance = await db.prepare(`INSERT INTO hours_public_lookup_limits(installation_id,window_start_ms,attempts)
    SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM hours_public_form_settings WHERE installation_id=? AND member_validation=? AND revision=?)
    ON CONFLICT(installation_id) DO UPDATE SET window_start_ms=excluded.window_start_ms,
      attempts=CASE WHEN hours_public_lookup_limits.window_start_ms=excluded.window_start_ms THEN hours_public_lookup_limits.attempts+1 ELSE 1 END
    WHERE hours_public_lookup_limits.window_start_ms!=excluded.window_start_ms OR hours_public_lookup_limits.attempts<60
    RETURNING attempts`).bind(installationId, windowStart, installationId, settings.memberValidation, settings.revision).first();
  if (!allowance) {
    const current = await readPublicFormSettings(db);
    if (current.memberValidation === "off" || current.revision !== settings.revision) return { status: 200, body: { mode: "off" } };
    return { status: 429, body: { error: "Member-ID checks are busy. Try again in a minute.", code: "validation_rate_limited" } };
  }
  // Validity-only never selects a name, including through hidden response fields.
  const member = await db.prepare(settings.memberValidation === "name"
    ? "SELECT trim(first_name||' '||last_name) AS name FROM members WHERE installation_id=? AND external_id=? AND active=1 LIMIT 1"
    : "SELECT 1 AS valid FROM members WHERE installation_id=? AND external_id=? AND active=1 LIMIT 1")
    .bind(installationId, memberExternalId.trim()).first<{ name?: string }>();
  const current = await readPublicFormSettings(db);
  const enabled = await db.prepare("SELECT generation FROM platform_modules WHERE installation_id=? AND module_id='hour-tracking' AND phase='enabled'").bind(installationId).first<{ generation: number }>();
  if (!enabled || enabled.generation !== module.generation || current.memberValidation !== settings.memberValidation || current.revision !== settings.revision) return { status: 200, body: { mode: "off" } };
  return { status: 200, body: { mode: settings.memberValidation, valid: Boolean(member), ...(settings.memberValidation === "name" && member ? { name: member.name } : {}) } };
}
