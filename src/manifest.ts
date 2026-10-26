// Outreach Participation module definition. It keeps the ID, contract, setup version, capabilities, routes, jobs, Discord
// commands, report datasets, tables and cleanup targets it had as a first-party module, so existing lifecycle rows, Operator
// assignments, setup progress, saved reports and retained data stay valid.
import { coreMemberReportFieldDefinitions, defineModuleManifest, reportFilterOperators, type ReportFieldDefinition } from "@lancerlogin/module-sdk";

const outreachMemberFields: readonly ReportFieldDefinition[] = [
  ...coreMemberReportFieldDefinitions(),
  { id: "outreach.member.minutes", label: "Outreach minutes", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number"), durationUnits: ["minutes", "hours"], defaultDurationUnit: "hours" },
  { id: "outreach.member.entries", label: "Participation entries", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.member.activities", label: "Distinct activities", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.member.supported-teams", label: "Supported teams", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.member.last-service-date", label: "Last participation date", group: "Outreach participation", kind: "dimension", valueType: "date", sortable: true, filterOperators: reportFilterOperators("date") },
];

const outreachActivityFields: readonly ReportFieldDefinition[] = [
  { id: "outreach.activity.id", label: "Activity record ID", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.activity.title", label: "Activity", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.activity.date", label: "Service date", group: "Activity", kind: "dimension", valueType: "date", sortable: true, filterOperators: reportFilterOperators("date") },
  { id: "outreach.activity.labels", label: "Outreach labels", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.activity.mode", label: "Activity type", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.activity.team-id", label: "Supported team record ID", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.activity.team", label: "Supported team", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.activity.participants", label: "Distinct participants", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.activity.entries", label: "Entries", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.activity.minutes", label: "Minutes", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number"), durationUnits: ["minutes", "hours"], defaultDurationUnit: "minutes" },
];

const outreachEntryFields: readonly ReportFieldDefinition[] = [
  { id: "outreach.entry.id", label: "Entry record ID", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.member", label: "Member", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.activity-id", label: "Activity record ID", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.activity", label: "Activity", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.labels", label: "Outreach labels", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.date", label: "Service date", group: "Entry", kind: "dimension", valueType: "date", sortable: true, filterOperators: reportFilterOperators("date") },
  { id: "outreach.entry.start", label: "Start", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.end", label: "End", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.minutes", label: "Minutes", group: "Entry", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number"), durationUnits: ["minutes", "hours"], defaultDurationUnit: "minutes" },
  { id: "outreach.entry.channel", label: "Submission channel", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.entry.status", label: "Status", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
];

const outreachTeamFields: readonly ReportFieldDefinition[] = [
  { id: "outreach.team.id", label: "Team record ID", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.team.name", label: "Supported team", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.team.number", label: "Team number", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.team.program", label: "Program", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "outreach.team.participants", label: "Distinct participants", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.team.activities", label: "Activities", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.team.entries", label: "Entries", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "outreach.team.minutes", label: "Minutes", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number"), durationUnits: ["minutes", "hours"], defaultDurationUnit: "minutes" },
];

const manifest = defineModuleManifest({
  id: "hour-tracking",
  label: "Outreach Participation",
  description: "Outreach labels, supported teams, dated activities, member submissions, staff exceptions, and participation totals.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "hours.manage", label: "Manage Outreach Participation", operator: true }],
  navigation: [{ label: "Outreach", path: "/hours" }],
  settings: [{ label: "Outreach", path: "/settings/outreach-setup" }],
  setup: {
    version: 1,
    steps: [
      { id: "rules", label: "Entry rules", required: true },
      { id: "catalog", label: "Labels and supported teams", required: true },
    ],
  },
  jobs: [{ id: "hour-tracking.publication", interval: 300_000, label: "Outreach event publication" }],
  discordCommands: [
    { name: "outreach-submit", type: 1, description: "Record completed Outreach participation for your linked member", options: [
      { name: "activity", description: "Dated Outreach activity reference or exact title", type: 3, required: true },
      { name: "start", description: "Local start time in HH:MM format", type: 3, required: true },
      { name: "end", description: "Local end time in HH:MM format", type: 3, required: true },
      { name: "notes", description: "Private task notes for Staff", type: 3 },
    ] },
    { name: "outreach-correction", type: 1, description: "Ask Staff to review linked Outreach participation", options: [
      { name: "message", description: "What Staff should review", type: 3, required: true },
      { name: "receipt", description: "Participation receipt reference", type: 3 },
      { name: "date", description: "Service date in YYYY-MM-DD format", type: 3 },
    ] },
  ],
  reportDatasets: [
    { id: "outreach.members", label: "Members - Outreach", description: "Member-level Outreach participation totals.", rowIdentity: "core.member.identity", capability: "hours.manage", fields: outreachMemberFields, filters: ["period", "roster", "labels", "outreach-labels"], groupBy: ["core.member.identity"], defaultColumns: ["core.member.name", "outreach.member.minutes", "outreach.member.entries", "outreach.member.activities"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [{ dataset: "core.members", localField: "core.member.identity", foreignField: "core.member.identity" }] },
    { id: "outreach.activities", label: "Outreach activities", description: "Dated Outreach activities with participation totals.", rowIdentity: "outreach.activity.id", capability: "hours.manage", fields: outreachActivityFields, filters: ["period", "outreach-labels"], groupBy: ["outreach.activity.id", "outreach.activity.title", "outreach.activity.date", "outreach.activity.labels", "outreach.activity.mode", "outreach.activity.team"], defaultColumns: ["outreach.activity.title", "outreach.activity.date", "outreach.activity.labels", "outreach.activity.participants", "outreach.activity.minutes"], defaultSort: { field: "outreach.activity.date", direction: "desc" }, relationships: [{ dataset: "outreach.entries", localField: "outreach.activity.id", foreignField: "outreach.entry.activity-id" }], fieldAliases: { "outreach.activity.category": "outreach.activity.labels" } },
    { id: "outreach.entries", label: "Outreach entries", description: "Individual Outreach participation entries.", rowIdentity: "outreach.entry.id", capability: "hours.manage", fields: outreachEntryFields, filters: ["period", "outreach-labels"], groupBy: ["outreach.entry.id", "outreach.entry.member", "outreach.entry.activity", "outreach.entry.date", "outreach.entry.channel", "outreach.entry.status"], defaultColumns: ["outreach.entry.member", "outreach.entry.activity", "outreach.entry.date", "outreach.entry.minutes", "outreach.entry.channel"], defaultSort: { field: "outreach.entry.date", direction: "desc" }, relationships: [{ dataset: "outreach.activities", localField: "outreach.entry.activity-id", foreignField: "outreach.activity.id" }] },
    { id: "outreach.teams", label: "Supported teams", description: "Supported-team participation totals from designated team-support activities.", rowIdentity: "outreach.team.id", capability: "hours.manage", fields: outreachTeamFields, filters: ["period", "outreach-labels"], groupBy: ["outreach.team.id", "outreach.team.name", "outreach.team.number", "outreach.team.program"], defaultColumns: ["outreach.team.name", "outreach.team.number", "outreach.team.program", "outreach.team.participants", "outreach.team.minutes"], defaultSort: { field: "outreach.team.name", direction: "asc" }, relationships: [{ dataset: "outreach.activities", localField: "outreach.team.id", foreignField: "outreach.activity.team-id" }] },
  ],
  // Saved reports have always stored this filter as outreachLabelIds and outreachLabelMatch; those names stay.
  reportFilters: [{ id: "outreach-labels", kind: "option-set", label: "Outreach labels", optionLabel: "Outreach label", optionNoun: "label", selectionKey: "outreachLabelIds", matchKey: "outreachLabelMatch" }],
  walkthroughs: { outreach: { version: 1, steps: ["activities", "member-submissions", "submission-log", "corrections", "manual-entry", "reports-handoff"] } },
  apiRoutes: [
    { path: "/module-setup/hour-tracking", match: "prefix", access: "setup" },
    { path: "/admin/hours", match: "prefix", access: "workspace" },
    { path: "/public/hours", match: "prefix", access: "service" },
  ],
  tablePrefix: "hours_",
  persistence: {
    tables: [
      "hours_categories", "hours_labels", "hours_teams", "hours_activities", "hours_activity_labels", "hours_entry_settings", "hours_entries", "hours_entry_revisions",
      "hours_submission_keys", "hours_reopen_windows", "hours_correction_requests", "hours_correction_resolutions",
      "hours_publication_settings", "hours_activity_publications", "hours_publication_operations",
      "hours_public_form_settings", "hours_public_lookup_limits",
    ],
    sharedFields: [],
    transientAuthority: [
      { table: "hours_publication_operations", columns: ["status", "next_attempt_at", "lease_token", "lease_expires_at"] },
    ],
  },
  // Version 3 is the plugin section. Version 2 rows come only from Core's section of backups made while Outreach was first-party.
  backup: {
    version: 3,
    tables: [
      "hours_categories", "hours_labels", "hours_teams", "hours_activities", "hours_activity_labels", "hours_entry_settings", "hours_entries", "hours_entry_revisions",
      "hours_submission_keys", "hours_reopen_windows", "hours_correction_requests", "hours_correction_resolutions",
      "hours_publication_settings", "hours_activity_publications", "hours_publication_operations",
      "hours_public_form_settings",
    ],
    nonPortableTables: ["hours_public_lookup_limits"],
  },
  lifecycle: {
    cleanupTargets: [
      "hours_publication_operations", "hours_activity_publications", "hours_correction_resolutions", "hours_correction_requests",
      "hours_reopen_windows", "hours_submission_keys", "hours_entry_revisions", "hours_entries", "hours_activities", "hours_teams",
      "hours_categories", "hours_publication_settings", "hours_entry_settings", "platform_module_setup_progress:hour-tracking", "platform_module_assignments:hour-tracking", "hours_activity_labels", "hours_labels",
      "hours_public_form_settings", "hours_public_lookup_limits",
    ],
  },
  deletedData: [
    "Outreach labels, supported teams, and activities",
    "Member submissions, staff exceptions, integer-minute totals, and immutable entry history",
    "Outreach setup and assignment records",
  ],
});

export default manifest;
