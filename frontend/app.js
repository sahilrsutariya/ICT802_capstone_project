/* EIAGR frontend - vanilla JS single-page app. Talks to the Flask REST API
   under /api. No build step required - open index.html via the Flask server. */

const API = "/api";
let CURRENT_USER = null;
let PERMISSIONS = [];
let REFERENCE = null;
let CURRENT_ASSET_ID = null;

// ---------------------------------------------------------------- helpers
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: "include",
    headers: opts.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Not authenticated");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function has(perm) { return PERMISSIONS.includes(perm); }

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function classificationBadge(c) {
  if (!c) return `<span class="badge badge-na">&mdash;</span>`;
  const map = { "Public": "public", "Internal": "internal", "Sensitive": "sensitive",
                "Highly Sensitive / Restricted": "restricted" };
  return `<span class="badge badge-${map[c] || "na"}">${c}</span>`;
}
function criticalityBadge(c) {
  if (!c) return `<span class="badge badge-na">Not assessed</span>`;
  return `<span class="badge badge-${c.toLowerCase()}">${c}</span>`;
}
function reviewBadge(r) {
  const map = { "Overdue": "overdue", "Due Soon": "duesoon", "Due": "due", "Not Due": "notdue" };
  return `<span class="badge badge-${map[r] || "na"}">${r}</span>`;
}

// ---------------------------------------------------------------- auth
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  errBox.textContent = "";
  try {
    const data = await api("/login", { method: "POST", body: JSON.stringify({ username, password }) });
    CURRENT_USER = data.user;
    await afterLogin();
  } catch (err) {
    errBox.textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  CURRENT_USER = null;
  showLogin();
});

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

async function afterLogin() {
  const me = await api("/me");
  CURRENT_USER = me.user;
  PERMISSIONS = me.permissions || [];
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("user-badge").textContent = `${CURRENT_USER.full_name} \u00b7 ${CURRENT_USER.role}`;

  document.getElementById("nav-audit").classList.toggle("hidden", !has("view_audit"));
  document.getElementById("nav-admin").classList.toggle("hidden", !(has("edit_taxonomy") || has("manage_users")));

  REFERENCE = await api("/reference");
  populateReferenceDropdowns();
  switchView("dashboard");
}

// ---------------------------------------------------------------- nav
document.getElementById("topnav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-btn");
  if (!btn) return;
  switchView(btn.dataset.view);
});

function switchView(view) {
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById("view-" + view).classList.remove("hidden");
  if (view === "dashboard") loadDashboard();
  if (view === "assets") loadAssets();
  if (view === "audit") loadAudit();
  if (view === "admin") loadAdmin();
}

// ---------------------------------------------------------------- reference dropdowns
function populateReferenceDropdowns() {
  const clsFilter = document.getElementById("filter-classification");
  clsFilter.innerHTML = `<option value="">All classifications</option>` +
    REFERENCE.classifications.map(c => `<option>${c.level}</option>`).join("");

  const lifeFilter = document.getElementById("filter-lifecycle");
  lifeFilter.innerHTML = `<option value="">All lifecycle states</option>` +
    REFERENCE.lifecycle_statuses.map(l => `<option>${l}</option>`).join("");
}

// ================================================================== DASHBOARD
async function loadDashboard() {
  const d = await api("/dashboard/summary");
  const kpis = [
    { label: "Total Assets", value: d.total_assets, cls: "" },
    { label: "Critical Assets", value: d.critical_assets, cls: "alert" },
    { label: "Sensitive/Restricted", value: d.sensitive_assets, cls: "warn" },
    { label: "Overdue Reviews", value: d.overdue_reviews, cls: "alert" },
    { label: "Metadata Completeness", value: d.metadata_completeness_pct + "%", cls: "" },
  ];
  document.getElementById("kpi-row").innerHTML = kpis.map(k => `
    <div class="kpi ${k.cls}"><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>
  `).join("");

  renderBarChart("chart-classification", d.by_classification);
  renderBarChart("chart-criticality", d.by_criticality, ["Critical", "High", "Medium", "Low", "Not assessed"]);

  const ex = await api("/dashboard/exceptions");
  const box = document.getElementById("exceptions-list");
  if (ex.count === 0) {
    box.innerHTML = `<div class="exceptions-empty">No governance exceptions &mdash; all assets pass current data-quality rules.</div>`;
  } else {
    box.innerHTML = ex.exceptions.map(x => `
      <div class="exception-row">
        <span class="exc-name">${x.asset_code} &mdash; ${x.name}</span>
        <span class="exc-reasons">${x.reasons.join(", ")}</span>
      </div>
    `).join("");
  }
}

function renderBarChart(containerId, dataObj, order = null) {
  const entries = order
    ? order.filter(k => k in dataObj).map(k => [k, dataObj[k]])
    : Object.entries(dataObj).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(e => e[1]));
  document.getElementById(containerId).innerHTML = entries.map(([label, count]) => `
    <div class="bar-row">
      <div class="bar-label">${label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
      <div class="bar-count">${count}</div>
    </div>
  `).join("");
}

// ================================================================== ASSET REGISTER
let searchDebounce;
["search-box"].forEach(id => document.getElementById(id).addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadAssets, 250);
}));
["filter-classification", "filter-criticality", "filter-lifecycle", "filter-review"].forEach(id =>
  document.getElementById(id).addEventListener("change", loadAssets)
);

async function loadAssets() {
  const params = new URLSearchParams();
  const q = document.getElementById("search-box").value.trim();
  if (q) params.set("q", q);
  const cls = document.getElementById("filter-classification").value;
  if (cls) params.set("classification", cls);
  const crit = document.getElementById("filter-criticality").value;
  if (crit) params.set("criticality", crit);
  const life = document.getElementById("filter-lifecycle").value;
  if (life) params.set("lifecycle", life);
  const rev = document.getElementById("filter-review").value;
  if (rev) params.set("review_status", rev);

  const data = await api("/assets?" + params.toString());
  const body = document.getElementById("asset-table-body");
  body.innerHTML = data.assets.map(a => `
    <tr data-id="${a.id}">
      <td>${a.asset_code}</td>
      <td>${a.name}</td>
      <td>${a.org_unit || "&mdash;"}</td>
      <td>${a.business_owner || "<em>Unassigned</em>"}</td>
      <td>${classificationBadge(a.classification)}</td>
      <td>${criticalityBadge(a.criticality_label)}</td>
      <td>${a.lifecycle_status || "&mdash;"}</td>
      <td>${reviewBadge(a.review_status)}</td>
    </tr>
  `).join("");
  document.getElementById("asset-count").textContent = `${data.count} asset(s)`;
  body.querySelectorAll("tr").forEach(row => row.addEventListener("click", () => openAsset(row.dataset.id)));
}

document.getElementById("btn-back-to-list").addEventListener("click", () => switchView("assets"));

// ---- New asset modal
document.getElementById("btn-new-asset").addEventListener("click", () => {
  document.getElementById("new-asset-error").textContent = "";
  document.getElementById("new-asset-form").innerHTML = `
    <div class="form-row"><label>Asset Name *</label><input id="na-name"></div>
    <div class="form-row"><label>Description</label><textarea id="na-desc" rows="3"></textarea></div>
    <div class="form-row"><label>Asset Type</label><select id="na-type">${optList(REFERENCE.asset_types, "name")}</select></div>
    <div class="form-row"><label>Organisational Unit *</label><select id="na-org">${optList(REFERENCE.org_units, "name")}</select></div>
    <div class="form-row"><label>Classification</label><select id="na-cls">${optList(REFERENCE.classifications, "level")}</select></div>
  `;
  document.getElementById("modal-backdrop").classList.remove("hidden");
});
document.getElementById("btn-cancel-new").addEventListener("click", () =>
  document.getElementById("modal-backdrop").classList.add("hidden"));

function optList(items, labelKey) {
  return `<option value="">--</option>` + items.map(i => `<option value="${i.id}">${i[labelKey]}</option>`).join("");
}

document.getElementById("btn-create-asset").addEventListener("click", async () => {
  const name = document.getElementById("na-name").value.trim();
  const org = document.getElementById("na-org").value;
  const errBox = document.getElementById("new-asset-error");
  if (!name || !org) { errBox.textContent = "Asset Name and Organisational Unit are required."; return; }
  try {
    await api("/assets", { method: "POST", body: JSON.stringify({
      name, description: document.getElementById("na-desc").value,
      asset_type_id: document.getElementById("na-type").value || null,
      org_unit_id: org,
      classification_id: document.getElementById("na-cls").value || null,
    })});
    document.getElementById("modal-backdrop").classList.add("hidden");
    loadAssets();
  } catch (err) {
    errBox.textContent = err.message;
  }
});

// ---- Import / Export
document.getElementById("btn-export").addEventListener("click", () => {
  window.location.href = API + "/assets/export";
});
document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const box = document.getElementById("import-result");
  box.classList.remove("hidden");
  box.textContent = "Importing\u2026";
  try {
    const res = await api("/assets/import", { method: "POST", body: fd });
    box.innerHTML = `Imported <b>${res.imported_count}</b> asset(s). Rejected <b>${res.rejected_count}</b> row(s)` +
      (res.rejected_count ? ": " + res.rejected.map(r => `row ${r.row} (${r.errors.join(", ")})`).join("; ") : ".");
    loadAssets();
  } catch (err) {
    box.textContent = "Import failed: " + err.message;
  }
  e.target.value = "";
});

// ================================================================== ASSET DETAIL
async function openAsset(id) {
  CURRENT_ASSET_ID = id;
  const { asset } = await api(`/assets/${id}`);
  document.getElementById("detail-title").textContent = `${asset.asset_code} \u2014 ${asset.name}`;

  document.getElementById("detail-form").innerHTML = `
    <div class="form-row"><label>Name</label><input id="d-name" value="${escapeAttr(asset.name)}"></div>
    <div class="form-row"><label>Description</label><textarea id="d-desc" rows="3">${asset.description || ""}</textarea></div>
    <div class="form-row"><label>Classification</label><select id="d-cls">${optList(REFERENCE.classifications, "level")}</select></div>
    <div class="form-row"><label>Retention Rule</label><select id="d-ret">${optList(REFERENCE.retention_rules, "name")}</select></div>
    <div class="form-row"><label>Business Owner</label><select id="d-owner">${optList(REFERENCE.people, "full_name")}</select></div>
    <div class="form-row"><label>Custodian</label><select id="d-custodian">${optList(REFERENCE.people, "full_name")}</select></div>
  `;
  setSelectByLabel("d-cls", REFERENCE.classifications, "level", asset.classification);
  setSelectByLabel("d-ret", REFERENCE.retention_rules, "name", asset.retention_rule);
  setSelectByLabel("d-owner", REFERENCE.people, "full_name", asset.business_owner);
  setSelectByLabel("d-custodian", REFERENCE.people, "full_name", asset.custodian);

  const canEdit = has("edit_asset");
  document.getElementById("btn-save-asset").classList.toggle("hidden", !canEdit);
  document.querySelectorAll("#detail-form input, #detail-form select, #detail-form textarea")
    .forEach(i => i.disabled = !canEdit);

  // Criticality
  document.getElementById("criticality-form").innerHTML = ["confidentiality","integrity","availability","privacy","business_dependency"]
    .map(f => `<div class="form-row-inline"><label>${label(f)}</label><input type="number" min="1" max="5" id="c-${f}"></div>`).join("");
  document.getElementById("btn-assess").classList.toggle("hidden", !canEdit);
  const latest = asset.criticality_history[0];
  document.getElementById("criticality-result").innerHTML = latest
    ? `<span class="criticality-score-big">${latest.total_score}/25</span> ${criticalityBadge(latest.label)}
       <div style="margin-top:6px;color:#777;">Assessed by ${latest.assessed_by || "&mdash;"} on ${fmtDate(latest.assessed_at)}</div>`
    : `<em>Not yet assessed</em>`;

  // Lifecycle
  const lc = await api(`/assets/${id}/lifecycle/next`);
  document.getElementById("lifecycle-current").innerHTML =
    `<div class="lifecycle-badge-row">Current status: <b>${lc.current}</b></div>`;
  const actionsBox = document.getElementById("lifecycle-actions");
  if (has("edit_asset") && lc.allowed.length) {
    actionsBox.innerHTML = lc.allowed.map(s => `<button data-status="${s}">Move to &ldquo;${s}&rdquo;</button>`).join("");
    actionsBox.querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
      try {
        await api(`/assets/${id}/lifecycle`, { method: "PUT", body: JSON.stringify({ status: b.dataset.status }) });
        openAsset(id);
      } catch (err) { alert(err.message); }
    }));
  } else {
    actionsBox.innerHTML = lc.allowed.length ? "" : `<em>No further transitions (terminal state).</em>`;
  }

  // Reviews
  document.getElementById("review-form").innerHTML = has("complete_review") ? `
    <div class="form-row"><label>Outcome</label>
      <select id="rv-outcome"><option>Confirmed</option><option>Updated</option><option>No Longer Required</option></select>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="rv-notes" rows="2"></textarea></div>
  ` : `<em>Your role cannot complete governance reviews.</em>`;
  document.getElementById("btn-review").classList.toggle("hidden", !has("complete_review"));
  document.getElementById("review-history").innerHTML = asset.reviews.length
    ? asset.reviews.map(r => `<div class="review-history-item"><b>${r.outcome}</b> by ${r.reviewed_by || "&mdash;"} on ${fmtDate(r.review_date)}${r.notes ? " &mdash; " + r.notes : ""}</div>`).join("")
    : `<div class="review-history-item"><em>No review history yet.</em></div>`;

  // Audit (visible to Owner/GovAdmin/Auditor per role; hide box entirely if no permission)
  const auditBox = document.getElementById("detail-audit");
  if (asset.audit && asset.audit.length) {
    auditBox.innerHTML = `<table class="audit-table-mini">` + asset.audit.map(a => `
      <tr><td>${fmtDate(a.timestamp)}</td><td>${a.username}</td><td>${a.action}</td>
          <td>${a.field_changed || ""}</td><td>${a.old_value || ""} &rarr; ${a.new_value || ""}</td></tr>
    `).join("") + `</table>`;
  } else {
    auditBox.innerHTML = `<em>No audit entries yet.</em>`;
  }

  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById("view-detail").classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
}

function label(field) { return field.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }
function fmtDate(iso) { if (!iso) return "&mdash;"; return new Date(iso).toLocaleString(); }
function escapeAttr(s) { return (s || "").replace(/"/g, "&quot;"); }
function setSelectByLabel(selectId, items, labelKey, value) {
  const sel = document.getElementById(selectId);
  const match = items.find(i => i[labelKey] === value);
  if (match) sel.value = match.id;
}

document.getElementById("btn-save-asset").addEventListener("click", async () => {
  const status = document.getElementById("save-status");
  try {
    await api(`/assets/${CURRENT_ASSET_ID}`, { method: "PUT", body: JSON.stringify({
      name: document.getElementById("d-name").value,
      description: document.getElementById("d-desc").value,
      classification_id: document.getElementById("d-cls").value || null,
      retention_rule_id: document.getElementById("d-ret").value || null,
      business_owner_id: document.getElementById("d-owner").value || null,
      custodian_id: document.getElementById("d-custodian").value || null,
    })});
    status.textContent = "Saved.";
    setTimeout(() => status.textContent = "", 2000);
  } catch (err) { status.textContent = "Error: " + err.message; status.style.color = "#C0392B"; }
});

document.getElementById("btn-assess").addEventListener("click", async () => {
  const factors = ["confidentiality","integrity","availability","privacy","business_dependency"];
  const payload = {};
  for (const f of factors) {
    const v = parseInt(document.getElementById("c-" + f).value, 10);
    if (!v || v < 1 || v > 5) { alert(`Please enter a value 1-5 for ${label(f)}.`); return; }
    payload[f] = v;
  }
  try {
    await api(`/assets/${CURRENT_ASSET_ID}/criticality`, { method: "POST", body: JSON.stringify(payload) });
    openAsset(CURRENT_ASSET_ID);
  } catch (err) { alert(err.message); }
});

document.getElementById("btn-review").addEventListener("click", async () => {
  try {
    await api(`/assets/${CURRENT_ASSET_ID}/reviews`, { method: "POST", body: JSON.stringify({
      outcome: document.getElementById("rv-outcome").value,
      notes: document.getElementById("rv-notes").value,
      next_review_in_days: 365,
    })});
    openAsset(CURRENT_ASSET_ID);
  } catch (err) { alert(err.message); }
});

// ================================================================== AUDIT LOG (global)
async function loadAudit() {
  const data = await api("/audit");
  document.getElementById("audit-table-body").innerHTML = data.entries.map(a => `
    <tr><td>${fmtDate(a.timestamp)}</td><td>${a.username}</td><td>${a.action}</td>
        <td>${a.asset_id ? "IA-" + String(a.asset_id).padStart(4, "0") : "&mdash;"}</td>
        <td>${a.field_changed || ""}</td><td>${a.old_value || ""} &rarr; ${a.new_value || ""}</td></tr>
  `).join("");
}

// ================================================================== ADMIN
async function loadAdmin() {
  document.getElementById("admin-status").textContent = "";
  const roleSel = document.getElementById("admin-user-role");
  roleSel.innerHTML = REFERENCE.roles.map(r => `<option>${r}</option>`).join("");

  const canEditTaxonomy = has("edit_taxonomy");
  document.getElementById("btn-add-assettype").closest(".card").classList.toggle("hidden", !canEditTaxonomy);
  document.getElementById("btn-add-classification").closest(".card").classList.toggle("hidden", !canEditTaxonomy);
  document.getElementById("btn-add-retention").closest(".card").classList.toggle("hidden", !canEditTaxonomy);
  const canManageUsers = has("manage_users");
  document.getElementById("admin-user-username").closest(".card").classList.toggle("hidden", !canManageUsers);

  if (canManageUsers) {
    const users = await api("/users");
    document.getElementById("admin-user-list").innerHTML = users.users.map(u =>
      `<div class="u-row"><span>${u.full_name} (${u.username})</span><span>${u.role}</span></div>`).join("");
  }
}

document.getElementById("btn-add-assettype")?.addEventListener("click", async () => {
  await taxonomyAdd("asset_type", { name: document.getElementById("admin-assettype-name").value });
});
document.getElementById("btn-add-classification")?.addEventListener("click", async () => {
  await taxonomyAdd("classification", {
    level: document.getElementById("admin-classification-name").value,
    rank: parseInt(document.getElementById("admin-classification-rank").value || "0", 10),
  });
});
document.getElementById("btn-add-retention")?.addEventListener("click", async () => {
  await taxonomyAdd("retention_rule", {
    name: document.getElementById("admin-retention-name").value,
    retention_period: document.getElementById("admin-retention-period").value,
    disposal_authority: document.getElementById("admin-retention-authority").value,
  });
});
async function taxonomyAdd(kind, payload) {
  const status = document.getElementById("admin-status");
  try {
    await api(`/admin/taxonomy/${kind}`, { method: "POST", body: JSON.stringify(payload) });
    status.style.color = "#2E7D4F";
    status.textContent = "Added. Reference data will refresh on next page load.";
    REFERENCE = await api("/reference");
  } catch (err) {
    status.style.color = "#C0392B";
    status.textContent = err.message;
  }
}

document.getElementById("btn-add-user")?.addEventListener("click", async () => {
  const status = document.getElementById("admin-status");
  try {
    await api("/users", { method: "POST", body: JSON.stringify({
      username: document.getElementById("admin-user-username").value,
      full_name: document.getElementById("admin-user-fullname").value,
      role: document.getElementById("admin-user-role").value,
      password: document.getElementById("admin-user-password").value || "password123",
    })});
    status.style.color = "#2E7D4F";
    status.textContent = "User created.";
    loadAdmin();
  } catch (err) {
    status.style.color = "#C0392B";
    status.textContent = err.message;
  }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const me = await api("/me");
    if (me.user) {
      CURRENT_USER = me.user;
      await afterLogin();
      return;
    }
  } catch (e) { /* not logged in */ }
  showLogin();
})();
