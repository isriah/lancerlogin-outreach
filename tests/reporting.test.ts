// Reporting windows on installation civil days, including days when clocks change. These mirror both tests in LancerLogin
// Core's tests-ts/outreach/reporting.ts. Here the SDK's civil time is this plugin's test stand-in
// (tests/helpers/module-sdk-civil-time-stub.mjs), so they also check that stand-in against Core's expectations.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/sdk.mjs";

const { outreachDayStartsAt, outreachReportingState } = await import("../src/shared/outreach-reporting.ts");

test("reporting uses installation civil-day boundaries and the strict 24-hour reopening threshold", () => {
  const activity = { serviceDate: "2026-09-14", archived: false }; const settings = { reportingDays: 30, timeZone: "America/New_York" };
  const close = Date.parse("2026-10-14T04:00:00Z");
  assert.deepEqual(outreachReportingState(activity, settings, [], close - 86_400_000), { open: true, closesMs: close, canReopen: false });
  assert.equal(outreachReportingState(activity, settings, [], close - 86_400_000 + 1).canReopen, true);
  assert.equal(outreachReportingState(activity, settings, [], close).open, false);
  assert.equal(outreachReportingState({ ...activity, archived: true }, settings, [], close).canReopen, false);
  assert.equal(outreachReportingState({ serviceDate: "2026-10-15", archived: false }, settings, [], close).canReopen, false);
  const window = { startsMs: close, expiresMs: close + 86_400_000, revoked: false };
  assert.equal(outreachReportingState(activity, settings, [window], close).open, true);
  assert.equal(outreachReportingState(activity, settings, [{ ...window, revoked: true }], close).open, false);
});

test("all-day boundaries follow 23-hour and 25-hour days and midnight clock changes", () => {
  assert.equal(outreachDayStartsAt("2026-03-09", "America/New_York") - outreachDayStartsAt("2026-03-08", "America/New_York"), 23 * 3_600_000);
  assert.equal(outreachDayStartsAt("2026-11-02", "America/New_York") - outreachDayStartsAt("2026-11-01", "America/New_York"), 25 * 3_600_000);
  assert.equal(outreachDayStartsAt("2018-11-04", "America/Sao_Paulo"), Date.parse("2018-11-04T03:00:00Z"));
});
