# Changelog

All notable changes to the LancerLogin Outreach plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

## [Unreleased]

Events can publish automatically to each destination on its own: **Settings > Outreach > General** replaces **Automatically publish Events** with **Publish Events to Discord automatically** and **Publish Events to Google Calendar automatically**, each disabled with a link to **Settings > Integrations** until that destination is set up. Installations that had automatic publication on get both switches on. An Event already published to a destination is updated there whenever it is edited, even with that switch off. **Publish upcoming Events** queues up to 100 active Events that have not ended yet to the destinations that are on, and is offered once when a switch is turned on. Saving or publishing an Event makes its first delivery attempt right away, and the queue delivers at most 5 a run, within the Workers Free plan's limits. Under each switch the card shows its deliveries waiting and needing another attempt, and the latest problem. Deliveries now retry like meeting calendar sync: a Discord permission error or rate limit stops that run's Discord deliveries, a rate limit waits what Discord asks for without counting an attempt, other failures retry with backoff up to an hour instead of giving up after 6 attempts, and a refusal that repeats, such as Discord's limit of 100 scheduled events, waits for **Retry**. An Event's publication menu says when a failed delivery retries. A first Discord delivery creates its event without listing the server's events first. The Discord publication button uses Discord's current logo. Adds migration 0002 and Outreach backup version 5.

## [1.2.0] - 2026-11-01

Members can log **Team support** and **Other service** time from the public form without a Staff-created activity: a service date and minutes, with no start or end time, counted right away and shown to Staff as **Duration only**. A team a member adds is checked with FIRST through LancerLogin's shared FIRST connection, which fills in its name, and is marked **Added by a member** in **Settings > Outreach > Supported teams** until Staff mark it reviewed. The public form no longer has a Staff sign in link. Adds migration 0001 and Outreach backup version 4. Supports LancerLogin Core `>=2.1.0-beta.3 <3.0.0` (module SDK 1.2.0). See [v1.2.0](docs/releases/v1.2.0.md).

## [1.1.0] - 2026-10-28

Other plugins, such as Guest Visits, can record team support in Outreach through the `hour-tracking.team-support` interface once an Administrator grants access: find or add a supported team and create its Team Support activity. Supports LancerLogin Core `>=2.0.0-beta.15 <3.0.0` (module SDK 1.1.0). See [v1.1.0](docs/releases/v1.1.0.md).

## [1.0.0] - 2026-10-26

This first standalone release packages Outreach Participation as LancerLogin's first official module plugin. Supports LancerLogin Core `>=2.0.0-beta.11 <3.0.0`. See [v1.0.0](docs/releases/v1.0.0.md).
