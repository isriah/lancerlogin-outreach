import { useEffect, useState } from "react";
import type { ModuleSnapshotItem } from "@lancerlogin/module-sdk";
import { dashboardApi as api } from "@lancerlogin/module-sdk/dashboard";
import { outreachPrograms } from "../shared/outreach-programs.ts";

type SetupStep = ModuleSnapshotItem["setup"]["steps"][number] & { valid: boolean; outcome: "completed" | "skipped" | null; completedAt: string | null };
type SetupState = { moduleId: string; generation: number; ready: boolean; phase: string; version: number; steps: SetupStep[] };
type Rules = { reportingDays: number; reopenHours: number; revision: number };
type Team = { id: string; name: string; number: string; program: string };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function readState(value: unknown, module: ModuleSnapshotItem): SetupState {
  if (!object(value) || value.moduleId !== module.id || value.generation !== module.generation || value.version !== module.setup.version || typeof value.ready !== "boolean" || value.phase !== "enabled" || !Array.isArray(value.steps) || value.steps.length !== module.setup.steps.length) throw new Error("Outreach setup state could not be verified. Reload setup.");
  const steps = value.steps.map((item, index) => {
    const expected = module.setup.steps[index];
    if (!object(item) || item.id !== expected?.id || item.label !== expected.label || item.required !== expected.required || typeof item.valid !== "boolean" || ![null, "completed", "skipped"].includes(item.outcome as string | null)) throw new Error("Outreach setup state could not be verified. Reload setup.");
    return item as SetupStep;
  });
  return { moduleId: module.id, generation: module.generation, ready: value.ready, phase: "enabled", version: module.setup.version, steps };
}

export function OutreachSetupWorkspace({ module, navigate, onReady }: { module: ModuleSnapshotItem; navigate: (path: string) => void; onReady: () => Promise<void> | void }) {
  const [state, setState] = useState<SetupState>(); const [current, setCurrent] = useState(0); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [rules, setRules] = useState<Rules>(); const [teams, setTeams] = useState<Team[]>([]); const [team, setTeam] = useState({ name: "", number: "", program: "" });
  async function load() {
    setBusy(true); setNotice("");
    try { const next = readState(await api(`/admin/modules/${encodeURIComponent(module.id)}/setup`), module); setState(next); const pending = next.steps.findIndex((item) => item.required ? !(item.valid && item.outcome === "completed") : item.outcome === null); setCurrent(pending < 0 ? 0 : pending); }
    catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [module.id, module.generation]);
  const step = state?.steps[current];
  useEffect(() => {
    if (step?.id === "rules") void api<{ values: Rules }>("/module-setup/hour-tracking/rules").then((result) => setRules(result.values)).catch((error: Error) => setNotice(error.message));
    if (step?.id === "catalog") void api<{ teams: Team[] }>("/module-setup/hour-tracking/catalog").then((result) => setTeams(result.teams)).catch((error: Error) => setNotice(error.message));
  }, [step?.id]);
  async function save() {
    if (!state || !step) return; setBusy(true); setNotice("");
    try {
      if (step.id === "rules") {
        if (!rules) throw new Error("Outreach entry rules are still loading.");
        const result = await api<{ values: Rules }>("/module-setup/hour-tracking/rules", { method: "PUT", body: JSON.stringify(rules) }); setRules(result.values);
      }
      if (step.id === "catalog" && !teams.length) {
        if (!team.name.trim()) throw new Error("Add at least one supported team before continuing.");
        const created = await api<Team>("/module-setup/hour-tracking/catalog", { method: "POST", body: JSON.stringify(team) }); setTeams([created]);
      }
      const outcome = step.required || step.valid ? "completed" : "skipped";
      const next = readState(await api(`/admin/modules/${encodeURIComponent(module.id)}/setup`, { method: "PUT", body: JSON.stringify({ generation: module.generation, stepId: step.id, outcome }) }), module); setState(next);
      if (current < next.steps.length - 1) setCurrent((index) => index + 1); else if (next.ready) { await onReady(); navigate("/hours"); } else setNotice("Complete every required Outreach step before finishing setup.");
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  const completed = state?.steps.filter((item) => item.outcome === "skipped" || item.outcome === "completed" && item.valid).length ?? 0;
  return <section className="module-onboarding" aria-labelledby="outreach-setup-title"><div className="page-intro"><p className="kicker">Outreach Participation module</p><h1 id="outreach-setup-title">Set up Outreach</h1><p>Confirm entry rules and add a supported team to finish module setup.</p></div>{notice && <p className="ui-status settings-notice" data-tone="error" role="alert">{notice}</p>}{!state && <p className="ui-status" role="status">{busy ? "Loading Outreach setup..." : "Outreach setup is unavailable."}</p>}{state && step && <><div className="module-setup-summary" role="status"><strong>{state.ready ? "Setup complete" : "Setup required"}</strong><span>Step {current + 1} of {state.steps.length} - {completed} recorded</span></div><article className="module-setup-card ui-form" aria-labelledby={`outreach-step-${step.id}`}><div className="module-setup-card-heading"><div><p className="kicker">Step {current + 1} - {step.required ? "Required" : "Optional"}</p><h2 id={`outreach-step-${step.id}`}>{step.label}</h2></div><span className="ui-status" data-tone={step.outcome === "skipped" || step.valid && step.outcome === "completed" ? "success" : step.valid ? "neutral" : "warning"}>{step.outcome === "skipped" ? "Set up later" : step.valid && step.outcome === "completed" ? "Complete" : step.valid ? "Ready" : "Action needed"}</span></div>
      {step.id === "rules" && (rules ? <div className="form-grid"><label>Reporting window in days<input type="number" min={1} max={365} value={rules.reportingDays} onChange={(event) => setRules({ ...rules, reportingDays: Number(event.target.value) })} /></label><p>Staff can reopen an activity's reporting for 24 hours when fewer than 24 hours remain or reporting is closed.</p><p>Members submit against eligible Staff-created activities through the public form or a linked Discord account. Staff review correction requests and can add participation from an activity when an exception requires it.</p></div> : <p role="status">Loading Outreach entry rules...</p>)}
      {step.id === "catalog" && <div className="outreach-stack"><p>Event, Team Support, and Other Service are ready. Add at least one team that Outreach can support.</p>{teams.length ? <ul className="compact-list">{teams.map((item) => <li key={item.id}><strong>{item.name}</strong>{item.number ? ` - ${item.number}` : ""}</li>)}</ul> : <div className="form-grid"><label>Supported team name<input required maxLength={150} value={team.name} onChange={(event) => setTeam({ ...team, name: event.target.value })} /></label><label>Team number<input maxLength={32} value={team.number} onChange={(event) => setTeam({ ...team, number: event.target.value })} /></label><label>Program<select className="ui-native-select" required value={team.program} onChange={(event) => setTeam({ ...team, program: event.target.value })}><option value="">Choose program</option>{outreachPrograms.map(program => <option key={program} value={program}>{program}</option>)}</select></label></div>}</div>}
      <div className="module-actions"><button className="ui-button" type="button" disabled={busy || current === 0} onClick={() => setCurrent((index) => index - 1)}>Back</button><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : !step.required && !step.valid ? "Set up later and finish" : current === state.steps.length - 1 ? "Finish Outreach setup" : "Save and continue"}</button></div></article></>}</section>;
}
