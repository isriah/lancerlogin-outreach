import { useEffect, useRef, useState } from "react";
import { resolveCivilTime, type CivilTimeOccurrence } from "@lancerlogin/module-sdk";
import { dashboardApi as api } from "@lancerlogin/module-sdk/dashboard";
import { AppLink, usePath } from "@lancerlogin/module-sdk/dashboard";
import { backfillButtonText, backfillConfirmText, backfillDestinations, backfillHelp, backfillResultText, deliveryText, integrationsHref, integrationsLinkText, latestProblemText, noBackfillDestinationText, notSetUpText, parsePublicationDestinations, publicationProviderOrder, retryingAtText, switchDisabled, switchLabel, switchNotice, type BackfillPage, type PublicationDestinations, type PublicationProvider } from "./outreach-publication-destinations.ts";

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
  googleNextAttemptAt?: string | null;
  discordStatus: string | null;
  discordAction?: "publish" | "delete" | null;
  discordError: string | null;
  discordExternalId?: string | null;
  discordNextAttemptAt?: string | null;
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
  { key: "google_calendar", label: "Google Calendar", selected: "googleCalendar", status: "googleStatus", action: "googleAction", error: "googleError", externalId: "googleExternalId", nextAttemptAt: "googleNextAttemptAt" },
  { key: "discord", label: "Discord", selected: "discord", status: "discordStatus", action: "discordAction", error: "discordError", externalId: "discordExternalId", nextAttemptAt: "discordNextAttemptAt" },
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

/** Discord's Clyde mark, the same path as simple-icons' "discord" icon from Discord's brand assets. It is filled, unlike the stroked calendar. */
const discordMarkPath = "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z";

function PublicationIcon({ provider }: { provider: "google_calendar" | "discord" }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="outreach-publication-icon" data-provider={provider}>{provider === "google_calendar" ? <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M7 2v5M17 2v5M3 10h18M7 14h3M14 14h3M7 17h3" /></> : <path d={discordMarkPath} fill="currentColor" stroke="none" />}</svg>;
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
    // A failed delivery with a next attempt retries by itself; one without waits for Retry.
    const retrying = status === "failed" ? retryingAtText(current?.[provider.nextAttemptAt]) : null;
    return <div className="outreach-publication-destination" key={provider.key}>
      <button className="ui-button outreach-publication-trigger" data-provider={provider.key} data-published={present} type="button" disabled={saving || pending || Boolean(activity.archived) && !(status === "failed" && action === "delete")} aria-label={`${provider.label}: ${label}`} aria-expanded={menu === provider.key} title={`${provider.label}: ${label}${error ? ` - ${error}` : ""}${retrying ? ` ${retrying}.` : ""}`} onClick={() => present || status === "failed" ? setMenu(menu === provider.key ? null : provider.key) : void act(provider.key, "publish")}><PublicationIcon provider={provider.key} /><span className="outreach-publication-mark" aria-hidden="true">{status === "failed" ? "!" : pending ? "◷" : present ? "✓" : "+"}</span></button>
      {menu === provider.key && <div className="ui-card outreach-publication-menu" role="group" aria-label={`${provider.label} publication actions`}><strong>{provider.label}</strong><span>{label}</span>{error && <p className="field-help">{error}</p>}{retrying && <p className="field-help">{retrying}</p>}{status === "failed" && <button className="ui-button" type="button" disabled={saving} onClick={() => void act(provider.key, "retry")}>Retry {provider.label}</button>}{!activity.archived && <><button className="ui-button" type="button" disabled={saving} onClick={() => void act(provider.key, "publish")}>Update {provider.label}</button>{present && <button className="ui-button ui-button--danger" type="button" disabled={saving} onClick={() => void act(provider.key, "delete")}>Unpublish {provider.label}</button>}</>}</div>}
    </div>;
  })}</div>;
}

/**
 * One automatic switch per destination, its delivery status, and Publish upcoming Events. Turning a switch on offers to
 * publish the upcoming Events once; nothing is published until the Admin confirms.
 */
export function OutreachAutomaticPublicationSetting() {
  const { navigate } = usePath();
  const [status, setStatus] = useState<PublicationDestinations>();
  const [busy, setBusy] = useState(true); const [unavailable, setUnavailable] = useState(false);
  // The confirmation for Publish upcoming Events, opened by its button or once when a switch is turned on.
  const [offer, setOffer] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  async function load() { const next = parsePublicationDestinations(await api<unknown>("/admin/hours/publication-destinations")); setStatus(next); setUnavailable(!next); return next; }
  useEffect(() => { void load().catch((error) => setNotice({ tone: "error", text: (error as Error).message })).finally(() => setBusy(false)); }, []);
  async function change(provider: PublicationProvider, automatic: boolean) {
    if (!status) return;
    setBusy(true); setNotice(undefined); setOffer(false);
    try {
      const next = parsePublicationDestinations(await api<unknown>("/admin/hours/publication-destinations", { method: "PATCH", body: JSON.stringify({ provider, automatic, revision: status.revision }) }));
      if (next) setStatus(next); else await load();
      setNotice({ tone: "success", text: switchNotice(provider, automatic) });
      if (automatic) setOffer(true);
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function publishUpcoming() {
    setBusy(true); setNotice(undefined); setOffer(false);
    try {
      // Pages of 10 like Core's Discord calendar sync-all; the server ends the run at its limit of 100 Events.
      const total = { selected: 0, queued: 0, skipped: 0, failed: 0 }; let cursor: string | null = null;
      do {
        const page: BackfillPage = await api<BackfillPage>(`/admin/hours/publication-destinations/backfill${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, { method: "POST", body: "{}" });
        total.selected += page.selected; total.queued += page.queued; total.skipped += page.skipped; total.failed += page.failed;
        cursor = total.selected < page.limit ? page.nextCursor : null;
      } while (cursor);
      await load(); setNotice({ tone: total.failed ? "error" : "success", text: backfillResultText(total) });
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  const ready = status ? backfillDestinations(status) : [];
  return <article className="ui-card outreach-stack" aria-labelledby="automatic-outreach-publication-title"><div><h2 id="automatic-outreach-publication-title">Automatic activity publication</h2><p>Off by default. Turn on a destination to queue each future Event there when it is saved. An Event already published to a destination is updated there whenever it is edited, even with that switch off, and removed when it is archived or changed to another type. Team Support and Other Service activities are never published.</p></div>
    {status && publicationProviderOrder.map((provider) => {
      const destination = status.destinations.find((item) => item.provider === provider); if (!destination) return null;
      const helpId = `automatic-outreach-publication-${provider}`;
      return <div className="outreach-stack outreach-publication-destination-setting" key={provider} data-provider={provider}>
        <label className="settings-checkbox"><input className="ui-checkbox" type="checkbox" role="switch" checked={destination.automatic} disabled={switchDisabled(destination, busy)} aria-describedby={helpId} onChange={(event) => void change(provider, event.target.checked)} /> {switchLabel(provider)}</label>
        <div id={helpId} className="field-help">{!destination.configured ? <p>{notSetUpText} <AppLink href={integrationsHref} navigate={navigate}>{integrationsLinkText}</AppLink>.</p> : <><p>{deliveryText(destination)}</p>{destination.latestProblem && <p>{latestProblemText(destination.latestProblem)}</p>}</>}</div>
      </div>;
    })}
    {offer && ready.length > 0 && <div className="outreach-stack outreach-publication-offer" role="group" aria-label={backfillButtonText}><p>{backfillConfirmText(ready)}</p><div className="module-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void publishUpcoming()}>{backfillButtonText}</button><button className="ui-button" type="button" disabled={busy} onClick={() => setOffer(false)}>Not now</button></div></div>}
    {status && !(offer && ready.length) && <div className="outreach-stack"><div className="module-actions"><button className="ui-button" type="button" disabled={busy || !ready.length} onClick={() => setOffer(true)}>{backfillButtonText}</button></div><p className="field-help">{ready.length ? backfillHelp : noBackfillDestinationText}</p></div>}
    {busy && !status && <p className="ui-status" role="status">Loading publication settings...</p>}
    {unavailable && <p className="ui-status" role="status">Publication settings are unavailable. Reload to try again.</p>}
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}</article>;
}
