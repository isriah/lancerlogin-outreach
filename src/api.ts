// Outreach's Worker contribution. Handlers receive Core's module context and the module-scoped database; plugins never see
// the Worker environment, so the public submission route checks requests against Core's dashboard origin from the context.
import { defineApiModule } from "@lancerlogin/module-sdk/api";
import { outreachBackupAdapter } from "./api/outreach-backup.ts";
import { outreachCatalogRoute, outreachSetupRoute } from "./api/outreach-catalogs.ts";
import { outreachDiscordHandlers } from "./api/outreach-discord.ts";
import { outreachEntryRoute } from "./api/outreach-entries.ts";
import { outreachCleanupBlocker, outreachCleanupSteps } from "./api/outreach-lifecycle.ts";
import { outreachSetupPredicates, outreachSetupStepValid } from "./api/outreach-module-setup.ts";
import { outreachPublicRoute } from "./api/outreach-public.ts";
import { publicFormSettingsRoute } from "./api/outreach-public-settings.ts";
import { outreachPublicationRoute, processOutreachPublicationOperations } from "./api/outreach-publication.ts";
import { outreachPublicationProviders } from "./api/outreach-publication-providers.ts";
import { outreachLabelFilterOptions, outreachReportHandlers } from "./api/outreach-reporting.ts";
import { outreachReviewRoute } from "./api/outreach-review.ts";

const defaultCategories = [["event", "Event", "event"], ["team-support", "Team Support", "team"], ["other-service", "Other Service", "task"]] as const;

const api = defineApiModule({
  moduleId: "hour-tracking",
  routes: {
    async "/module-setup/hour-tracking"(context) {
      if (!context.url.pathname.startsWith("/module-setup/hour-tracking/")) return undefined;
      const principal = await context.requireRole(["admin"]);
      const routed = await outreachSetupRoute(context.db, principal.userId, context.request, await context.body());
      return context.respond(routed.body, routed.status);
    },
    async "/admin/hours"(context) {
      const path = context.url.pathname;
      if (path === "/admin/hours/public-form-settings") {
        const principal = await context.requireRole(["admin"]);
        const routed = await publicFormSettingsRoute(context.db, principal.userId, context.request, await context.body());
        return context.respond(routed.body, routed.status);
      }
      if (path === "/admin/hours/publication-settings") {
        const principal = await context.requireRole(["admin"]);
        const routed = await outreachPublicationRoute(context.db, outreachPublicationProviders(context.services), principal.userId, context.request, await context.body());
        return context.respond(routed.body, routed.status);
      }
      if (path === "/admin/hours/publications" || path === "/admin/hours/publication-providers" || /^\/admin\/hours\/activities\/[^/]+\/publication(?:\/|$)/.test(path)) {
        const principal = await context.requireRole(["admin", "operator"]);
        const routed = await outreachPublicationRoute(context.db, outreachPublicationProviders(context.services), principal.userId, context.request, await context.body());
        return context.respond(routed.body, routed.status);
      }
      if (/^\/admin\/hours\/(reopen-windows|corrections)(?:\/|$)/.test(path)) {
        const principal = await context.requireRole(["admin", "operator"]);
        const routed = await outreachReviewRoute(context.db, principal.userId, context.request, await context.body());
        return context.respond(routed.body, routed.status);
      }
      if (/^\/admin\/hours\/(context|member-choices|totals|entries)(?:\/|$)/.test(path)) {
        const principal = await context.requireRole(["admin", "operator"]);
        if (context.request.method === "PATCH") context.requireDashboardOrigin("Participation edits require the dashboard origin");
        const routed = await outreachEntryRoute(context.db, principal.userId, context.request, await context.body());
        return context.respond(routed.body, routed.status);
      }
      if (!path.startsWith("/admin/hours/")) return undefined;
      const principal = await context.requireRole(["admin", "operator"]);
      const routed = await outreachCatalogRoute(context.db, principal.userId, context.request, await context.body(), outreachPublicationProviders(context.services));
      return context.respond(routed.body, routed.status);
    },
    async "/public/hours"(context) {
      if (!context.url.pathname.startsWith("/public/hours/")) return undefined;
      const routed = await outreachPublicRoute(context.db, context.request, context.dashboardOrigin ?? context.url.origin, await context.body());
      return context.respond(routed.body, routed.status);
    },
  },
  privateResponseRoutes: ["/public/hours"],
  setup: { predicates: outreachSetupPredicates, stepValid: outreachSetupStepValid },
  jobs: {
    "hour-tracking.publication": ({ db, services }) => processOutreachPublicationOperations(db, outreachPublicationProviders(services)),
  },
  reports: outreachReportHandlers,
  reportFilters: { "outreach-labels": { options: outreachLabelFilterOptions } },
  discord: outreachDiscordHandlers,
  // Roster members with participation history cannot be deleted; Core asks Admins to deactivate them instead.
  rosterReferences: { label: "Outreach", columns: [{ table: "hours_entries", column: "member_id" }, { table: "hours_correction_requests", column: "requester_member_id" }] },
  cleanup: { steps: outreachCleanupSteps, blocker: { sql: outreachCleanupBlocker, bindings: (installationId) => [installationId] } },
  // The rows a first-party installation received at creation, now created idempotently on first enablement (and on
  // enablement after completed deletion). Existing rows, including settings kept through an earlier deletion, are unchanged.
  freshEnable: (db, { installationId, now }) => [
    db.prepare("INSERT OR IGNORE INTO hours_entry_settings(installation_id) VALUES(?)").bind(installationId),
    db.prepare("INSERT OR IGNORE INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES(?,0,0,?,?)").bind(installationId, now, now),
    ...defaultCategories.map(([id, name, mode]) => db.prepare("INSERT OR IGNORE INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)").bind(installationId, id, name, mode, now, now)),
  ],
  backup: outreachBackupAdapter,
});

export default api;
