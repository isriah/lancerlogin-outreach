# LancerLogin Outreach plugin

Outreach Participation records the service hours members contribute to outreach activities, through a public submission form or Discord, with staff review, reporting and optional activity publication.

This repository is a LancerLogin module plugin (module ID `hour-tracking`). LancerLogin composes it into an installation's own build at an exact commit. See LancerLogin's `docs/MODULE-PLUGINS.md` for how plugins are selected, composed, updated and removed.

## Selecting the plugin

Outreach is LancerLogin's first official plugin. Every installation build includes it by default at the commit LancerLogin pins in `scripts/official-modules.json`, so an installation needs no selection entry. An installation can pin a different Outreach release by listing `hour-tracking` in its `lancerlogin.modules.json`, or opt out of all official plugins with `"officialModules": false`.

```json
{
  "format": 1,
  "modules": [
    { "id": "hour-tracking", "source": "https://github.com/isriah/lancerlogin-outreach.git", "commit": "<full 40-character commit SHA>" }
  ]
}
```

- Pins are always full commit SHAs. Tags and branches are refused. Choose a release, then pin the commit it points to.
- From a LancerLogin Core checkout, `npm run plugins:resolve -- --selection path/to/lancerlogin.modules.json --track stable --module hour-tracking` writes the commit of the newest stable release into the selection. Use `--track beta` or `--track nightly` for the other tracks.
- This repository is public, so the deployment repository needs no token to fetch this plugin. `LANCERLOGIN_PLUGIN_TOKEN` only matters for private plugins.

## Compatibility

| Plugin | LancerLogin Core | Module contract |
| --- | --- | --- |
| 1.0.x | `>=2.0.0-beta.11 <3.0.0` (Modular 2.0.0-beta.11 and later 2.x releases) | 1 |
| 1.1.x | `>=2.0.0-beta.15 <3.0.0` (Modular 2.0.0-beta.15, the first Core with module SDK 1.1.0, and later 2.x releases) | 1 |
| 1.2.x | `>=2.1.0-beta.3 <3.0.0` (Core 2.1.0-beta.3, the first Core with module SDK 1.2.0 and its shared FIRST connection, `services.first`, and later 2.x releases) | 1 |
| 1.3.x | `>=2.1.0-beta.7 <3.0.0` (Core 2.1.0-beta.7, the first Core with module SDK 1.5.0, and later 2.x releases) | 1 |

The supported Core range is the `lancerlogin.core` field in `package.json`. Composition refuses this plugin for a Core outside that range, before an installation build or web update starts. React and `@lancerlogin/module-sdk` are peer dependencies provided by Core; the `@lancerlogin/module-sdk` range also refuses a Core whose SDK is too old.

## Member self-logging

On the public form, a member chooses what they are logging: a **Scheduled activity** Staff created (a dated activity), **Team support** or **Other service**. Team support and Other service take a service date inside the reporting window and a duration in whole minutes (1 to 1440), with no start or end time, and count immediately; Staff can edit or void them like any entry.

- **Team support** names a team on the supported teams list, or a new team by number, program and name. A new team is matched to an existing one by number and program, ignoring letter case and surrounding spaces, and is otherwise added to the list flagged as added by a member. See [Checking team numbers with FIRST](#checking-team-numbers-with-first). **Settings > Outreach > Supported teams** shows the flag, filters to member-added teams and lets Staff mark one reviewed. The entry joins the Team Support activity for that team and date, which is created when there is none.
- **Other service** takes a short description (up to 150 characters), such as "STEM tutoring". The entry joins the Other Service activity with that title on that date, created when there is none, and keeps the description in its notes.

Duration-only entries store their interval anchored at the start of the service day so totals, receipts and history are unchanged, and they never count as overlapping other participation. Reports show no start or end time for them.

## Checking team numbers with FIRST

When a member adds a new team, the public form checks its number and program with FIRST through Core's shared FIRST connection (`services.first`, module SDK 1.2.0), which an Admin sets up in **Settings > Integrations > FIRST**. Outreach never contacts FIRST itself and never sees the credentials.

- The form checks a 1- to 6-digit number about half a second after the member stops typing, once a program is chosen, through `GET /public/hours/team-lookup?program=&number=`. That route answers only `{ "status": "found", "name": "..." }`, `{ "status": "not-found" }` or `{ "status": "unavailable" }`, never FIRST's other team details or why it is unavailable.
- **Found:** FIRST's name fills in the team name, which is locked until the number or program changes.
- **Not found:** the form warns that FIRST has no such team, and the member can still submit with a typed name.
- **Unavailable** (no credential for that program, FIRST rate limits or errors, or a number that is not 1 to 6 digits): the form says nothing and the member types the name.
- FLL Challenge and Explore are checked too, with FIRST's public team search, which needs no credential.
- On submission, Outreach checks again on the server before it adds the team, and stores FIRST's name instead of the typed one when FIRST finds the team. It asks only for a team that is not already on the supported teams list, and never refuses a submission because FIRST is unavailable or has no such team. Retrying an exact submission returns the saved receipt without asking again.
- Core caches answers and allows each public visitor 10 uncached lookups a minute, so a rate-limited check reads as unavailable.

## Importing activities from CSV

**Import CSV**, just left of **+ Create activity** on the Outreach page (`/hours`) (on phones the calendar view shows it below the month navigation instead), imports up to 200 dated activities of any type from a CSV file or rows pasted from a spreadsheet, for anyone who can create activities (Admins and Operators, `hours.manage`). It works like Core's meeting import and uses the module SDK 1.4.0 CSV kit: **Download template** gives the columns with synthetic examples, and **Preview activities** shows every row before anything is saved.

| Column | Required | Also matched | Rule |
| --- | --- | --- | --- |
| Title | Yes | Activity, Event, Name | 1 to 150 characters |
| Date | Yes | Service date, Event date | MM/DD/YYYY, such as 11/14/2026, or 2026-11-14 |
| Type | No | Activity type, Mode | Event, Team support or Other service; Event when blank |
| Start time, End time | No | Start, End | Events only, both or neither (neither is all day); 24-hour or AM/PM, in five-minute steps, in the installation's time zone |
| Supported team | Team support only | Team, Team number | A team number or exact name of a supported team that is not archived |
| Labels | No | Outreach labels | Active Outreach label names, separated by `;` |
| Location | No | Place, Venue | Up to 300 characters |
| Description | No | Details, Notes | Up to 4,000 characters |
| Impact relevant | No | Impact, Counts toward impact | yes or no; yes when blank |

- **Checks.** Rows are checked as saving an activity checks them, in the preview and again on the server. A row with a problem stays listed with its reason and is skipped; the other rows can still be imported. A local time that clocks skip for daylight saving time is a problem; one they repeat uses the first occurrence, with a warning.
- **Matching.** A row with the same date, type, title (ignoring letter case) and supported team as an active activity matches it. Each matching row has a **Skip** or **Update** choice, and **Matching rows: Skip all / Update all** sets them all (Mixed when they differ); Skip is the default. An update shows old and new values, changes only the columns the file has, and is saved as editing the activity saves it, at its current revision.
- **Event publication.** An imported or updated Event that has not ended yet is queued to each destination whose automatic switch is on, and an updated Event to each destination it is already published to, as saving it does; the preview notes where. Delivery is left to the `hour-tracking.publication` job (5 deliveries a run), so an import makes no provider requests.
- **Budget.** `POST /admin/hours/activities/import` takes `{ rows, dryRun, actions }`; a dry run returns each row's result. A commit writes every row that is not a problem, its labels and its Event publication in one D1 batch with one `outreach.activities.imported` audit row, and rolls back entirely if an activity changed since the request read it. A 200-row commit makes at most 9 D1 queries plus Core's two destination status reads.

## Event publication

Event activities can be published as Discord scheduled events and Google Calendar events through Core's shared connections, which an Admin sets up in **Settings > Integrations**. Team Support and Other Service activities are never published. Outreach creates no channel posts; an Event's location goes in the Discord event's description. Staff publish, update, unpublish or retry one Event with the destination icons in its details.

- **Automatic publication.** **Settings > Outreach > General** has one switch per destination, **Publish Events to Discord automatically** and **Publish Events to Google Calendar automatically**, both off by default. A destination that is not set up shows its switch disabled with a link to **Settings > Integrations**. Saving an Event that has not ended yet queues it to the destinations whose switch is on.
- **Keeping published Events in sync.** Once an Event is published to a destination, editing it queues an update there even with that switch off. Archiving it or changing it to another activity type removes it there.
- **Publish upcoming Events** queues active Events that have not ended yet, up to 100 in one run and 5 per request, so each request stays within the Workers Free plan's 50 D1 queries, to each destination that is on and set up (`POST /admin/hours/publication-destinations/backfill`). An Event already published or waiting there is skipped, so turning on a second destination publishes only to it. The card offers it once, with a confirmation, when a switch is turned on; it never runs by itself.
- **Delivery.** Saving or publishing an Event makes its first delivery attempt in that request: one Event, at most one delivery per destination. What fails or is left waits for the `hour-tracking.publication` job, which delivers up to 5 queued deliveries every 5 minutes, so a run stays well within the Workers Free plan's 50 subrequests and 50 D1 queries (a delivery makes at most 3 provider requests, plus a token refresh for Google Calendar, and about 5 queries). The job runs in the same maintenance pass as Core's meeting calendar sync and on the same Discord server's scheduled-event routes. The card shows each destination's deliveries waiting and needing another attempt, and the latest problem. Retries match meeting calendar sync: a Discord permission error or rate limit stops that run's deliveries to Discord (Google Calendar continues); a rate limit waits what the provider asked for, from a minute to an hour, without counting an attempt; other failures retry with a backoff that doubles from a minute up to an hour, for as long as they last; a refusal that repeats (a permission error, Discord's limit of 100 scheduled events per server, or another 4xx) waits for **Retry** in the Event's publication menu, which says when a failed delivery retries by itself.
- **Settings routes.** `GET` and `PATCH /admin/hours/publication-destinations` read and set one destination's switch (`{ provider, automatic, revision }`) and return every destination's switch and delivery status. The original `/admin/hours/publication-settings` (`{ automatic, revision }`) still works: `automatic` reads as on while either switch is on, and setting it sets both. Both, and Publish upcoming Events, are Admin settings.

## Team support for other modules

Outreach provides the `hour-tracking.team-support` interface (version 1) so other modules, such as Guest Visits, can record team support without touching Outreach's tables. Its operations find supported teams by number and program, create a supported team when none matches, and create the one Team Support activity for a team and date. Each operation is idempotent and refuses archived teams. A module uses it only with an Administrator's grant in **Settings > Modules > Module access**, or for a signed-in user who can manage Outreach. Outreach records each creation in the audit log with the calling module.

## Release tracks

Releases follow the same rules as LancerLogin itself. The highest version wins, never the most recent publication.

| Track | Tags | Offered to | Use for |
| --- | --- | --- | --- |
| Stable | `vX.Y.Z` | Stable, Beta and Nightly | Production installations |
| Beta | `vX.Y.Z-beta.N`, GitHub prerelease | Beta and Nightly | Installations that opted in to early releases |
| Nightly | `vX.Y.Z-nightly.YYYYMMDD`, GitHub prerelease | Nightly only | **Test installations only** |

- `1.1.0-beta.10` follows `1.1.0-beta.9`, and `1.1.0` follows every `1.1.0-beta.N`.
- A nightly sorts below every beta of the same version and is never offered to the Stable or Beta tracks. Nightly builds come straight from `main`, have generated notes and receive no review beyond automated verification. Never pin one on an installation people depend on.
- Published releases are immutable. A tag is never moved or reused, and a published release is never replaced.

Patch notes for each stable and beta release are in [docs/releases](docs/releases/README.md); [CHANGELOG.md](CHANGELOG.md) summarizes every release.

## Continuous integration

**Verify** (`.github/workflows/ci.yml`) runs on every push to `main`, every pull request and on demand. It checks out the LancerLogin Core commit pinned in `.github/plugin-release.json` from the public [isriah/LancerLogin](https://github.com/isriah/LancerLogin) repository (currently Core `v2.1.0-beta.7`, pinned by its full commit SHA; the tag is recorded beside it for people), composes this plugin commit into it and runs Core's acceptance module gate for `hour-tracking` (`npm run verify:module -- acceptance hour-tracking`): the plugin's Core-side tests, browser specs, typechecks and builds. Plugin tests cannot skip in CI.

Verify also runs a second, non-blocking entry, **verify against Core main**: the same checks with this commit composed into the `main` branch of that Core repository. It shows a change in Core that breaks this plugin before the pin moves. Core main can change without this plugin changing, so a failure there doesn't block pull requests, releases or nightly builds (they require the pinned `verify` job), but it is a warning to act on: fix the plugin, or report the Core change.

No repository secrets are needed. Core and every plugin it composes are public; `scripts/verify-with-core.mjs` clones the other plugins Core pins anonymously. Two optional secrets are used only when set, for a Core pin that is ever private again: `LANCERLOGIN_CORE_TOKEN` (Contents: read on that Core repository) and `LANCERLOGIN_PLUGIN_TOKEN` (read access to private plugin repositories that Core composes).

To test against a newer Core release, update `core.commit` (the full commit SHA of the release tag) and `core.tag` in `.github/plugin-release.json` in its own pull request.

Run the same gate locally from a clean commit with a Core checkout beside it: `git clone https://github.com/isriah/LancerLogin.git ../LancerLogin`, `git -C ../LancerLogin checkout <core.commit>`, `npm ci` in that checkout, then `npm run verify:core -- ../LancerLogin` (add `--mode fast` for the logic tests only). The plugin's own tests run with `npm ci` and then `npm test`; neither needs Core. `tests/*.test.ts` mirror the Core tests that exercise this plugin's own code (catalogs, entries, review, publication, public routes, participation, reporting and walkthrough text) on Core's real table definitions, dumped from Core into `tests/fixtures/core-tables.sql`. `.npmrc` sets `legacy-peer-deps` because Core provides the peer dependencies when it composes the plugin, so npm never installs them here. For writing plugins, see `docs/PLUGIN-AUTHORING.md` in isriah/LancerLogin (available from the next Modular release).

## Releasing

1. On `main`, set `package.json` `version`, add `docs/releases/vX.Y.Z.md` (title `# LancerLogin Outreach plugin vX.Y.Z`, a short summary, then **Bugs fixed**, **Features added** and **Features removed**, writing `None.` for an empty section) and a `## [X.Y.Z] - YYYY-MM-DD` entry in `CHANGELOG.md`. Commit them as `Release vX.Y.Z`.
2. Wait for **Verify** to pass for that exact commit on `main`.
3. Tag the commit and push the tag: `git tag vX.Y.Z <commit>` and `git push origin vX.Y.Z`.
4. **Release plugin** (`.github/workflows/release.yml`) checks the version, notes, changelog and release commit, requires the successful Verify run for that exact commit, and prepares a draft release with the patch notes.
5. Publish from a checkout of this repository with your GitHub CLI login: `node scripts/plugin-release.mjs publish vX.Y.Z` to check, then `node scripts/plugin-release.mjs publish vX.Y.Z --publish`. Publication requires immutable releases to be enabled, rechecks the tag, commit, Verify run and notes, publishes beta releases as prereleases, and makes a stable release Latest only when it is higher than the current Latest.
6. Update Outreach's pin in LancerLogin Core's `scripts/official-modules.json` with `npm run plugins:resolve -- --selection scripts/official-modules.json --track stable` in a Core change, so the next LancerLogin release ships it.

**Nightly plugin build** (`.github/workflows/nightly.yml`) runs daily and on demand from `main`. It publishes `vX.Y.Z-nightly.YYYYMMDD` only when `main` has commits that are not in any release and Verify passed for that exact commit. Its version is above every stable and beta release, so the Nightly track always offers it, and its notes list the commits since the previous release. It never becomes Latest.

## License

Apache-2.0. See [LICENSE](LICENSE).
