import type { D1Database } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";

type SetupPredicate = { sql: string; bindings: readonly unknown[] };
const installationId = "primary";

export const outreachSetupPredicates: Readonly<Record<string, (installationId: string) => SetupPredicate>> = Object.freeze({
  rules: (id) => ({ sql: `EXISTS(SELECT 1 FROM hours_entry_settings WHERE installation_id=?
    AND typeof(reporting_days)='integer' AND reporting_days BETWEEN 1 AND 365
    AND typeof(reopen_hours)='integer' AND reopen_hours BETWEEN 1 AND 168)`, bindings: [id] }),
  catalog: (id) => ({ sql: `EXISTS(SELECT 1 FROM hours_categories WHERE installation_id=? AND id='event' AND mode='event' AND archived=0)
    AND EXISTS(SELECT 1 FROM hours_categories WHERE installation_id=? AND id='team-support' AND mode='team' AND archived=0)
    AND EXISTS(SELECT 1 FROM hours_categories WHERE installation_id=? AND id='other-service' AND mode='task' AND archived=0)
    AND EXISTS(SELECT 1 FROM hours_teams WHERE installation_id=? AND archived=0)`, bindings: [id, id, id, id] }),
});

export async function outreachSetupStepValid(db: D1Database, stepId: string) {
  const predicate = outreachSetupPredicates[stepId];
  if (!predicate) throw new HttpError(500, "Outreach setup binding is unavailable");
  const value = predicate(installationId);
  return Boolean(await db.prepare(`SELECT 1 AS valid WHERE ${value.sql}`).bind(...value.bindings).first());
}
