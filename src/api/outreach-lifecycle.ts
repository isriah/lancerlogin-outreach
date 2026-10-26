import type { CleanupStep } from "@lancerlogin/module-sdk/api";

/** Outreach retained-data cleanup. Step order is persisted as a cursor, so only append. */
export const outreachCleanupSteps: readonly CleanupStep[] = [
  { kind: "delete", table: "hours_publication_operations" },
  { kind: "delete", table: "hours_activity_publications" },
  { kind: "delete", table: "hours_correction_resolutions" },
  { kind: "delete", table: "hours_correction_requests" },
  { kind: "delete", table: "hours_reopen_windows" },
  { kind: "delete", table: "hours_submission_keys" },
  { kind: "delete", table: "hours_entry_revisions" },
  { kind: "delete", table: "hours_entries" },
  { kind: "delete", table: "hours_activities" },
  { kind: "delete", table: "hours_teams" },
  { kind: "delete", table: "hours_categories" },
  { kind: "delete", table: "hours_entry_settings" },
  { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["hour-tracking"] },
  { kind: "assignments" },
  // Appended so an in-progress retained-data cursor keeps its historical meaning.
  { kind: "delete", table: "hours_activity_labels" },
  { kind: "delete", table: "hours_labels" },
  { kind: "delete", table: "hours_public_form_settings" },
  { kind: "delete", table: "hours_public_lookup_limits" },
];

/** Leased Outreach publication work that must drain before deletion. Binds the installation once. */
export const outreachCleanupBlocker = "EXISTS(SELECT 1 FROM hours_publication_operations WHERE installation_id=? AND status='processing' AND julianday(lease_expires_at)>julianday('now'))";
