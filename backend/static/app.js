// Lethe frontend, vanilla JS, no build step. Talks to the FastAPI backend
// on the same origin (override with ?api=... for a split deploy).
const API = new URLSearchParams(location.search).get("api") || "";
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let STATE = { customers: [], mode: "cascade", auditCustomer: null, lastCert: null };
window.STATE = STATE;

async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2400); }
function busy(btn, on, label) { if (on) { btn.dataset.txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label || "Working..."}`; } else { btn.disabled = false; btn.innerHTML = btn.dataset.txt; } }

// ---------- navigation ----------
function goto(sec) {
  document.querySelectorAll(".section").forEach((s) => s.classList.toggle("active", s.id === "s-" + sec));
  document.querySelectorAll(".step").forEach((s) => s.classList.toggle("active", s.dataset.sec === sec));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (sec === "comply") loadCompliance();
}
document.querySelectorAll(".step").forEach((s) => s.addEventListener("click", () => goto(s.dataset.sec)));

// ---------- health ----------
async function loadHealth() {
  try {
    const h = await api("/api/health");
    STATE.cloud = h.cloud_configured;
    const pb = $("#pill-backend"), pj = $("#pill-judge");
    pb.innerHTML = `<span class="dot"></span>memory: ${h.memory_backend}`; pb.classList.add("live");
    pj.innerHTML = `<span class="dot"></span>judge: ${h.judge}`; if (h.judge === "llm") pj.classList.add("live");
    const cs = $("#cloud-status");
    if (cs) {
      cs.textContent = h.cloud_configured ? "Cognee Cloud connected" : "Cognee Cloud not configured";
      cs.className = "tag " + (h.cloud_configured ? "verified" : "");
    }
    const cgBtn = $("#btn-cloudproof");
    if (cgBtn && !h.cloud_configured) cgBtn.disabled = true;
  } catch (e) { /* offline */ }
}

// ---------- customers ----------
async function loadCustomers() {
  const d = await api("/api/customers");
  STATE.customers = d.customers;
  STATE.anySeeded = d.seeded;
  renderCustGrid(); renderCustSelects();
  if (window.renderGraph) window.renderGraph();
}
function renderCustGrid() {
  const g = $("#cust-grid");
  if (!STATE.anySeeded) { g.innerHTML = '<span class="muted">Nothing ingested yet, hit “Seed 5 PaySwift customers”.</span>'; return; }
  g.innerHTML = "";
  STATE.customers.forEach((c) => {
    const tag = c.forgotten ? `<span class="tag gone">forgotten</span>` : c.audited ? `<span class="tag">audited</span>` : `<span class="tag">in memory</span>`;
    g.appendChild(el("div", "cust", `<div class="nm">${c.name}</div><div class="meta">${c.city} ${c.complaint} ${c.amount}</div><div class="ds">customer_${c.id}</div><div style="margin-top:8px">${tag}</div>`));
  });
}
function renderCustSelects() {
  ["#audit-cust", "#forget-cust", "#cloudproof-cust", "#cloudgraph-cust"].forEach((sel) => {
    const s = $(sel); if (!s) return; const cur = s.value;
    s.innerHTML = STATE.customers.map((c) => `<option value="${c.id}">${c.name}, ${c.city} (customer_${c.id})</option>`).join("");
    if (cur) s.value = cur;
  });
}

// ---------- REMEMBER ----------
$("#btn-seed").addEventListener("click", async (e) => {
  busy(e.target, true, "Ingesting...");
  try { const r = await api("/api/seed", { method: "POST" }); STATE.anySeeded = true; await loadCustomers(); toast(`Ingested ${r.count} datasets ${r.documents} docs`); }
  catch (err) { toast("Seed failed: " + err.message); } finally { busy(e.target, false); }
});
$("#btn-remember").addEventListener("click", async (e) => {
  const id = $("#rem-id").value.trim(), text = $("#rem-text").value.trim();
  if (!id || !text) return toast("Need an ID and some text.");
  busy(e.target, true, "Remembering...");
  try { await api("/api/remember", { method: "POST", body: JSON.stringify({ customer_id: id, text }) }); STATE.anySeeded = true; $("#rem-text").value = ""; await loadCustomers(); toast("Remembered customer_" + id); }
  catch (err) { toast(err.message); } finally { busy(e.target, false); }
});

// ---------- RECALL ----------
async function doAsk() {
  const q = $("#ask-q").value.trim(); if (!q) return;
  const chat = $("#chat");
  // newest exchange on top: insert answer first, then question above it
  const aEl = el("div", "msg a", `<div class="who">MEMORY</div><span class="spinner" style="border-top-color:var(--emerald);border-color:rgba(0,0,0,.12)"></span>recalling...`);
  chat.prepend(aEl);
  chat.prepend(el("div", "msg q", `<div class="who">YOU</div>${escapeHtml(q)}`));
  $("#ask-q").value = "";
  try {
    const r = await api("/api/recall", { method: "POST", body: JSON.stringify({ question: q }) });
    const ctx = (r.contexts || []).length ? `<div class="ctx">retrieved ${r.contexts.length} context(s):\n${r.contexts.map(c=>""+c.slice(0,180)+"...").join("\n")}</div>` : "";
    aEl.innerHTML = `<div class="who">MEMORY</div>${escapeHtml(r.answer)}${ctx}
      <div class="feedback"><button data-fb="up">Helpful</button><button data-fb="down">Mark wrong (improve)</button></div>`;
    aEl.querySelectorAll("[data-fb]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.fb === "down") { await api("/api/improve", { method: "POST", body: JSON.stringify({ feedback: "User marked this answer wrong: " + q }) }); toast("Feedback sent improve() (memify) triggered"); }
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
  busy(e.target, true, "Interrogating...");
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
  busy(e.target, true, "Running polygraph...");
  try {
    const r = await api(`/api/erase-and-verify/${id}?cascade=${cascade}`, { method: "POST" });
    STATE.lastCert = r.certificate;
    // flip board: start from BEFORE verdicts, then flip to AFTER
    $("#forget-board").classList.remove("hidden");
    const afterMap = Object.fromEntries(r.after.results.map((x) => [x.id, x]));
    renderProbeRows($("#forget-probes"), r.before.results);
    animateBig($("#fb-before"), r.before.leaks, "/15", "leak");
    $("#fb-after").innerHTML = `<small>/15</small>`; $("#fb-after").className = "bignum";
    animateGauge($("#forget-fill"), $("#forget-cont"), r.before.contamination_score);
    toast("Baseline captured, executing forget()...");
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
    ? `<div class="seal"><div class="sm">ERASURE</div><div class="lg">VERIFIED</div><div class="sm">0 LEAKS</div></div>`
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
      <div class="cf"><div class="k">Contamination</div><div class="v">${v.contamination_before}%  <b>${v.contamination_after}%</b></div></div>
      <div class="cf"><div class="k">Judge</div><div class="v">${v.judge}</div></div>
      <div class="cf"><div class="k">Attack classes</div><div class="v">${v.attack_classes.join(", ")}</div></div>
      <div class="cf"><div class="k">Method</div><div class="v">${escapeHtml(c.method)}</div></div>
    </div>
    ${residual}
    <div class="cf" style="margin-top:6px"><div class="k">Evidence Merkle root (SHA-256)</div><div class="sig">${c.evidence_merkle_root}</div></div>
    <div class="cf" style="margin-top:10px"><div class="k">Signature (${c.signature.algorithm})</div><div class="sig">${c.signature.value}</div></div>
    <div class="verifybox">
      <b>Independent verification</b> <span class="muted" style="font-size:12px">, recompute the signature and Merkle root to detect any tampering.</span>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="btn-verify">Verify certificate</button>
        <button class="ghost" id="btn-download">Download JSON</button>
        <button class="ghost" id="btn-print">Print (PDF)</button>
        <button class="ghost" id="btn-tamper">Simulate tampering</button>
        <button class="ghost" id="btn-copylink">Copy verify link</button>
      </div>
      <div class="sharebox">
        <img class="qr" alt="verification QR" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(_certLink(c))}" onerror="this.style.display='none'" />
        <div>
          <div class="k" style="font-size:11px;color:var(--gold);font-family:var(--mono)">SHAREABLE VERIFICATION LINK</div>
          <div class="sharelink">${escapeHtml(_certLink(c))}</div>
        </div>
      </div>
      <div class="vresult" id="vresult"></div>
    </div>`;
  w.appendChild(card);
  $("#btn-verify").addEventListener("click", () => verifyCert(STATE.lastCert));
  $("#btn-copylink").addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(_certLink(c)); toast("Verification link copied"); });
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
  const out = $("#vresult"); out.innerHTML = `<span class="muted">verifying...</span>`;
  try {
    const r = await api("/api/certificate/verify", { method: "POST", body: JSON.stringify({ certificate: cert }) });
    const line = (ok, t) => `<div class="${ok ? 'ok' : 'no'}">${ok ? 'PASS' : 'FAIL'} ${t}</div>`;
    out.innerHTML =
      (tampered ? `<div class="no">Verifying a TAMPERED copy (leaks_after forced to 0):</div>` : "") +
      line(r.signature_valid, `signature ${r.signature_valid ? 'authentic' : 'BROKEN, certificate was altered'}`) +
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

// ---------- Memory graph (force-directed, vanilla canvas 2D) ----------
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }

function buildGraphModel(customers) {
  const nodes = [], edges = [], byId = {};
  const add = (n) => { byId[n.id] = n; nodes.push(n); return n; };
  const cities = new Set(), complaints = new Set();
  customers.forEach((c) => {
    add({ id: "c:" + c.id, type: "customer", cid: c.id, label: c.name, sub: c.complaint, forgotten: !!c.forgotten, r: 13 });
    if (c.city) cities.add(c.city);
    if (c.complaint) complaints.add(c.complaint);
  });
  cities.forEach((city) => add({ id: "city:" + city, type: "city", label: city, r: 7 }));
  complaints.forEach((cx) => add({ id: "cx:" + cx, type: "complaint", label: cx, r: 7 }));
  customers.forEach((c) => {
    const s = "c:" + c.id;
    if (c.city) edges.push({ s, t: "city:" + c.city, kind: "attr" });
    if (c.complaint) edges.push({ s, t: "cx:" + c.complaint, kind: "attr" });
    (c.linked_to || []).forEach((lid) => { if (byId["c:" + lid]) edges.push({ s, t: "c:" + lid, kind: "link" }); });
  });
  return { nodes, edges, byId };
}

function createMemGraph(canvas) {
  const wrap = canvas.parentElement, ctx = canvas.getContext("2d");
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0, dpr = 1, nodes = [], edges = [], byId = {};
  let raf = null, alpha = 0, dragging = null, hover = null;
  const pos = {}; // id -> {x,y,vx,vy} preserved across re-renders

  function C() {
    return { text: cssVar("--text"), brass: cssVar("--brass"), brassTint: cssVar("--brass-tint"),
      cyan: cssVar("--cyan"), red: cssVar("--red"), border: cssVar("--border-strong"),
      panel: cssVar("--panel"), faint: cssVar("--faint") };
  }
  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    W = canvas.clientWidth || wrap.clientWidth; H = canvas.clientHeight || 340;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function heat(a) { alpha = Math.max(alpha, a); if (!reduce) loop(); }
  function tick() {
    const cx = W / 2, cy = H / 2;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        const rep = 4200 / d2, fx = (dx / d) * rep, fy = (dy / d) * rep;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    edges.forEach((e) => {
      const a = byId[e.s], b = byId[e.t]; if (!a || !b) return;
      const rest = e.kind === "link" ? 175 : 118;
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const k = 0.035 * (d - rest), fx = (dx / d) * k, fy = (dy / d) * k;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    });
    nodes.forEach((n) => { n.vx += (cx - n.x) * 0.006; n.vy += (cy - n.y) * 0.006; });
    nodes.forEach((n) => {
      if (n === dragging) { n.vx = 0; n.vy = 0; }
      else { n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy; }
      // leave extra room below each node for its label(s)
      const padX = n.r + 40, padTop = n.r + 10, padBot = n.r + 38;
      n.x = Math.max(padX, Math.min(W - padX, n.x));
      n.y = Math.max(padTop, Math.min(H - padBot, n.y));
      pos[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy };
    });
  }
  function drawEdges(col) {
    edges.forEach((e) => {
      const a = byId[e.s], b = byId[e.t]; if (!a || !b) return;
      const erased = a.forgotten || b.forgotten;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      if (erased) { ctx.strokeStyle = col.red; ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2; }
      else if (e.kind === "link") { ctx.strokeStyle = col.brass; ctx.globalAlpha = 0.75; ctx.setLineDash([2, 4]); ctx.lineWidth = 1.3; }
      else { ctx.strokeStyle = col.border; ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineWidth = 1; }
      ctx.stroke();
    });
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  function roundRectPath(x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function label(text, x, y, font, color, col) {
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = font;
    const m = font.match(/([\d.]+)px/);   // the pixel size, not the font-weight
    const size = m ? parseFloat(m[1]) : 12;
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = 0.85; ctx.fillStyle = col.panel;   // halo so text stays readable
    roundRectPath(x - w / 2 - 5, y - 3, w + 10, size + 6, 5); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
  function drawNodeCircle(n, col) {
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    const ring = n === hover ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7);
    if (n.type === "customer") {
      if (n.forgotten) {
        ctx.fillStyle = col.panel; ctx.fill();
        ctx.setLineDash([3, 3]); ctx.lineWidth = 2; ctx.strokeStyle = col.red; ctx.stroke(); ctx.setLineDash([]);
      } else {
        ctx.fillStyle = col.text; ctx.fill();
        if (n === hover) { ctx.lineWidth = ring; ctx.strokeStyle = col.brass; ctx.stroke(); }
      }
    } else if (n.type === "city") {
      ctx.fillStyle = col.brassTint; ctx.fill();
      ctx.lineWidth = ring; ctx.strokeStyle = col.brass; ctx.stroke();
    } else {
      ctx.fillStyle = col.panel; ctx.fill();
      ctx.lineWidth = ring; ctx.strokeStyle = col.cyan; ctx.stroke();
    }
  }
  function drawNodeLabel(n, col) {
    const y = n.y + n.r + 5;
    if (n.type === "customer") {
      if (n.forgotten) {
        label("customer_" + n.cid + " erased", n.x, y, '500 11px "IBM Plex Mono", monospace', col.red, col);
      } else {
        label(trunc(n.label, 22), n.x, y, '600 12.5px Lora, serif', col.text, col);
        if (n.sub) label(trunc(n.sub, 22), n.x, y + 17, '10px "IBM Plex Mono", monospace', col.faint, col);
      }
    } else if (n.type === "city") {
      label(trunc(n.label, 18), n.x, y, '600 11px "IBM Plex Sans", sans-serif', col.brass, col);
    } else {
      label(trunc(n.label, 18), n.x, y, '500 11px "IBM Plex Sans", sans-serif', col.cyan, col);
    }
  }
  function draw() {
    const col = C();
    ctx.clearRect(0, 0, W, H);
    drawEdges(col);
    nodes.forEach((n) => drawNodeCircle(n, col));   // circles first
    nodes.forEach((n) => drawNodeLabel(n, col));    // then labels on top
  }
  function loop() {
    cancelAnimationFrame(raf);
    const step = () => { tick(); draw(); alpha *= 0.95; if (alpha > 0.02 || dragging) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  }
  function settle() { for (let i = 0; i < 320; i++) tick(); draw(); }

  function update(model) {
    if (!W) resize();
    model.nodes.forEach((n) => {
      const p = pos[n.id];
      if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; }
      else { n.x = W / 2 + (Math.random() - 0.5) * 140; n.y = H / 2 + (Math.random() - 0.5) * 100; n.vx = 0; n.vy = 0; }
    });
    nodes = model.nodes; edges = model.edges; byId = model.byId;
    if (reduce) settle(); else heat(1);
  }

  function local(ev) { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  function nodeAt(x, y) {
    for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i], dx = x - n.x, dy = y - n.y; if (dx * dx + dy * dy <= (n.r + 6) * (n.r + 6)) return n; }
    return null;
  }
  canvas.addEventListener("pointerdown", (ev) => {
    const p = local(ev), n = nodeAt(p.x, p.y);
    if (n) { dragging = n; try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} canvas.style.cursor = "grabbing"; heat(0.6); }
  });
  canvas.addEventListener("pointermove", (ev) => {
    const p = local(ev);
    if (dragging) { dragging.x = p.x; dragging.y = p.y; dragging.vx = 0; dragging.vy = 0; pos[dragging.id] = { x: p.x, y: p.y, vx: 0, vy: 0 }; heat(0.5); }
    else { hover = nodeAt(p.x, p.y); canvas.style.cursor = hover ? "grab" : "default"; if (reduce) draw(); }
  });
  const release = () => { if (dragging) { dragging = null; canvas.style.cursor = "default"; heat(0.4); } };
  window.addEventListener("pointerup", release);
  canvas.addEventListener("pointerleave", () => { if (!dragging) { hover = null; if (reduce) draw(); } });

  if (window.ResizeObserver) new ResizeObserver(() => { resize(); if (reduce) settle(); else heat(0.3); }).observe(wrap);

  resize();
  return { update };
}

let MG = null;
function renderGraph() {
  const canvas = document.getElementById("memgraph");
  if (!canvas || !STATE.customers || !STATE.customers.length) return;
  if (!MG) MG = createMemGraph(canvas);
  MG.update(buildGraphModel(STATE.customers));
}
window.renderGraph = renderGraph;

function renderCloudGraph(g) {
  const canvas = document.getElementById("memgraph");
  if (!canvas) return;
  if (!MG) MG = createMemGraph(canvas);
  const byId = {};
  // Map Cognee Cloud node types onto the engine's visual buckets: entities are
  // the prominent (ink) nodes, entity-types are brass, structural nodes
  // (chunks/documents/summaries) are small cyan so the semantic layer pops.
  const nodes = (g.nodes || []).map((n) => {
    let vt, label, r;
    if (n.type === "Entity") { vt = "customer"; label = n.label; r = 12; }
    else if (n.type === "EntityType") { vt = "city"; label = n.label; r = 7; }
    else { vt = "complaint"; label = n.type.replace("Text", "").replace("Document", "doc"); r = 6; }
    const o = { id: n.id, type: vt, label: label, sub: "", forgotten: false, r: r };
    byId[n.id] = o; return o;
  });
  const edges = (g.edges || []).filter((e) => byId[e.s] && byId[e.t]).map((e) => ({ s: e.s, t: e.t, kind: "attr", label: e.label }));
  MG.update({ nodes, edges, byId });
}

// ---------- PII highlight + certificate link helpers ----------
function highlightPII(escaped, subject) {
  let out = escaped;
  if (subject) {
    const re = new RegExp("(" + subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "g");
    out = out.replace(re, '<span class="pii">$1</span>');
  }
  out = out.replace(/(\+91[-\s]?\d{5}[-\s]?\d{5})/g, '<span class="pii">$1</span>');
  out = out.replace(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi, '<span class="pii">$1</span>');
  return out;
}
function _certLink(c) { return location.origin + "/?cert=" + encodeURIComponent(c.certificate_id); }

// ---------- Feature: Prove on Cognee Cloud ----------
const _cloudProofBtn = $("#btn-cloudproof");
if (_cloudProofBtn) _cloudProofBtn.addEventListener("click", async (e) => {
  const id = $("#cloudproof-cust").value; if (!id) return;
  const out = $("#cloudproof-result");
  busy(e.target, true, "Running on Cognee Cloud...");
  out.innerHTML = `<p class="hint">Talking to your Cognee Cloud tenant: add, cognify, recall, forget, recall. This can take up to a minute.</p>`;
  try {
    const r = await api(`/api/cloud/selftest?customer_id=${id}`, { method: "POST" });
    const badge = r.erasure_verified
      ? `<span class="tag verified">ERASURE VERIFIED on Cognee Cloud</span>`
      : `<span class="tag gone">still present</span>`;
    out.innerHTML = `
      <div class="proofcols">
        <div class="proofcol before"><div class="h">RECALL BEFORE forget (leaks)</div><div class="ans">${highlightPII(escapeHtml(r.answer_before_forget), r.subject)}</div></div>
        <div class="proofcol after"><div class="h">RECALL AFTER forget (silent)</div><div class="ans">${highlightPII(escapeHtml(r.answer_after_forget), r.subject)}</div></div>
      </div>
      <div class="proofverdict">${badge} <span class="muted" style="font-weight:400">endpoint: ${escapeHtml(r.endpoint)}</span></div>`;
    toast(r.erasure_verified ? "Cognee Cloud erasure verified" : "Cloud proof complete");
  } catch (err) { out.innerHTML = `<span class="muted">Cloud proof failed: ${escapeHtml(err.message)}</span>`; }
  finally { busy(e.target, false); }
});

// ---------- Feature: graph mode toggle (local model vs Cognee Cloud) ----------
document.querySelectorAll(".gseg").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".gseg").forEach((x) => x.classList.remove("sel"));
  b.classList.add("sel");
  const mode = b.dataset.gmode; STATE.graphMode = mode;
  $("#cloud-graph-controls").classList.toggle("hidden", mode !== "cloud");
  if (mode === "local") {
    $("#graph-hint").textContent = "Live view of the memory's knowledge graph. Erased subjects collapse into redacted ghost nodes. Drag nodes to explore.";
    renderGraph();
  } else {
    $("#graph-hint").textContent = "The actual knowledge graph Cognee Cloud built for this dataset. Load a subject, forget it, then reload to watch it disappear.";
  }
}));
const _cloudSeedBtn = $("#btn-cloudseed");
if (_cloudSeedBtn) _cloudSeedBtn.addEventListener("click", async (e) => {
  const id = $("#cloudgraph-cust").value; if (!id) return;
  busy(e.target, true, "Seeding to Cognee Cloud...");
  $("#graph-hint").textContent = "Ingesting customer_" + id + " into Cognee Cloud (add + cognify). This runs an LLM server-side and can take up to a minute.";
  try { await api("/api/cloud/seed/" + id, { method: "POST" }); toast("Seeded customer_" + id + " to Cognee Cloud"); $("#graph-hint").textContent = "Seeded. Click 'Load cloud graph' to view the real graph Cognee built."; }
  catch (err) { toast("Cloud seed failed: " + err.message); }
  finally { busy(e.target, false); }
});
const _cloudForgetBtn = $("#btn-cloudforget");
if (_cloudForgetBtn) _cloudForgetBtn.addEventListener("click", async (e) => {
  const id = $("#cloudgraph-cust").value; if (!id) return;
  busy(e.target, true, "Forgetting on Cognee Cloud...");
  try { await api("/api/cloud/forget/" + id, { method: "POST" }); toast("Forgotten on Cognee Cloud"); renderCloudGraph({ nodes: [], edges: [] }); $("#graph-hint").textContent = "Erased on Cognee Cloud. Reload the graph to confirm it is gone."; }
  catch (err) { toast("Cloud forget failed: " + err.message); }
  finally { busy(e.target, false); }
});
const _cloudGraphBtn = $("#btn-cloudgraph");
if (_cloudGraphBtn) _cloudGraphBtn.addEventListener("click", async (e) => {
  const id = $("#cloudgraph-cust").value; if (!id) return;
  busy(e.target, true, "Fetching cloud graph...");
  try {
    const g = await api("/api/cloud/graph/" + id);
    if (!g.present || !(g.nodes || []).length) {
      $("#graph-hint").textContent = "No Cognee Cloud graph for customer_" + id + " yet. Seed and cognify it on the cloud first.";
      renderCloudGraph({ nodes: [], edges: [] });
    } else {
      renderCloudGraph(g);
      $("#graph-hint").textContent = `${g.nodes.length} nodes and ${g.edges.length} edges fetched live from Cognee Cloud.`;
    }
  } catch (err) { toast("Cloud graph failed: " + err.message); }
  finally { busy(e.target, false); }
});

// ---------- Feature: compliance cockpit + ledger ----------
async function loadCompliance() {
  try {
    const c = await api("/api/compliance");
    const dash = (x) => (x == null ? "n/a" : x);
    $("#comply-table tbody").innerHTML = c.subjects.map((s) => `<tr>
      <td><b>${escapeHtml(s.name)}</b><br><span class="mono muted">customer_${s.id}</span></td>
      <td>${escapeHtml(s.city)}</td>
      <td>${s.contamination_before == null ? "n/a" : s.contamination_before + "%"}</td>
      <td>${s.leaks_before == null ? "n/a" : s.leaks_before + "/15"}</td>
      <td>${s.leaks_after == null ? "n/a" : s.leaks_after + "/15"}</td>
      <td>${dash(s.residual)}</td>
      <td><span class="st ${s.status}">${s.status.replace(/_/g, " ")}</span></td>
    </tr>`).join("");
    const l = await api("/api/ledger");
    $("#ledger-empty").classList.toggle("hidden", l.count > 0);
    $("#ledger-table tbody").innerHTML = l.entries.map((e) => `<tr>
      <td class="mono">${escapeHtml(e.certificate_id)}</td>
      <td>${escapeHtml(e.data_subject_name)}</td>
      <td class="mono">${escapeHtml(e.executed_at.slice(0, 19).replace("T", " "))}</td>
      <td><span style="color:var(--red)">${e.leaks_before}</span> to <span style="color:var(--emerald-deep)">${e.leaks_after}</span></td>
      <td>${e.verdict.startsWith("ERASURE VERIFIED") ? '<span class="st erased_verified">verified</span>' : '<span class="st erased_incomplete">incomplete</span>'}</td>
      <td><button class="ghost" data-cert="${escapeHtml(e.certificate_id)}">View</button></td>
    </tr>`).join("");
    $("#ledger-table tbody").querySelectorAll("[data-cert]").forEach((b) => b.addEventListener("click", () => openCertById(b.dataset.cert)));
  } catch (err) { /* ignore */ }
}
async function openCertById(id) {
  try {
    const cert = await api("/api/certificate/" + encodeURIComponent(id));
    STATE.lastCert = cert; goto("forget"); renderCertificate(cert);
  } catch (err) { toast("Certificate not found (server may have restarted)"); }
}
const _bJson = $("#btn-export-json"); if (_bJson) _bJson.addEventListener("click", () => window.open((API || "") + "/api/ledger/export?fmt=json", "_blank"));
const _bCsv = $("#btn-export-csv"); if (_bCsv) _bCsv.addEventListener("click", () => window.open((API || "") + "/api/ledger/export?fmt=csv", "_blank"));
const _bRef = $("#btn-refresh-comply"); if (_bRef) _bRef.addEventListener("click", loadCompliance);

// ---------- boot ----------
(async function () {
  goto("remember");
  await loadHealth();
  try { await loadCustomers(); STATE.anySeeded = STATE.customers.some((c) => c.audited || c.forgotten); } catch (e) {}
  const shared = new URLSearchParams(location.search).get("cert");
  if (shared) openCertById(shared);
})();
