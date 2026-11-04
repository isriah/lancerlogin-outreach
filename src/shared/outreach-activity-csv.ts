// Outreach activity CSV columns and row rules, shared by the dashboard preview and the Worker, which checks every row again.
// The rules are those of a saved activity (write() in src/api/outreach-catalogs.ts); catalog names (supported teams and
// labels) and the installation time zone are resolved by the Worker.
import { csvFieldFor, csvText, delimiterFor, formatCsvDate, formatCsvTime, mapCsvHeader, parseCsvDate, parseCsvTime, parseDelimited } from "@lancerlogin/module-sdk";

export type OutreachActivityCsvField = "title" | "date" | "type" | "startTime" | "endTime" | "team" | "labels" | "location" | "description" | "impact";
export type OutreachActivityCsvValues = Partial<Record<OutreachActivityCsvField, string>>;
/** One data row: its line number in the file and the cells of recognised columns only. A missing key means the column is absent. */
export type OutreachActivityCsvRow = { rowNumber: number; values: OutreachActivityCsvValues };
export type ParsedOutreachActivityCsv = { hasHeader: boolean; recognised: OutreachActivityCsvField[]; ignored: string[]; errors: string[]; rows: OutreachActivityCsvRow[] };
export type OutreachActivityCsvMode = "event" | "team" | "task";
/**
 * A row's activity before catalog names and the time zone are resolved. Optional fields are undefined when their column is
 * absent, so an update keeps the current value; blank cells are no labels, no location or description, and impact relevant.
 * `startLocal` and `endLocal` are undefined when both columns are absent, and null for an all-day Event.
 */
export type OutreachActivityCsvActivity = { title: string; serviceDate: string; mode: OutreachActivityCsvMode; startLocal?: string | null; endLocal?: string | null; teamRef: string | null; labelNames?: string[]; location?: string; description?: string; impactRelevant?: boolean };

export const outreachActivityCsvFields: OutreachActivityCsvField[] = ["title", "date", "type", "startTime", "endTime", "team", "labels", "location", "description", "impact"];
export const outreachActivityCsvFieldLabels: Record<OutreachActivityCsvField, string> = { title: "Title", date: "Date", type: "Type", startTime: "Start time", endTime: "End time", team: "Supported team", labels: "Labels", location: "Location", description: "Description", impact: "Impact relevant" };
export const outreachActivityCsvFieldHelp: { field: OutreachActivityCsvField; label: string; required: string; example: string }[] = [
  { field: "title", label: outreachActivityCsvFieldLabels.title, required: "Required", example: "Test Library Demo" },
  { field: "date", label: outreachActivityCsvFieldLabels.date, required: "Required", example: "11/14/2026" },
  { field: "type", label: outreachActivityCsvFieldLabels.type, required: "Optional, Event when blank", example: "Team support" },
  { field: "startTime", label: outreachActivityCsvFieldLabels.startTime, required: "Events only, with End time", example: "10:00" },
  { field: "endTime", label: outreachActivityCsvFieldLabels.endTime, required: "Events only, with Start time", example: "1:00 PM" },
  { field: "team", label: outreachActivityCsvFieldLabels.team, required: "Required for Team support", example: "9999" },
  { field: "labels", label: outreachActivityCsvFieldLabels.labels, required: "Optional", example: "Test Label A;Test Label B" },
  { field: "location", label: outreachActivityCsvFieldLabels.location, required: "Optional", example: "Test Public Library" },
  { field: "description", label: outreachActivityCsvFieldLabels.description, required: "Optional", example: "" },
  { field: "impact", label: outreachActivityCsvFieldLabels.impact, required: "Optional, yes when blank", example: "no" },
];
export const outreachActivityCsvRowLimit = 200;
/** Longest cell the Worker reads; longer cells are refused before any parsing. Descriptions take up to 4,000 characters. */
export const outreachActivityCsvCellLimit = 5_000;
export const outreachActivityCsvTemplate = csvText([
  outreachActivityCsvFields.map((field) => outreachActivityCsvFieldLabels[field]),
  ["Test Library Demo", "11/14/2026", "Event", "10:00", "13:00", "", "Test Label A", "Test Public Library", "Synthetic example", "yes"],
  ["Test Mentoring Visit", "11/18/2026", "Team support", "", "", "9999", "", "", "", "yes"],
  ["Test Park Cleanup", "11/21/2026", "Other service", "", "", "", "", "Test Park", "", "no"],
]);

const aliases: Record<string, OutreachActivityCsvField> = {
  title: "title", activity: "title", activitytitle: "title", event: "title", name: "title",
  date: "date", servicedate: "date", eventdate: "date",
  type: "type", activitytype: "type", mode: "type",
  starttime: "startTime", start: "startTime",
  endtime: "endTime", end: "endTime",
  supportedteam: "team", team: "team", teamnumber: "team",
  labels: "labels", outreachlabels: "labels",
  location: "location", place: "location", venue: "location",
  description: "description", details: "description", notes: "description",
  impactrelevant: "impact", impact: "impact", countstowardimpact: "impact",
};
const headerSpec = { aliases, labels: outreachActivityCsvFieldLabels, required: [["title"], ["date"]] as const };

export const outreachActivityCsvFieldFor = (header: string) => csvFieldFor(aliases, header);

/** Parses pasted or uploaded activity text. Comma-separated text needs a header; tab-separated rows may omit it when they follow the template order. */
export function parseOutreachActivityCsvText(text: string): ParsedOutreachActivityCsv {
  const parsed = parseDelimited(text); const first = parsed[0] ?? [];
  const hasHeader = delimiterFor(text) === "," || first.some((value) => Boolean(outreachActivityCsvFieldFor(value)));
  const errors: string[] = []; let columns: (OutreachActivityCsvField | undefined)[] = outreachActivityCsvFields; let recognised: OutreachActivityCsvField[] = []; let ignored: string[] = [];
  if (hasHeader) { const mapping = mapCsvHeader(parsed.shift() ?? [], headerSpec); columns = mapping.columns; recognised = mapping.recognised; ignored = mapping.ignored; errors.push(...mapping.errors); }
  const rowOffset = hasHeader ? 2 : 1;
  const width = hasHeader ? columns.length : Math.min(outreachActivityCsvFields.length, Math.max(2, ...parsed.map((row) => row.length)));
  if (!hasHeader) { columns = outreachActivityCsvFields.slice(0, width); recognised = [...columns] as OutreachActivityCsvField[]; }
  const rows = parsed.map((row, index) => {
    if (!hasHeader && (row.length < 2 || row.length > outreachActivityCsvFields.length)) errors.push(`Row ${index + rowOffset} needs two to ten tab-separated columns in this order: ${outreachActivityCsvFields.map((field) => outreachActivityCsvFieldLabels[field]).join(", ")}.`);
    const values: OutreachActivityCsvValues = {};
    columns.forEach((field, column) => { if (field) values[field] = row[column] ?? ""; });
    return { rowNumber: index + rowOffset, values };
  });
  return { hasHeader, recognised, ignored, errors, rows };
}

const types: Record<string, OutreachActivityCsvMode> = { event: "event", events: "event", teamsupport: "team", team: "team", otherservice: "task", other: "task", service: "task", task: "task" };
const yes = new Set(["yes", "y", "true", "1"]); const no = new Set(["no", "n", "false", "0"]);
const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const outreachActivityTypeLabels: Record<OutreachActivityCsvMode, string> = { event: "Event", team: "Team support", task: "Other service" };

/** Checks one row's values as a saved activity is checked. Returns every problem found. */
export function resolveOutreachActivityCsvRow(values: OutreachActivityCsvValues): { activity: OutreachActivityCsvActivity; errors?: undefined } | { activity?: undefined; errors: string[] } {
  if (Object.values(values).some((value) => typeof value !== "string" || value.length > outreachActivityCsvCellLimit)) return { errors: [`Each cell must be text of at most ${outreachActivityCsvCellLimit.toLocaleString("en-US")} characters`] };
  const errors: string[] = [];
  const title = (values.title ?? "").trim();
  if (!title) errors.push("Add a title"); else if (title.length > 150) errors.push("Title must be 150 characters or fewer");
  const date = parseCsvDate(values.date ?? "");
  if (!date.ok) errors.push(date.error);
  const typeText = (values.type ?? "").trim(); const mode = typeText ? types[typeText.toLowerCase().replace(/[\s_-]+/g, "")] : "event";
  if (!mode) errors.push(`Type must be Event, Team support or Other service, not ${typeText}`);
  const startText = values.startTime?.trim() ?? ""; const endText = values.endTime?.trim() ?? "";
  let startLocal: string | null | undefined = values.startTime === undefined && values.endTime === undefined ? undefined : null; let endLocal: string | null | undefined = startLocal;
  if (mode && mode !== "event" && (startText || endText)) errors.push("Only Event activities take a start and end time");
  else if (startText || endText) {
    if (!startText || !endText) errors.push("Add both a start time and an end time, or leave both blank for an all-day Event");
    else {
      const start = parseCsvTime(startText); const end = parseCsvTime(endText);
      for (const value of [start, end]) if (!value.ok) errors.push(value.error);
      if (start.ok && end.ok) {
        if (clockMinutes(start.value) % 5 || clockMinutes(end.value) % 5) errors.push("Choose start and end times in five-minute steps, such as 10:05");
        else if (clockMinutes(end.value) <= clockMinutes(start.value)) errors.push("End time must be after the start time on the same day");
        startLocal = start.value; endLocal = end.value;
      }
    }
  }
  const teamRef = values.team?.trim() || null;
  if (mode === "team" && !teamRef) errors.push("Team support needs a Supported team");
  if (mode && mode !== "team" && teamRef) errors.push("Only Team support activities take a supported team");
  const names = values.labels === undefined ? undefined : values.labels.split(";").map((name) => name.trim()).filter(Boolean);
  const labelNames = names?.filter((name, index) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index);
  if ((labelNames?.length ?? 0) > 100) errors.push("Choose at most 100 Outreach labels");
  if (labelNames?.some((name) => name.length > 100)) errors.push("Outreach label names are 100 characters or fewer");
  const location = values.location?.trim(); const description = values.description?.trim();
  if (location && location.length > 300) errors.push("Location must be 300 characters or fewer");
  if (description && description.length > 4_000) errors.push("Description must be 4,000 characters or fewer");
  const impact = values.impact?.trim().toLowerCase();
  const impactRelevant = impact === undefined ? undefined : !impact || yes.has(impact) ? true : no.has(impact) ? false : undefined;
  if (impact && impactRelevant === undefined) errors.push(`Impact relevant must be yes or no, not ${values.impact!.trim()}`);
  if (errors.length || !date.ok || !mode) return { errors };
  return { activity: { title, serviceDate: date.value, mode, startLocal, endLocal, teamRef: mode === "team" ? teamRef : null, labelNames, location, description, impactRelevant } };
}

const pad = (value: number) => String(value).padStart(2, "0");
const dayMs = 86_400_000; const spanMs = 7 * dayMs;
/**
 * Wall-clock conversion for one time zone, as civil-time's resolveCivilTime does, but with offsets memoised per UTC week and
 * transitions found once by binary search (Core's meeting import clock), so a 200-row import formats about a hundred
 * instants instead of over a thousand, within the Workers Free plan's 10 ms CPU. `candidates` lists a local time's instants:
 * none when clocks skip it, two when they repeat it. Assumes at most one offset change per week, on whole seconds.
 */
export type OutreachCsvClock = { timeZone: string; candidates: (date: string, time: string) => number[]; dayStart: (date: string) => number; civil: (epoch: number) => { date: string; time: string } };
const clocks = new Map<string, OutreachCsvClock>();
/** One clock per zone for the isolate's life (zone rules do not change while it runs), so each preview reuses the sampled offsets. */
export function outreachCsvClock(timeZone: string): OutreachCsvClock {
  const cached = clocks.get(timeZone); if (cached) return cached;
  const clock = createClock(timeZone); if (clocks.size >= 4) clocks.delete(clocks.keys().next().value!); clocks.set(timeZone, clock);
  return clock;
}
function createClock(timeZone: string): OutreachCsvClock {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new Error(`${timeZone} is not a supported time zone`); }
  const sampled = new Map<number, number>(); const transitions = new Map<number, number>();
  const measure = (epoch: number) => { const parts = Object.fromEntries(format.formatToParts(epoch).map((part) => [part.type, part.value])); return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(epoch / 1000) * 1000; };
  const spanOffset = (span: number) => { let value = sampled.get(span); if (value === undefined) { value = measure(span * spanMs); sampled.set(span, value); } return value; };
  const offsetAt = (epoch: number) => {
    const span = Math.floor(epoch / spanMs); const before = spanOffset(span); const after = spanOffset(span + 1);
    if (before === after) return before;
    let change = transitions.get(span);
    if (change === undefined) { let low = span * spanMs; let high = (span + 1) * spanMs; while (high - low > 1000) { const middle = low + Math.floor((high - low) / 2000) * 1000; if (measure(middle) === before) low = middle; else high = middle; } change = high; transitions.set(span, change); }
    return epoch < change ? before : after;
  };
  const candidates = (date: string, time: string) => {
    const nominal = Date.parse(`${date}T${time}:00.000Z`);
    return [...new Set([offsetAt(nominal - dayMs), offsetAt(nominal + dayMs)])].map((offset) => nominal - offset).filter((epoch) => epoch + offsetAt(epoch) === nominal).sort((left, right) => left - right);
  };
  // The first valid instant of a civil day, as outreachDayStartsAt finds it, including zones whose clocks change at midnight.
  const dayStart = (date: string) => {
    for (let minute = 0; minute < 1440; minute += 1) { const found = candidates(date, `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`)[0]; if (found !== undefined) return found; }
    throw new Error("This calendar date does not exist in the installation time zone");
  };
  const civil = (epoch: number) => { const local = new Date(epoch + offsetAt(epoch)); return { date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`, time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}` }; };
  return { timeZone, candidates, dayStart, civil };
}

export type OutreachEventOccurrence = "earlier" | "later" | null;
/**
 * Places an Event's times in the installation time zone. A time that clocks skip is an error; a time they repeat uses the
 * earlier occurrence, with a warning, as the activity editor's "earlier" choice does, unless `occurrences` already choose
 * one (an update that keeps an Event's stored times keeps its choices). An all-day Event spans its civil day.
 */
export function placeOutreachEventTimes(clock: OutreachCsvClock, serviceDate: string, startLocal: string | null, endLocal: string | null, occurrences: [OutreachEventOccurrence, OutreachEventOccurrence] = [null, null]): { error: string } | { error?: undefined; startOccurrence: OutreachEventOccurrence; endOccurrence: OutreachEventOccurrence; startMs: number; endMs: number; warnings: string[] } {
  if (!startLocal || !endLocal) {
    const next = new Date(Date.parse(`${serviceDate}T00:00:00.000Z`) + dayMs).toISOString().slice(0, 10);
    return { startOccurrence: null, endOccurrence: null, startMs: clock.dayStart(serviceDate), endMs: clock.dayStart(next), warnings: [] };
  }
  const warnings: string[] = []; const chosen: { epoch: number; occurrence: OutreachEventOccurrence }[] = [];
  for (const [index, time] of [startLocal, endLocal].entries()) {
    const found = clock.candidates(serviceDate, time); const when = `${formatCsvTime(time)} on ${formatCsvDate(serviceDate)} in ${clock.timeZone}`; const given = occurrences[index] ?? null;
    if (!found.length) return { error: `${when} doesn't exist: clocks move forward for daylight saving time. Choose another time` };
    if (found.length > 1 && !given) warnings.push(`${when} happens twice: clocks move back for daylight saving time. The first ${formatCsvTime(time)} is used`);
    chosen.push({ epoch: given === "later" ? found.at(-1)! : found[0]!, occurrence: given ?? (found.length > 1 ? "earlier" : null) });
  }
  if (chosen[1]!.epoch <= chosen[0]!.epoch) return { error: "End time must be after the start time on the same day" };
  return { startOccurrence: chosen[0]!.occurrence, endOccurrence: chosen[1]!.occurrence, startMs: chosen[0]!.epoch, endMs: chosen[1]!.epoch, warnings };
}
