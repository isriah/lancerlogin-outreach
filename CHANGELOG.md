# Changelog

All notable changes to the LancerLogin Outreach plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

## [1.2.0] - 2026-11-01

Members can log **Team support** and **Other service** time from the public form without a Staff-created activity: a service date and minutes, with no start or end time, counted right away and shown to Staff as **Duration only**. A team a member adds is checked with FIRST through LancerLogin's shared FIRST connection, which fills in its name, and is marked **Added by a member** in **Settings > Outreach > Supported teams** until Staff mark it reviewed. The public form no longer has a Staff sign in link. Adds migration 0001 and Outreach backup version 4. Supports LancerLogin Core `>=2.1.0-beta.3 <3.0.0` (module SDK 1.2.0). See [v1.2.0](docs/releases/v1.2.0.md).

## [1.1.0] - 2026-10-28

Other plugins, such as Guest Visits, can record team support in Outreach through the `hour-tracking.team-support` interface once an Administrator grants access: find or add a supported team and create its Team Support activity. Supports LancerLogin Core `>=2.0.0-beta.15 <3.0.0` (module SDK 1.1.0). See [v1.1.0](docs/releases/v1.1.0.md).

## [1.0.0] - 2026-10-26

This first standalone release packages Outreach Participation as LancerLogin's first official module plugin. Supports LancerLogin Core `>=2.0.0-beta.11 <3.0.0`. See [v1.0.0](docs/releases/v1.0.0.md).
