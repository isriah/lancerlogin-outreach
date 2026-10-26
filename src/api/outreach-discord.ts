import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import type { DiscordModuleInteraction, DiscordModuleInteractionHandler } from "@lancerlogin/module-sdk/api";
import { submitOutreachEntry } from "./outreach-entries.ts";
import { requestOutreachCorrection } from "./outreach-review.ts";

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

function linkedIdentity(interaction: DiscordModuleInteraction) {
  const value = interaction.member?.user?.id ?? interaction.user?.id;
  if (typeof value !== "string" || !/^\d{10,24}$/.test(value)) throw new HttpError(400, "Use this command from a linked Discord account.");
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

export const outreachDiscordHandlers: Readonly<Record<string, DiscordModuleInteractionHandler>> = Object.freeze({
  "outreach-submit": submit,
  "outreach-correction": correction,
});
