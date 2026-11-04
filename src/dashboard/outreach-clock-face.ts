/** Clock-face values and conversions for OutreachClock. outreach.css places the option at face index i at i * 30 degrees clockwise from the top. */
export type ClockPeriod = "AM" | "PM";

/** The angle outreach.css gives the option at this face index, in degrees clockwise from the top. */
export const clockAngle = (index: number) => index * 30;
/** The hour at a face index, like a real clock: 12 at the top (index 0), then 1 through 11 clockwise. */
export const clockHourAt = (index: number) => index % 12 || 12;
/** The minute at a face index in five-minute steps: 00 at the top (index 0), then 05 through 55 clockwise. */
export const clockMinuteAt = (index: number) => index % 12 * 5;

/** A 24-hour "HH:MM" value as a 12-hour hour (1 to 12), a minute rounded to the face's five-minute steps, and AM or PM. */
export const clockParts = (time: string) => { const match = /^(\d\d):(\d\d)/.exec(time); const sourceHour = match ? Number(match[1]) : 12; return { hour: sourceHour % 12 || 12, minute: match ? Math.round(Number(match[2]) / 5) * 5 % 60 : 0, period: sourceHour >= 12 ? "PM" as const : "AM" as const }; };
/** A 12-hour choice as a 24-hour "HH:MM" value. 12 AM is 00:00 and 12 PM is 12:00. */
export const clockValue = (hour: number, minute: number, period: ClockPeriod) => `${String(hour % 12 + (period === "PM" ? 12 : 0)).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
export const clockDisplay = (time: string) => { const current = clockParts(time); return `${current.hour}:${String(current.minute).padStart(2, "0")} ${current.period}`; };
