import { useRef, useState } from "react";
import type { CivilTimeOccurrence } from "@lancerlogin/module-sdk";
import { dashboardApi as api } from "@lancerlogin/module-sdk/dashboard";
import { useModalFocus } from "@lancerlogin/module-sdk/dashboard";
import { OutreachClock } from "./outreach-clock";
import type { OutreachParticipationEntry } from "./outreach-participation";

type Activity = { id: string; title: string; serviceDate: string; archived: boolean };
type Member = { id: string; label: string; externalId: string };
export function OutreachEntryEditDialog({ entry, deleting, activities, members, timeZone, onClose, onChanged, setNotice }: {
  entry: OutreachParticipationEntry & { timeZone?: string }; deleting: boolean; activities: Activity[]; members: Member[]; timeZone: string;
  onClose: () => void; onChanged: () => Promise<void>; setNotice: (notice: { tone: "success" | "error"; text: string }) => void;
}) {
  const dialog = useRef<HTMLElement>(null); const [memberId, setMemberId] = useState(entry.memberId); const [activityId, setActivityId] = useState(entry.activityId);
  const [startLocal, setStartLocal] = useState(entry.startLocal); const [endLocal, setEndLocal] = useState(entry.endLocal);
  const [startOccurrence, setStartOccurrence] = useState<CivilTimeOccurrence | undefined>(entry.startOccurrence ?? undefined); const [endOccurrence, setEndOccurrence] = useState<CivilTimeOccurrence | undefined>(entry.endOccurrence ?? undefined);
  const [taskNotes, setTaskNotes] = useState(entry.taskNotes); const [reason, setReason] = useState(""); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const date = activityId === entry.activityId ? entry.serviceDate : activities.find(activity => activity.id === activityId)?.serviceDate ?? "";
  const zone = entry.timeZone ?? timeZone; const close = () => { if (!saving) onClose(); };
  useModalFocus(dialog, true, saving, close);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      await api(`/admin/hours/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ revision: entry.revision, action: deleting ? "voided" : "corrected", reason,
        ...(!deleting ? { memberId, activityId, startLocal, endLocal, startOccurrence: startOccurrence ?? null, endOccurrence: endOccurrence ?? null, taskNotes } : {}) }) });
      await onChanged(); setNotice({ tone: "success", text: deleting ? "Participation deleted from totals. Its history is retained." : "Participation updated. Its history is retained." }); onClose();
    } catch (caught) { setError((caught as Error).message); } finally { setSaving(false); }
  }
  return <div className="dialog-backdrop"><section ref={dialog} className="meeting-management-dialog outreach-entry-edit-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby="outreach-entry-edit-title" tabIndex={-1}>
    <div className="dialog-heading"><div><h2 id="outreach-entry-edit-title">{deleting ? "Delete participation" : "Edit participation"}</h2><p>{entry.memberName} - {entry.serviceDate}, {entry.startLocal} to {entry.endLocal}</p></div><button className="ui-button" type="button" aria-label="Close participation dialog" disabled={saving} onClick={close}>×</button></div>
    <form className="ui-form outreach-stack" onSubmit={event => void save(event)}>
      {deleting ? <><p>This removes the entry from hours and reports. The original submission and revision history remain available for review.</p></> : <>
        <label>Member<select className="ui-native-select" data-modal-initial-focus required disabled={saving} value={memberId} onChange={event => setMemberId(event.target.value)}>{members.map(member => <option key={member.id} value={member.id}>{member.label} ({member.externalId})</option>)}</select></label>
        <label>Dated activity<select className="ui-native-select" required disabled={saving} value={activityId} onChange={event => { setActivityId(event.target.value); setStartOccurrence(undefined); setEndOccurrence(undefined); }}>{activities.filter(activity => !activity.archived || activity.id === entry.activityId).map(activity => <option key={activity.id} value={activity.id}>{activity.serviceDate} - {activity.title}</option>)}</select></label>
        <p className="field-help">Recorded date: {date}. Editing this activity keeps the original recorded date.</p>
        <div className="outreach-time-grid"><OutreachClock label="Start time" date={date} time={startLocal} zone={zone} occurrence={startOccurrence} onTime={time => { setStartLocal(time); setStartOccurrence(undefined); }} onOccurrence={setStartOccurrence} disabled={saving} /><OutreachClock label="End time" date={date} time={endLocal} zone={zone} occurrence={endOccurrence} onTime={time => { setEndLocal(time); setEndOccurrence(undefined); }} onOccurrence={setEndOccurrence} disabled={saving} /></div>
        <label>Task notes<textarea className="ui-control" maxLength={4000} disabled={saving} value={taskNotes} onChange={event => setTaskNotes(event.target.value)} /></label>
      </>}
      <label>Staff reason<textarea className="ui-control" required maxLength={4000} disabled={saving} value={reason} onChange={event => setReason(event.target.value)} /></label>
      {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="ui-button" type="button" disabled={saving} onClick={close}>Cancel</button><button className={`ui-button ${deleting ? "ui-button--danger" : "ui-button--primary"}`} type="submit" disabled={saving || !reason.trim()}>{saving ? "Saving..." : deleting ? "Delete participation" : "Save participation"}</button></div>
    </form>
  </section></div>;
}
