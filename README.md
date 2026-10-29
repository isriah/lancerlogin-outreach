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

The supported Core range is the `lancerlogin.core` field in `package.json`. Composition refuses this plugin for a Core outside that range, before an installation build or web update starts. React and `@lancerlogin/module-sdk` are peer dependencies provided by Core; the `@lancerlogin/module-sdk` range also refuses a Core whose SDK is too old.

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

**Verify** (`.github/workflows/ci.yml`) runs on every push to `main`, every pull request and on demand. It checks out the LancerLogin Core commit pinned in `.github/plugin-release.json` from the public [isriah/LancerLogin](https://github.com/isriah/LancerLogin) repository (currently Modular `v2.0.0-beta.16`, pinned by its full commit SHA; the tag is recorded beside it for people), composes this plugin commit into it and runs Core's acceptance module gate for `hour-tracking` (`npm run verify:module -- acceptance hour-tracking`): the plugin's Core-side tests, browser specs, typechecks and builds. Plugin tests cannot skip in CI.

No repository secrets are needed. Core and every plugin it composes are public; `scripts/verify-with-core.mjs` clones the other plugins Core pins anonymously. Two optional secrets are used only when set, for a Core pin that is ever private again: `LANCERLOGIN_CORE_TOKEN` (Contents: read on that Core repository) and `LANCERLOGIN_PLUGIN_TOKEN` (read access to private plugin repositories that Core composes).

To test against a newer Core release, update `core.commit` (the full commit SHA of the release tag) and `core.tag` in `.github/plugin-release.json` in its own pull request.

Run the same gate locally from a clean commit with a Core checkout beside it: `git clone https://github.com/isriah/LancerLogin.git ../LancerLogin`, `git -C ../LancerLogin checkout <core.commit>`, `npm ci` in that checkout, then `npm run verify:core -- ../LancerLogin` (add `--mode fast` for the logic tests only). The plugin's own release-policy tests run with `npm test`. For writing plugins, see `docs/PLUGIN-AUTHORING.md` in isriah/LancerLogin (available from the next Modular release).

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
