// The Outreach part of the walkthrough guidance test in LancerLogin Core's tests-ts/outreach/walkthrough-guidance.ts (its
// one test). Core composes this plugin's walkthrough into its page walkthroughs and also checks guidance that is Core's
// own (meeting contests, fingerprints); those assertions and the composition stay in Core. This file checks the text
// that this plugin contributes.
import test from "node:test";
import assert from "node:assert/strict";
import { outreachWalkthrough } from "../src/dashboard/outreach-walkthrough.ts";

test("walkthrough guidance distinguishes public IDs from a login and names the Admin's choice", () => {
  assert.equal(outreachWalkthrough.pageId, "outreach");
  const submission = outreachWalkthrough.steps.find((step) => step.id === "member-submissions")!;
  assert.match(submission.description, /public ID entry is not a login/);
  assert.match(submission.description, /Admins choose whether/);
});
