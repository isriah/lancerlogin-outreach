import type { WalkthroughExperienceDefinition } from "@lancerlogin/module-sdk/dashboard";

export const outreachWalkthrough: WalkthroughExperienceDefinition = {
  pageId: "outreach",
  readySelector: '[data-walkthrough-page="outreach"][data-walkthrough-ready="true"]',
  returnFocusSelector: '[data-walkthrough-page="outreach"]',
  welcomeTitle: "Follow the Outreach workflow",
  welcomeDescription: "Learn how staff plan activities, receive member participation, review exceptions, and continue into Reports. This tour will not change Outreach records.",
  finishTitle: "You're ready to manage Outreach",
  finishDescription: "Start with a dated activity, review the Submission Log and corrections in context, use staff entry only for an exception, and open Reports for totals and analysis.",
  steps: [
    { id: "activities", title: "Start with a dated activity", description: "Create a dated activity with a title, labels, and optional team or event times. Open an activity to review each member's counted hours and expand their individual submissions. Planned event times do not set a member's actual hours.", targets: '[data-walkthrough="outreach-activities"]' },
    { id: "member-submissions", title: "Let members submit their participation", description: "Members normally record completed participation through the public form using their roster ID, or through a linked Discord account. Admins choose whether the public form checks IDs or reveals a matching name; public ID entry is not a login.", targets: '[data-walkthrough="outreach-submission-sources"]' },
    { id: "submission-log", title: "Review the Submission Log", description: "Expand Submission Log below the activity browser to review counted and void entries together with their member, activity, time, source, notes, and staff attribution when applicable.", targets: '[data-walkthrough="outreach-submission-log"]' },
    { id: "corrections", title: "Review corrections inside the activity", description: "Corrections appears when a request needs review. Choose Review in activity so staff can compare the request with that activity and preserve the decision as immutable history.", targets: '[data-walkthrough="outreach-corrections"]' },
    { id: "manual-entry", title: "Use staff entry only for an exception", description: "In Calendar, choose the activity date, or switch to Table and choose an activity. Open the dated activity and choose Add member participation when staff must record an exception. The entry requires a staff reason and remains attributed to Staff.", targets: '[data-walkthrough="outreach-staff-exception"], [data-walkthrough="outreach-activities"]' },
    { id: "reports-handoff", title: "Continue into Reports", description: "Open Reports for member, activity, entry, and supported-team totals. Keeping analysis there leaves Outreach focused on operational records and review.", targets: '#primary-dashboard-navigation a[href="/reports"]', navigation: true },
  ],
};
