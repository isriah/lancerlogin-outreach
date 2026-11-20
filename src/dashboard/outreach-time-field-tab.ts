// Wires the Tab handling in outreach-time-tab.ts to a native time input.
import type React from "react";
import { useRef } from "react";
import { timeTabKey, timeTabStart, type TimeSegment, type TimeTabState } from "./outreach-time-tab.ts";

// Time fields follow the operating system's clock setting on some systems, which the page cannot read. A field that
// was empty and has had only its hour and minutes typed shows which clock it uses: it has a value on a 24-hour clock
// and none yet on a 12-hour clock, where AM/PM is still missing. What one field shows holds for every field.
let observedTwelveHour: boolean | undefined;
function guessedTwelveHour(): boolean {
  try { return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true; } catch { return true; }
}

/** Props for a native `<input type="time">` that keep Tab on the segment typing has just moved to. */
export function useTimeFieldTab() {
  const state = useRef<TimeTabState>(timeTabStart()); const pointer = useRef(false);
  // Whether the field was empty when focus arrived, and has since seen only digits and Tab, in known segments.
  const conclusive = useRef(false); const typedInto = useRef({ hour: false, minute: false });
  const begin = (segment: TimeSegment, empty: boolean) => { state.current = timeTabStart(segment); conclusive.current = empty && segment === "hour"; typedInto.current = { hour: false, minute: false }; };
  return {
    onPointerDown: () => { pointer.current = true; begin("unknown", false); },
    onFocus: (event: React.FocusEvent<HTMLInputElement>) => {
      // Focus that arrives by keyboard from an earlier control starts on the hour. A click chooses its own segment.
      const from = event.relatedTarget; const forward = !pointer.current && from instanceof Node && Boolean(from.compareDocumentPosition(event.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING);
      pointer.current = false; begin(forward ? "hour" : "unknown", event.currentTarget.value === "");
    },
    onBlur: () => { pointer.current = false; begin("unknown", false); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (conclusive.current && typedInto.current.hour && typedInto.current.minute) observedTwelveHour = event.currentTarget.value === "";
      const digit = /^[0-9]$/.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (digit && state.current.segment === "hour") typedInto.current.hour = true;
      else if (digit && state.current.segment === "minute") typedInto.current.minute = true;
      else if (!["Tab", "Shift"].includes(event.key)) conclusive.current = false;
      const result = timeTabKey(state.current, event, observedTwelveHour ?? guessedTwelveHour()); state.current = result.state;
      if (result.ignore) event.preventDefault();
    },
  };
}
