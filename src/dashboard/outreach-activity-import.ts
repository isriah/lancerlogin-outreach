// Text and state for the Import Outreach activities dialog, kept apart from its React so the plugin's tests can check them.
// The dialog follows Core's meeting import: a server dry run previews every row, then one request imports them.
import { formatCsvTimeRange } from "@lancerlogin/module-sdk";
import { outreachActivityTypeLabels, type OutreachActivityCsvMode } from "../shared/outreach-activity-csv.ts";
import { listText, publicationProviderLabels, publicationProviderOrder, type PublicationProvider } from "./outreach-publication-destinations.ts";

export type ImportActivity = { title: string; date: string; mode: OutreachActivityCsvMode; startTime: string | null; endTime: string | null; team: string | null; labels: string[]; location: string; description: string; impactRelevant: boolean };
export type ImportChange = "title" | "time" | "labels" | "location" | "description" | "impact";
export type ActivityImportRow = { rowNumber: number; action: "add" | "update" | "skip" | "error"; title?: string; activity?: ImportActivity; existing?: ImportActivity & { activityId: string }; changes?: ImportChange[]; error?: string; warnings?: string[]; publication?: { publish: PublicationProvider[]; update: PublicationProvider[] } };
export type ActivityImportSummary = { add: number; update: number; skip: number; error: number };
export type ActivityImportResult = { rows: ActivityImportRow[]; summary: ActivityImportSummary; imported?: { added: number; updated: number; activityIds: string[] }; publication?: { queued: number; providers: PublicationProvider[] } };
export type ImportChoice = "skip" | "update";

export const importTemplateFilename = "outreach-activities-template.csv";
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
export const typeText = (activity: ImportActivity) => outreachActivityTypeLabels[activity.mode];
/** An Event's times as "10:00 AM–1:00 PM", or All day; other activities have no times. */
export const timeText = (activity: ImportActivity) => activity.mode !== "event" ? "—" : activity.startTime && activity.endTime ? formatCsvTimeRange(activity.startTime, activity.endTime) : "All day";
export const teamText = (activity: ImportActivity) => activity.team ?? "—";
export const labelsText = (activity: ImportActivity) => activity.labels.length ? activity.labels.join("; ") : "—";
const sentence = (error: string) => `${error[0]!.toLowerCase()}${error.slice(1)}${/[.!?]$/.test(error) ? "" : "."}`;
const changeNames: Record<ImportChange, string> = { title: "title", time: "time", labels: "labels", location: "location", description: "description", impact: "impact relevant" };

/** "Will publish to Discord and Google Calendar", "Will update on Discord", or both, after an Event's title. */
export function publicationNoteText(publication: ActivityImportRow["publication"]) {
  if (!publication) return "";
  const names = (providers: PublicationProvider[]) => listText(publicationProviderOrder.filter((provider) => providers.includes(provider)).map((provider) => publicationProviderLabels[provider]));
  const parts = [publication.publish.length && `publish to ${names(publication.publish)}`, publication.update.length && `update on ${names(publication.update)}`].filter(Boolean);
  return parts.length ? `Will ${parts.join(" and ")}` : "";
}

/** The Issues cell: the row's problem, or how it matches an existing activity, or a repeated daylight-saving time. */
export function issueText(row: ActivityImportRow) {
  if (row.error) return row.error;
  const parts = [row.existing && `Matches existing · ${row.changes?.length ? `changes ${listText(row.changes.map((change) => changeNames[change]))}` : "no changes"}`, row.warnings?.length && "Repeated time: first one used"].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

export const problemHeading = (count: number) => `${count === 1 ? "1 row has" : `${count} rows have`} a problem and won't be imported.`;
export const problemText = (row: ActivityImportRow) => `Row ${row.rowNumber}${row.activity?.title ?? row.title ? `, ${row.activity?.title ?? row.title}` : ""}: ${sentence(row.error!)}`;
export const warningText = (row: ActivityImportRow, warning: string) => `Row ${row.rowNumber}${row.activity ? `, ${row.activity.title}` : ""}: ${sentence(warning)}`;

/** "2 to add, 1 to update, 1 with a problem." */
export function summaryText(summary: ActivityImportSummary) {
  return `${[summary.add && `${summary.add} to add`, summary.update && `${summary.update} to update`, summary.skip && `${summary.skip} skipped as a duplicate`, summary.error && `${summary.error} with a problem`].filter(Boolean).join(", ")}.`;
}

/** "Import 3 activities (skip 1 row with a problem)". */
export const importButtonText = (summary: ActivityImportSummary) => `Import ${plural(summary.add + summary.update, "activity", "activities")}${summary.error ? ` (skip ${plural(summary.error, "row", "rows")} with a problem)` : ""}`;

/** A row that matches an existing activity and has no problem gets a Skip/Update choice; a problem row shows Error. */
export const choosable = (row: ActivityImportRow) => Boolean(row.existing) && row.action !== "error";

/** The Matching rows switch: Skip all, Update all, or Mixed when rows differ. Undefined when no row matches. */
export function bulkChoice(rows: ActivityImportRow[], choices: Record<string, ImportChoice>): ImportChoice | "mixed" | undefined {
  const matched = rows.filter(choosable); const updates = matched.filter((row) => choices[row.rowNumber] === "update").length;
  return !matched.length ? undefined : updates === matched.length ? "update" : updates === 0 ? "skip" : "mixed";
}

/** The workspace notice after an import. */
export function importedText(result: ActivityImportResult) {
  const { added = 0, updated = 0 } = result.imported ?? {};
  return `${plural(added + updated, "activity", "activities")} imported: ${added} added, ${updated} updated.${result.publication?.queued ? " Event publication is queued and delivered a few at a time every five minutes." : ""}`;
}

export const importHelpText = (timeZone: string) => `Header names are matched loosely, so "Start time", "start_time" and "startTime" all work. Dates use MM/DD/YYYY, such as 11/14/2026; 2026-11-14 also works. Type is Event, Team support or Other service. Event times are in the installation's time zone (${timeZone}), in five-minute steps; leave both blank for an all-day Event. A supported team is its team number or exact name. Separate labels with semicolons. Each row is one activity; a row with the same date, type, title and team as an existing activity matches it.`;
