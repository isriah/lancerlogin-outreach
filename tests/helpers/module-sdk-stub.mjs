// The parts of @lancerlogin/module-sdk/api that Outreach logic uses at runtime. Core provides the real SDK in a composed
// build; this stand-in lets the plugin's own tests run without a Core checkout. The report helpers keep only what the
// plugin's projections need: rows carry their cells, no Core roster is read, and filters and sorting are not applied.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const reportRow = (_definition, id, label, values) => ({ id, label, values });
export const filterAndSortReportRows = (_definition, rows) => rows;
export const reportFilterSelection = () => ({ ids: [], match: "any" });
export const reportRosterData = async () => ({ members: [], labels: new Map() });
export const reportMemberIncluded = () => true;
export const reportMemberValues = () => ({});

/** The Worker contribution as declared, so a test can call its route handlers with a stand-in context. */
export const defineApiModule = (definition) => definition;
