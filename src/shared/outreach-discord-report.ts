// The private /outreach-report reply: a linked member's counted Outreach participation, since Outreach's reporting start
// date and all time, by activity type, with their most recent entries. Pure, so tests can render it without a database.
// Task notes are never part of it. Activity titles are member- and Staff-entered text, so Discord markdown and mention
// characters are removed from them as Core does in its Discord reports; Core sends every module reply privately with
// mentions disabled.

export type OutreachReportMode = "event" | "team" | "task";

export type OutreachReportTotals = {
  mode: OutreachReportMode;
  entries: number;
  activities: number;
  minutes: number;
  periodEntries: number;
  periodActivities: number;
  periodMinutes: number;
};

export type OutreachReportEntry = { id: string; serviceDate: string; title: string; mode: OutreachReportMode; durationMinutes: number };

export type OutreachReportInput = {
  /** Outreach's reporting start date (operational baseline), or null when none is set. */
  startsOn: string | null;
  totals: readonly OutreachReportTotals[];
  /** The most recent counted entries, newest first. */
  recent: readonly OutreachReportEntry[];
  openCorrections: number;
};

/** The labels of the default Outreach categories, one per activity type, in the order reports list them. */
export const outreachReportModeLabels: Readonly<Record<OutreachReportMode, string>> = Object.freeze({ event: "Event", team: "Team Support", task: "Other Service" });
const modeOrder: readonly OutreachReportMode[] = ["event", "team", "task"];

/** Discord's message limit is 2,000 characters; entry lines stop here, as Core's attendance report does. */
export const outreachReportLengthGuard = 1850;
export const outreachReportUnlinked = "Your Discord account is not linked to exactly one active LancerLogin roster member. Use /pair with your member ID, or ask an Operator to check your roster link.";
const hint = "Use /outreach-submit to record participation or /outreach-correction to ask Staff to review an entry.";

/** As the dashboard shows hours: total minutes / 60 with two decimals. */
export const outreachReportHours = (minutes: number) => `${(minutes / 60).toFixed(2)} hours`;
const count = (value: number, singular: string, plural: string) => `${value} ${value === 1 ? singular : plural}`;
/** Activity titles without Discord markdown, mention or line-break characters, as Core's discordReportText removes them. */
export const outreachReportText = (value: string, limit: number) => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_~|<>@]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);

type Sums = { entries: number; activities: number; minutes: number };
const sums = (rows: readonly OutreachReportTotals[], period: boolean): Sums & { byMode: Array<Sums & { mode: OutreachReportMode }> } => {
  const byMode = modeOrder.map((mode) => {
    const row = rows.find((item) => item.mode === mode);
    return { mode, entries: (period ? row?.periodEntries : row?.entries) ?? 0, activities: (period ? row?.periodActivities : row?.activities) ?? 0, minutes: (period ? row?.periodMinutes : row?.minutes) ?? 0 };
  });
  // An activity has one type, so distinct activities add up across types.
  return { byMode, entries: byMode.reduce((total, item) => total + item.entries, 0), activities: byMode.reduce((total, item) => total + item.activities, 0), minutes: byMode.reduce((total, item) => total + item.minutes, 0) };
};

/** The main headline is bold and counts entries; the all-time line under a period headline is plain and does not. */
const headline = (prefix: string, value: Sums, main: boolean) => {
  const strong = (text: string) => main ? `**${text}**` : text;
  return `${prefix}: ${strong(outreachReportHours(value.minutes))} across ${strong(count(value.activities, "activity", "activities"))}${main ? ` (${count(value.entries, "entry", "entries")})` : ""}.`;
};
const modeLines = (value: ReturnType<typeof sums>) => value.byMode.filter((item) => item.activities > 0)
  .map((item) => `\n• ${outreachReportModeLabels[item.mode]}: ${outreachReportHours(item.minutes)} (${count(item.activities, "activity", "activities")})`).join("");

export function outreachDiscordReport(input: OutreachReportInput): string {
  const allTime = sums(input.totals, false);
  let content = "**Your Outreach participation**\n";
  if (input.startsOn) {
    const period = sums(input.totals, true);
    content += period.entries ? headline(`Since ${input.startsOn} (Outreach reporting start date)`, period, true) + modeLines(period) : `No counted Outreach participation since ${input.startsOn}.`;
    if (allTime.entries) content += `\n${headline("All time", allTime, false)}`;
  } else {
    content += allTime.entries ? headline("All time", allTime, true) + modeLines(allTime) : "No counted Outreach participation yet.";
  }
  const footer = `${input.openCorrections > 0 ? `\nOpen correction requests: ${input.openCorrections}. Totals change only after Staff review.` : ""}\n${hint}`;
  if (input.recent.length) {
    content += "\n\n**Recent participation**";
    for (const entry of input.recent) {
      const line = `\n• ${entry.serviceDate} - ${outreachReportText(entry.title, 150) || outreachReportModeLabels[entry.mode]} - ${outreachReportHours(entry.durationMinutes)} (receipt \`${entry.id}\`)`;
      if ((content + line + footer).length > outreachReportLengthGuard) { content += "\nMore entries omitted to fit Discord."; break; }
      content += line;
    }
  }
  return content + (input.recent.length ? "" : "\n") + footer;
}
