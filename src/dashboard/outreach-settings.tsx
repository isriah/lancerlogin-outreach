import { useEffect, useRef, useState } from "react";
import { SettingsSectionNavigation, settingsSectionHref } from "@lancerlogin/module-sdk/dashboard";
import { usePath } from "@lancerlogin/module-sdk/dashboard";
import { dashboardApi as api } from "@lancerlogin/module-sdk/dashboard";
import { useModalFocus } from "@lancerlogin/module-sdk/dashboard";
import { outreachPrograms } from "../shared/outreach-programs.ts";
import { OutreachAutomaticPublicationSetting } from "./outreach-activity-publication";
import { OutreachPublicFormSettings } from "./outreach-public-settings";

type Kind = "teams" | "labels";
type Item = { id: string; name: string; archived: boolean; revision: number; number?: string; program?: string };
type CatalogPage = { items: Item[]; nextCursor: string | null; total?: number; activeCount?: number; archivedCount?: number };
type Notice = { tone: "success" | "error"; text: string };

export function OutreachSettings({ isAdmin = true, onOpenSetup }: { isAdmin?: boolean; onOpenSetup?: () => void }) {
  const { path, search, navigate } = usePath();
  const requested = new URLSearchParams(search).get("section");
  const tab: "general" | Kind = requested === "teams" || requested === "labels" ? requested : isAdmin ? "general" : "teams";
  const [counts, setCounts] = useState<Partial<Record<Kind, number>>>({}); const [notice, setNotice] = useState<Notice>();
  async function refreshCounts() {
    const [teams, labels] = await Promise.all([api<CatalogPage>("/admin/hours/teams?limit=1"), api<CatalogPage>("/admin/hours/labels?limit=1")]);
    setCounts({ teams: teams.activeCount === undefined ? undefined : teams.activeCount + (teams.archivedCount ?? 0), labels: labels.activeCount === undefined ? undefined : labels.activeCount + (labels.archivedCount ?? 0) });
  }
  useEffect(() => { void refreshCounts().catch(error => setNotice({ tone: "error", text: (error as Error).message })); }, []);
  useEffect(() => { setNotice(undefined); }, [tab]);
  return <section className="outreach-stack outreach-settings-tabs" aria-label="Outreach settings">
    <SettingsSectionNavigation label="Outreach settings sections" pickerLabel="Outreach section" currentHref={settingsSectionHref(path, search, tab)} navigate={navigate} sections={([...(isAdmin ? ["general"] : []), "teams", "labels"] as Array<"general" | Kind>).map(item => [settingsSectionHref(path, search, item), item === "general" ? "General" : `${item === "teams" ? "Supported teams" : "Labels"}${counts[item] === undefined ? "" : ` (${counts[item]})`}`])} />
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
    {tab === "general" && <div className="outreach-stack"><OutreachReportingSettings /><OutreachAutomaticPublicationSetting /><OutreachPublicFormSettings />{onOpenSetup && <article className="settings-callout"><div><h2>Reopen Outreach setup</h2><p>Review one setup card at a time.</p></div><button className="ui-button" type="button" onClick={onOpenSetup}>Open Outreach setup</button></article>}</div>}
    {tab !== "general" && <Catalog key={tab} kind={tab} onChanged={refreshCounts} setNotice={setNotice} />}
  </section>;
}

function OutreachReportingSettings() {
  const [rules, setRules] = useState<{ reportingDays: number; reopenHours: number; revision: number }>(); const [days, setDays] = useState(30); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState<Notice>();
  useEffect(() => { let current = true; void api<{ values: NonNullable<typeof rules> }>("/module-setup/hour-tracking/rules").then(result => { if (current) { setRules(result.values); setDays(result.values.reportingDays); } }).catch(error => { if (current) setNotice({ tone: "error", text: (error as Error).message }); }); return () => { current = false; }; }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!rules) return; setSaving(true); setNotice(undefined);
    try { const result = await api<{ values: NonNullable<typeof rules> }>("/module-setup/hour-tracking/rules", { method: "PUT", body: JSON.stringify({ ...rules, reportingDays: days }) }); setRules(result.values); setNotice({ tone: "success", text: "Reporting default saved." }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); } finally { setSaving(false); }
  }
  return <article className="ui-card outreach-stack"><div><h2>Reporting defaults</h2><p>Activities use this installation's reporting window. Staff can reopen reporting for 24 hours from the activity details.</p></div><form className="ui-form form-grid" onSubmit={event => void save(event)}><label>Reporting window in days<input className="ui-control" type="number" required min={1} max={365} value={days} disabled={saving || !rules} onChange={event => setDays(Number(event.target.value))} /></label><button className="ui-button ui-button--primary" type="submit" disabled={saving || !rules}>Save reporting default</button></form>{notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}</article>;
}

function Catalog({ kind, onChanged, setNotice }: { kind: Kind; onChanged: () => Promise<void>; setNotice: (notice: Notice) => void }) {
  const [query, setQuery] = useState(""); const [search, setSearch] = useState(""); const [archived, setArchived] = useState("false"); const [cursor, setCursor] = useState<string | null>(null); const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [page, setPage] = useState<CatalogPage>(); const [busy, setBusy] = useState(true); const [error, setError] = useState(""); const [version, setVersion] = useState(0); const [editing, setEditing] = useState<{ item?: Item }>();
  const title = kind === "teams" ? "Supported teams" : "Outreach labels"; const noun = kind === "teams" ? "team" : "label";
  function resetPage() { setCursor(null); setPrevious([]); }
  useEffect(() => { if (query === search) return; const timer = window.setTimeout(() => { setSearch(query); resetPage(); }, 250); return () => window.clearTimeout(timer); }, [query, search]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(""); setPage(undefined);
    const params = new URLSearchParams({ archived, limit: "20", q: search }); if (cursor) params.set("after", cursor);
    void api<CatalogPage>(`/admin/hours/${kind}?${params}`, { signal: controller.signal }).then(next => { if (!controller.signal.aborted) setPage(next); }).catch(error => { if (!controller.signal.aborted) setError((error as Error).message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [kind, archived, search, cursor, version]);
  async function changed() { resetPage(); setVersion(current => current + 1); await onChanged(); }
  async function archive(item: Item) {
    setBusy(true);
    try { await api(`/admin/hours/${kind}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, archived: !item.archived }) }); await changed(); setNotice({ tone: "success", text: `${kind === "teams" ? "Team" : "Label"} ${item.archived ? "reopened" : "archived"}.` }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); setBusy(false); }
  }
  return <section className="ui-card outreach-stack outreach-catalog-panel" data-kind={kind} aria-label={title}><div className="panel-heading outreach-catalog-heading"><div><h2>{title}</h2><p>{page?.total === undefined ? "" : `${page.total} matching ${kind}`}</p></div><button className="ui-button ui-button--primary" type="button" aria-haspopup="dialog" onClick={() => setEditing({})}>Add {noun}</button></div>
    <div className="form-grid ui-form"><label>Search {kind}<input className="ui-control" type="search" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} /></label><label>{kind === "teams" ? "Team" : "Label"} status<select className="ui-native-select" value={archived} onChange={event => { setArchived(event.target.value); resetPage(); }}><option value="false">Active</option><option value="true">Archived</option><option value="all">All</option></select></label></div>
    {busy ? <p className="ui-status" role="status">Loading {kind}...</p> : error ? <p className="ui-status" data-tone="error" role="alert">{error}</p> : !page?.items.length ? <p className="empty-state">No matching {kind}.</p> : <><div className="outreach-team-records">{kind === "teams" && page.items.map(item => <article className="outreach-team-record" key={item.id}><div><strong>{item.name}</strong><p>{item.program} · {item.number ? `#${item.number}` : "No number"}</p><span className="ui-status">{item.archived ? "Archived" : "Active"}</span></div><button className="ui-button settings-edit-button" type="button" aria-label={`Edit ${item.name}`} aria-haspopup="dialog" disabled={busy} onClick={() => setEditing({ item })}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true" focusable="false"><path d="m16 3 5 5-13 13H3v-5L16 3ZM13 6l5 5" /></svg></button></article>)}</div><div className="responsive-table"><table className="ui-table outreach-catalog-table" aria-label={title}><thead><tr><th>Name</th>{kind === "teams" && <><th>Program</th><th>Number</th></>}<th>Status</th><th>Actions</th></tr></thead><tbody>{page.items.map(item => <tr key={item.id}><th scope="row">{item.name}</th>{kind === "teams" && <><td>{item.program}</td><td>{item.number || "None"}</td></>}<td>{item.archived ? "Archived" : "Active"}</td><td><div className="module-actions"><button className="ui-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => setEditing({ item })}>Edit<span className="visually-hidden"> {item.name}</span></button><button className="ui-button" type="button" disabled={busy} onClick={() => void archive(item)}>{item.archived ? "Reopen" : "Archive"}<span className="visually-hidden"> {item.name}</span></button></div></td></tr>)}</tbody></table></div></>}
    {(Boolean(page?.items.length) || previous.length > 0) && <div className="module-actions outreach-catalog-pagination"><button className="ui-button" type="button" disabled={busy || !previous.length} onClick={() => { setCursor(previous[previous.length - 1] ?? null); setPrevious(previous.slice(0, -1)); }}>Previous</button><span>Page {previous.length + 1}</span><button className="ui-button" type="button" disabled={busy || !page?.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(page!.nextCursor); }}>Next</button></div>}
    {editing && <CatalogDialog kind={kind} item={editing.item} onClose={() => setEditing(undefined)} onChanged={changed} setNotice={setNotice} />}
  </section>;
}

function CatalogDialog({ kind, item, onClose, onChanged, setNotice }: { kind: Kind; item?: Item; onClose: () => void; onChanged: () => Promise<void>; setNotice: (notice: Notice) => void }) {
  const dialog = useRef<HTMLElement>(null); const [name, setName] = useState(item?.name ?? ""); const [number, setNumber] = useState(item?.number ?? ""); const [program, setProgram] = useState(outreachPrograms.includes(item?.program as typeof outreachPrograms[number]) ? item!.program! : ""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const noun = kind === "teams" ? "team" : "label"; const title = `${item ? "Edit" : "Add"} ${kind === "teams" ? "supported team" : "Outreach label"}`; const close = () => { if (!busy) onClose(); };
  useModalFocus(dialog, true, busy, close);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api(`/admin/hours/${kind}${item ? `/${encodeURIComponent(item.id)}` : ""}`, { method: item ? "PATCH" : "POST", body: JSON.stringify({ name, ...(kind === "teams" ? { number, program } : {}), archived: item?.archived ?? false, ...(item ? { revision: item.revision } : {}) }) }); await onChanged(); setNotice({ tone: "success", text: `${kind === "teams" ? "Team" : "Label"} ${item ? "updated" : "added"}.` }); onClose(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function archiveTeam() {
    if (!item || busy) return; setBusy(true); setError("");
    try { await api(`/admin/hours/teams/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, archived: !item.archived }) }); await onChanged(); setNotice({ tone: "success", text: `Team ${item.archived ? "reopened" : "archived"}.` }); onClose(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="dialog-backdrop"><section ref={dialog} className="meeting-management-dialog outreach-catalog-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby="outreach-catalog-dialog-title" tabIndex={-1}><div className="dialog-heading"><h2 id="outreach-catalog-dialog-title">{title}</h2><button className="ui-button" type="button" aria-label={`Close ${noun} dialog`} disabled={busy} onClick={close}>×</button></div><form className="ui-form outreach-stack" onSubmit={event => void save(event)}><label>{kind === "teams" ? "Team" : "Label"} name<input className="ui-control" data-modal-initial-focus required maxLength={kind === "teams" ? 150 : 100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>{kind === "teams" && <div className="form-grid"><label>Team number<input className="ui-control" maxLength={32} disabled={busy} value={number} onChange={event => setNumber(event.target.value)} /></label><label>Program<select className="ui-native-select" required disabled={busy} value={program} onChange={event => setProgram(event.target.value)}><option value="">Choose program</option>{outreachPrograms.map(program => <option key={program} value={program}>{program}</option>)}</select></label></div>}{error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}<div className="dialog-actions"><button className="ui-button" type="button" disabled={busy} onClick={close}>Cancel</button><button className="ui-button ui-button--primary" type="submit" disabled={busy || !name.trim() || kind === "teams" && !program}>{busy ? "Saving..." : `${item ? "Save" : "Add"} ${noun}`}</button></div>{kind === "teams" && item && <button className="ui-button ui-button--danger team-dialog-archive" type="button" disabled={busy} onClick={() => void archiveTeam()}>{item.archived ? "Reopen team" : "Archive team"}</button>}</form></section></div>;
}
