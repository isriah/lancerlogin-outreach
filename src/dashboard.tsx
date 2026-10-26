// Outreach's dashboard contribution. It imports only the module SDK and React; the composed dashboard provides one shared
// copy of each. Core renders every page, setup screen and the public submission page inside the module root that scopes
// outreach.css.
import { defineDashboardModule, type DashboardPageContext } from "@lancerlogin/module-sdk/dashboard";
import { OutreachWorkspace } from "./dashboard/outreach-workspace";
import { OutreachSettings } from "./dashboard/outreach-settings";
import { OutreachSetupWorkspace } from "./dashboard/outreach-setup-workspace";
import { outreachWalkthrough } from "./dashboard/outreach-walkthrough.ts";
import { PublicOutreachForm } from "./dashboard/public-outreach-form";
// Imported after the components so Outreach rules follow the Core stylesheets those components load, as they did in Core.
import "./outreach.css";

function workspace({ role, navigate, params }: DashboardPageContext) {
  return <OutreachWorkspace activityId={params.activityId} isAdmin={role === "admin"} onOpenActivity={(id) => navigate(`/hours/activities/${encodeURIComponent(id)}`)} />;
}

function OutreachSetupSettings({ onOpenSetup, isAdmin }: { onOpenSetup?: () => void; isAdmin: boolean }) { return <section className="settings-page settings-guided-setup" aria-labelledby="outreach-settings-title"><div className="page-intro"><h1 id="outreach-settings-title">Outreach</h1><p>Configure defaults and manage supported teams and labels.</p></div><OutreachSettings isAdmin={isAdmin} onOpenSetup={onOpenSetup} /></section>; }

const dashboard = defineDashboardModule({
  moduleId: "hour-tracking",
  routes: [
    { path: "/hours", render: workspace, wide: true },
    { path: "/hours/activities/:activityId+", render: workspace, wide: true },
  ],
  settingsPages: [
    { path: "/settings/outreach-setup", operator: true, render: ({ role, openSetup }) => <OutreachSetupSettings isAdmin={role === "admin"} onOpenSetup={role === "admin" ? openSetup : undefined} /> },
  ],
  setup: OutreachSetupWorkspace,
  walkthroughs: [{ path: "/hours", definition: outreachWalkthrough }],
  // Members record participation and request corrections here without signing in.
  publicPages: [{ path: "/submit-hours", skipLinkLabel: "Skip to submission form", render: () => <PublicOutreachForm /> }],
});

export default dashboard;
