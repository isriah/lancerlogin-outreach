// The civil-time helpers of @lancerlogin/module-sdk that Outreach logic uses at runtime, ported from LancerLogin Core's
// packages/shared/src/civil-time.ts so the plugin's own tests run without a Core checkout. Core provides the real SDK in a
// composed build.
export class CivilTimeError extends Error {
  constructor(code, message) { super(message); this.name = "CivilTimeError"; this.code = code; }
}

const dayMilliseconds = 86_400_000;
const formatters = new Map();

function utc(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute, second, millisecond);
  return result.getTime();
}

function dateEpoch(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CivilTimeError("invalid_date", "Provide a YYYY-MM-DD calendar date");
  const [year, month, day] = date.split("-").map(Number);
  const epoch = utc(year, month, day);
  if (new Date(epoch).toISOString().slice(0, 10) !== date) throw new CivilTimeError("invalid_date", "Calendar date does not exist");
  return epoch;
}

function timeMilliseconds(time) {
  const match = typeof time === "string" && /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) throw new CivilTimeError("invalid_time", "Provide HH:mm with optional seconds and milliseconds");
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3] ?? 0) * 1000 + Number((match[4] ?? "").padEnd(3, "0"));
}

function formatter(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.length || timeZone.length > 100) throw new CivilTimeError("invalid_timezone", "Provide a supported time zone");
  if (!formatters.has(timeZone)) {
    try { formatters.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", era: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })); }
    catch { throw new CivilTimeError("invalid_timezone", "Time zone is not supported by this runtime"); }
  }
  return formatters.get(timeZone);
}

function representedUtc(format, instant) {
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const year = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year);
  return utc(year, Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), new Date(instant).getUTCMilliseconds());
}

export function instantToCivil(epochMilliseconds, timeZone) {
  if (!Number.isSafeInteger(epochMilliseconds)) throw new CivilTimeError("invalid_instant", "Provide exact epoch milliseconds");
  const represented = representedUtc(formatter(timeZone), epochMilliseconds);
  const iso = new Date(represented).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 23), offsetSeconds: (represented - epochMilliseconds) / 1000 };
}

export function resolveCivilTime(input) {
  const nominal = dateEpoch(input.date) + timeMilliseconds(input.time);
  const format = formatter(input.timeZone);
  const offsets = new Set([-dayMilliseconds, dayMilliseconds].map((delta) => representedUtc(format, nominal + delta) - (nominal + delta)));
  return [...offsets].map((offset) => ({ epochMilliseconds: nominal - offset, offsetSeconds: offset / 1000 }))
    .filter((candidate) => representedUtc(format, candidate.epochMilliseconds) === nominal)
    .sort((left, right) => left.epochMilliseconds - right.epochMilliseconds);
}

export function selectCivilTime(input, occurrence) {
  if (occurrence !== undefined && occurrence !== "earlier" && occurrence !== "later") throw new CivilTimeError("invalid_occurrence", "Choose earlier or later");
  const candidates = resolveCivilTime(input);
  if (!candidates.length) throw new CivilTimeError("nonexistent_time", "This local time does not exist in the selected time zone");
  if (candidates.length > 1 && occurrence === undefined) throw new CivilTimeError("ambiguous_time", "Choose the earlier or later occurrence of this local time");
  return candidates[occurrence === "later" ? candidates.length - 1 : 0];
}

export function addCalendarDays(date, days) {
  const epoch = dateEpoch(date);
  if (!Number.isSafeInteger(days)) throw new CivilTimeError("invalid_date", "Calendar day increment must be an integer");
  return new Date(epoch + days * dayMilliseconds).toISOString().slice(0, 10);
}

export function elapsedIntegerMinutes(startMilliseconds, endMilliseconds) {
  const difference = endMilliseconds - startMilliseconds;
  if (difference <= 0) throw new CivilTimeError("non_positive_duration", "End must be after start");
  if (difference % 60_000 !== 0) throw new CivilTimeError("non_integral_duration", "Elapsed duration must be a whole number of minutes");
  return difference / 60_000;
}

// SDK 1.4.0 adds the CSV import kit to this entry.
export * from "./module-sdk-csv-import-stub.mjs";
