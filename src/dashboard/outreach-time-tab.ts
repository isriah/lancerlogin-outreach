// Tab order inside a native time field.
//
// A browser's time field is one input with an hour, a minute and (on a 12-hour clock) an AM/PM segment, then a picker
// button. Typing a digit that completes a segment already moves to the next one: 9 in the hour, or the second digit of
// any segment. A Tab pressed straight after that digit, meant as "next segment", would then skip a segment: 9, Tab
// lands on AM/PM instead of the minutes, and 30, Tab lands on the picker button instead of AM/PM. The page cannot see
// which segment has focus, so this follows the keys typed into the field and reports the one Tab to ignore: a forward
// Tab pressed directly after a digit that moved on by itself. Every other key keeps the browser's own behaviour.
// This file has no React import, so the plugin's own tests can load it; useTimeFieldTab wires it to a field.

/** "after-minute" is where typing leaves the minutes: AM/PM on a 12-hour clock, still the minutes on a 24-hour one. */
export type TimeSegment = "hour" | "minute" | "after-minute" | "period" | "picker" | "unknown";
export type TimeTabState = { segment: TimeSegment; typed: string; advanced: boolean };
export type TimeTabKey = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };

/** Where a field starts: its hour when focus arrives from before it, otherwise wherever the browser or pointer put it. */
export const timeTabStart = (segment: TimeSegment = "unknown"): TimeTabState => ({ segment, typed: "", advanced: false });

const order = (twelveHour: boolean): TimeSegment[] => twelveHour ? ["hour", "minute", "period", "picker"] : ["hour", "minute", "picker"];
const moved = (segment: TimeSegment, by: number, twelveHour: boolean, last: TimeSegment): TimeSegment => {
  const segments = order(twelveHour); const index = segments.indexOf(segment);
  if (index < 0) return "unknown";
  return segments[Math.min(Math.max(index + by, 0), segments.indexOf(last))]!;
};

// A segment moves on once it holds two digits, or one digit no second digit could follow (2 to 9 for a 12-hour hour,
// 3 to 9 for a 24-hour hour, 6 to 9 for minutes).
function typeDigit(state: TimeTabState, digit: string, twelveHour: boolean): TimeTabState {
  const typed = state.typed + digit; const full = typed.length >= 2;
  if (state.segment === "hour") return full || Number(typed) * 10 > (twelveHour ? 12 : 23) ? { segment: "minute", typed: "", advanced: true } : { ...state, typed, advanced: false };
  // Whether the minutes move on to AM/PM is settled by the next key, when the caller knows more about the field.
  if (state.segment === "minute") return full || Number(typed) * 10 > 59 ? { segment: "after-minute", typed: "", advanced: false } : { ...state, typed, advanced: false };
  // After a click the segment is unknown. Two digits, or 6 to 9, move on from the hour and the minutes alike.
  if (state.segment === "unknown") return full || Number(digit) >= 6 ? { segment: "unknown", typed: "", advanced: true } : { ...state, typed, advanced: false };
  return { ...state, typed: "", advanced: false };
}

/** The state after one key pressed in the field, and whether that key is the Tab to ignore. `twelveHour` says whether the field has an AM/PM segment. */
export function timeTabKey(before: TimeTabState, event: TimeTabKey, twelveHour: boolean): { state: TimeTabState; ignore: boolean } {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock"].includes(event.key)) return { state: before, ignore: false };
  const state: TimeTabState = before.segment === "after-minute" ? { segment: twelveHour ? "period" : "minute", typed: "", advanced: twelveHour } : before;
  const settled = (segment: TimeSegment): TimeTabState => ({ segment, typed: "", advanced: false });
  if (event.altKey || event.ctrlKey || event.metaKey) return { state: settled(state.segment), ignore: false };
  if (event.key === "Tab") {
    if (!event.shiftKey && state.advanced) return { state: settled(state.segment), ignore: true };
    return { state: settled(moved(state.segment, event.shiftKey ? -1 : 1, twelveHour, "picker")), ignore: false };
  }
  if (/^[0-9]$/.test(event.key)) return { state: typeDigit(state, event.key, twelveHour), ignore: false };
  // The arrow keys move between the segments but never onto the picker button.
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") return { state: settled(state.segment === "picker" ? "picker" : moved(state.segment, event.key === "ArrowLeft" ? -1 : 1, twelveHour, twelveHour ? "period" : "minute")), ignore: false };
  return { state: settled(state.segment), ignore: false };
}
