// Outreach report projections. Core resolves the report period, checks dataset access and passes the module-scoped database;
// these handlers read Outreach tables and Core roster fields through the SDK's report helpers and apply the Outreach label filter.
import { filterAndSortReportRows, reportFilterSelection, reportMemberIncluded, reportMemberValues, reportRosterData, reportRow, type D1Database, type NormalizedReportDefinition, type ReportCell, type ReportProjectionContext, type ReportProjectionHandler } from "@lancerlogin/module-sdk/api";

type OutreachActivityLabel = { id: string; name: string };
type OutreachEntry = { id: string; memberId: string; activityId: string; activityTitle: string; serviceDate: string; startLocal: string; endLocal: string; durationMinutes: number; channel: string; status: string; activityMode: string; teamId: string | null; activityLabels: OutreachActivityLabel[] };

function parseOutreachLabels(value: string) { return JSON.parse(value) as OutreachActivityLabel[]; }
function outreachLabelsMatch(definition: NormalizedReportDefinition, labels: OutreachActivityLabel[]) {
  const selection = reportFilterSelection(definition, "outreach-labels");
  if (!selection.ids.length) return true;
  const current = new Set(labels.map((label) => label.id));
  return selection.match === "all" ? selection.ids.every((id) => current.has(id)) : selection.ids.some((id) => current.has(id));
}
function outreachLabelText(labels: OutreachActivityLabel[]) { return labels.map((label) => label.name).sort((a, b) => a.localeCompare(b)).join("; ") || "None"; }

async function outreachEntries(db: D1Database, context: ReportProjectionContext, includeVoided = false) {
  const result = await db.prepare(`SELECT e.id,e.member_id AS memberId,e.activity_id AS activityId,a.title AS activityTitle,e.service_date AS serviceDate,e.start_local AS startLocal,e.end_local AS endLocal,e.duration_minutes AS durationMinutes,e.channel,e.status,a.mode AS activityMode,a.team_id AS teamId,
    COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name)) FROM (SELECT l.id,l.name FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id WHERE al.installation_id=a.installation_id AND al.activity_id=a.id ORDER BY l.name,l.id) labels),'[]') AS activityLabels
    FROM hours_entries e JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id
    WHERE e.installation_id='primary' AND (? IS NULL OR e.service_date>=?) AND e.service_date<=? ${includeVoided ? "" : "AND e.status='counted'"} ORDER BY e.service_date,e.id`).bind(context.from ?? null, context.from ?? null, context.to).all<Omit<OutreachEntry, "activityLabels"> & { activityLabels: string }>();
  return (result.results ?? []).map((entry) => ({ ...entry, activityLabels: parseOutreachLabels(entry.activityLabels) }));
}

async function projectOutreachMembers(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const [data, entries] = await Promise.all([reportRosterData(db, context.today), outreachEntries(db, context)]);
  const totals = new Map<string, { minutes: number; entries: number; activities: Set<string>; teams: Set<string>; last: string | null }>();
  for (const entry of entries.filter((item) => outreachLabelsMatch(definition, item.activityLabels))) {
    const total = totals.get(entry.memberId) ?? { minutes: 0, entries: 0, activities: new Set<string>(), teams: new Set<string>(), last: null };
    total.minutes += entry.durationMinutes; total.entries += 1; total.activities.add(entry.activityId); if (entry.activityMode === "team" && entry.teamId) total.teams.add(entry.teamId); if (!total.last || entry.serviceDate > total.last) total.last = entry.serviceDate; totals.set(entry.memberId, total);
  }
  const rows = data.members.flatMap((member) => {
    const labels = data.labels.get(member.id) ?? new Map<string, string>(); if (!reportMemberIncluded(definition, member, labels)) return [];
    const total = totals.get(member.id) ?? { minutes: 0, entries: 0, activities: new Set<string>(), teams: new Set<string>(), last: null };
    const name = `${member.firstName} ${member.lastName}`; const values = { ...reportMemberValues(member, labels),
      "outreach.member.minutes": { text: String(total.minutes), sortValue: total.minutes }, "outreach.member.entries": { text: String(total.entries), sortValue: total.entries },
      "outreach.member.activities": { text: String(total.activities.size), sortValue: total.activities.size }, "outreach.member.supported-teams": { text: String(total.teams.size), sortValue: total.teams.size },
      "outreach.member.last-service-date": { text: total.last ?? "N/A", sortValue: total.last },
    } satisfies Record<string, ReportCell>;
    return [reportRow(definition, member.id, name, values, `/roster/${encodeURIComponent(member.memberId)}`)];
  });
  return filterAndSortReportRows(definition, rows);
}

async function projectOutreachActivities(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  type Activity = { id: string; title: string; serviceDate: string; mode: string; teamId: string | null; team: string | null; participants: number; entries: number; minutes: number; labels: string };
  const result = await db.prepare(`SELECT a.id,a.title,a.service_date AS serviceDate,a.mode,a.team_id AS teamId,t.name AS team,
      COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name)) FROM (SELECT l.id,l.name FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id WHERE al.installation_id=a.installation_id AND al.activity_id=a.id ORDER BY l.name,l.id) labels),'[]') AS labels,
      COUNT(DISTINCT CASE WHEN e.status='counted' THEN e.member_id END) AS participants,COUNT(CASE WHEN e.status='counted' THEN 1 END) AS entries,COALESCE(SUM(CASE WHEN e.status='counted' THEN e.duration_minutes ELSE 0 END),0) AS minutes
    FROM hours_activities a LEFT JOIN hours_teams t ON t.installation_id=a.installation_id AND t.id=a.team_id LEFT JOIN hours_entries e ON e.installation_id=a.installation_id AND e.activity_id=a.id
    WHERE a.installation_id='primary' AND (? IS NULL OR a.service_date>=?) AND a.service_date<=? GROUP BY a.id,a.title,a.service_date,a.mode,a.team_id,t.name ORDER BY a.service_date,a.id`).bind(context.from ?? null, context.from ?? null, context.to).all<Activity>();
  return filterAndSortReportRows(definition, (result.results ?? []).flatMap((activity) => {
    const labels = parseOutreachLabels(activity.labels); if (!outreachLabelsMatch(definition, labels)) return [];
    return [reportRow(definition, activity.id, activity.title, {
    "outreach.activity.id": { text: activity.id, sortValue: activity.id }, "outreach.activity.title": { text: activity.title, sortValue: activity.title.toLocaleLowerCase() }, "outreach.activity.date": { text: activity.serviceDate, sortValue: activity.serviceDate },
    "outreach.activity.labels": { text: outreachLabelText(labels), sortValue: outreachLabelText(labels).toLocaleLowerCase(), empty: !labels.length }, "outreach.activity.mode": { text: activity.mode === "event" ? "Event" : activity.mode === "team" ? "Team support" : "Other service", sortValue: activity.mode },
    "outreach.activity.team-id": { text: activity.teamId ?? "", sortValue: activity.teamId }, "outreach.activity.team": { text: activity.team ?? "N/A", sortValue: activity.team?.toLocaleLowerCase() ?? null },
    "outreach.activity.participants": { text: String(Number(activity.participants)), sortValue: Number(activity.participants) }, "outreach.activity.entries": { text: String(Number(activity.entries)), sortValue: Number(activity.entries) }, "outreach.activity.minutes": { text: String(Number(activity.minutes)), sortValue: Number(activity.minutes) },
    })];
  }));
}

async function projectOutreachEntries(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const [entries, roster] = await Promise.all([outreachEntries(db, context, true), reportRosterData(db, context.today)]); const members = new Map(roster.members.map((member) => [member.id, `${member.firstName} ${member.lastName}`]));
  return filterAndSortReportRows(definition, entries.filter((entry) => outreachLabelsMatch(definition, entry.activityLabels)).map((entry) => reportRow(definition, entry.id, entry.activityTitle, {
    "outreach.entry.id": { text: entry.id, sortValue: entry.id }, "outreach.entry.member": { text: members.get(entry.memberId) ?? "Unavailable member", sortValue: (members.get(entry.memberId) ?? "").toLocaleLowerCase() },
    "outreach.entry.activity-id": { text: entry.activityId, sortValue: entry.activityId }, "outreach.entry.activity": { text: entry.activityTitle, sortValue: entry.activityTitle.toLocaleLowerCase() }, "outreach.entry.date": { text: entry.serviceDate, sortValue: entry.serviceDate },
    "outreach.entry.labels": { text: outreachLabelText(entry.activityLabels), sortValue: outreachLabelText(entry.activityLabels).toLocaleLowerCase(), empty: !entry.activityLabels.length },
    "outreach.entry.start": { text: entry.startLocal, sortValue: entry.startLocal }, "outreach.entry.end": { text: entry.endLocal, sortValue: entry.endLocal }, "outreach.entry.minutes": { text: String(entry.durationMinutes), sortValue: entry.durationMinutes },
    "outreach.entry.channel": { text: entry.channel, sortValue: entry.channel }, "outreach.entry.status": { text: entry.status, sortValue: entry.status },
  })));
}

async function projectOutreachTeams(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  type Team = { id: string; number: string; name: string; program: string };
  const [result, entries] = await Promise.all([
    db.prepare("SELECT id,number,name,program FROM hours_teams WHERE installation_id='primary' ORDER BY name COLLATE NOCASE,id").all<Team>(),
    outreachEntries(db, context),
  ]);
  const matching = entries.filter((entry) => entry.activityMode === "team" && entry.teamId && outreachLabelsMatch(definition, entry.activityLabels));
  return filterAndSortReportRows(definition, (result.results ?? []).map((team) => {
    const current = matching.filter((entry) => entry.teamId === team.id); const participants = new Set(current.map((entry) => entry.memberId)).size; const activities = new Set(current.map((entry) => entry.activityId)).size; const minutes = current.reduce((sum, entry) => sum + entry.durationMinutes, 0);
    return reportRow(definition, team.id, team.name, {
    "outreach.team.id": { text: team.id, sortValue: team.id }, "outreach.team.name": { text: team.name, sortValue: team.name.toLocaleLowerCase() }, "outreach.team.number": { text: team.number, sortValue: team.number }, "outreach.team.program": { text: team.program, sortValue: team.program.toLocaleLowerCase() },
    "outreach.team.participants": { text: String(participants), sortValue: participants }, "outreach.team.activities": { text: String(activities), sortValue: activities }, "outreach.team.entries": { text: String(current.length), sortValue: current.length }, "outreach.team.minutes": { text: String(minutes), sortValue: minutes },
    });
  }));
}

export const outreachReportHandlers: Readonly<Record<string, ReportProjectionHandler>> = Object.freeze({
  "outreach.members": projectOutreachMembers,
  "outreach.activities": projectOutreachActivities,
  "outreach.entries": projectOutreachEntries,
  "outreach.teams": projectOutreachTeams,
});

/** Options of the Outreach label report filter, archived labels included, so saved filters on archived labels stay readable. */
export async function outreachLabelFilterOptions(db: D1Database) {
  const result = await db.prepare("SELECT id,name,archived FROM hours_labels WHERE installation_id='primary' ORDER BY name COLLATE NOCASE,id").all<{ id: string; name: string; archived: number }>();
  return (result.results ?? []).map((label) => ({ ...label, archived: Boolean(label.archived) }));
}
