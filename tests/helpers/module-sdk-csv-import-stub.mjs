// The CSV import kit of @lancerlogin/module-sdk (SDK 1.4.0) that Outreach uses, ported from LancerLogin Core's
// packages/shared/src/csv-import.ts so the plugin's own tests run without a Core checkout. Core provides the real SDK in a
// composed build.
const byteOrderMark = /^﻿/;
function normaliseCsvHeader(value) {
  return value.replace(byteOrderMark, "").toLowerCase().replace(/[\s_.-]+/g, "");
}
function csvFieldFor(aliases, header) {
  return Object.hasOwn(aliases, normaliseCsvHeader(header)) ? aliases[normaliseCsvHeader(header)] : void 0;
}
function delimiterFor(text) {
  return text.replace(byteOrderMark, "").split(/\r\n|\n|\r/, 1)[0].includes("	") ? "	" : ",";
}
function parseDelimited(text) {
  const delimiter = delimiterFor(text);
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length) rows[0][0] = rows[0][0].replace(byteOrderMark, "");
  return rows;
}
function mapCsvHeader(header, spec) {
  const columns = header.map((name) => csvFieldFor(spec.aliases, name));
  const firstColumn = /* @__PURE__ */ new Map();
  const errors = [];
  const ignored = [];
  header.forEach((name, index) => {
    const field = columns[index];
    if (!field) {
      if (name.trim()) ignored.push(name.trim());
      return;
    }
    const earlier = firstColumn.get(field);
    if (earlier !== void 0) {
      errors.push(`Columns "${earlier}" and "${name}" both match ${spec.labels[field]}. Keep only one.`);
      columns[index] = void 0;
    } else firstColumn.set(field, name);
  });
  for (const entry of spec.required) {
    const fields = typeof entry === "string" ? [entry] : entry;
    if (!fields.some((field) => firstColumn.has(field))) errors.push(`Missing column: ${fields.map((field) => spec.labels[field]).join(" or ")}`);
  }
  return { columns, recognised: columns.filter((field) => Boolean(field)), ignored, errors };
}
function csvText(rows) {
  return rows.map((row) => row.map((cell) => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",")).join("\n") + "\n";
}
const pad = (value) => String(value).padStart(2, "0");
const realDate = (year, month, day) => month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
const dateHelp = "Use MM/DD/YYYY, such as 11/10/2026, or 2026-11-10";
function parseCsvDate(input) {
  const value = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? { ok: true, value } : { ok: false, error: `${value} is not a real date` };
  if (!us) return { ok: false, error: value ? `${value} is not a date. ${dateHelp}` : `Add a date. ${dateHelp}` };
  const [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
  if (month > 12 && day <= 12) return { ok: false, error: `${value} looks like day/month. Use MM/DD/YYYY, such as ${pad(day)}/${pad(month)}/${year}` };
  if (!realDate(year, month, day)) return { ok: false, error: `${value} is not a real date` };
  return { ok: true, value: `${year}-${pad(month)}-${pad(day)}` };
}
function formatCsvDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}
const timeHelp = "Use 24-hour HH:MM, such as 18:00, or h:mm AM/PM, such as 6:00 PM";
function parseCsvTime(input) {
  const value = input.trim();
  const clock = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(value);
  const meridiem = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/.exec(value);
  if (clock && Number(clock[1]) <= 23 && Number(clock[2]) <= 59) return { ok: true, value: `${pad(Number(clock[1]))}:${clock[2]}` };
  if (meridiem && Number(meridiem[1]) >= 1 && Number(meridiem[1]) <= 12 && Number(meridiem[2] ?? 0) <= 59) {
    const hour = Number(meridiem[1]) % 12 + (meridiem[3].toLowerCase() === "p" ? 12 : 0);
    return { ok: true, value: `${pad(hour)}:${meridiem[2] ?? "00"}` };
  }
  return { ok: false, error: value ? `${value} is not a time. ${timeHelp}` : `Add a time. ${timeHelp}` };
}
function formatCsvTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}
function formatCsvTimeRange(start, end) {
  const [from, to] = [formatCsvTime(start), formatCsvTime(end)];
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -3)}\u2013${to}` : `${from}\u2013${to}`;
}
const durationHelp = "Use minutes (90), hours and minutes (1:30) or 1h30m";
function parseCsvDuration(input) {
  const value = input.trim().toLowerCase();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  const units = /^(?:(\d{1,2})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,4})\s*m(?:in(?:utes?|s)?)?)?$/.exec(value);
  const minutes = /^\d{1,4}$/.test(value) ? Number(value) : clock && Number(clock[2]) <= 59 ? Number(clock[1]) * 60 + Number(clock[2]) : units && (units[1] || units[2]) ? Number(units[1] ?? 0) * 60 + Number(units[2] ?? 0) : NaN;
  if (!Number.isFinite(minutes)) return { ok: false, error: value ? `${input.trim()} is not a duration. ${durationHelp}` : `Add a duration. ${durationHelp}` };
  if (minutes < 1 || minutes > 1440) return { ok: false, error: "Duration must be from 1 minute to 24 hours" };
  return { ok: true, value: minutes };
}
export {
  csvFieldFor,
  csvText,
  delimiterFor,
  formatCsvDate,
  formatCsvTime,
  formatCsvTimeRange,
  mapCsvHeader,
  normaliseCsvHeader,
  parseCsvDate,
  parseCsvDuration,
  parseCsvTime,
  parseDelimited
};
