import { addCalendarDays, instantToCivil, resolveCivilTime } from "@lancerlogin/module-sdk";

/** First valid instant of a civil day, including time zones with midnight clock changes. */
export function outreachDayStartsAt(date: string, timeZone: string): number {
  for (let minute = 0; minute < 1440; minute++) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const candidates = resolveCivilTime({ date, time, timeZone });
    if (candidates.length) return candidates[0]!.epochMilliseconds;
  }
  throw new Error("This calendar date does not exist in the installation time zone");
}

export function outreachReportingState(activity: { serviceDate: string; archived: boolean }, settings: { reportingDays: number; timeZone: string },
  windows: Array<{ startsMs: number; expiresMs: number; revoked: boolean }>, now: number) {
  const future = activity.serviceDate > instantToCivil(now, settings.timeZone).date;
  const standardClosesMs = outreachDayStartsAt(addCalendarDays(activity.serviceDate, settings.reportingDays), settings.timeZone);
  const closesMs = Math.max(standardClosesMs, ...windows.filter(item => !item.revoked && item.startsMs <= now && item.expiresMs > now).map(item => item.expiresMs));
  const open = !activity.archived && !future && closesMs > now;
  return { open, closesMs, canReopen: !activity.archived && !future && closesMs - now < 86_400_000 };
}
