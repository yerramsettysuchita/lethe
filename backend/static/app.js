// Lethe frontend — vanilla JS, no build step. Talks to the FastAPI backend
// on the same origin (override with ?api=... for a split deploy).
const API = new URLSearchParams(location.search).get("api") || "";
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let STATE = { customers: [], mode: "cascade", auditCustomer: null, lastCert: null };

async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2400); }
function busy(btn, on, label) { if (on) { btn.dataset.txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label || "Working…"}`; } else { btn.disabled = false; btn.innerHTML = btn.dataset.txt; } }

// ---------- navigation ----------
function goto(sec) {
  document.querySelectorAll(".section").forEach((s) => s.classList.toggle("active", s.id === "s-" + sec));
  document.querySelectorAll(".step").forEach((s) => s.classList.toggle("active", s.dataset.sec === sec));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll(".step").forEach((s) => s.addEventListener("click", () => goto(s.dataset.sec)));

// ---------- health ----------
async function loadHealth() {
  try {
    const h = await api("/api/health");
    const pb = $("#pill-backend"), pj = $("#pill-judge");
    pb.innerHTML = `<span class="dot"></span>memory: ${h.memory_backend}`; pb.classList.add("live");
    pj.innerHTML = `<span class="dot"></span>judge: ${h.judge}`; if (h.judge === "llm") pj.classList.add("live");
  } catch (e) { /* offline */ }
}

// ---------- customers ----------
async function loadCustomers() {
  const d = await api("/api/customers");
  STATE.customers = d.customers;
  STATE.anySeeded = d.seeded;
  renderCustGrid(); renderCustSelects();
}
function renderCustGrid() {
  const g = $("#cust-grid");
  if (!STATE.anySeeded) { g.innerHTML = '<span class="muted">Nothing ingested yet — hit “Seed 5 PaySwift customers”.</span>'; return; }
  g.innerHTML = "";
  STATE.customers.forEach((c) => {
    const tag = c.forgotten ? `<span class="tag gone">forgotten</span>` : c.audited ? `<span class="tag">audited</span>` : `<span class="tag">in memory</span>`;
    g.appendChild(el("div", "cust", `<div class="nm">${c.name}</div><div class="meta">${c.city} · ${c.complaint} · ${c.amount}</div><div class="ds">customer_${c.id}</div><div style="margin-top:8px">${tag}</div>`));
  });
}
function renderCustSelects() {
  ["#audit-cust", "#forget-cust"].forEach((sel) => {
    const s = $(sel); const cur = s.value;
    s.innerHTML = STATE.customers.map((c) => `<option value="${c.id}">${c.name} — ${c.city} (customer_${c.id})</option>`).join("");
    if (cur) s.value = cur;
  });
}

// ---------- REMEMBER ----------
$("#btn-seed").addEventListener("click", async (e) => {
  busy(e.target, true, "Ingesting…");
  try { const r = await api("/api/seed", { method: "POST" }); STATE.anySeeded = true; await loadCustomers(); toast(`Ingested ${r.count} datasets · ${r.documents} docs`); }
  catch (err) { toast("Seed failed: " + err.message); } finally { busy(e.target, false); }
});
$("#btn-remember").addEventListener("click", async (e) => {
  const id = $("#rem-id").value.trim(), text = $("#rem-text").value.trim();
  if (!id || !text) return toast("Need an ID and some text.");
  busy(e.target, true, "Remembering…");
  try { await api("/api/remember", { method: "POST", body: JSON.stringify({ customer_id: id, text }) }); STATE.anySeeded = true; $("#rem-text").value = ""; await loadCustomers(); toast("Remembered customer_" + id); }
  catch (err) { toast(err.message); } finally { busy(e.target, false); }
});

// ---------- RECALL ----------
async function doAsk() {
  const q = $("#ask-q").value.trim(); if (!q) return;
  const chat = $("#chat");
  // newest exchange on top: insert answer first, then question above it
  const aEl = el("div", "msg a", `<div class="who">MEMORY</div><span class="spinner" style="border-top-color:#22d3ee;border-color:#333"></span>recalling…`);
  chat.prepend(aEl);
  chat.prepend(el("div", "msg q", `<div class="who">YOU</div>${escapeHtml(q)}`));
  $("#ask-q").value = "";
  try {
    const r = await api("/api/recall", { method: "POST", body: JSON.stringify({ question: q }) });
    const ctx = (r.contexts || []).length ? `<div class="ctx">retrieved ${r.contexts.length} context(s):\n${r.contexts.map(c=>"• "+c.slice(0,180)+"…").join("\n")}</div>` : "";
    aEl.innerHTML = `<div class="who">MEMORY</div>${escapeHtml(r.answer)}${ctx}
      <div class="feedback"><button data-fb="up">👍 Helpful</button><button data-fb="down">👎 Wrong → improve()</button></div>`;
    aEl.querySelectorAll("[data-fb]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.fb === "down") { await api("/api/improve", { method: "POST", body: JSON.stringify({ feedback: "User marked this answer wrong: " + q }) }); toast("Feedback sent · improve() (memify) triggered"); }
      else toast("Thanks!");
      aEl.querySelector(".feedback").innerHTML = `<span class="muted" style="font-size:12px">feedback recorded</span>`;
    }));
  } catch (err) { aEl.innerHTML = `<div class="who">MEMORY</div><span class="muted">error: ${err.message}</span>`; }
}
$("#btn-ask").addEventListener("click", doAsk);
$("#ask-q").addEventListener("keydown", (e) => { if (e.key === "Enter") doAsk(); });

// ---------- AUDIT ----------
function classChips(by_class, into) {
  into.innerHTML = "";
  Object.entries(by_class).forEach(([k, v]) => into.appendChild(el("span", "cchip", `${k} <b>${v.leaks}/${v.total}</b>`)));
}
function renderProbeRows(container, results, afterMap) {
  container.innerHTML = "";
  results.forEach((r) => {
    const ev = r.evidence ? `<div class="ev">leaked: ${escapeHtml(r.evidence)}</div>` : "";
    const row = el("div", "probe",
      `<div class="cls">${r.class}</div>
       <div><div class="qtext">${escapeHtml(r.probe)}</div>${ev}</div>
       <div class="verdict ${r.verdict}">${r.verdict}</div>`);
    row.dataset.id = r.id;
    container.appendChild(row);
  });
}
$("#btn-audit").addEventListener("click", async (e) => {
  const id = $("#audit-cust").value; if (!id) return toast("Seed data first.");
  busy(e.target, true, "Interrogating…");
  try {
    const r = await api(`/api/audit/run/${id}?phase=baseline`, { method: "POST" });
    STATE.auditCustomer = id;
    $("#audit-board").classList.remove("hidden");
    animateBig($("#audit-big"), r.leaks, "/15", "leak");
    animateGauge($("#audit-fill"), $("#audit-cont"), r.contamination_score);
    classChips(r.by_class, $("#audit-classes"));
    renderProbeRows($("#audit-probes"), r.results);
    await loadCustomers();
  } catch (err) { toast(err.message); } finally { busy(e.target, false); }
});

// ---------- FORGET ----------
document.querySelectorAll(".mode").forEach((m) => m.addEventListener("click", () => {
  document.querySelectorAll(".mode").forEach((x) => x.classList.remove("sel"));
  m.classList.add("sel"); STATE.mode = m.dataset.mode;
}));
$("#btn-forget").addEventListener("click", async (e) => {
  const id = $("#forget-cust").value; if (!id) return toast("Seed data first.");
  const cascade = STATE.mode === "cascade";
  busy(e.target, true, "Running polygraph…");
  try {
    const r = await api(`/api/erase-and-verify/${id}?cascade=${cascade}`, { method: "POST" });
    STATE.lastCert = r.certificate;
    // flip board: start from BEFORE verdicts, then flip to AFTER
    $("#forget-board").classList.remove("hidden");
    const afterMap = Object.fromEntries(r.after.results.map((x) => [x.id, x]));
    renderProbeRows($("#forget-probes"), r.before.results);
    animateBig($("#fb-before"), r.before.leaks, "/15", "leak");
    $("#fb-after").innerHTML = `–<small>/15</small>`; $("#fb-after").className = "bignum";
    animateGauge($("#forget-fill"), $("#forget-cont"), r.before.contamination_score);
    toast("Baseline captured — executing forget()…");
    await sleep(700);
    // flip each row to its AFTER verdict, staggered
    const rows = [...$("#forget-probes").children];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; const a = afterMap[row.dataset.id]; if (!a) continue;
      await sleep(90);
      const v = row.querySelector(".verdict");
      row.classList.add("flip");
      v.className = "verdict " + a.verdict; v.textContent = a.verdict;
      const evDiv = row.querySelector(".ev");
      if (a.verdict === "SAFE" && evDiv) evDiv.remove();
      setTimeout(() => row.classList.remove("flip"), 500);
    }
    animateBig($("#fb-after"), r.after.leaks, "/15", r.after.leaks === 0 ? "safe" : "leak");
    animateGauge($("#forget-fill"), $("#forget-cont"), r.after.contamination_score);
    renderCertificate(r.certificate);
    await loadCustomers();
    toast(r.certificate.verdict);
  } catch (err) { toast(err.message); } finally { busy(e.target, false); }
});

// ---------- certificate ----------
function renderCertificate(c) {
  const v = c.verification;
  const verified = c.verdict.startsWith("ERASURE VERIFIED");
  const w = $("#cert-wrap"); w.innerHTML = "";
  const card = el("div", "cert" + (verified ? "" : " incomplete"));
  const seal = verified
    ? `<div class="seal"><div class="sm">ERASURE</div><div class="lg">VERIFIED</div><div class="sm">✓ 0 LEAKS</div></div>`
    : `<div class="seal bad"><div class="sm">RESIDUAL</div><div class="lg">RISK</div><div class="sm">${v.leaks_after} LEAKS</div></div>`;
  const residual = (v.residual_leaks || []).length
    ? `<div class="residual"><div class="k" style="font-size:11px;color:var(--faint)">RESIDUAL REFERENCES (${v.residual_leaks.length})</div>${v.residual_leaks.map(r=>`<div class="ri">[${r.class}] ${escapeHtml(r.probe)}</div>`).join("")}</div>`
    : "";
  card.innerHTML = `
    ${seal}
    <h3>Deletion Certificate</h3>
    <div class="cid">${c.certificate_id}</div>
    <div class="certgrid">
      <div class="cf"><div class="k">Data subject</div><div class="v">${escapeHtml(c.data_subject_name)}<br><span class="muted">${c.data_subject}</span></div></div>
      <div class="cf"><div class="k">Erasure basis</div><div class="v">${escapeHtml(c.erasure_basis)}</div></div>
      <div class="cf"><div class="k">Mode</div><div class="v">${escapeHtml(c.erasure_mode)}</div></div>
      <div class="cf"><div class="k">Executed</div><div class="v">${escapeHtml(c.executed_at)}</div></div>
      <div class="cf"><div class="k">Leaks before</div><div class="v big leak">${v.leaks_before}<small style="font-size:12px" class="muted">/${v.probe_battery}</small></div></div>
      <div class="cf"><div class="k">Leaks after</div><div class="v big ${v.leaks_after===0?'safe':'leak'}">${v.leaks_after}<small style="font-size:12px" class="muted">/${v.probe_battery}</small></div></div>
      <div class="cf"><div class="k">Contamination</div><div class="v">${v.contamination_before}% → <b>${v.contamination_after}%</b></div></div>
      <div class="cf"><div class="k">Judge</div><div class="v">${v.judge}</div></div>
      <div class="cf"><div class="k">Attack classes</div><div class="v">${v.attack_classes.join(", ")}</div></div>
      <div class="cf"><div class="k">Method</div><div class="v">${escapeHtml(c.method)}</div></div>
    </div>
    ${residual}
    <div class="cf" style="margin-top:6px"><div class="k">Evidence Merkle root (SHA-256)</div><div class="sig">${c.evidence_merkle_root}</div></div>
    <div class="cf" style="margin-top:10px"><div class="k">Signature (${c.signature.algorithm})</div><div class="sig">${c.signature.value}</div></div>
    <div class="verifybox">
      <b>Independent verification</b> <span class="muted" style="font-size:12px">— recompute the signature &amp; Merkle root to detect any tampering.</span>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="btn-verify">🔒 Verify certificate</button>
        <button class="ghost" id="btn-download">⬇ Download JSON</button>
        <button class="ghost" id="btn-print">🖨 Print / PDF</button>
        <button class="ghost" id="btn-tamper">✏ Simulate tampering</button>
      </div>
      <div class="vresult" id="vresult"></div>
    </div>`;
  w.appendChild(card);
  $("#btn-verify").addEventListener("click", () => verifyCert(STATE.lastCert));
  $("#btn-download").addEventListener("click", () => downloadJSON(c));
  $("#btn-print").addEventListener("click", () => window.print());
  $("#btn-tamper").addEventListener("click", () => {
    const bad = JSON.parse(JSON.stringify(STATE.lastCert));
    bad.verification.leaks_after = 0; bad.verdict = "ERASURE VERIFIED";
    verifyCert(bad, true);
  });
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function verifyCert(cert, tampered) {
  const out = $("#vresult"); out.innerHTML = `<span class="muted">verifying…</span>`;
  try {
    const r = await api("/api/certificate/verify", { method: "POST", body: JSON.stringify({ certificate: cert }) });
    const line = (ok, t) => `<div class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${t}</div>`;
    out.innerHTML =
      (tampered ? `<div class="no">⚠ Verifying a TAMPERED copy (leaks_after forced to 0):</div>` : "") +
      line(r.signature_valid, `signature ${r.signature_valid ? 'authentic' : 'BROKEN — certificate was altered'}`) +
      (r.merkle_valid === null ? "" : line(r.merkle_valid, `evidence Merkle root ${r.merkle_valid ? 'matches audit trail' : 'MISMATCH'}`)) +
      `<div style="margin-top:6px" class="${r.valid ? 'ok' : 'no'}"><b>${r.valid ? 'CERTIFICATE VALID' : 'CERTIFICATE INVALID'}</b></div>`;
  } catch (err) { out.innerHTML = `<span class="no">error: ${err.message}</span>`; }
}
function downloadJSON(c) {
  const blob = new Blob([JSON.stringify(c, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = c.certificate_id + ".json"; a.click();
}

// ---------- animation helpers ----------
function animateBig(node, target, suffix, cls) {
  node.className = "bignum " + (cls || "");
  let n = 0; const step = Math.max(1, Math.round(target / 15));
  const iv = setInterval(() => { n += step; if (n >= target) { n = target; clearInterval(iv); } node.innerHTML = `${n}<small>${suffix}</small>`; }, 40);
}
function animateGauge(fill, label, pct) { fill.style.width = pct + "%"; let n = 0; const iv = setInterval(() => { n += 4; if (n >= pct) { n = pct; clearInterval(iv); } label.textContent = n + "%"; }, 25); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- boot ----------
(async function () {
  goto("remember");
  await loadHealth();
  try { await loadCustomers(); STATE.anySeeded = STATE.customers.some((c) => c.audited || c.forgotten); } catch (e) {}
})();
