// Team support operations Outreach offers other modules through its `hour-tracking.team-support` interface, and that its
// public form uses when a member logs Team support or Other service without a Staff-created activity. Each one is
// idempotent, so a caller that retries after an unclear failure never creates duplicate teams or activities.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { outreachPrograms } from "../shared/outreach-programs.ts";

type Program = typeof outreachPrograms[number];
export type SupportedTeam = { readonly id: string; readonly number: string; readonly name: string; readonly program: string; readonly archived: boolean; readonly addedByMember: boolean };
/** Who asked: the calling module, and the signed-in user when there is one. Recorded in Outreach's audit entries. */
export type TeamSupportCaller = { readonly moduleId: string; readonly userId?: string; readonly grantId?: string };
/** A member submitting through Outreach's public form. Teams it adds are flagged for Staff review. */
export type MemberCaller = { readonly channel: "public" };
type Caller = TeamSupportCaller | MemberCaller;

const installationId = "primary";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const teamColumns = "id,number,name,program,archived,added_by_member";

function field(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new HttpError(400, `Provide the ${label}`);
  return value.trim();
}
function program(value: unknown): Program {
  if (!outreachPrograms.includes(value as Program)) throw new HttpError(400, "Choose Explore, Challenge, FTC, or FRC as the team program");
  return value as Program;
}
function serviceDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new HttpError(400, "Provide a valid service date");
  return value;
}
const team = (row: Record<string, unknown>): SupportedTeam => ({ id: String(row.id), number: String(row.number), name: String(row.name), program: String(row.program), archived: Boolean(row.archived), addedByMember: Boolean(row.added_by_member) });
const byMember = (caller: Caller): caller is MemberCaller => "channel" in caller;
const callerMetadata = (caller: Caller) => byMember(caller) ? { channel: caller.channel } : { viaModule: caller.moduleId, ...caller.grantId ? { grantId: caller.grantId } : {} };
const audit = (db: D1Database, caller: Caller, action: string, targetId: string, metadata: Record<string, unknown>, now: string) =>
  db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'outreach_catalog',?,?,? WHERE changes()=1")
    .bind(crypto.randomUUID(), installationId, byMember(caller) ? null : caller.userId ?? null, action, targetId, JSON.stringify({ ...metadata, ...callerMetadata(caller) }), now);

/** Supported teams with this number and program, active first. Numbers compare without surrounding spaces or letter case. */
export async function findSupportedTeams(db: D1Database, input: unknown): Promise<{ teams: SupportedTeam[] }> {
  if (!object(input)) throw new HttpError(400, "Provide a team number and program");
  const number = field(input.number, "team number", 32); const selected = program(input.program);
  const rows = await db.prepare(`SELECT ${teamColumns} FROM hours_teams WHERE installation_id=? AND lower(trim(number))=lower(?) AND program=? ORDER BY archived,name,id LIMIT 20`).bind(installationId, number, selected).all<Record<string, unknown>>();
  return { teams: (rows.results ?? []).map(team) };
}

/**
 * The active supported team with this number and program, created when there is none. An archived match is refused rather
 * than restored, so a team staff retired is never revived by another module or a member. A team a member creates is
 * flagged as added by a member.
 */
export async function ensureSupportedTeam(db: D1Database, caller: Caller, input: unknown, nowMs = Date.now()): Promise<{ team: SupportedTeam; created: boolean }> {
  if (!object(input)) throw new HttpError(400, "Provide a team number, name and program");
  const number = field(input.number, "team number", 32); const name = field(input.name, "team name", 150); const selected = program(input.program);
  const { teams } = await findSupportedTeams(db, { number, program: selected });
  const active = teams.find((item) => !item.archived);
  if (active) return { team: active, created: false };
  if (teams.length) throw new HttpError(409, byMember(caller) ? archivedTeamForMembers : `Supported team ${number} (${selected}) is archived in Outreach. Restore it there first.`);
  const id = crypto.randomUUID(); const now = new Date(nowMs).toISOString();
  // The insert and its audit entry only take effect when no active match appeared meanwhile.
  await db.batch([
    db.prepare("INSERT INTO hours_teams(installation_id,id,number,name,program,archived,revision,created_at,updated_at,added_by_member) SELECT ?,?,?,?,?,0,0,?,?,? WHERE NOT EXISTS(SELECT 1 FROM hours_teams WHERE installation_id=? AND lower(trim(number))=lower(?) AND program=? AND archived=0)")
      .bind(installationId, id, number, name, selected, now, now, byMember(caller) ? 1 : 0, installationId, number, selected),
    audit(db, caller, "outreach.teams.created", id, { number, program: selected, ...byMember(caller) ? { addedByMember: true } : {} }, now),
  ]);
  const created = await db.prepare(`SELECT ${teamColumns} FROM hours_teams WHERE installation_id=? AND lower(trim(number))=lower(?) AND program=? AND archived=0 ORDER BY created_at,id LIMIT 1`).bind(installationId, number, selected).first<Record<string, unknown>>();
  if (!created) throw new HttpError(409, "The supported team could not be created. Try again.");
  return { team: team(created), created: String(created.id) === id };
}

// Core dropped the unique index on (category, date, team) when activities gained labels, so Staff may create several
// matching activities. Each lookup returns the earliest active match (an archived one only when no active one exists),
// and each insert only takes effect when no match exists, so concurrent calls still create at most one activity.
const teamActivityMatch = "installation_id=? AND category_id='team-support' AND service_date=? AND team_id=?";
const otherActivityMatch = "installation_id=? AND category_id='other-service' AND service_date=? AND team_id IS NULL AND lower(trim(title))=lower(?)";
const earliest = "ORDER BY archived,created_at,id LIMIT 1";

/** The Team Support activity for this team and date, when there is one. */
export async function findTeamSupportActivity(db: D1Database, teamId: string, serviceDateValue: string) {
  return (await db.prepare(`SELECT id FROM hours_activities WHERE ${teamActivityMatch} ${earliest}`).bind(installationId, serviceDate(serviceDateValue), teamId).first<{ id: string }>())?.id;
}

/**
 * The Team Support activity for this team and date, created when there is none. Outreach keeps one per team and date, so
 * repeated calls, including concurrent ones, return the same activity.
 */
export async function ensureTeamSupportActivity(db: D1Database, caller: Caller, input: unknown, nowMs = Date.now()): Promise<{ activityId: string; created: boolean }> {
  if (!object(input)) throw new HttpError(400, "Provide a supported team and service date");
  const teamId = field(input.teamId, "supported team", 128); const date = serviceDate(input.serviceDate);
  const title = input.title === undefined ? undefined : field(input.title, "activity title", 150);
  const supported = await db.prepare(`SELECT ${teamColumns} FROM hours_teams WHERE installation_id=? AND id=?`).bind(installationId, teamId).first<Record<string, unknown>>();
  if (!supported) throw new HttpError(404, "Supported team not found");
  const existing = await findTeamSupportActivity(db, teamId, date);
  if (existing) return { activityId: existing, created: false };
  if (supported.archived) throw new HttpError(409, byMember(caller) ? archivedTeamForMembers : "That supported team is archived in Outreach. Restore it there first.");
  const id = crypto.randomUUID(); const now = new Date(nowMs).toISOString();
  const label = `${String(supported.number) ? `${String(supported.number)} ` : ""}${String(supported.name)}`;
  await db.batch([
    db.prepare(`INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,team_id,title,description,location,impact_relevant,archived,revision,created_at,updated_at) SELECT ?,?,c.id,'team',?,?,?,'','',c.impact_default,0,0,?,? FROM hours_categories c WHERE c.installation_id=? AND c.id='team-support' AND c.archived=0 AND EXISTS(SELECT 1 FROM hours_teams WHERE installation_id=? AND id=? AND archived=0) AND NOT EXISTS(SELECT 1 FROM hours_activities WHERE ${teamActivityMatch})`)
      .bind(installationId, id, date, teamId, title ?? `Team support: ${label}`.slice(0, 150), now, now, installationId, installationId, teamId, installationId, date, teamId),
    audit(db, caller, "outreach.activities.created", id, { mode: "team", teamId, serviceDate: date }, now),
  ]);
  const activity = await findTeamSupportActivity(db, teamId, date);
  if (!activity) throw new HttpError(409, byMember(caller) ? teamSupportUnavailable : "Team Support is unavailable in Outreach. Check that its activity type is active.");
  return { activityId: activity, created: activity === id };
}

/** Member-facing refusals, which the public form shows as they are. */
export const archivedTeamForMembers = "That team is no longer on the supported teams list. Choose another team or contact Staff.";
export const teamSupportUnavailable = "Team support logging is unavailable. Contact Staff.";
export const otherServiceUnavailable = "Other service logging is unavailable. Contact Staff.";
export const closedActivityForMembers = "Staff closed that activity to member submissions. Contact Staff.";

/** The Other Service activity with this title on this date, when there is one. Titles compare without surrounding spaces or letter case. */
export async function findOtherServiceActivity(db: D1Database, serviceDateValue: string, titleValue: string) {
  return (await db.prepare(`SELECT id FROM hours_activities WHERE ${otherActivityMatch} ${earliest}`).bind(installationId, serviceDate(serviceDateValue), titleValue.trim()).first<{ id: string }>())?.id;
}

/**
 * The Other Service activity with this title on this date, created when there is none, so members can log other service
 * (such as "STEM tutoring") without a Staff-created activity. A Staff-created Other Service activity with the same title
 * on that date is reused. Repeated and concurrent calls return the same activity.
 */
export async function ensureOtherServiceActivity(db: D1Database, caller: Caller, input: unknown, nowMs = Date.now()): Promise<{ activityId: string; created: boolean }> {
  if (!object(input)) throw new HttpError(400, "Provide a service date and description");
  const date = serviceDate(input.serviceDate); const title = field(input.title, "service description", 150);
  const existing = await findOtherServiceActivity(db, date, title);
  if (existing) return { activityId: existing, created: false };
  const id = crypto.randomUUID(); const now = new Date(nowMs).toISOString();
  await db.batch([
    db.prepare(`INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,team_id,title,description,location,impact_relevant,archived,revision,created_at,updated_at) SELECT ?,?,c.id,'task',?,NULL,?,'','',c.impact_default,0,0,?,? FROM hours_categories c WHERE c.installation_id=? AND c.id='other-service' AND c.archived=0 AND NOT EXISTS(SELECT 1 FROM hours_activities WHERE ${otherActivityMatch})`)
      .bind(installationId, id, date, title, now, now, installationId, installationId, date, title),
    audit(db, caller, "outreach.activities.created", id, { mode: "task", serviceDate: date }, now),
  ]);
  const activity = await findOtherServiceActivity(db, date, title);
  if (!activity) throw new HttpError(409, byMember(caller) ? otherServiceUnavailable : "Other Service is unavailable in Outreach. Check that its activity type is active.");
  return { activityId: activity, created: activity === id };
}
