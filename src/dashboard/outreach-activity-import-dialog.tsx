import { type ChangeEvent, useRef, useState } from "react";
import { dashboardApi as api, downloadCsvTemplate, formatCsvDate, useModalFocus } from "@lancerlogin/module-sdk/dashboard";
import { outreachActivityCsvFieldHelp, outreachActivityCsvFieldLabels, outreachActivityCsvRowLimit, outreachActivityCsvTemplate, parseOutreachActivityCsvText, type OutreachActivityCsvField, type OutreachActivityCsvRow } from "../shared/outreach-activity-csv.ts";
import { bulkChoice, choosable, importButtonText, importHelpText, importTemplateFilename, issueText, labelsText, problemHeading, problemText, publicationNoteText, summaryText, teamText, timeText, typeText, warningText, type ActivityImportResult, type ImportChoice } from "./outreach-activity-import.ts";

const downloadTemplate = () => downloadCsvTemplate(importTemplateFilename, outreachActivityCsvTemplate);

/** Old and new values of a changed field, as <del>old</del> → <ins>new</ins>. */
function Change({ from, to }: { from: string; to: string }) {
  return <><del>{from}</del> <span className="import-arrow" aria-hidden="true">→</span> <ins>{to}</ins></>;
}

type Props = { open: boolean; timeZone: string; onClose: () => void; onImported: (result: ActivityImportResult) => Promise<void> };

/** Import Outreach activities from CSV, as Core imports meetings: upload or paste, then a server dry run previews every row before anything is written. */
export function OutreachActivityImportDialog({ open, timeZone, onClose, onImported }: Props) {
  const [csv, setCsv] = useState(""); const [sourceName, setSourceName] = useState(""); const [readingFile, setReadingFile] = useState(false);
  const [rows, setRows] = useState<OutreachActivityCsvRow[]>([]); const [recognised, setRecognised] = useState<OutreachActivityCsvField[]>([]); const [ignored, setIgnored] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]); const [preview, setPreview] = useState<ActivityImportResult>(); const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [busy, setBusy] = useState(false); const dialog = useRef<HTMLDivElement>(null); const fileInput = useRef<HTMLInputElement>(null);

  useModalFocus(dialog, open, busy, () => { if (preview) setPreview(undefined); else close(); });

  function close() { if (busy) return; setPreview(undefined); setErrors([]); setChoices({}); onClose(); }
  function showErrors(next: string[]) { setErrors(next); window.requestAnimationFrame(() => document.getElementById("outreach-import-errors")?.focus()); }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setCsv(""); setPreview(undefined); setSourceName("");
    if (!/\.csv$/i.test(file.name) || !file.size || file.size > 1_048_576) { setErrors(["Choose a nonempty .csv file no larger than 1 MiB."]); return; }
    setReadingFile(true); setErrors([]);
    try { setCsv(await file.text()); setSourceName(file.name); }
    catch { setErrors(["The CSV file could not be read. Try selecting it again."]); }
    finally { setReadingFile(false); }
  }
  async function dryRun(nextRows: OutreachActivityCsvRow[], nextChoices: Record<string, ImportChoice>) {
    setBusy(true);
    try { setPreview(await api<ActivityImportResult>("/admin/hours/activities/import", { method: "POST", body: JSON.stringify({ rows: nextRows, dryRun: true, actions: nextChoices }) })); setErrors([]); return true; }
    catch (error) { setPreview(undefined); showErrors([(error as Error).message]); return false; }
    finally { setBusy(false); }
  }
  async function prepare() {
    // The browser checks the file's shape; the server checks every row again with the same rules and decides what each one does.
    const parsed = parseOutreachActivityCsvText(csv); const next = [...parsed.errors];
    if (!parsed.rows.length && !(parsed.hasHeader && next.length)) next.push("Add at least one activity row.");
    if (parsed.rows.length > outreachActivityCsvRowLimit) next.push(`Import no more than ${outreachActivityCsvRowLimit} activities at a time.`);
    setRecognised(parsed.recognised); setIgnored(parsed.ignored);
    if (next.length) { showErrors(next); return; }
    setRows(parsed.rows); setChoices({});
    if (await dryRun(parsed.rows, {})) window.requestAnimationFrame(() => dialog.current?.focus());
  }
  function choose(next: Record<string, ImportChoice>) { setChoices(next); void dryRun(rows, next); }
  async function confirm() {
    setBusy(true);
    try { const result = await api<ActivityImportResult>("/admin/hours/activities/import", { method: "POST", body: JSON.stringify({ rows, dryRun: false, actions: choices }) }); setPreview(undefined); setCsv(""); setSourceName(""); setChoices({}); await onImported(result); onClose(); }
    catch (error) { showErrors([(error as Error).message]); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  const heading = <div className="dialog-heading"><div><h2 id="outreach-import-title">Import Outreach activities</h2><p>{preview ? "Review each activity before importing." : "Upload a CSV file or paste spreadsheet rows, then preview every activity."}</p></div><button type="button" aria-label="Close Outreach import" disabled={busy} onClick={close}>×</button></div>;
  const errorMessages = errors.length > 0 && <div id="outreach-import-errors" className="inline-messages error" role="alert" tabIndex={-1}><strong>Please fix the activities file</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>;
  let content;
  if (!preview) {
    content = <>
      {heading}
      <div className="roster-import-file" role="group" aria-labelledby="outreach-import-file-label">
        <span id="outreach-import-file-label">CSV file</span>
        <div className="roster-import-file-controls">
          <button type="button" aria-label="Choose CSV file" disabled={readingFile} onClick={() => fileInput.current?.click()}>Choose File</button>
          <span className="roster-import-filename" aria-live="polite">{sourceName || "No file chosen"}</span>
          <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="CSV file" hidden tabIndex={-1} disabled={readingFile} onChange={(event) => void chooseFile(event)} />
        </div>
      </div>
      {sourceName && <p className="field-help" role="status">Loaded {sourceName}. Review the rows below before previewing.</p>}
      <label>Activities CSV or spreadsheet rows<textarea className="code-textarea" rows={7} value={csv} placeholder="Paste CSV with headers or tab-separated spreadsheet rows" disabled={readingFile} onChange={(event) => { setCsv(event.target.value); setSourceName(""); setErrors([]); }} aria-describedby={errors.length ? "outreach-import-errors" : "outreach-import-help"} aria-invalid={errors.length > 0} /></label>
      <div className="roster-import-format" role="group" aria-labelledby="outreach-import-format-title">
        <div className="roster-import-format-heading"><span id="outreach-import-format-title">CSV format</span><button type="button" onClick={downloadTemplate}>Download template</button></div>
        <table className="roster-format-table"><caption className="visually-hidden">Outreach activity CSV columns</caption>
          <thead><tr><th scope="col">Column</th><th scope="col">Required</th><th scope="col">Example</th></tr></thead>
          <tbody>{outreachActivityCsvFieldHelp.map((column) => <tr key={column.field}><th scope="row">{column.label}</th><td>{column.required}</td><td>{column.example && <code>{column.example}</code>}</td></tr>)}</tbody>
        </table>
        <p id="outreach-import-help" className="field-help">{importHelpText(timeZone)}</p>
      </div>
      {errorMessages}
      <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-button" type="button" disabled={readingFile || busy} onClick={() => void prepare()}>{readingFile ? "Reading file…" : busy ? "Checking…" : "Preview activities"}</button></div>
    </>;
  } else {
    const { summary } = preview; const importing = summary.add + summary.update; const problems = preview.rows.filter((row) => row.action === "error");
    const matched = preview.rows.filter(choosable); const bulk = bulkChoice(preview.rows, choices);
    const setAll = (choice: ImportChoice) => choose(Object.fromEntries(matched.map((row) => [row.rowNumber, choice])));
    const warnings = [
      ...preview.rows.filter((row) => row.action !== "error").flatMap((row) => (row.warnings ?? []).map((warning) => warningText(row, warning))),
      ...(ignored.length ? [`Ignored columns: ${ignored.join(", ")}`] : []),
    ];
    content = <>
      {heading}
      {warnings.length > 0 && <div className="inline-messages warning" role="status"><strong>Review before importing</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      <div className="import-preview-bar">
        <p className="field-help roster-import-recognised">Recognised columns: {recognised.map((field) => outreachActivityCsvFieldLabels[field]).join(", ")}</p>
        {bulk && <div className="import-match-bulk">
          <fieldset className="meeting-view-toggle import-match-choice"><legend>Matching rows:</legend><div>
            {(["skip", "update"] as const).map((choice) => <label key={choice} className={bulk === choice ? "selected" : undefined}><input type="radio" name="outreach-match-action" value={choice} checked={bulk === choice} disabled={busy} onChange={() => setAll(choice)} />{choice === "skip" ? "Skip all" : "Update all"}</label>)}
          </div></fieldset>
          {bulk === "mixed" && <span className="import-match-state">Mixed</span>}
        </div>}
      </div>
      <div className="table-scroll"><table className="data-table roster-preview-table import-preview-table"><caption className="visually-hidden">Processed Outreach activity import</caption>
        <thead><tr><th scope="col">Change</th><th scope="col">Title</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Time</th><th scope="col">Team</th><th scope="col">Labels</th><th scope="col">Issues</th></tr></thead>
        <tbody>{preview.rows.map((row) => {
          const activity = row.activity; const existing = row.existing; const shown = row.action === "update" && existing;
          const changed = (name: string) => Boolean(shown && row.changes?.includes(name as never));
          const choice = choices[row.rowNumber] ?? "skip"; const note = publicationNoteText(row.publication);
          const badge = choosable(row) ? <select className={`ui-native-select import-row-select ${choice}`} aria-label={`Action for ${activity?.title ?? existing!.title}`} value={choice} disabled={busy} onChange={(event) => choose({ ...choices, [row.rowNumber]: event.target.value as ImportChoice })}><option value="skip">Skip</option><option value="update">Update</option></select>
            : <span className={`change-badge ${row.action}`}>{row.action === "error" ? "Error" : row.action === "add" ? "Add" : "Skip"}</span>;
          return <tr key={row.rowNumber}>
            <td>{badge}</td>
            <td className={changed("title") ? "import-change" : undefined}>{changed("title") ? <Change from={existing!.title} to={activity!.title} /> : activity?.title ?? row.title ?? "—"}{note && <small className="import-row-note">{note}</small>}</td>
            <td>{activity ? formatCsvDate(activity.date) : "—"}</td>
            <td>{activity ? typeText(activity) : "—"}</td>
            <td className={changed("time") ? "import-change" : undefined}>{!activity ? "—" : changed("time") ? <Change from={timeText(existing!)} to={timeText(activity)} /> : timeText(activity)}</td>
            <td>{activity ? teamText(activity) : "—"}</td>
            <td className={changed("labels") ? "import-change" : undefined}>{!activity ? "—" : changed("labels") ? <Change from={labelsText(existing!)} to={labelsText(activity)} /> : labelsText(activity)}</td>
            <td className={row.error ? "import-issue-error" : undefined}>{issueText(row)}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {problems.length > 0 && <div id="outreach-import-errors" className="inline-messages error" role="alert" tabIndex={-1}><strong>{problemHeading(problems.length)}</strong> Fix the file and preview again, or import the other rows.<ul>{problems.map((row) => <li key={row.rowNumber}>{problemText(row)}</li>)}</ul></div>}
      {errors.length > 0 && !problems.length && errorMessages}
      <p className="field-help import-preview-summary" role="status">{summaryText(summary)}</p>
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Back</button><button className="primary-button" type="button" disabled={busy || !importing} onClick={() => void confirm()}>{busy ? "Working…" : importButtonText(summary)}</button></div>
    </>;
  }
  return <div className="dialog-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="outreach-import-title" tabIndex={-1} ref={dialog}><section className="roster-import-dialog" aria-labelledby="outreach-import-title">{content}</section></div></div>;
}
