-- The hours_* schema LancerLogin Core's adopted Outreach migrations (0042 through 0066) produce, dumped from a database
-- migrated with Core v2.0.0-beta.16 or later. Plugin tests build on it and then apply this plugin's own migrations.

CREATE TABLE hours_categories (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  mode TEXT NOT NULL CHECK(mode IN ('event','team','task')),
  impact_default INTEGER NOT NULL DEFAULT 1 CHECK(impact_default IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);

CREATE TABLE hours_teams (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '' CHECK(length(number)<=32),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  program TEXT NOT NULL DEFAULT '' CHECK(length(program)<=100),
  historical_descriptors TEXT NOT NULL DEFAULT '' CHECK(length(historical_descriptors)<=4000),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);

CREATE TABLE hours_activities (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('event','team','task')),
  service_date TEXT NOT NULL CHECK(service_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  team_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 150),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  location TEXT NOT NULL DEFAULT '' CHECK(length(location)<=300),
  impact_relevant INTEGER NOT NULL DEFAULT 1 CHECK(impact_relevant IN (0,1)),
  source_meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  source_snapshot TEXT CHECK(source_snapshot IS NULL OR json_valid(source_snapshot)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, event_start_local TEXT CHECK(event_start_local IS NULL OR event_start_local GLOB '[0-2][0-9]:[0-5][0-9]'), event_end_local TEXT CHECK(event_end_local IS NULL OR event_end_local GLOB '[0-2][0-9]:[0-5][0-9]'), event_start_occurrence TEXT CHECK(event_start_occurrence IS NULL OR event_start_occurrence IN ('earlier','later')), event_end_occurrence TEXT CHECK(event_end_occurrence IS NULL OR event_end_occurrence IN ('earlier','later')),
  PRIMARY KEY(installation_id,id),
  FOREIGN KEY(installation_id,category_id) REFERENCES hours_categories(installation_id,id),
  FOREIGN KEY(installation_id,team_id) REFERENCES hours_teams(installation_id,id),
  CHECK((mode='team' AND team_id IS NOT NULL) OR (mode!='team' AND team_id IS NULL))
);

CREATE TABLE hours_entry_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  reporting_days INTEGER NOT NULL DEFAULT 30 CHECK(typeof(reporting_days)='integer' AND reporting_days BETWEEN 1 AND 365),
  reopen_hours INTEGER NOT NULL DEFAULT 24 CHECK(typeof(reopen_hours)='integer' AND reopen_hours BETWEEN 1 AND 168),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991)
);

CREATE TABLE hours_entries (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  activity_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  start_local TEXT NOT NULL CHECK(start_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_local TEXT NOT NULL CHECK(end_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  start_occurrence TEXT CHECK(start_occurrence IN ('earlier','later')),
  end_occurrence TEXT CHECK(end_occurrence IN ('earlier','later')),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_offset_seconds INTEGER NOT NULL,
  end_offset_seconds INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK(typeof(duration_minutes)='integer' AND duration_minutes>0),
  task_notes TEXT NOT NULL DEFAULT '' CHECK(length(task_notes)<=4000),
  status TEXT NOT NULL DEFAULT 'counted' CHECK(status IN ('counted','void')),
  channel TEXT NOT NULL DEFAULT 'staff' CHECK(channel IN ('staff','public','discord')),
  attribution TEXT NOT NULL CHECK(attribution IN ('staff_recorded','self_asserted','linked_discord')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id),
  CHECK(end_ms>start_ms AND (end_ms-start_ms)=duration_minutes*60000),
  CHECK((channel='staff' AND attribution='staff_recorded') OR (channel='public' AND attribution='self_asserted') OR (channel='discord' AND attribution='linked_discord'))
);

CREATE TABLE hours_entry_revisions (
  installation_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  activity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created','corrected','voided')),
  reason TEXT NOT NULL DEFAULT '' CHECK(length(reason)<=4000),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,entry_id,revision),
  FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id)
);

CREATE TABLE hours_submission_keys (
  installation_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('staff','public','discord')),
  key_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,channel,key_hash),
  UNIQUE(installation_id,entry_id),
  FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id) ON DELETE CASCADE
);

CREATE TABLE hours_reopen_windows (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  activity_id TEXT,
  starts_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id),
  CHECK(typeof(starts_ms)='integer' AND typeof(expires_ms)='integer' AND expires_ms>starts_ms AND expires_ms-starts_ms<=604800000)
);

CREATE TABLE hours_correction_requests (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('public','discord')),
  attribution TEXT NOT NULL CHECK((channel='public' AND attribution='self_asserted') OR (channel='discord' AND attribution='linked_discord')),
  requester_member_id TEXT NOT NULL REFERENCES members(id),
  entry_id TEXT,
  claimed_service_date TEXT,
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  key_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision IN (0,1)),
  created_at TEXT NOT NULL,
  resolved_at TEXT, activity_id TEXT,
  PRIMARY KEY(installation_id,id),
  UNIQUE(installation_id,channel,key_hash),
  FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id),
  CHECK(claimed_service_date IS NULL OR claimed_service_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK((status='open' AND revision=0 AND resolved_at IS NULL) OR (status='resolved' AND revision=1 AND resolved_at IS NOT NULL))
);

CREATE TABLE hours_correction_resolutions (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('acknowledged','dismissed','corrected','voided')),
  note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 4000),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  entry_id TEXT,
  entry_revision INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,request_id),
  FOREIGN KEY(installation_id,request_id) REFERENCES hours_correction_requests(installation_id,id),
  FOREIGN KEY(installation_id,entry_id,entry_revision) REFERENCES hours_entry_revisions(installation_id,entry_id,revision),
  CHECK((entry_id IS NULL AND entry_revision IS NULL) OR (entry_id IS NOT NULL AND entry_revision>=0)),
  CHECK(action NOT IN ('corrected','voided') OR entry_id IS NOT NULL)
);

CREATE TABLE hours_activity_publications (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  start_local TEXT NOT NULL CHECK(start_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_local TEXT NOT NULL CHECK(end_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  start_occurrence TEXT CHECK(start_occurrence IN ('earlier','later')),
  end_occurrence TEXT CHECK(end_occurrence IN ('earlier','later')),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  google_calendar INTEGER NOT NULL DEFAULT 0 CHECK(google_calendar IN (0,1)),
  discord INTEGER NOT NULL DEFAULT 0 CHECK(discord IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,activity_id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
  CHECK(end_ms>start_ms AND google_calendar+discord>0),
  CHECK((status='draft' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR (status='approved' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE hours_publication_operations (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  publication_revision INTEGER NOT NULL CHECK(typeof(publication_revision)='integer' AND publication_revision>=0),
  provider TEXT NOT NULL CHECK(provider IN ('google_calendar','discord')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
  next_attempt_at TEXT,
  external_id TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'publish' CHECK(action IN ('publish','delete')), event_snapshot_json TEXT CHECK(event_snapshot_json IS NULL OR json_valid(event_snapshot_json)),
  PRIMARY KEY(installation_id,activity_id,publication_revision,provider),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activity_publications(installation_id,activity_id) ON DELETE CASCADE,
  CHECK((status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status!='processing' AND lease_token IS NULL AND lease_expires_at IS NULL))
);

CREATE TABLE hours_labels (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);

CREATE TABLE hours_activity_labels (
  installation_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,activity_id,label_id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,label_id) REFERENCES hours_labels(installation_id,id)
);

CREATE TABLE hours_publication_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE hours_public_form_settings (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_validation TEXT NOT NULL DEFAULT 'off' CHECK(member_validation IN ('off','validity','name')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  updated_at TEXT NOT NULL
);

CREATE TABLE hours_public_lookup_limits (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms)='integer'),
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts BETWEEN 1 AND 60)
);

CREATE INDEX hours_activity_date ON hours_activities(installation_id,service_date,id);

CREATE INDEX hours_entries_member_time ON hours_entries(installation_id,member_id,start_ms,end_ms) WHERE status='counted';

CREATE INDEX hours_entries_activity ON hours_entries(installation_id,activity_id,status,id);

CREATE INDEX hours_reopen_active ON hours_reopen_windows(installation_id,revoked,expires_ms,activity_id);

CREATE INDEX hours_correction_inbox ON hours_correction_requests(installation_id,status,id);

CREATE INDEX hours_correction_member ON hours_correction_requests(installation_id,requester_member_id,id);

CREATE INDEX hours_publication_delivery ON hours_publication_operations(installation_id,status,next_attempt_at,updated_at);

CREATE INDEX hours_label_catalog ON hours_labels(installation_id,archived,name,id);

CREATE INDEX hours_activity_label_lookup ON hours_activity_labels(installation_id,label_id,activity_id);

CREATE INDEX hours_correction_activity ON hours_correction_requests(installation_id,activity_id,status,id);

CREATE INDEX hours_entries_logged_order ON hours_entries(installation_id,created_at DESC,id DESC);

CREATE TRIGGER hours_entries_no_overlap_insert BEFORE INSERT ON hours_entries
WHEN NEW.status='counted' AND EXISTS(
  SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted'
    AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms
)
BEGIN SELECT RAISE(ABORT,'hours_overlap'); END;

CREATE TRIGGER hours_entries_no_overlap_update BEFORE UPDATE OF member_id,start_ms,end_ms,status ON hours_entries
WHEN NEW.status='counted' AND EXISTS(
  SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted'
    AND e.id!=NEW.id AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms
)
BEGIN SELECT RAISE(ABORT,'hours_overlap'); END;

CREATE TRIGGER hours_reopen_window_immutable BEFORE UPDATE ON hours_reopen_windows
WHEN OLD.revoked=1 OR NEW.revoked!=1 OR NEW.revision!=OLD.revision+1
  OR NEW.installation_id IS NOT OLD.installation_id OR NEW.id IS NOT OLD.id OR NEW.activity_id IS NOT OLD.activity_id
  OR NEW.starts_ms!=OLD.starts_ms OR NEW.expires_ms!=OLD.expires_ms OR NEW.reason!=OLD.reason
  OR NEW.actor_user_id!=OLD.actor_user_id OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_reopen_window_immutable'); END;

CREATE TRIGGER hours_correction_request_immutable BEFORE UPDATE ON hours_correction_requests
WHEN OLD.status!='open' OR NEW.status!='resolved' OR NEW.revision!=1 OR NEW.resolved_at IS NULL
  OR NEW.installation_id IS NOT OLD.installation_id OR NEW.id IS NOT OLD.id OR NEW.channel IS NOT OLD.channel
  OR NEW.attribution IS NOT OLD.attribution OR NEW.requester_member_id IS NOT OLD.requester_member_id
  OR NEW.entry_id IS NOT OLD.entry_id OR NEW.claimed_service_date IS NOT OLD.claimed_service_date
  OR NEW.message IS NOT OLD.message OR NEW.key_hash IS NOT OLD.key_hash OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_correction_request_immutable'); END;

CREATE TRIGGER hours_correction_resolution_immutable BEFORE UPDATE ON hours_correction_resolutions
BEGIN SELECT RAISE(ABORT,'hours_correction_resolution_immutable'); END;

CREATE TRIGGER hours_entry_provenance BEFORE UPDATE ON hours_entries
WHEN OLD.status='void' OR NEW.revision!=OLD.revision+1
  OR NEW.installation_id!=OLD.installation_id OR NEW.id!=OLD.id OR NEW.time_zone!=OLD.time_zone
  OR NEW.channel!=OLD.channel OR NEW.attribution!=OLD.attribution OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_entry_provenance'); END;

CREATE TRIGGER hours_entry_revision_immutable BEFORE UPDATE ON hours_entry_revisions
BEGIN SELECT RAISE(ABORT,'hours_entry_revision_immutable'); END;

CREATE TRIGGER hours_submission_receipt_immutable BEFORE UPDATE ON hours_submission_keys
BEGIN SELECT RAISE(ABORT,'hours_submission_receipt_immutable'); END;

CREATE TRIGGER hours_activity_event_schedule_insert BEFORE INSERT ON hours_activities
WHEN (NEW.mode!='event' AND (NEW.event_start_local IS NOT NULL OR NEW.event_end_local IS NOT NULL OR NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
  OR ((NEW.event_start_local IS NULL)!=(NEW.event_end_local IS NULL))
  OR (NEW.event_start_local IS NULL AND (NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'hours_activity_event_schedule'); END;

CREATE TRIGGER hours_activity_event_schedule_update BEFORE UPDATE OF mode,event_start_local,event_end_local,event_start_occurrence,event_end_occurrence ON hours_activities
WHEN (NEW.mode!='event' AND (NEW.event_start_local IS NOT NULL OR NEW.event_end_local IS NOT NULL OR NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
  OR ((NEW.event_start_local IS NULL)!=(NEW.event_end_local IS NULL))
  OR (NEW.event_start_local IS NULL AND (NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'hours_activity_event_schedule'); END;

CREATE TRIGGER hours_activity_publication_transition BEFORE UPDATE ON hours_activity_publications
WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.activity_id IS NOT OLD.activity_id
  OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status='approved' AND NEW.status!='approved')
  OR (NEW.status='draft' AND (OLD.status!='draft' OR NEW.revision!=OLD.revision+1 OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
  OR (NEW.status='approved' AND (NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL OR NEW.revision!=OLD.revision+1))
BEGIN SELECT RAISE(ABORT,'hours_activity_publication_transition'); END;

CREATE TRIGGER hours_correction_activity_scope BEFORE INSERT ON hours_correction_requests
WHEN NEW.activity_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM hours_activities WHERE installation_id=NEW.installation_id AND id=NEW.activity_id
)
BEGIN SELECT RAISE(ABORT,'hours_correction_activity_scope'); END;

CREATE TRIGGER hours_correction_activity_immutable BEFORE UPDATE ON hours_correction_requests
WHEN NEW.activity_id IS NOT OLD.activity_id
BEGIN SELECT RAISE(ABORT,'hours_correction_activity_immutable'); END;
