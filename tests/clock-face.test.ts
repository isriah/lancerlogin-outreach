// The Outreach time picker's clock face: the order and positions of its hours and minutes, and the 24-hour values they
// produce.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clockAngle, clockDisplay, clockHourAt, clockMinuteAt, clockParts, clockValue } from "../src/dashboard/outreach-clock-face.ts";

// The face OutreachClock renders: 12 options, index 0 first.
const face = (at: (index: number) => number) => Array.from({ length: 12 }, (_, index) => at(index));
const atAngle = (at: (index: number) => number, degrees: number) => face(at)[face(at).findIndex((_, index) => clockAngle(index) === degrees)];

test("the hour ring has 12 at the top and runs clockwise through 11", () => {
  assert.deepEqual(face(clockHourAt), [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual([0, 90, 180, 270].map((degrees) => atAngle(clockHourAt, degrees)), [12, 3, 6, 9]);
});

test("the minute ring has 00 at the top and runs clockwise in five-minute steps", () => {
  assert.deepEqual(face(clockMinuteAt), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual([0, 90, 180, 270].map((degrees) => atAngle(clockMinuteAt, degrees)), [0, 15, 30, 45]);
});

test("the clock renders its face from these values, and the stylesheet places index 0 at the top", async () => {
  const clock = await readFile(new URL("../src/dashboard/outreach-clock.tsx", import.meta.url), "utf8");
  assert.match(clock, /Array\.from\(\{ length: 12 \}, \(_, index\) => phase === "hour" \? clockHourAt\(index\) : clockMinuteAt\(index\)\)/);
  assert.match(clock, /"--clock-index": index/);
  const css = await readFile(new URL("../src/outreach.css", import.meta.url), "utf8");
  const option = css.split("\n").find((line) => line.includes("button.ui-button.outreach-clock-option"));
  assert.ok(option, "outreach.css styles the clock options");
  assert.match(option, /--clock-angle: calc\(var\(--clock-index\) \* 30deg\)/);
  // Rotate, move straight up, then undo the rotation: index 0 is at the top and later indexes go clockwise.
  assert.match(option, /transform: rotate\(var\(--clock-angle\)\) translateY\(-[\d.]+rem\) rotate\(calc\(-1 \* var\(--clock-angle\)\)\)/);
});

test("12 AM is midnight and 12 PM is noon", () => {
  assert.equal(clockValue(12, 0, "AM"), "00:00");
  assert.equal(clockValue(12, 30, "PM"), "12:30");
  assert.equal(clockValue(1, 5, "AM"), "01:05");
  assert.equal(clockValue(11, 55, "PM"), "23:55");
  assert.deepEqual(clockParts("00:00"), { hour: 12, minute: 0, period: "AM" });
  assert.deepEqual(clockParts("12:00"), { hour: 12, minute: 0, period: "PM" });
  assert.deepEqual(clockParts("13:07"), { hour: 1, minute: 5, period: "PM" });
  assert.equal(clockDisplay("00:15"), "12:15 AM");
  assert.equal(clockDisplay("12:45"), "12:45 PM");
});

test("every hour and minute on the face round-trips through its 24-hour value", () => {
  for (const period of ["AM", "PM"] as const) for (const hour of face(clockHourAt)) for (const minute of face(clockMinuteAt)) {
    assert.deepEqual(clockParts(clockValue(hour, minute, period)), { hour, minute, period });
  }
});
