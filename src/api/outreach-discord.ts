import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import type { DiscordModuleInteraction, DiscordModuleInteractionHandler } from "@lancerlogin/module-sdk/api";
import { submitOutreachEntry } from "./outreach-entries.ts";
import { requestOutreachCorrection } from "./outreach-review.ts";
import { outreachDiscordReport, outreachReportUnlinked, type OutreachReportEntry, type OutreachReportTotals } from "../shared/outreach-discord-report.ts";

type Row = { id: string; serviceDate: string };

function commandOptions(interaction: DiscordModuleInteraction, allowed: readonly string[]) {
  const values = new Map<string, string>();
  const options = interaction.data?.options ?? [];
  if (!Array.isArray(options) || options.length > allowed.length) throw new HttpError(400, "This Outreach command is malformed. Try it again.");
  for (const option of options) {
    if (!option || typeof option.name !== "string" || typeof option.value !== "string" || !allowed.includes(option.name) || values.has(option.name)) throw new HttpError(400, "This Outreach command is malformed. Try it again.");
    values.set(option.name, option.value.trim());
  }
  return values;
}

function discordUserId(interaction: DiscordModuleInteraction) {
  const value = interaction.member?.user?.id ?? interaction.user?.id;
  if (typeof value !== "string" || !/^\d{10,24}$/.test(value)) throw new HttpError(400, "Use this command from a linked Discord account.");
  return value;
}

function linkedIdentity(interaction: DiscordModuleInteraction) {
  const value = discordUserId(interaction);
  if (typeof interaction.id !== "string" || !/^\d{10,24}$/.test(interaction.id)) throw new HttpError(400, "This Discord request cannot be confirmed. Try the command again.");
  return { discordUserId: value, idempotencyKey: `discord:${interaction.id}` };
}

async function submit(db: D1Database, interaction: DiscordModuleInteraction, now: number) {
  const options = commandOptions(interaction, ["activity", "start", "end", "notes"]); const identity = linkedIdentity(interaction);
  const reference = options.get("activity") ?? ""; const startLocal = options.get("start") ?? ""; const endLocal = options.get("end") ?? "";
  if (!reference || !startLocal || !endLocal) throw new HttpError(400, "Choose an activity and provide start and end times.");
  const result = await db.prepare(`SELECT id,service_date AS serviceDate FROM hours_activities
    WHERE installation_id='primary' AND archived=0 AND (id=? OR title=? COLLATE NOCASE) ORDER BY id LIMIT 2`).bind(reference, reference).all<Row>();
  const activities = result.results ?? [];
  if (activities.length !== 1) throw new HttpError(400, "Choose one eligible dated activity using its reference or exact title.");
  const activity = activities[0]!; const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id='primary'").first<{ timeZone: string }>();
  if (!settings) throw new HttpError(409, "Outreach settings are unavailable.");
  const saved = await submitOutreachEntry(db, { channel: "discord", discordUserId: identity.discordUserId }, {
    activityId: activity.id, serviceDate: activity.serviceDate, startLocal, endLocal,
    taskNotes: options.get("notes") ?? "", idempotencyKey: identity.idempotencyKey, expectedTimeZone: settings.timeZone,
  }, now);
  const receipt = saved.body as { id: string; serviceDate: string; durationMinutes: number };
  return `${saved.status === 200 ? "This exact submission was already recorded" : "Participation recorded"}: ${receipt.durationMinutes} minutes on ${receipt.serviceDate}. Receipt: ${receipt.id}`;
}

async function correction(db: D1Database, interaction: DiscordModuleInteraction, now: number) {
  const options = commandOptions(interaction, ["message", "receipt", "date"]); const identity = linkedIdentity(interaction); const message = options.get("message") ?? "";
  if (!message) throw new HttpError(400, "Describe what Staff should review.");
  const saved = await requestOutreachCorrection(db, { channel: "discord", discordUserId: identity.discordUserId }, {
    message, ...(options.get("receipt") ? { receiptId: options.get("receipt") } : {}), ...(options.get("date") ? { serviceDate: options.get("date") } : {}),
    idempotencyKey: `correction:${identity.idempotencyKey}`,
  }, now);
  const receipt = saved.body as { reference: string };
  return `${saved.status === 200 ? "This exact correction request was already received" : "Correction request received"}. Staff review is required before totals change. Reference: ${receipt.reference}`;
}

// The members linked to this Discord account that may report: exactly one must exist and be active, or the reply says so.
const linkedMember = "linked AS (SELECT id FROM members WHERE installation_id='primary' AND discord_user_id=? AND active=1)";
const baseline = "SELECT starts_on FROM module_report_baselines WHERE installation_id='primary' AND module_id='hour-tracking'";

/**
 * /outreach-report: the linked member's own counted participation, privately. Its four reads are independent and keyed by
 * the Discord account, so they start together and Core's module-scoped database sends them as one D1 batch. Reads made for
 * an account that is not linked to exactly one active member are discarded.
 */
async function report(db: D1Database, interaction: DiscordModuleInteraction, _now: number) {
  commandOptions(interaction, []); const discordUser = discordUserId(interaction);
  const [context, totals, recent, corrections] = await Promise.all([
    db.prepare(`SELECT (SELECT COUNT(*) FROM members WHERE installation_id='primary' AND discord_user_id=?) AS linked,
      (SELECT id FROM members WHERE installation_id='primary' AND discord_user_id=? AND active=1 ORDER BY id LIMIT 1) AS memberId,
      (${baseline}) AS startsOn`).bind(discordUser, discordUser).first<{ linked: number; memberId: string | null; startsOn: string | null }>(),
    db.prepare(`WITH ${linkedMember}, period AS (SELECT (${baseline}) AS startsOn)
      SELECT a.mode,COUNT(*) AS entries,COUNT(DISTINCT e.activity_id) AS activities,SUM(e.duration_minutes) AS minutes,
        COUNT(CASE WHEN e.service_date>=p.startsOn THEN 1 END) AS periodEntries,
        COUNT(DISTINCT CASE WHEN e.service_date>=p.startsOn THEN e.activity_id END) AS periodActivities,
        COALESCE(SUM(CASE WHEN e.service_date>=p.startsOn THEN e.duration_minutes END),0) AS periodMinutes
      FROM hours_entries e JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id CROSS JOIN period p
      WHERE e.installation_id='primary' AND e.status='counted' AND e.member_id IN (SELECT id FROM linked) GROUP BY a.mode`).bind(discordUser).all<OutreachReportTotals>(),
    db.prepare(`WITH ${linkedMember}
      SELECT e.id,e.service_date AS serviceDate,a.title,a.mode,e.duration_minutes AS durationMinutes
      FROM hours_entries e JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id
      WHERE e.installation_id='primary' AND e.status='counted' AND e.member_id IN (SELECT id FROM linked) ORDER BY e.start_ms DESC,e.id DESC LIMIT 5`).bind(discordUser).all<OutreachReportEntry>(),
    db.prepare(`WITH ${linkedMember}
      SELECT COUNT(*) AS open FROM hours_correction_requests WHERE installation_id='primary' AND status='open' AND requester_member_id IN (SELECT id FROM linked)`).bind(discordUser).first<{ open: number }>(),
  ]);
  if (!context || Number(context.linked) !== 1 || !context.memberId) return outreachReportUnlinked;
  return outreachDiscordReport({
    startsOn: context.startsOn ?? null,
    totals: (totals.results ?? []).map((row) => ({ ...row, entries: Number(row.entries), activities: Number(row.activities), minutes: Number(row.minutes), periodEntries: Number(row.periodEntries), periodActivities: Number(row.periodActivities), periodMinutes: Number(row.periodMinutes) })),
    recent: (recent.results ?? []).map((row) => ({ ...row, durationMinutes: Number(row.durationMinutes) })),
    openCorrections: Number(corrections?.open ?? 0),
  });
}

export const outreachDiscordHandlers: Readonly<Record<string, DiscordModuleInteractionHandler>> = Object.freeze({
  "outreach-submit": submit,
  "outreach-correction": correction,
  "outreach-report": report,
});
