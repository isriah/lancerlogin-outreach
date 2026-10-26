import { useEffect, useRef, useState } from "react";
import { resolveCivilTime, type CivilTimeOccurrence } from "@lancerlogin/module-sdk";
import { dashboardApi as api } from "@lancerlogin/module-sdk/dashboard";

export type OutreachEventSchedule = {
  eventStartLocal: string | null;
  eventEndLocal: string | null;
  eventStartOccurrence: CivilTimeOccurrence | null;
  eventEndOccurrence: CivilTimeOccurrence | null;
};

export type OutreachPublicationProviders = { google_calendar: boolean; discord: boolean };
export type OutreachActivityPublication = {
  activityId: string;
  revision: number;
  googleCalendar: boolean;
  discord: boolean;
  googleStatus: string | null;
  googleAction?: "publish" | "delete" | null;
  googleError: string | null;
  googleExternalId?: string | null;
  discordStatus: string | null;
  discordAction?: "publish" | "delete" | null;
  discordError: string | null;
  discordExternalId?: string | null;
};

type Notice = { tone: "success" | "error"; text: string };

function EventTimeField({ label, date, timeZone, time, occurrence, disabled, onTime, onOccurrence }: { label: string; date: string; timeZone: string; time: string | null; occurrence: CivilTimeOccurrence | null; disabled: boolean; onTime: (time: string | null) => void; onOccurrence: (occurrence: CivilTimeOccurrence | null) => void }) {
  let repeated = false; let missing = false;
  if (time && date) try { const candidates = resolveCivilTime({ date, time, timeZone }); repeated = candidates.length > 1; missing = candidates.length === 0; } catch { /* Server validates incomplete schedule fields. */ }
  return <div className="outreach-stack"><label>{label}<input className="ui-control" type="time" step={300} value={time ?? ""} disabled={disabled} onChange={event => { onTime(event.target.value || null); }} /></label>
    {missing && <p className="field-help" role="alert">This local time does not exist because the clock changes.</p>}
    {repeated && <label>{label} occurrence<select className="ui-native-select" required disabled={disabled} value={occurrence ?? ""} onChange={event => onOccurrence(event.target.value as CivilTimeOccurrence || null)}><option value="">Choose occurrence</option><option value="earlier">First occurrence</option><option value="later">Second occurrence</option></select></label>}
  </div>;
}

export function OutreachEventScheduleFields({ date, timeZone, value, onChange, disabled, suppressHelp = false }: { date: string; timeZone: string; value: OutreachEventSchedule; onChange: (value: OutreachEventSchedule) => void; disabled: boolean; suppressHelp?: boolean }) {
  return <fieldset className="outreach-stack outreach-fieldset"><legend>Event times (optional)</legend>{!suppressHelp && <p className="field-help">Leave both blank for an all-day event. Enter both to schedule times in {timeZone}. Members record their actual participation separately.</p>}<div className="outreach-time-grid">
    <EventTimeField label="Event start time" date={date} timeZone={timeZone} time={value.eventStartLocal} occurrence={value.eventStartOccurrence} disabled={disabled} onTime={eventStartLocal => onChange({ ...value, eventStartLocal, eventStartOccurrence: null })} onOccurrence={eventStartOccurrence => onChange({ ...value, eventStartOccurrence })} />
    <EventTimeField label="Event end time" date={date} timeZone={timeZone} time={value.eventEndLocal} occurrence={value.eventEndOccurrence} disabled={disabled} onTime={eventEndLocal => onChange({ ...value, eventEndLocal, eventEndOccurrence: null })} onOccurrence={eventEndOccurrence => onChange({ ...value, eventEndOccurrence })} />
  </div></fieldset>;
}

const providerDetails = [
  { key: "google_calendar", label: "Google Calendar", selected: "googleCalendar", status: "googleStatus", action: "googleAction", error: "googleError", externalId: "googleExternalId" },
  { key: "discord", label: "Discord", selected: "discord", status: "discordStatus", action: "discordAction", error: "discordError", externalId: "discordExternalId" },
] as const;

function statusLabel(configured: boolean, selected: boolean, status: string | null, action: "publish" | "delete" | null | undefined) {
  if (!configured) return "Not configured";
  if (!selected || !status) return "Not published";
  if (action === "delete") return status === "delivered" ? "Removed" : status === "failed" ? "Removal failed" : "Removal queued";
  if (status === "delivered") return "Published";
  if (status === "failed") return "Publication failed";
  if (status === "processing") return "Publishing";
  return "Queued";
}

function PublicationIcon({ provider }: { provider: "google_calendar" | "discord" }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="outreach-publication-icon">{provider === "google_calendar" ? <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M7 2v5M17 2v5M3 10h18M7 14h3M14 14h3M7 17h3" /></> : <><path d="M7 6c3-2 7-2 10 0l3 12c-2 2-4 3-6 3l-1-2h-2l-1 2c-2 0-4-1-6-3Z" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /></>}</svg>;
}

export function ActivityPublicationControls({ activity, publication, providers, onChanged, setNotice }: { activity: { id: string; revision: number; serviceDate: string; archived?: boolean } & OutreachEventSchedule; publication?: OutreachActivityPublication; providers: OutreachPublicationProviders; onChanged: () => Promise<void>; setNotice: (notice: Notice) => void }) {
  const [saving, setSaving] = useState(false); const [menu, setMenu] = useState<string | null>(null); const container = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(publication);
  useEffect(() => { setCurrent(publication); }, [publication]);
  useEffect(() => {
    if (!providers.google_calendar && !providers.discord) return;
    let cancelled = false;
    const read = () => api<OutreachActivityPublication | null>(`/admin/hours/activities/${encodeURIComponent(activity.id)}/publication`).then(next => { if (!cancelled && next?.activityId === activity.id) setCurrent(next); }).catch(() => undefined);
    void read(); const timer = window.setInterval(read, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activity.id, providers.google_calendar, providers.discord]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenu(null); container.current?.querySelector<HTMLButtonElement>(`button[data-provider="${menu}"]`)?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menu]);
  async function act(provider: "google_calendar" | "discord", action: "publish" | "delete" | "retry") {
    setSaving(true);
    try {
      await api(`/admin/hours/activities/${encodeURIComponent(activity.id)}/publication${action === "retry" ? "/retry" : ""}`, { method: "POST", body: JSON.stringify(action === "retry" ? { revision: current!.revision, provider } : { activityRevision: activity.revision, publicationRevision: current?.revision ?? null, provider, action }) });
      setMenu(null); await onChanged(); setNotice({ tone: "success", text: action === "delete" ? "Publication removal queued for this destination." : "Publication queued for this destination." });
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setSaving(false); }
  }
  return <div ref={container} className="outreach-publication-icons" role="group" aria-label="Event publication">{providerDetails.filter(provider => providers[provider.key]).map(provider => {
    const status = current?.[provider.status] ?? null; const action = current?.[provider.action] ?? null;
    const label = statusLabel(true, Boolean(current?.[provider.selected]), status, action);
    const present = action !== "delete" && (status === "delivered" || Boolean(current?.[provider.externalId]));
    const pending = status === "pending" || status === "processing";
    const error = current?.[provider.error];
    return <div className="outreach-publication-destination" key={provider.key}>
      <button className="ui-button outreach-publication-trigger" data-provider={provider.key} data-published={present} type="button" disabled={saving || pending || Boolean(activity.archived) && !(status === "failed" && action === "delete")} aria-label={`${provider.label}: ${label}`} aria-expanded={menu === provider.key} title={`${provider.label}: ${label}${error ? ` - ${error}` : ""}`} onClick={() => present || status === "failed" ? setMenu(menu === provider.key ? null : provider.key) : void act(provider.key, "publish")}><PublicationIcon provider={provider.key} /><span className="outreach-publication-mark" aria-hidden="true">{status === "failed" ? "!" : pending ? "◷" : present ? "✓" : "+"}</span></button>
      {menu === provider.key && <div className="ui-card outreach-publication-menu" role="group" aria-label={`${provider.label} publication actions`}><strong>{provider.label}</strong><span>{label}</span>{error && <p className="field-help">{error}</p>}{status === "failed" && <button className="ui-button" type="button" disabled={saving} onClick={() => void act(provider.key, "retry")}>Retry {provider.label}</button>}{!activity.archived && <><button className="ui-button" type="button" disabled={saving} onClick={() => void act(provider.key, "publish")}>Update {provider.label}</button>{present && <button className="ui-button ui-button--danger" type="button" disabled={saving} onClick={() => void act(provider.key, "delete")}>Unpublish {provider.label}</button>}</>}</div>}
    </div>;
  })}</div>;
}

export function OutreachAutomaticPublicationSetting() {
  const [setting, setSetting] = useState<{ automatic: boolean; revision: number }>();
  const [providers, setProviders] = useState<OutreachPublicationProviders>();
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => { void Promise.all([api<{ automatic: boolean; revision: number }>("/admin/hours/publication-settings"), api<OutreachPublicationProviders>("/admin/hours/publication-providers")]).then(([nextSetting, nextProviders]) => { setSetting(nextSetting); setProviders(nextProviders); }).catch((error) => setNotice({ tone: "error", text: (error as Error).message })).finally(() => setBusy(false)); }, []);
  async function change(automatic: boolean) {
    if (!setting) return;
    setBusy(true); setNotice(undefined);
    try {
      const next = await api<{ automatic: boolean; revision: number }>("/admin/hours/publication-settings", { method: "PATCH", body: JSON.stringify({ automatic, revision: setting.revision }) });
      setSetting(next); setNotice({ tone: "success", text: automatic ? "Automatic Event publication is on." : "Automatic Event publication is off." });
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  const destinations = providers ? [providers.google_calendar ? "Google Calendar" : "", providers.discord ? "Discord" : ""].filter(Boolean) : [];
  return <article className="ui-card outreach-stack" aria-labelledby="automatic-outreach-publication-title"><div><h2 id="automatic-outreach-publication-title">Automatic activity publication</h2><p>Off by default. When on, saving a future Event queues every configured destination. Team Support and Other Service activities are never published.</p></div>{setting && <label className="settings-checkbox"><input className="ui-checkbox" type="checkbox" role="switch" checked={setting.automatic} disabled={busy} onChange={(event) => void change(event.target.checked)} /> Automatically publish Events</label>}<p className="field-help">Configured destinations: {destinations.length ? destinations.join(" and ") : "None. Configure Google Calendar or Discord in Integrations."}</p>{busy && !setting && <p className="ui-status" role="status">Loading publication settings...</p>}{notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}</article>;
}
