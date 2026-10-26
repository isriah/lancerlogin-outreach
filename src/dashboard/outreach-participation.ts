export type OutreachParticipationEntry = {
  id: string; memberId: string; activityId: string; revision: number; status: "counted" | "void";
  memberName: string; externalId: string; serviceDate: string; startLocal: string; endLocal: string;
  startOccurrence?: "earlier" | "later" | null; endOccurrence?: "earlier" | "later" | null;
  durationMinutes: number; taskNotes: string; attribution: string; staffReason?: string | null;
};

export function groupOutreachParticipation<T extends OutreachParticipationEntry>(entries: T[]) {
  const members = new Map<string, { memberId: string; name: string; externalId: string; minutes: number; counted: number; entries: T[] }>();
  for (const entry of entries) {
    const member = members.get(entry.memberId) ?? { memberId: entry.memberId, name: entry.memberName, externalId: entry.externalId, minutes: 0, counted: 0, entries: [] };
    member.entries.push(entry);
    if (entry.status === "counted") { member.minutes += entry.durationMinutes; member.counted += 1; }
    members.set(entry.memberId, member);
  }
  return [...members.values()].filter(member => member.minutes > 0).map((member) => ({ ...member, entries: [...member.entries].sort((left, right) => left.serviceDate.localeCompare(right.serviceDate) || left.startLocal.localeCompare(right.startLocal) || left.id.localeCompare(right.id)) })).sort((left, right) => left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId));
}

export const outreachEntrySource = (attribution: string) => attribution === "linked_discord" ? "Linked Discord submission" : attribution === "self_asserted" ? "Public form submission" : attribution === "staff_recorded" ? "Staff-added entry" : "Member submission";

/** Follow every page before presenting totals, and fail closed on a broken cursor. */
export async function loadOutreachPages<T>(path: string, readPage: (path: string, signal?: AbortSignal) => Promise<{ items: T[]; nextCursor: string | null }>, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = []; const visited = new Set<string>(); let cursor: string | null = null;
  do {
    const query = cursor === null ? path : `${path}${path.includes("?") ? "&" : "?"}after=${encodeURIComponent(cursor)}`;
    const page = await readPage(query, signal);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (visited.has(cursor)) throw new Error("Outreach records could not be loaded completely. Refresh and try again.");
      visited.add(cursor);
    }
  } while (cursor !== null);
  return items;
}
