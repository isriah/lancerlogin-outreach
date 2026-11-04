// Event publication controls in the Outreach dashboard, checked in their source as Core's dashboard tests check it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the Discord publication button uses Discord's current Clyde mark, filled", () => {
  const publication = source("dashboard/outreach-activity-publication.tsx");
  // Discord's brand-asset path, as simple-icons publishes it at viewBox 0 0 24 24.
  assert.match(publication, /"M20\.317 4\.3698a19\.7913 19\.7913 0 00-4\.8851-1\.5152[^"]*2\.4189Z"/);
  assert.match(publication, /<path d=\{discordMarkPath\} fill="currentColor" stroke="none" \/>/);
  assert.doesNotMatch(publication, /M7 6c3-2 7-2 10 0/, "the hand-drawn outline is gone");
});
