const $ = (id) => document.getElementById(id);
const form = $("observe-form"), button = $("observe"), report = $("report"), error = $("error"), status = $("status");
function text(el, value) { el.textContent = String(value ?? ""); }
function emptyOrItems(container, rows, render) {
  container.replaceChildren();
  if (!rows.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "No visible items captured."; container.append(p); return; }
  for (const row of rows) container.append(render(row));
}
function evidenceItem(label, value, id, href) {
  const div = document.createElement("div"); div.className = "evidence-item";
  const small = document.createElement("small"); small.textContent = `${id} · ${label}`;
  const body = href ? document.createElement("a") : document.createElement("span");
  body.textContent = value; if (href) { body.href = href; body.target = "_blank"; body.rel = "noopener noreferrer"; }
  div.append(small, body); return div;
}
function showReceipt(r) {
  text($("receipt-id"), r.id); $("receipt-id").dataset.receiptId = r.id; text($("page-title"), r.title || "Untitled page");
  text($("http-status"), `HTTP ${r.status ?? "unknown"} · ${r.engine}`);
  const final = $("final-url"); final.href = r.finalUrl; final.textContent = r.finalUrl;
  $("screenshot").src = r.screenshotUrl; text($("visible-text"), r.text || "No visible body text extracted.");
  text($("text-count"), `${(r.text || "").length.toLocaleString()} chars`);
  emptyOrItems($("headings"), r.headings.map((x,i) => ({x,i})), ({x,i}) => evidenceItem(`HEADING · ${i+1}`, x, r.observations.find(o => o.kind === "heading" && o.value === x)?.evidenceId || "—"));
  emptyOrItems($("links"), r.links, x => evidenceItem("LINK", x.text, r.observations.find(o => o.kind === "link" && o.value.startsWith(`${x.text} →`))?.evidenceId || "—", x.href));
  emptyOrItems($("controls"), r.controls, x => evidenceItem(`${x.role.toUpperCase()}${x.disabled ? " · DISABLED" : ""}`, x.label, r.observations.find(o => o.kind === "control" && o.value.startsWith(`${x.role}: ${x.label}`))?.evidenceId || "—"));
  text($("receipt-details"), JSON.stringify({ id:r.id, requestedUrl:r.requestedUrl, finalUrl:r.finalUrl, status:r.status, snapshotHash:r.snapshotHash, screenshotHash:r.screenshotHash, actionsPerformed:r.actionsPerformed, mutations:r.mutations, observations:r.observations }, null, 2));
  report.hidden = false; error.hidden = true; status.hidden = true;
}
form.addEventListener("submit", async event => {
  event.preventDefault(); error.hidden = true; report.hidden = true; status.hidden = false; text(status, "Opening isolated browser and reading visible page evidence…"); button.disabled = true;
  try {
    const response = await fetch("/api/lens/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: $("url").value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || `Observation failed (${response.status})`); showReceipt(result);
  } catch (err) { text(error, err instanceof Error ? err.message : "Observation failed"); error.hidden = false; status.hidden = true; }
  finally { button.disabled = false; }
});
