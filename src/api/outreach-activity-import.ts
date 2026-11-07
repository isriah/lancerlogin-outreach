// POST /admin/hours/activities/import: CSV rows of Outreach activities, checked again here whatever the dashboard preview
// showed. A dry run classifies each row as add, update (a matching activity, when the caller chose Update), skip or error;
// a commit writes every row that is not an error in one D1 batch with its Event publication and one audit row.
//
// Budget (Workers Free: 10 ms CPU, 50 D1 queries with a batch counting once, 100 bound parameters per statement): rows are
// placed with one memoised zone clock; the time zone, the activities on the file's dates (with their labels), the named
// supported teams and labels, the categories and the publication switches are read once each, then the publications and
// deliveries of the Events being updated, with the destinations' status. Publication is queued in the batch for the
// publication job, which delivers at most 5 a pass, rather than delivered inline. A 200-row commit makes at most nine
// queries, plus Core's own reads of the destinations' status, in a batch of about 210 statements.
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import { HttpError } from "@lancerlogin/module-sdk/api";
import { outreachActivityCsvCellLimit, outreachActivityCsvFields, outreachActivityCsvRowLimit, outreachActivityTypeLabels, outreachCsvClock, placeOutreachEventTimes, resolveOutreachActivityCsvRow, type OutreachActivityCsvActivity, type OutreachActivityCsvMode, type OutreachActivityCsvRow, type OutreachEventOccurrence } from "../shared/outreach-activity-csv.ts";
import { catalogWriteStatement, outreachActivityColumns, outreachActivityGuard } from "./outreach-catalogs.ts";
import { outreachLatestExternalIds, outreachPublicationQueueStatements, outreachPublishedProviders, readOutreachPublicationDestinations, type OutreachPublicationProvider, type OutreachPublicationProviders, type OutreachPublicationQueueItem } from "./outreach-publication.ts";

type Row = Record<string, unknown>;
const installationId = "primary";
const providerOrder: OutreachPublicationProvider[] = ["discord", "google_calendar"];
const categoryByMode = { event: "event", team: "team-support", task: "other-service" } as const;

/** A row's activity as the preview shows it: the team as its number (or name), labels by name, times as 24-hour HH:MM. */
export type OutreachImportActivity = { title: string; date: string; mode: OutreachActivityCsvMode; startTime: string | null; endTime: string | null; team: string | null; labels: string[]; location: string; description: string; impactRelevant: boolean };
export type OutreachImportChange = "title" | "time" | "labels" | "location" | "description" | "impact";
export type OutreachActivityImportRowResult = {
  rowNumber: number; action: "add" | "update" | "skip" | "error"; title?: string; activity?: OutreachImportActivity; existing?: OutreachImportActivity & { activityId: string };
  changes?: OutreachImportChange[]; error?: string; warnings?: string[];
  /** Destinations this row's Event will be queued to: new ones, and those it is already published to. */
  publication?: { publish: OutreachPublicationProvider[]; update: OutreachPublicationProvider[] };
};
type Team = { id: string; number: string; name: string; archived: number };
type Label = { id: string; name: string; archived: number };
type Existing = Row & { id: string; title: string; mode: OutreachActivityCsvMode; service_date: string; team_id: string | null; revision: number; event_start_local: string | null; event_end_local: string | null; event_start_occurrence: OutreachEventOccurrence; event_end_occurrence: OutreachEventOccurrence; labels_json: string };
type Planned = {
  result: OutreachActivityImportRowResult; activity?: OutreachActivityCsvActivity; match?: Existing; columns?: Row; labelIds?: string[]; labelsChanged?: boolean;
  timing?: { startMs: number; endMs: number; allDay: boolean }; eligible?: boolean; wanted?: OutreachPublicationProvider[];
};

function requestRows(value: unknown): { rows: OutreachActivityCsvRow[]; dryRun: boolean; actions: Record<string, "skip" | "update"> } {
  const input = value as { rows?: unknown; dryRun?: unknown; actions?: unknown } | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["rows", "dryRun", "actions"].includes(key))) throw new HttpError(400, "Provide Outreach activity rows to import");
  const rows = input.rows;
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Add at least one Outreach activity row");
  if (rows.length > outreachActivityCsvRowLimit) throw new HttpError(400, `Import no more than ${outreachActivityCsvRowLimit} activities at a time`);
  const numbers = new Set<number>();
  for (const row of rows as OutreachActivityCsvRow[]) {
    const keys = row && typeof row.values === "object" && row.values && !Array.isArray(row.values) ? Object.keys(row.values) : undefined;
    if (!Number.isInteger(row?.rowNumber) || row.rowNumber < 1 || row.rowNumber > 100_000 || numbers.has(row.rowNumber) || !keys || keys.some((key) => !outreachActivityCsvFields.includes(key as never) || typeof (row.values as Record<string, unknown>)[key] !== "string" || (row.values as Record<string, string>)[key]!.length > outreachActivityCsvCellLimit)) throw new HttpError(400, "Each Outreach activity row needs a distinct row number and text cells for known columns");
    numbers.add(row.rowNumber);
  }
  const actions = (input.actions ?? {}) as Record<string, unknown>;
  if (typeof actions !== "object" || Array.isArray(actions) || Object.values(actions).some((action) => action !== "skip" && action !== "update")) throw new HttpError(400, "Matching row actions must be skip or update");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new HttpError(400, "dryRun must be true or false");
  return { rows: rows as OutreachActivityCsvRow[], dryRun: input.dryRun !== false, actions: actions as Record<string, "skip" | "update"> };
}

const lower = (value: string) => value.trim().toLowerCase();
const matchKey = (date: string, mode: string, title: string, teamId: string | null) => `${date}|${mode}|${lower(title)}|${teamId ?? ""}`;
const sameSet = (left: string[], right: string[]) => left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n");

export async function runOutreachActivityImport(db: D1Database, actor: string, body: unknown, providers: OutreachPublicationProviders, now = Date.now()) {
  const { rows, dryRun, actions } = requestRows(body);
  const planned: Planned[] = rows.map((row) => {
    const resolved = resolveOutreachActivityCsvRow(row.values);
    return resolved.activity ? { result: { rowNumber: row.rowNumber, action: "add" }, activity: resolved.activity } : { result: { rowNumber: row.rowNumber, action: "error", title: row.values.title?.trim() || undefined, error: resolved.errors.join(". ") } };
  });
  const placed = planned.filter((plan) => plan.activity);
  const dates = [...new Set(placed.map((plan) => plan.activity!.serviceDate))];
  const teamRefs = [...new Set(placed.map((plan) => plan.activity!.teamRef).filter((ref): ref is string => Boolean(ref)))];
  const labelNames = [...new Set(placed.flatMap((plan) => plan.activity!.labelNames ?? []).map(lower))];
  // One read each: the time zone, the active activities on the file's dates with their labels, the named teams and labels,
  // the categories and the publication switches.
  const [settings, existingRows, teamRows, labelRows, categoryRows, switches] = await Promise.all([
    db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>(),
    dates.length ? db.prepare(`SELECT a.*,COALESCE((SELECT json_group_array(json_object('id',l.id,'name',l.name)) FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id
      WHERE al.installation_id=a.installation_id AND al.activity_id=a.id),'[]') AS labels_json FROM hours_activities a WHERE a.installation_id=? AND a.archived=0 AND a.service_date IN (SELECT value FROM json_each(?)) ORDER BY a.id`).bind(installationId, JSON.stringify(dates)).all<Existing>() : { results: [] as Existing[] },
    teamRefs.length ? db.prepare("SELECT id,number,name,archived FROM hours_teams WHERE installation_id=? AND (number IN (SELECT value FROM json_each(?)) OR lower(name) IN (SELECT lower(value) FROM json_each(?)))").bind(installationId, JSON.stringify(teamRefs), JSON.stringify(teamRefs)).all<Team>() : { results: [] as Team[] },
    labelNames.length ? db.prepare("SELECT id,name,archived FROM hours_labels WHERE installation_id=? AND lower(name) IN (SELECT value FROM json_each(?))").bind(installationId, JSON.stringify(labelNames)).all<Label>() : { results: [] as Label[] },
    db.prepare("SELECT id,archived FROM hours_categories WHERE installation_id=?").bind(installationId).all<{ id: string; archived: number }>(),
    readOutreachPublicationDestinations(db),
  ]);
  if (!settings) throw new HttpError(409, "Organization time zone is unavailable");
  const timeZone = settings.timeZone; const clock = outreachCsvClock(timeZone); const today = clock.civil(now).date;
  const teams = teamRows.results ?? []; const labels = labelRows.results ?? []; const activeCategories = new Set((categoryRows.results ?? []).filter((item) => !item.archived).map((item) => item.id));
  const teamById = new Map(teams.map((team) => [team.id, team]));
  // Labels by lowercase name, active first.
  const labelByName = new Map<string, Label>();
  for (const label of [...labels].sort((left, right) => left.archived - right.archived)) if (!labelByName.has(lower(label.name))) labelByName.set(lower(label.name), label);
  const existingByKey = new Map<string, Existing>();
  for (const activity of existingRows.results ?? []) { const key = matchKey(activity.service_date, activity.mode, activity.title, activity.team_id); if (!existingByKey.has(key)) existingByKey.set(key, activity); }
  const firstRow = new Map<string, number>();
  const teamText = (teamId: string | null, fallback: string | null) => { const team = teamId ? teamById.get(teamId) : undefined; return team ? team.number || team.name : fallback; };
  const local = (activity: Row, teamId: string | null, labelList: string[]): OutreachImportActivity => ({ title: String(activity.title), date: String(activity.service_date), mode: activity.mode as OutreachActivityCsvMode, startTime: (activity.event_start_local as string | null) ?? null, endTime: (activity.event_end_local as string | null) ?? null, team: teamText(teamId, null), labels: labelList, location: String(activity.location ?? ""), description: String(activity.description ?? ""), impactRelevant: Boolean(activity.impact_relevant) });

  for (const plan of placed) {
    const activity = plan.activity!; const result = plan.result;
    const fail = (error: string) => { result.action = "error"; result.error = error; };
    // What the preview shows for a row whose catalog names do not resolve.
    result.activity = { title: activity.title, date: activity.serviceDate, mode: activity.mode, startTime: activity.startLocal ?? null, endTime: activity.endLocal ?? null, team: activity.teamRef, labels: activity.labelNames ?? [], location: activity.location ?? "", description: activity.description ?? "", impactRelevant: activity.impactRelevant ?? true };
    let teamId: string | null = null;
    if (activity.teamRef) {
      const ref = activity.teamRef; const byNumber = teams.filter((team) => team.number === ref); const found = byNumber.length ? byNumber : teams.filter((team) => lower(team.name) === lower(ref));
      const active = found.filter((team) => !team.archived);
      const kind = /^\d+$/.test(ref) ? `team number ${ref}` : `supported team ${ref}`;
      if (!found.length) { fail(`Unknown ${kind}`); continue; }
      if (!active.length) { fail(`Supported team ${found[0]!.number ? `${found[0]!.number} ` : ""}${found[0]!.name} is archived`); continue; }
      if (active.length > 1) { fail(`${kind[0]!.toUpperCase()}${kind.slice(1)} matches more than one supported team. Use the team's exact name`); continue; }
      teamId = active[0]!.id; result.activity.team = teamText(teamId, ref);
    }
    if (!activeCategories.has(categoryByMode[activity.mode])) { fail(`The ${outreachActivityTypeLabels[activity.mode]} activity type is archived`); continue; }
    const key = matchKey(activity.serviceDate, activity.mode, activity.title, teamId); const repeated = firstRow.get(key);
    if (repeated !== undefined) { fail(`Repeats row ${repeated}`); continue; }
    firstRow.set(key, result.rowNumber);
    const match = existingByKey.get(key); plan.match = match;
    const current = match ? JSON.parse(match.labels_json) as { id: string; name: string }[] : [];
    if (match) result.existing = { activityId: match.id, ...local(match, match.team_id, current.map((label) => label.name).sort((left, right) => left.localeCompare(right))) };
    // Labels by name: an archived label stays only on an activity that already has it, as an edit allows.
    const chosen: Label[] = [];
    for (const name of activity.labelNames ?? []) {
      const label = labelByName.get(lower(name));
      if (!label) { fail(`Unknown Outreach label ${name}`); break; }
      if (label.archived && !current.some((item) => item.id === label.id)) { fail(`Outreach label ${label.name} is archived`); break; }
      chosen.push(label);
    }
    if (result.action === "error") continue;
    plan.labelIds = activity.labelNames === undefined ? current.map((label) => label.id) : chosen.map((label) => label.id);
    const labelList = activity.labelNames === undefined ? current.map((label) => label.name) : chosen.map((label) => label.name);
    // An absent column keeps the matching activity's value; blank cells clear it.
    const startLocal = activity.startLocal === undefined ? match?.event_start_local ?? null : activity.startLocal; const endLocal = activity.endLocal === undefined ? match?.event_end_local ?? null : activity.endLocal;
    const keepsTimes = Boolean(match) && startLocal === match!.event_start_local && endLocal === match!.event_end_local;
    let occurrences: [OutreachEventOccurrence, OutreachEventOccurrence] = [null, null];
    if (activity.mode === "event") {
      const placedTimes = placeOutreachEventTimes(clock, activity.serviceDate, startLocal, endLocal, keepsTimes ? [match!.event_start_occurrence ?? null, match!.event_end_occurrence ?? null] : [null, null]);
      if (placedTimes.error !== undefined) { fail(placedTimes.error); continue; }
      occurrences = [placedTimes.startOccurrence, placedTimes.endOccurrence];
      if (placedTimes.warnings.length) result.warnings = placedTimes.warnings;
      plan.timing = { startMs: placedTimes.startMs, endMs: placedTimes.endMs, allDay: !startLocal };
    }
    const input: Row = { mode: activity.mode, teamId, serviceDate: activity.serviceDate, title: activity.title, description: activity.description ?? match?.description ?? "", location: activity.location ?? match?.location ?? "", impactRelevant: activity.impactRelevant ?? (match ? Boolean(match.impact_relevant) : true), archived: false,
      ...(activity.mode === "event" ? { eventStartLocal: startLocal, eventEndLocal: endLocal, eventStartOccurrence: occurrences[0], eventEndOccurrence: occurrences[1] } : {}) };
    // The input names every field a save stores, so it is the whole next activity, and an update checks as an edit does.
    try { plan.columns = { archived: 0, ...outreachActivityColumns(input, input, match ?? null) }; }
    catch (error) { fail((error as Error).message); continue; }
    result.activity = local(plan.columns, teamId, labelList);
    if (!match) continue;
    const changes: OutreachImportChange[] = [];
    if (match.title !== plan.columns.title) changes.push("title");
    if (match.event_start_local !== plan.columns.event_start_local || match.event_end_local !== plan.columns.event_end_local || (match.event_start_occurrence ?? null) !== plan.columns.event_start_occurrence || (match.event_end_occurrence ?? null) !== plan.columns.event_end_occurrence) changes.push("time");
    plan.labelsChanged = !sameSet(current.map((label) => label.id), plan.labelIds); if (plan.labelsChanged) changes.push("labels");
    if (String(match.location ?? "") !== plan.columns.location) changes.push("location");
    if (String(match.description ?? "") !== plan.columns.description) changes.push("description");
    if (Boolean(match.impact_relevant) !== Boolean(plan.columns.impact_relevant)) changes.push("impact");
    result.changes = changes;
    result.action = actions[String(result.rowNumber)] === "update" && changes.length ? "update" : "skip";
  }

  // Event publication, as saving an activity queues it: an Event that has not ended goes to each destination whose switch
  // is on and, when updated, to each destination it is already published to; only set-up destinations are queued.
  const events = planned.filter((plan) => (plan.result.action === "add" || plan.result.action === "update") && plan.timing);
  for (const plan of events) {
    plan.eligible = plan.timing!.allDay ? plan.activity!.serviceDate >= today : plan.timing!.endMs > now;
    plan.wanted = providerOrder.filter((provider) => switches[provider]);
  }
  const updatedEvents = events.filter((plan) => plan.match && plan.eligible).map((plan) => plan.match!.id);
  const needsStatus = events.some((plan) => plan.eligible) && (providerOrder.some((provider) => switches[provider]) || updatedEvents.length > 0);
  const [publicationRows, operationRows, available] = await Promise.all([
    updatedEvents.length ? db.prepare("SELECT * FROM hours_activity_publications WHERE installation_id=? AND activity_id IN (SELECT value FROM json_each(?))").bind(installationId, JSON.stringify(updatedEvents)).all<Row>() : { results: [] as Row[] },
    updatedEvents.length ? db.prepare("SELECT * FROM hours_publication_operations WHERE installation_id=? AND activity_id IN (SELECT value FROM json_each(?))").bind(installationId, JSON.stringify(updatedEvents)).all<Row>() : { results: [] as Row[] },
    needsStatus ? providers.status() : Promise.resolve({ google_calendar: false, discord: false } as Record<OutreachPublicationProvider, boolean>),
  ]);
  const publicationOf = new Map((publicationRows.results ?? []).map((row) => [String(row.activity_id), row]));
  const operationsOf = new Map<string, Row[]>();
  for (const row of operationRows.results ?? []) { const list = operationsOf.get(String(row.activity_id)); if (list) list.push(row); else operationsOf.set(String(row.activity_id), [row]); }
  const queue: { plan: Planned; item: Omit<OutreachPublicationQueueItem, "activityId" | "activityRevision"> }[] = [];
  for (const plan of events) {
    if (!plan.eligible) continue;
    const existing = plan.match ? publicationOf.get(plan.match.id) ?? null : null; const operations = plan.match ? operationsOf.get(plan.match.id) ?? [] : [];
    const published = outreachPublishedProviders(existing, operations);
    const selected = providerOrder.filter((provider) => (plan.wanted!.includes(provider) || published.has(provider)) && available[provider]);
    if (!selected.length) continue;
    const previous = existing ? operations.filter((row) => Number(row.publication_revision) === Number(existing.revision)) : [];
    if (previous.some((row) => row.status === "processing")) { plan.result.action = "error"; plan.result.error = "This Event's publication is being delivered right now. Preview again in a minute"; continue; }
    plan.result.publication = { publish: selected.filter((provider) => !published.has(provider)), update: selected.filter((provider) => published.has(provider)) };
    const startLocal = plan.columns!.event_start_local as string | null;
    queue.push({ plan, item: { activity: plan.columns!, timeZone, existing, previous, externalIds: outreachLatestExternalIds(operations), selected,
      timing: { startLocal: startLocal ?? "00:00", endLocal: plan.columns!.event_end_local ?? "00:00", startOccurrence: plan.columns!.event_start_occurrence, endOccurrence: plan.columns!.event_end_occurrence, startMs: plan.timing!.startMs, endMs: plan.timing!.endMs, allDay: plan.timing!.allDay } } });
  }

  const results = planned.map((plan) => plan.result);
  const summary = { add: 0, update: 0, skip: 0, error: 0 };
  for (const row of results) summary[row.action] += 1;
  if (dryRun) return { dryRun: true, timeZone, rows: results, summary };
  const apply = planned.filter((plan) => plan.result.action === "add" || plan.result.action === "update");
  if (!apply.length) throw new HttpError(400, "No rows can be imported. Fix the file and preview again");
  return commit(db, actor, apply, queue.filter((entry) => entry.plan.result.action !== "error"), results, summary, now);
}

async function commit(db: D1Database, actor: string, apply: Planned[], queue: { plan: Planned; item: Omit<OutreachPublicationQueueItem, "activityId" | "activityRevision"> }[], results: OutreachActivityImportRowResult[], summary: Record<string, number>, now: number) {
  const at = new Date(now).toISOString(); const statements: D1Statement[] = [];
  const ids = new Map(apply.map((plan) => [plan, plan.match?.id ?? crypto.randomUUID()]));
  const written: Row[] = []; const labelPairs: { a: string; l: string }[] = []; const relabelled: string[] = [];
  // Each row is the same INSERT or revision-checked UPDATE that saving the activity makes. The whole batch rolls back when
  // one of them does not apply (another save between this request's reads and its batch, or a team or type archived
  // meanwhile): the batch ends by checking every row holds what was written at its new revision, and json() of a refusal
  // fails the batch, as a save's own check refuses a stale revision.
  const stale = "'Outreach activities changed during the import'";
  const checked = ["title", "service_date", "mode", "team_id", "description", "location", "impact_relevant", "event_start_local", "event_end_local", "event_start_occurrence", "event_end_occurrence"] as const;
  for (const plan of apply) {
    const id = ids.get(plan)!; const match = plan.match ?? null; const guard = outreachActivityGuard(match?.id, plan.columns!, match);
    statements.push(catalogWriteStatement(db, "hours_activities", match?.id, id, plan.columns!, match ? Number(match.revision) : 0, at, guard.sql, guard.values));
    written.push({ id, revision: match ? Number(match.revision) + 1 : 0, ...Object.fromEntries(checked.map((column) => [column, plan.columns![column]])) });
    if (!match || plan.labelsChanged) { if (match) relabelled.push(id); for (const labelId of plan.labelIds ?? []) labelPairs.push({ a: id, l: labelId }); }
  }
  if (relabelled.length) statements.push(db.prepare("DELETE FROM hours_activity_labels WHERE installation_id=? AND activity_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM json_each(?) k WHERE json_extract(k.value,'$.a')=hours_activity_labels.activity_id AND json_extract(k.value,'$.l')=hours_activity_labels.label_id)").bind(installationId, JSON.stringify(relabelled), JSON.stringify(labelPairs)));
  if (labelPairs.length) statements.push(db.prepare("INSERT OR IGNORE INTO hours_activity_labels(installation_id,activity_id,label_id,created_by,created_at) SELECT ?,json_extract(value,'$.a'),json_extract(value,'$.l'),?,? FROM json_each(?)").bind(installationId, actor, at, JSON.stringify(labelPairs)));
  const publication = outreachPublicationQueueStatements(db, actor, queue.map(({ plan, item }) => ({ ...item, activityId: ids.get(plan)!, activityRevision: plan.match ? Number(plan.match.revision) + 1 : 0 })), now);
  // Every publication must move to its next revision too, as queuePublication checks each one.
  if (publication.statements.length) statements.push(publication.statements[0]!, db.prepare(`SELECT json(CASE WHEN changes()=? THEN '1' ELSE ${stale} END) AS applied`).bind(publication.revisions.length), ...publication.statements.slice(1));
  statements.push(db.prepare(`SELECT json(CASE WHEN (SELECT COUNT(*) FROM json_each(?) j JOIN hours_activities a ON a.installation_id=? AND a.id=json_extract(j.value,'$.id') AND a.revision=json_extract(j.value,'$.revision') AND a.updated_at=?
    AND ${checked.map((column) => `a.${column} IS json_extract(j.value,'$.${column}')`).join(" AND ")})=? THEN '1' ELSE ${stale} END) AS applied`).bind(JSON.stringify(written), installationId, at, written.length));
  const added = apply.filter((plan) => !plan.match).map((plan) => ids.get(plan)!); const updated = apply.filter((plan) => plan.match).map((plan) => ids.get(plan)!);
  const queuedProviders = providerOrder.filter((provider) => queue.some((entry) => entry.item.selected.includes(provider)));
  statements.push(db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,'outreach.activities.imported','outreach_catalog',NULL,?,?)").bind(crypto.randomUUID(), installationId, actor, JSON.stringify({ ...summary, addedIds: added, updatedIds: updated, publicationQueued: queue.length, providers: queuedProviders }), at));
  try { await db.batch(statements); }
  catch (error) {
    if (/malformed JSON|UNIQUE|FOREIGN KEY|CHECK constraint|hours_activity/i.test(String(error))) throw new HttpError(409, "Outreach activities changed during the import. Preview the file again");
    throw error;
  }
  for (const plan of apply) if (!plan.match) plan.result.existing = undefined;
  return { dryRun: false, rows: results, summary, imported: { added: added.length, updated: updated.length, activityIds: [...added, ...updated] }, publication: { queued: queue.length, providers: queuedProviders } };
}
