import { useEffect, useState } from "react";
import { dashboardApi as api } from "@lancerlogin/module-sdk/dashboard";

type Settings = { memberValidation: "off" | "validity" | "name"; revision: number };
export function OutreachPublicFormSettings() {
  const [saved, setSaved] = useState<Settings>(); const [mode, setMode] = useState<Settings["memberValidation"]>("off"); const [busy, setBusy] = useState(true); const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"error" | "success">("error");
  useEffect(() => {
    let current = true;
    void api<Settings>("/admin/hours/public-form-settings").then(next => { if (current) { setSaved(next); setMode(next.memberValidation); } })
      .catch(error => { if (current) setNotice((error as Error).message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!saved) return; setBusy(true); setNotice("");
    try { const next = await api<Settings>("/admin/hours/public-form-settings", { method: "PUT", body: JSON.stringify({ memberValidation: mode, revision: saved.revision }) }); setSaved(next); setNoticeTone("success"); setNotice("Public form privacy settings saved."); }
    catch (error) { setNoticeTone("error"); setNotice((error as Error).message); } finally { setBusy(false); }
  }
  return <section className="ui-card outreach-stack" aria-labelledby="outreach-public-privacy-title"><h2 id="outreach-public-privacy-title">Public member-ID validation</h2>
    <p>Live checks use only the entered ID. No roster list is sent to the browser. Even ID-only checks reveal roster membership; showing names also reveals member identity.</p>
    <form className="ui-form outreach-stack" onSubmit={event => void save(event)}><label>Public form privacy mode<select className="ui-native-select" value={mode} disabled={busy || !saved} onChange={event => setMode(event.target.value as Settings["memberValidation"])}>
      <option value="off">Off - no live member-ID checks</option><option value="validity">Validate ID only</option><option value="name">Validate ID and show name</option>
    </select></label><div className="module-actions"><button className="ui-button ui-button--primary" disabled={busy || !saved || mode === saved.memberValidation}>{busy ? saved ? "Saving..." : "Loading..." : "Save public form settings"}</button></div></form>
    {notice && <p className="ui-status" data-tone={noticeTone} role={noticeTone === "error" ? "alert" : "status"}>{notice}</p>}
  </section>;
}
