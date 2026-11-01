import { useEffect, useMemo, useRef, useState } from "react";
import type { CivilTimeOccurrence } from "@lancerlogin/module-sdk";
import { dashboardApiBaseUrl as apiBaseUrl } from "@lancerlogin/module-sdk/dashboard";
import { outreachPrograms } from "../shared/outreach-programs.ts";
import { OutreachClock } from "./outreach-clock";

type ValidationMode = "off" | "validity" | "name";
type Context = { organizationName: string; timeZone: string; today: string; earliestServiceDate: string; reportingDays: number; memberValidation?: ValidationMode };
type Activity = { id: string; title: string; serviceDate: string; location: string; reopened: boolean };
type Page<T> = { items: T[]; nextCursor: string | null };
type Team = { id: string; name: string; number: string; program: string };
type Receipt = { id: string; serviceDate: string; startLocal: string; endLocal: string; durationMinutes: number; timing?: "clock" | "duration"; createdAt: string };
/** What the member is logging: time at a Staff-created dated activity, or self-logged Team support or Other service. */
type Logging = "activity" | "team" | "other";
const loggingChoices: Array<{ value: Logging; label: string }> = [{ value: "activity", label: "Scheduled activity" }, { value: "team", label: "Team support" }, { value: "other", label: "Other service" }];
const newTeam = "new";
// Kept in step with the API's limits in outreach-entries.ts.
const maximumMinutes = 24 * 60; const descriptionLength = 150; const teamNoteLength = 500;
const teamLabel = (team: Pick<Team, "number" | "name" | "program">) => `${team.number ? `${team.number} ` : ""}${team.name} (${team.program})`;
type CorrectionReceipt = { reference: string; status: string; createdAt: string };
type Validation = { status: "checking" | "valid" | "invalid" | "unavailable"; text: string };
/** What FIRST says about the team number and program a member enters for a new team, through Core's FIRST connection. */
type TeamCheck = { key: string; status: "checking" | "found" | "not-found" | "unavailable"; name?: string };
// Kept in step with firstCheckableNumber in outreach-first.ts: FIRST team numbers are 1 to 6 digits.
const firstCheckableNumber = /^\d{1,6}$/; const teamCheckDelayMs = 400;
class PublicFormError extends Error {
  constructor(message: string, readonly retryExact: boolean) { super(message); }
}
async function publicApi<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await fetch(`${apiBaseUrl}/public/hours/${path}`, { credentials: "omit", cache: "no-store", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
  const body = await result.json().catch(() => ({})) as T & { error?: string; retryExact?: boolean };
  if (!result.ok) throw new PublicFormError(body.error ?? "Request failed", body.retryExact ?? result.status >= 500);
  return body;
}
const localMinutes = (time: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return undefined;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
};
const localTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const endAfterStart = (startLocal: string) => {
  const start = localMinutes(startLocal);
  return start === undefined ? undefined : localTime(Math.min(start + 60, 23 * 60 + 55));
};

export function PublicOutreachForm() {
  const [context, setContext] = useState<Context>(); const [activities, setActivities] = useState<Activity[]>([]);
  const [memberExternalId, setMemberExternalId] = useState(""); const [activityId, setActivityId] = useState("");
  const [validation, setValidation] = useState<Validation>(); const lookup = useRef<AbortController | null>(null); const lookupVersion = useRef(0);
  const [startLocal, setStartLocal] = useState(""); const [endLocal, setEndLocal] = useState(""); const [startOccurrence, setStartOccurrence] = useState<CivilTimeOccurrence>(); const [endOccurrence, setEndOccurrence] = useState<CivilTimeOccurrence>(); const [taskNotes, setTaskNotes] = useState("");
  const [busy, setBusy] = useState(true); const [notice, setNotice] = useState(""); const [pending, setPending] = useState<Record<string, unknown>>(); const [receipt, setReceipt] = useState<Receipt>(); const noticeRef = useRef<HTMLParagraphElement>(null);
  const [mode, setMode] = useState<"entry" | "correction">("entry"); const [correctionActivities, setCorrectionActivities] = useState<Activity[]>([]); const [correctionCursor, setCorrectionCursor] = useState<string | null>(null);
  const [correctionMessage, setCorrectionMessage] = useState(""); const [correctionPending, setCorrectionPending] = useState<Record<string, unknown>>(); const [correctionReceipt, setCorrectionReceipt] = useState<CorrectionReceipt>();
  const [logging, setLogging] = useState<Logging>("activity"); const [teams, setTeams] = useState<Team[]>(); const [teamId, setTeamId] = useState("");
  const [teamNumber, setTeamNumber] = useState(""); const [teamProgram, setTeamProgram] = useState(""); const [typedTeamName, setTypedTeamName] = useState("");
  const [serviceDate, setServiceDate] = useState(""); const [durationMinutes, setDurationMinutes] = useState(""); const [loggedLabel, setLoggedLabel] = useState("");
  const [teamCheck, setTeamCheck] = useState<TeamCheck>();
  const activity = activities.find(item => item.id === activityId); const entryDate = activity?.serviceDate ?? "";
  const selfLogged = logging !== "activity";

  function clearValidation() { lookup.current?.abort(); lookup.current = null; lookupVersion.current += 1; setValidation(undefined); }
  useEffect(() => {
    let current = true; setBusy(true);
    void Promise.all([publicApi<Context>("context"), publicApi<Page<Activity>>("activities?limit=100")])
      .then(([nextContext, activityPage]) => { if (!current) return; setContext(nextContext); setActivities(activityPage.items); })
      .catch(error => { if (current) setNotice((error as Error).message); }).finally(() => { if (current) setBusy(false); });
    const refreshPrivacy = () => {
      clearValidation(); if (document.visibilityState === "hidden") return;
      void publicApi<Context>("context").then(next => { if (current) setContext(next); }).catch(() => { if (current) setContext(previous => previous && { ...previous, memberValidation: "off" }); });
    };
    document.addEventListener("visibilitychange", refreshPrivacy); window.addEventListener("focus", refreshPrivacy);
    return () => { current = false; lookup.current?.abort(); document.removeEventListener("visibilitychange", refreshPrivacy); window.removeEventListener("focus", refreshPrivacy); };
  }, []);
  useEffect(() => { clearValidation(); }, [mode]);
  useEffect(() => {
    if (logging !== "team" || teams) return;
    let current = true;
    void (async () => {
      const items: Team[] = []; let cursor: string | null = null;
      do { const page: Page<Team> = await publicApi<Page<Team>>(`teams?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`); items.push(...page.items); cursor = page.nextCursor; } while (cursor && items.length < 2000);
      if (current) setTeams(items.sort((a, b) => a.program.localeCompare(b.program) || a.number.localeCompare(b.number, undefined, { numeric: true }) || a.name.localeCompare(b.name)));
    })().catch(error => { if (current) { setTeams([]); setNotice((error as Error).message); } });
    return () => { current = false; };
  }, [logging, teams]);
  useEffect(() => {
    if (mode !== "correction") return;
    let current = true; setBusy(true);
    void publicApi<Page<Activity>>("correction-activities?limit=100").then(page => {
      if (!current) return; setCorrectionActivities(page.items); setCorrectionCursor(page.nextCursor);
      setActivityId(previous => page.items.some(item => item.id === previous) ? previous : "");
    }).catch(error => { if (current) setNotice((error as Error).message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [mode]);
  useEffect(() => { if (notice) window.requestAnimationFrame(() => noticeRef.current?.focus()); }, [notice]);

  async function validateMember() {
    clearValidation(); if (!memberExternalId.trim() || !context || (context.memberValidation ?? "off") === "off") return;
    const version = lookupVersion.current; const controller = new AbortController(); lookup.current = controller;
    setValidation({ status: "checking", text: "Checking member ID..." });
    try {
      const result = await publicApi<{ mode: ValidationMode; valid?: boolean; name?: string }>("member-validation", { method: "POST", body: JSON.stringify({ memberExternalId }), signal: controller.signal });
      if (version !== lookupVersion.current || controller.signal.aborted) return;
      if (result.mode === "off") { setContext(previous => previous && { ...previous, memberValidation: "off" }); setValidation(undefined); return; }
      setValidation(result.valid
        ? { status: "valid", text: result.mode === "name" && result.name ? `Member: ${result.name}` : "Member ID confirmed." }
        : { status: "invalid", text: "No active roster member matches that ID. Check the member ID." });
    } catch {
      if (version === lookupVersion.current && !controller.signal.aborted) setValidation({ status: "unavailable", text: "Member-ID checking is temporarily unavailable. You can still submit for verification." });
    } finally { if (lookup.current === controller) lookup.current = null; }
  }
  const memberField = <label htmlFor="public-member-id">Roster member ID<input id="public-member-id" required maxLength={80} autoComplete="off" spellCheck={false} value={memberExternalId}
    aria-invalid={validation?.status === "invalid" || undefined} aria-describedby={validation ? "public-member-validation" : undefined}
    onFocus={clearValidation} onChange={event => { clearValidation(); setMemberExternalId(event.target.value); }} onBlur={() => void validateMember()} />
    {validation && <span id="public-member-validation" className="field-help" role={validation.status === "invalid" ? "alert" : "status"}>{validation.text}</span>}</label>;
  const startMinutes = localMinutes(startLocal); const endMinutes = localMinutes(endLocal);
  const timeOrderProblem = startMinutes !== undefined && endMinutes !== undefined && endMinutes <= startMinutes ? "End time must be after start time. Choose a later end time." : "";
  const minutesValue = /^\d+$/.test(durationMinutes) ? Number(durationMinutes) : NaN;
  const durationProblem = durationMinutes && !(minutesValue >= 1 && minutesValue <= maximumMinutes) ? `Enter whole minutes from 1 to ${maximumMinutes}.` : "";
  const dateProblem = serviceDate && context && (serviceDate > context.today || serviceDate < context.earliestServiceDate) ? `Choose a date from ${context.earliestServiceDate} to ${context.today}.` : "";
  const addingTeam = logging === "team" && teamId === newTeam;
  const teamCheckKey = addingTeam && teamProgram && firstCheckableNumber.test(teamNumber.trim()) ? `${teamProgram}:${teamNumber.trim()}` : "";
  const currentCheck = teamCheck && teamCheck.key === teamCheckKey ? teamCheck : undefined;
  const firstName = currentCheck?.status === "found" ? currentCheck.name : undefined;
  // A debounced check of a new team's number and program. FIRST's name fills in and locks the team name; a member's
  // typed name comes back when the number or program changes. "Not found" only warns, and "unavailable" stays quiet.
  useEffect(() => {
    if (!teamCheckKey) return;
    const controller = new AbortController(); const [program, number] = [teamCheckKey.slice(0, teamCheckKey.indexOf(":")), teamCheckKey.slice(teamCheckKey.indexOf(":") + 1)];
    const timer = window.setTimeout(() => {
      setTeamCheck({ key: teamCheckKey, status: "checking" });
      void publicApi<{ status: "found" | "not-found" | "unavailable"; name?: string }>(`team-lookup?program=${encodeURIComponent(program)}&number=${encodeURIComponent(number)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setTeamCheck(result.status === "found" && result.name ? { key: teamCheckKey, status: "found", name: result.name } : { key: teamCheckKey, status: result.status === "not-found" ? "not-found" : "unavailable" }); })
        .catch(() => { if (!controller.signal.aborted) setTeamCheck({ key: teamCheckKey, status: "unavailable" }); });
    }, teamCheckDelayMs);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [teamCheckKey]);
  const shownTeamName = firstName ?? typedTeamName;
  const teamCheckHelp = currentCheck?.status === "checking" ? "Checking the team number with FIRST..." : firstName !== undefined ? "Name from FIRST. Change the number or program to edit it."
    : currentCheck?.status === "not-found" ? `FIRST has no ${teamProgram} team ${teamNumber.trim()}. Check the number, or enter the team name to add it anyway.` : "";
  const body = useMemo(() => {
    if (!context) return undefined;
    if (logging === "activity") return { memberExternalId, activityId, serviceDate: entryDate, startLocal, endLocal, ...(startOccurrence ? { startOccurrence } : {}), ...(endOccurrence ? { endOccurrence } : {}), taskNotes, expectedTimeZone: context.timeZone };
    const common = { kind: logging, memberExternalId, serviceDate, durationMinutes: minutesValue, expectedTimeZone: context.timeZone };
    if (logging === "other") return { ...common, taskNotes };
    return { ...common, ...(addingTeam ? { team: { number: teamNumber, program: teamProgram, name: shownTeamName } } : { teamId }), ...(taskNotes.trim() ? { taskNotes } : {}) };
  }, [logging, memberExternalId, activityId, entryDate, startLocal, endLocal, startOccurrence, endOccurrence, taskNotes, context, serviceDate, minutesValue, addingTeam, teamNumber, teamProgram, shownTeamName, teamId]);
  const selfLoggedReady = Boolean(serviceDate) && !dateProblem && Boolean(durationMinutes) && !durationProblem && (logging === "other" ? Boolean(taskNotes.trim())
    : addingTeam ? Boolean(teamNumber.trim() && teamProgram && shownTeamName.trim()) : Boolean(teamId));
  const ready = logging === "activity" ? Boolean(activityId && entryDate && startMinutes !== undefined && endMinutes !== undefined && !timeOrderProblem) : selfLoggedReady;
  const chosenTeam = teams?.find(item => item.id === teamId);
  const loggedText = () => logging === "activity" ? activity?.title ?? "" : logging === "other" ? taskNotes.trim() : addingTeam ? teamLabel({ number: teamNumber.trim(), name: shownTeamName.trim(), program: teamProgram }) : chosenTeam ? teamLabel(chosenTeam) : "";

  async function submit(event?: React.FormEvent, exact?: Record<string, unknown>) {
    event?.preventDefault(); if ((!body && !exact) || (!exact && (pending || !ready))) return;
    const submission = exact ?? { ...body, idempotencyKey: crypto.randomUUID() }; setPending(submission); setBusy(true); setNotice("");
    if (!exact) setLoggedLabel(loggedText());
    try { const saved = await publicApi<Receipt>("entries", { method: "POST", body: JSON.stringify(submission) }); setReceipt(saved); setPending(undefined); clearValidation(); if (addingTeam) setTeams(undefined); }
    catch (error) {
      const uncertain = !(error instanceof PublicFormError) || error.retryExact; if (!uncertain) setPending(undefined);
      setNotice(`${(error as Error).message}${uncertain ? " If the network result is uncertain, retry the exact submission below." : ""}`);
    } finally { setBusy(false); }
  }
  function changeStartLocal(nextStartLocal: string) {
    setStartLocal(nextStartLocal); const nextStartMinutes = localMinutes(nextStartLocal); const currentEndMinutes = localMinutes(endLocal);
    if (nextStartMinutes === undefined || currentEndMinutes === undefined || nextStartMinutes < currentEndMinutes) return;
    const nextEndLocal = endAfterStart(nextStartLocal); if (nextEndLocal) { setEndLocal(nextEndLocal); setEndOccurrence(undefined); }
  }
  async function submitCorrection(event?: React.FormEvent, exact?: Record<string, unknown>) {
    event?.preventDefault(); if (!exact && correctionPending) return;
    const submission = exact ?? { memberExternalId, activityId, message: correctionMessage, idempotencyKey: crypto.randomUUID() };
    setCorrectionPending(submission); setBusy(true); setNotice("");
    try { const saved = await publicApi<CorrectionReceipt>("corrections", { method: "POST", body: JSON.stringify(submission) }); setCorrectionReceipt(saved); setCorrectionPending(undefined); clearValidation(); }
    catch (error) {
      const uncertain = !(error instanceof PublicFormError) || error.retryExact; if (!uncertain) setCorrectionPending(undefined);
      setNotice(`${(error as Error).message}${uncertain ? " If the network result is uncertain, retry the exact request below." : ""}`);
    } finally { setBusy(false); }
  }
  async function loadMoreCorrectionActivities() {
    if (!correctionCursor) return; setBusy(true);
    try { const page = await publicApi<Page<Activity>>(`correction-activities?limit=100&after=${encodeURIComponent(correctionCursor)}`); setCorrectionActivities(previous => [...previous, ...page.items]); setCorrectionCursor(page.nextCursor); }
    catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  function clearChoiceFields() { setTaskNotes(""); setActivityId(""); setStartLocal(""); setEndLocal(""); setStartOccurrence(undefined); setEndOccurrence(undefined); setTeamId(""); setTeamNumber(""); setTeamProgram(""); setTypedTeamName(""); setTeamCheck(undefined); setServiceDate(""); setDurationMinutes(""); }
  function reset() { setReceipt(undefined); clearChoiceFields(); setPending(undefined); setNotice(""); setMode("entry"); clearValidation(); }
  function chooseLogging(next: Logging) { if (next === logging) return; setLogging(next); clearChoiceFields(); setPending(undefined); setNotice(""); }
  function preventImplicitSubmission(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || !(event.target instanceof HTMLElement)) return;
    if (event.target.tagName !== "TEXTAREA" && event.target.tagName !== "BUTTON") event.preventDefault();
  }
  const alert = notice && <p ref={noticeRef} tabIndex={-1} className="ui-status" data-tone="error" role="alert">{notice}</p>;
  if (correctionReceipt) return <main id="dashboard-content" className="public-outreach-page"><section className="ui-card public-outreach-receipt" aria-labelledby="correction-receipt-title"><p className="kicker">Outreach correction</p><h1 id="correction-receipt-title">Correction request received</h1><p>Staff will review this request before any counted participation changes.</p><button className="ui-button ui-button--primary" type="button" onClick={() => { setCorrectionReceipt(undefined); setCorrectionMessage(""); setCorrectionPending(undefined); reset(); }}>Return to participation form</button></section></main>;
  if (receipt) return <main id="dashboard-content" className="public-outreach-page"><section className="ui-card public-outreach-receipt" aria-labelledby="outreach-receipt-title"><p className="kicker">Outreach Participation</p><h1 id="outreach-receipt-title">Participation recorded</h1><p><strong>{receipt.durationMinutes} minutes</strong> counted for {receipt.serviceDate}{receipt.timing === "duration" ? "" : `, from ${receipt.startLocal} to ${receipt.endLocal}`}{loggedLabel ? ` (${loggedLabel})` : ""}.</p><div className="module-actions"><button className="ui-button ui-button--primary" type="button" onClick={reset}>Record separate participation</button><button className="ui-button" type="button" onClick={() => { setReceipt(undefined); setMode("correction"); }}>Request a correction</button></div></section></main>;
  if (mode === "correction") return <main id="dashboard-content" className="public-outreach-page"><section className="public-outreach-intro"><p className="kicker">Member correction</p><h1>Request an Outreach correction</h1><p>Select the activity and describe what Staff should review. Counted participation changes only after Staff approves a correction.</p></section>{alert}<form className="ui-card ui-form outreach-stack public-outreach-form" onSubmit={event => void submitCorrection(event)} onKeyDown={preventImplicitSubmission}>
    {memberField}
    <label>Outreach activity<select required className="ui-native-select" value={activityId} onChange={event => setActivityId(event.target.value)}><option value="">Choose an activity</option>{[...correctionActivities].sort((a, b) => b.serviceDate.localeCompare(a.serviceDate) || a.title.localeCompare(b.title)).map(item => <option key={item.id} value={item.id}>{item.serviceDate} - {item.title}</option>)}</select>{!correctionActivities.length && <span className="field-help">No activities are available for correction.</span>}</label>
    {correctionCursor && <button className="ui-button" type="button" disabled={busy} onClick={() => void loadMoreCorrectionActivities()}>Load more activities</button>}
    <label>What should Staff review?<textarea required maxLength={4000} value={correctionMessage} onChange={event => setCorrectionMessage(event.target.value)} /></label>
    <div className="module-actions"><button className="ui-button ui-button--primary" disabled={busy || Boolean(correctionPending) || validation?.status === "invalid" || !memberExternalId.trim() || !activityId || !correctionMessage.trim()}>{busy ? "Confirming..." : "Send correction request"}</button>{correctionPending && <button className="ui-button" type="button" disabled={busy} onClick={() => void submitCorrection(undefined, correctionPending)}>Retry exact request</button>}<button className="ui-button" type="button" disabled={busy} onClick={() => { reset(); }}>Back to participation form</button></div>
  </form></main>;

  const dateAndMinutes = () => context && <div className="public-outreach-row">
    <label>Service date<input type="date" required min={context.earliestServiceDate} max={context.today} value={serviceDate} aria-invalid={Boolean(dateProblem) || undefined} aria-describedby={dateProblem ? "public-service-date-help" : undefined} onChange={event => setServiceDate(event.target.value)} />{dateProblem && <span id="public-service-date-help" className="field-help" role="alert">{dateProblem}</span>}</label>
    <label>Minutes<input type="number" required inputMode="numeric" min={1} max={maximumMinutes} step={1} value={durationMinutes} aria-invalid={Boolean(durationProblem) || undefined} aria-describedby={durationProblem ? "public-duration-help" : undefined} onChange={event => setDurationMinutes(event.target.value)} />{durationProblem && <span id="public-duration-help" className="field-help" role="alert">{durationProblem}</span>}</label>
  </div>;
  const submitLabel = logging === "team" ? "Record team support" : logging === "other" ? "Record other service" : "Record completed participation";

  return <main id="dashboard-content" className="public-outreach-page"><section className="public-outreach-intro"><div><p className="kicker">Member submission</p><h1>Record Outreach Participation</h1></div><button className="ui-button" type="button" onClick={() => { setMode("correction"); setNotice(""); }}>Request a correction instead</button></section>{alert}
    {busy && !context ? <p role="status">Loading current Outreach choices...</p> : context && <form className="ui-card ui-form outreach-stack public-outreach-form" onSubmit={event => void submit(event)} onKeyDown={preventImplicitSubmission}>
      <fieldset className="meeting-view-toggle public-outreach-choice" disabled={Boolean(pending)}><legend>What are you logging?</legend><div>{loggingChoices.map(choice => <label key={choice.value} className={logging === choice.value ? "selected" : ""}><input type="radio" name="public-outreach-logging" value={choice.value} checked={logging === choice.value} onChange={() => chooseLogging(choice.value)} />{choice.label}</label>)}</div></fieldset>
      {logging === "activity" ? <>
        <div className="public-outreach-row">{memberField}
          <label>Dated activity<select required className="ui-native-select" value={activityId} onChange={event => { if (event.target.value !== activityId) { setStartLocal(""); setEndLocal(""); } setActivityId(event.target.value); setStartOccurrence(undefined); setEndOccurrence(undefined); }}><option value="">Choose an eligible activity</option>{[...activities].sort((a, b) => b.serviceDate.localeCompare(a.serviceDate) || a.title.localeCompare(b.title)).map(item => <option key={item.id} value={item.id}>{item.serviceDate} - {item.title}{item.reopened ? " - reopened by Staff" : ""}</option>)}</select>{!activities.length && <span className="field-help">No Staff-created activities are open. Choose Team support or Other service instead.</span>}{activity?.location && <span className="field-help">Location: {activity.location}</span>}</label>
        </div>
        <div className="outreach-time-grid"><OutreachClock label="Start time" date={entryDate} time={startLocal} zone={context.timeZone} occurrence={startOccurrence} onTime={changeStartLocal} onOccurrence={setStartOccurrence} disabled={busy || !entryDate} showContext={false} /><OutreachClock label="End time" date={entryDate} time={endLocal} zone={context.timeZone} occurrence={endOccurrence} onTime={setEndLocal} onOccurrence={setEndOccurrence} disabled={busy || !entryDate} showContext={false} /></div>
        {timeOrderProblem && <p className="ui-status" data-tone="error" role="alert">{timeOrderProblem}</p>}
        <label>Private task notes (optional)<textarea maxLength={4000} rows={2} value={taskNotes} onChange={event => setTaskNotes(event.target.value)} /></label>
      </> : logging === "team" ? <>
        <div className="public-outreach-row">{memberField}
          <label>Team<select required className="ui-native-select" value={teamId} disabled={!teams} onChange={event => setTeamId(event.target.value)}><option value="">{teams ? "Choose a supported team" : "Loading supported teams..."}</option>{teams?.map(item => <option key={item.id} value={item.id}>{teamLabel(item)}</option>)}<option value={newTeam}>My team is not listed - add it</option></select></label>
        </div>
        {addingTeam && <div className="public-outreach-row public-outreach-row--team">
          <label>Team number<input required maxLength={32} autoComplete="off" value={teamNumber} aria-describedby={teamCheckHelp ? "public-team-check-help" : undefined} onChange={event => setTeamNumber(event.target.value)} /></label>
          <label>Program<select required className="ui-native-select" value={teamProgram} onChange={event => setTeamProgram(event.target.value)}><option value="">Choose</option>{outreachPrograms.map(program => <option key={program} value={program}>{program}</option>)}</select></label>
          <label>Team name<input required maxLength={150} autoComplete="off" value={shownTeamName} readOnly={firstName !== undefined} aria-describedby={teamCheckHelp ? "public-team-check-help" : undefined} onChange={event => setTypedTeamName(event.target.value)} />{teamCheckHelp && <span id="public-team-check-help" className={`field-help${currentCheck?.status === "not-found" ? " public-outreach-warning" : ""}`} role="status">{teamCheckHelp}</span>}</label>
        </div>}
        {dateAndMinutes()}
        <label>Note (optional)<input maxLength={teamNoteLength} autoComplete="off" value={taskNotes} onChange={event => setTaskNotes(event.target.value)} /></label>
      </> : <>
        {memberField}
        <label>Description<input required maxLength={descriptionLength} autoComplete="off" placeholder="For example, STEM tutoring" value={taskNotes} onChange={event => setTaskNotes(event.target.value)} /></label>
        {dateAndMinutes()}
      </>}
      <div className="module-actions public-outreach-actions"><button className="ui-button ui-button--primary" disabled={busy || Boolean(pending) || validation?.status === "invalid" || !memberExternalId.trim() || !ready}>{busy ? "Confirming..." : submitLabel}</button>{pending && <button className="ui-button" type="button" disabled={busy} onClick={() => void submit(undefined, pending)}>Retry exact submission</button>}{selfLogged && <p className="field-help">Counts right away.{logging === "team" ? " A team you add joins the supported teams list for Staff to review." : ""}</p>}</div>
    </form>}
  </main>;
}
