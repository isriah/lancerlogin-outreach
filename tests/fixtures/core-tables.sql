-- LancerLogin Core's own tables that Outreach reads, or that its tables reference, for the tests that mirror Core's
-- Outreach tests. Plugin tests apply tests/fixtures/core-hours-schema.sql and this plugin's migrations on top.
-- Dumped from a database migrated with every migration of LancerLogin Core v2.1.0-beta.5 (commit 86640f17),
-- through 0094_module_update_failures.sql. Tables: audit_log, installations, meeting_weight_categories, meetings, members, organization_settings, platform_modules, users.
-- Core's own triggers are left out: they maintain Core bookkeeping tables that are not here.

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('google', 'local', 'both')),
  telemetry_accepted_at TEXT,
  telemetry_install_id TEXT UNIQUE
, google_enabled INTEGER NOT NULL DEFAULT 0 CHECK (google_enabled IN (0, 1)), resend_enabled INTEGER NOT NULL DEFAULT 0 CHECK (resend_enabled IN (0, 1)), discord_enabled INTEGER NOT NULL DEFAULT 0 CHECK (discord_enabled IN (0, 1)), google_calendar_enabled INTEGER NOT NULL DEFAULT 0
CHECK (google_calendar_enabled IN (0, 1)));

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  email TEXT,
  local_username TEXT,
  password_hash TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL, member_id TEXT REFERENCES members(id) ON DELETE SET NULL, debug_mode INTEGER NOT NULL DEFAULT 0
  CHECK (debug_mode IN (0, 1)), session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(typeof(session_epoch)='integer' AND session_epoch>=0),
  UNIQUE(installation_id, email),
  UNIQUE(installation_id, local_username),
  CHECK (email IS NOT NULL OR local_username IS NOT NULL)
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  discord_user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL, attendance_required_from TEXT, inactive_periods_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(inactive_periods_json) AND json_type(inactive_periods_json) = 'array'),
  UNIQUE(installation_id, external_id)
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
, is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)), series_id TEXT, recurrence_frequency TEXT CHECK (recurrence_frequency IN ('daily', 'weekly', 'biweekly', 'monthly')), recurrence_until TEXT, recurrence_sequence INTEGER, deleted_at TEXT, weight_category_id TEXT REFERENCES meeting_weight_categories(id), weight_category_name TEXT, attendance_weight REAL NOT NULL DEFAULT 1
CHECK (attendance_weight BETWEEN 0.1 AND 100), audience_mode TEXT NOT NULL DEFAULT 'all' CHECK (audience_mode IN ('all', 'labels')));

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE "organization_settings" (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  organization_name TEXT NOT NULL DEFAULT 'LancerLogin',
  subtitle TEXT,
  logo_data TEXT,
  primary_color TEXT NOT NULL DEFAULT '#7c3aed',
  secondary_color TEXT NOT NULL DEFAULT '#0f766e',
  appearance TEXT NOT NULL DEFAULT 'system' CHECK (appearance IN ('system', 'themed', 'light', 'dark')),
  time_zone TEXT NOT NULL
, late_scan_minutes INTEGER NOT NULL DEFAULT 30 CHECK (late_scan_minutes BETWEEN 0 AND 180), logo_backdrop TEXT NOT NULL DEFAULT 'auto' CHECK (logo_backdrop IN ('auto', 'light', 'dark', 'none')), discord_contest_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (discord_contest_window_hours BETWEEN 1 AND 168), attendance_reporting_starts_on TEXT, discord_channel_manager_enabled INTEGER NOT NULL DEFAULT 0
CHECK (discord_channel_manager_enabled IN (0, 1)), anomaly_late_threshold_minutes INTEGER NOT NULL DEFAULT 10
CHECK (anomaly_late_threshold_minutes BETWEEN 0 AND 1440), anomaly_early_threshold_minutes INTEGER NOT NULL DEFAULT 10
CHECK (anomaly_early_threshold_minutes BETWEEN 0 AND 1440), discord_anomaly_reports_enabled INTEGER NOT NULL DEFAULT 0
CHECK (discord_anomaly_reports_enabled IN (0, 1)), discord_anomaly_report_channel_id TEXT, discord_anomaly_reports_enabled_at TEXT, attendance_recent_days INTEGER NOT NULL DEFAULT 30 CHECK (attendance_recent_days BETWEEN 1 AND 365), attendance_policy_activated_on TEXT, kiosk_authentication_method TEXT NOT NULL DEFAULT 'fingerprint'
CHECK(kiosk_authentication_method IN ('fingerprint', 'rfid', 'nfc', 'member_id', 'qr')), discord_block_recontests_after_rejection INTEGER NOT NULL DEFAULT 0 CHECK (discord_block_recontests_after_rejection IN (0, 1)), pin_lockout_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pin_lockout_enabled IN (0, 1)), pin_lockout_attempts INTEGER NOT NULL DEFAULT 5 CHECK (pin_lockout_attempts BETWEEN 3 AND 20), pin_lockout_minutes INTEGER NOT NULL DEFAULT 15 CHECK (pin_lockout_minutes BETWEEN 1 AND 1440));

CREATE TABLE meeting_weight_categories (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 80),
  weight REAL NOT NULL CHECK (weight BETWEEN 0.1 AND 100),
  minimum_duration_minutes INTEGER CHECK (minimum_duration_minutes IS NULL OR minimum_duration_minutes BETWEEN 1 AND 10080),
  position INTEGER NOT NULL CHECK (position >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, name)
);

CREATE TABLE platform_modules (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version) = 'integer' AND contract_version >= 1),
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation >= 1 AND generation < 9007199254740991),
  phase TEXT NOT NULL DEFAULT 'disabled' CHECK(phase IN ('disabled', 'enabled', 'retained', 'deleting', 'deleted')),
  setup_version INTEGER NOT NULL CHECK(typeof(setup_version) = 'integer' AND setup_version >= 1),
  setup_complete INTEGER NOT NULL DEFAULT 1 CHECK(setup_complete IN (0, 1)),
  disabled_at TEXT,
  delete_after TEXT, deletion_cursor INTEGER NOT NULL DEFAULT 0
CHECK(typeof(deletion_cursor) = 'integer' AND deletion_cursor >= 0), cleanup_failure TEXT
CHECK(cleanup_failure IS NULL OR cleanup_failure = 'retry-required'),
  PRIMARY KEY(installation_id, module_id),
  CHECK(
    (phase IN ('disabled', 'enabled', 'deleted') AND disabled_at IS NULL AND delete_after IS NULL)
    OR
    (phase IN ('retained', 'deleting') AND disabled_at IS NOT NULL AND delete_after IS NOT NULL
      AND julianday(disabled_at) IS NOT NULL AND julianday(delete_after) = julianday(disabled_at) + 7)
  )
);

CREATE INDEX idx_meetings_installation_starts ON meetings(installation_id, starts_at);

CREATE UNIQUE INDEX idx_one_user_per_member
  ON users(installation_id, member_id)
  WHERE member_id IS NOT NULL;

CREATE INDEX idx_meetings_series
ON meetings(installation_id, series_id, starts_at);

CREATE INDEX idx_meetings_active_schedule
ON meetings(installation_id, deleted_at, starts_at);

CREATE INDEX idx_members_installation_required_from
ON members (installation_id, attendance_required_from);

CREATE INDEX idx_meetings_installation_reporting_period
ON meetings (installation_id, starts_at)
WHERE deleted_at IS NULL;

CREATE INDEX idx_members_installation_participation_start
ON members (installation_id, attendance_required_from);

CREATE UNIQUE INDEX idx_members_installation_discord_user
ON members (installation_id, discord_user_id)
WHERE discord_user_id IS NOT NULL;

CREATE INDEX idx_meeting_weight_categories_order
ON meeting_weight_categories (installation_id, active, position, name);

CREATE INDEX platform_modules_cleanup_due ON platform_modules(phase, delete_after, installation_id, module_id);
