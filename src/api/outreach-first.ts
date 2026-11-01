// Team-number checks against FIRST through Core's shared FIRST connection (`services.first`, module SDK 1.2.0). Core holds
// the credentials, caches answers and limits public visitors; Outreach only asks whether a team exists and what FIRST calls
// it. A check never blocks a member: when FIRST is unavailable or has no such team, the member's typed name is used.
import type { FirstDataService } from "@lancerlogin/module-sdk/api";
import { outreachPrograms } from "../shared/outreach-programs.ts";

type Program = typeof outreachPrograms[number];

/** The part of `services.first` Outreach uses. */
export type FirstTeamLookup = Pick<FirstDataService, "lookupTeam">;
/** What the public form learns: FIRST's team name, that FIRST has no such team, or nothing. */
export type FirstTeamCheck = { status: "found"; name: string } | { status: "not-found" } | { status: "unavailable" };

/** Team numbers FIRST can check: 1 to 6 digits. Core refuses any other number. */
export const firstCheckableNumber = /^\d{1,6}$/;
/** Longest supported team name, matching outreach-team-support.ts. */
const teamNameLength = 150;
const unavailable: FirstTeamCheck = { status: "unavailable" };

/** Ask FIRST about a team. Every failure, including a missing service or an uncheckable number, reads as unavailable. */
export async function checkFirstTeam(first: FirstTeamLookup | undefined, program: unknown, teamNumber: unknown): Promise<FirstTeamCheck> {
  const trimmed = typeof teamNumber === "string" ? teamNumber.trim() : "";
  if (!first || !outreachPrograms.includes(program as Program) || !firstCheckableNumber.test(trimmed)) return unavailable;
  try {
    const answer = await first.lookupTeam({ program: program as Program, number: trimmed });
    if (answer?.status === "not-found") return { status: "not-found" };
    const name = answer?.status === "found" && typeof answer.team?.name === "string" ? answer.team.name.trim().slice(0, teamNameLength).trim() : "";
    return name ? { status: "found", name } : unavailable;
  } catch {
    return unavailable;
  }
}
