// Team-number checks against FIRST through Core's shared FIRST connection (`services.first`, module SDK 1.2.0). Core holds
// the credentials, caches answers and limits public visitors; Outreach only asks whether a team exists and what FIRST calls
// it. A check never blocks a member: when FIRST is unavailable or has no such team, the member's typed name is used.
import type { FirstDataService } from "@lancerlogin/module-sdk/api";
import { outreachPrograms } from "../shared/outreach-programs.ts";

type Program = typeof outreachPrograms[number];

/** The part of `services.first` Outreach uses. */
export type FirstTeamLookup = Pick<FirstDataService, "lookupTeam">;
/**
 * What the public form learns: FIRST's team name and, when Core reports one, the season FIRST found the team in; that
 * FIRST has no such team; or nothing.
 */
export type FirstTeamCheck = { status: "found"; name: string; season?: number } | { status: "not-found" } | { status: "unavailable" };

/** Team numbers FIRST can check: 1 to 6 digits. Core refuses any other number. */
export const firstCheckableNumber = /^\d{1,6}$/;
/** Longest supported team name, matching outreach-team-support.ts. */
const teamNameLength = 150;
const unavailable: FirstTeamCheck = { status: "unavailable" };
/** A season Core reports: a four-digit year. Anything else is left out rather than shown. */
const seasonOf = (value: unknown) => Number.isInteger(value) && (value as number) >= 2000 && (value as number) <= 2999 ? value as number : undefined;

/** Ask FIRST about a team. Every failure, including a missing service or an uncheckable number, reads as unavailable. */
export async function checkFirstTeam(first: FirstTeamLookup | undefined, program: unknown, teamNumber: unknown): Promise<FirstTeamCheck> {
  const trimmed = typeof teamNumber === "string" ? teamNumber.trim() : "";
  if (!first || !outreachPrograms.includes(program as Program) || !firstCheckableNumber.test(trimmed)) return unavailable;
  try {
    const answer = await first.lookupTeam({ program: program as Program, number: trimmed });
    if (answer?.status === "not-found") return { status: "not-found" };
    const name = answer?.status === "found" && typeof answer.team?.name === "string" ? answer.team.name.trim().slice(0, teamNameLength).trim() : "";
    if (!name) return unavailable;
    const season = seasonOf(answer?.status === "found" ? answer.team?.season : undefined);
    return season === undefined ? { status: "found", name } : { status: "found", name, season };
  } catch {
    return unavailable;
  }
}
