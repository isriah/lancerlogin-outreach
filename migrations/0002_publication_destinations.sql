-- Each Event publication destination has its own automatic switch. An installation that published every Event
-- automatically keeps both destinations on, and one that did not keeps both off.

-- The automatic column stays and mirrors whether either switch is on, for callers of the original settings route.
ALTER TABLE hours_publication_settings ADD COLUMN google_calendar_automatic INTEGER NOT NULL DEFAULT 0 CHECK(google_calendar_automatic IN (0,1));
ALTER TABLE hours_publication_settings ADD COLUMN discord_automatic INTEGER NOT NULL DEFAULT 0 CHECK(discord_automatic IN (0,1));
UPDATE hours_publication_settings SET google_calendar_automatic=automatic,discord_automatic=automatic;
