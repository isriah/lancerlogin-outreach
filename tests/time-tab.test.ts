// Tab order inside the event time fields: which Tab is ignored because typing had already moved to the next segment,
// and the label picker's condensed layout. Core's browser specs check the same order in a real browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { timeTabKey, timeTabStart, type TimeSegment, type TimeTabKey } from "../src/dashboard/outreach-time-tab.ts";

const key = (name: string): TimeTabKey => name === "Shift+Tab" ? { key: "Tab", shiftKey: true } : { key: name };
// Press keys in a field and report the segment the field is on after each one, as the browser would have it.
function press(keys: string[], { twelveHour = true, from = "hour" as TimeSegment } = {}) {
  let state = timeTabStart(from); const ignored: number[] = []; const segments: TimeSegment[] = [];
  keys.forEach((name, index) => {
    const result = timeTabKey(state, key(name), twelveHour); state = result.state; if (result.ignore) ignored.push(index);
    segments.push(state.segment === "after-minute" ? twelveHour ? "period" : "minute" : state.segment);
  });
  return { ignored, segments };
}

test("Tab after a typed hour stays on the minutes, and after typed minutes stays on AM/PM", () => {
  // 9 completes the hour and 30 the minutes, so the field has already moved on when each Tab arrives.
  const typed = press(["9", "Tab", "3", "0", "Tab", "p", "Tab"]);
  assert.deepEqual(typed.segments, ["minute", "minute", "minute", "period", "period", "period", "picker"]);
  assert.deepEqual(typed.ignored, [1, 4]);
  // Two-digit hours move on at the second digit.
  assert.deepEqual(press(["1", "1", "Tab", "1", "5", "Tab", "a", "Tab"]).ignored, [2, 5]);
  assert.deepEqual(press(["0", "9", "Tab"]).segments, ["hour", "minute", "minute"]);
});

test("Tab moves on when the typed digit left the segment open", () => {
  // 1 could become 10, 11 or 12 and 3 could become 30 to 39, so the field waits and Tab does the moving.
  const typed = press(["1", "Tab", "3", "Tab", "Tab"]);
  assert.deepEqual(typed.segments, ["hour", "minute", "minute", "period", "picker"]);
  assert.deepEqual(typed.ignored, []);
});

test("only the Tab directly after the completing digit is ignored", () => {
  assert.deepEqual(press(["9", "Tab", "Tab", "Tab"]).segments, ["minute", "minute", "period", "picker"]);
  assert.deepEqual(press(["9", "Tab", "Tab", "Tab"]).ignored, [1]);
  // Another key in between means the Tab is a deliberate one.
  for (const between of ["ArrowUp", "ArrowDown", "Backspace", "ArrowRight", "a"]) assert.deepEqual(press(["9", between, "Tab"]).ignored, [], between);
  // Holding Shift for a later Shift+Tab is not a key in between, and Shift+Tab itself is never ignored.
  assert.deepEqual(press(["9", "Shift", "Tab"]).ignored, [2]);
  assert.deepEqual(press(["9", "Shift+Tab"]), { ignored: [], segments: ["minute", "hour"] });
  assert.deepEqual(press(["9", "Tab", "3", "0", "Shift+Tab", "Shift+Tab"]).segments.slice(-3), ["period", "minute", "hour"]);
  // Shortcuts are left alone.
  assert.equal(timeTabKey(timeTabStart("hour"), { key: "9", ctrlKey: true }, true).state.segment, "hour");
});

test("Tab and Shift+Tab without typing walk hour, minutes, AM/PM and the picker button in order", () => {
  assert.deepEqual(press(["Tab", "Tab", "Tab"]), { ignored: [], segments: ["minute", "period", "picker"] });
  assert.deepEqual(press(["Shift+Tab", "Shift+Tab", "Shift+Tab"], { from: "picker" }), { ignored: [], segments: ["period", "minute", "hour"] });
  // The arrow keys stop at AM/PM and never reach the picker button.
  assert.deepEqual(press(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"]).segments, ["minute", "period", "period", "minute"]);
});

test("a 24-hour clock has no AM/PM segment to move on to", () => {
  // 2 waits for a second digit on a 24-hour clock and 3 does not; the minutes are the last segment.
  const typed = press(["2", "1", "Tab", "3", "0", "Tab"], { twelveHour: false });
  assert.deepEqual(typed.segments, ["hour", "minute", "minute", "minute", "minute", "picker"]);
  assert.deepEqual(typed.ignored, [2]);
  assert.deepEqual(press(["3", "Tab"], { twelveHour: false }).ignored, [1]);
  assert.deepEqual(press(["2", "Tab"], { twelveHour: false }), { ignored: [], segments: ["hour", "minute"] });
  assert.deepEqual(press(["2", "Tab"]).ignored, [1]);
  assert.deepEqual(press(["Tab", "Tab"], { twelveHour: false }).segments, ["minute", "picker"]);
});

test("after a click, only digits that complete an hour and minutes alike are followed", () => {
  // A click can land on any segment. 6 to 9 and any second digit complete both the hour and the minutes; 2 to 5 do not.
  assert.deepEqual(press(["7", "Tab"], { from: "unknown" }).ignored, [1]);
  assert.deepEqual(press(["4", "5", "Tab"], { from: "unknown" }).ignored, [2]);
  assert.deepEqual(press(["4", "Tab"], { from: "unknown" }).ignored, []);
  assert.deepEqual(press(["1", "Tab"], { from: "unknown" }).ignored, []);
});

test("the event time fields use the Tab handling and stay native time inputs with a labelled picker", async () => {
  const source = await readFile(new URL("../src/dashboard/outreach-activity-publication.tsx", import.meta.url), "utf8");
  assert.match(source, /const tab = useTimeFieldTab\(\)/);
  assert.match(source, /<label>\{label\}<input className="ui-control" type="time" step=\{300\}[^>]*\{\.\.\.tab\}/);
  assert.doesNotMatch(source, /tabIndex=\{?["']?[1-9]/);
});

test("the label picker wraps its choices into columns and keeps full-height rows", async () => {
  const [workspace, styles] = await Promise.all(["../src/dashboard/outreach-workspace.tsx", "../src/outreach.css"].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.match(workspace, /<fieldset className="outreach-fieldset outreach-label-picker"><legend>Outreach labels \(optional\)<\/legend>/);
  const rule = /\.outreach-label-picker \{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(rule, /grid-template-columns: repeat\(auto-fill,minmax\(9rem,1fr\)\)/);
  assert.match(rule, /gap: 0 var\(--space-3\)/);
  // Rows keep Core's .checkbox-field height, the 44px touch target; nothing here may shrink it.
  assert.doesNotMatch(styles, /\.outreach-label-picker[^{]*\{[^}]*(?:min-height|height|font-size)/);
});
