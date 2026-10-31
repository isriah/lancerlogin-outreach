-- Members can log Team support and Other service time from the public form without a Staff-created activity.

-- A supported team a member added from the public form stays flagged until Staff mark it reviewed in Outreach settings.
ALTER TABLE hours_teams ADD COLUMN added_by_member INTEGER NOT NULL DEFAULT 0 CHECK(added_by_member IN (0,1));

-- Entries record whether they carry clock times ('clock') or only a duration ('duration'). A duration-only entry keeps the
-- interval columns, anchored at the first instant of its service day, so totals, receipts and history read it unchanged.
-- Its anchored interval is not a time the member was present, so it never overlaps other participation.
ALTER TABLE hours_entries ADD COLUMN timing TEXT NOT NULL DEFAULT 'clock' CHECK(timing IN ('clock','duration'));

DROP TRIGGER hours_entries_no_overlap_insert;
CREATE TRIGGER hours_entries_no_overlap_insert BEFORE INSERT ON hours_entries
WHEN NEW.status='counted' AND NEW.timing='clock' AND EXISTS(
  SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted'
    AND e.timing='clock' AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms
)
BEGIN SELECT RAISE(ABORT,'hours_overlap'); END;

DROP TRIGGER hours_entries_no_overlap_update;
CREATE TRIGGER hours_entries_no_overlap_update BEFORE UPDATE OF member_id,start_ms,end_ms,status ON hours_entries
WHEN NEW.status='counted' AND NEW.timing='clock' AND EXISTS(
  SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted'
    AND e.timing='clock' AND e.id!=NEW.id AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms
)
BEGIN SELECT RAISE(ABORT,'hours_overlap'); END;

-- An entry keeps the timing it was submitted with.
DROP TRIGGER hours_entry_provenance;
CREATE TRIGGER hours_entry_provenance BEFORE UPDATE ON hours_entries
WHEN OLD.status='void' OR NEW.revision!=OLD.revision+1
  OR NEW.installation_id!=OLD.installation_id OR NEW.id!=OLD.id OR NEW.time_zone!=OLD.time_zone
  OR NEW.channel!=OLD.channel OR NEW.attribution!=OLD.attribution OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.created_at!=OLD.created_at OR NEW.timing!=OLD.timing
BEGIN SELECT RAISE(ABORT,'hours_entry_provenance'); END;
