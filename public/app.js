const rowsEl = document.querySelector("#leaderboardRows");
const refreshButton = document.querySelector("#refreshButton");
const sourceBadge = document.querySelector("#sourceBadge");
const errorMessage = document.querySelector("#errorMessage");
const topAgent = document.querySelector("#topAgent");
const totalSales = document.querySelector("#totalSales");
const bestSalesHour = document.querySelector("#bestSalesHour");
const lastRefresh = document.querySelector("#lastRefresh");
const tabsEl = document.querySelector("#campaignTabs");
const dateFrom = document.querySelector("#dateFrom");
const dateTo = document.querySelector("#dateTo");
const todayBtn = document.querySelector("#todayBtn");
const dateRangeBanner = document.querySelector("#dateRangeBanner");

let refreshTimer = null;
let activeCampaignId = "";

// ── Helpers ────────────────────────────────────────────────────────────
function esc(v) {
  return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function fmtDuration(s) {
  const t=Number(s||0), h=Math.floor(t/3600), m=Math.floor((t%3600)/60), sec=Math.floor(t%60);
  return h+":"+String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0");
}
function fmtTime(v) {
  return new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit",second:"2-digit"}).format(new Date(v));
}
function fmtDate(d) {
  return new Date(d+"T00:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
}
function medalFor(rank) {
  if (rank===1) return "🏆";
  if (rank===2) return "🥈";
  if (rank===3) return "🥉";
  return rank;
}
function todayStr() {
  const now = new Date();
  const pad = n => String(n).padStart(2,"0");
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
}
function isToday() {
  return dateFrom.value === todayStr() && dateTo.value === todayStr();
}

// ── Date picker setup ──────────────────────────────────────────────────
dateFrom.value = todayStr();
dateTo.value = todayStr();
dateFrom.max = todayStr();
dateTo.max = todayStr();

dateFrom.addEventListener("change", () => {
  // Make sure 'to' is never before 'from'
  if (dateTo.value < dateFrom.value) dateTo.value = dateFrom.value;
  refreshLeaderboard();
});
dateTo.addEventListener("change", () => {
  if (dateFrom.value > dateTo.value) dateFrom.value = dateTo.value;
  refreshLeaderboard();
});
todayBtn.addEventListener("click", () => {
  dateFrom.value = todayStr();
  dateTo.value = todayStr();
  refreshLeaderboard();
});

// ── Campaigns ──────────────────────────────────────────────────────────
async function loadCampaigns() {
  try {
    const res = await fetch("/api/campaigns");
    const campaigns = await res.json();
    if (!campaigns.length) return;
    activeCampaignId = campaigns[0].id;
    tabsEl.innerHTML = campaigns.map((c,i) =>
      `<button class="tab${i===0?" tab-active":""}" data-id="${esc(c.id)}">${esc(c.name)}</button>`
    ).join("");
    tabsEl.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        tabsEl.querySelectorAll(".tab").forEach(b=>b.classList.remove("tab-active"));
        btn.classList.add("tab-active");
        activeCampaignId = btn.dataset.id;
        refreshLeaderboard();
      });
    });
  } catch(e) { console.error(e); }
}

// ── Render ─────────────────────────────────────────────────────────────
function renderRows(agents) {
  if (!agents.length) { rowsEl.innerHTML='<p class="empty">No agents found for this date range.</p>'; return; }
  rowsEl.innerHTML = agents.map(a=>
    `<article class="agent-row${a.rank<=3?" top"+a.rank:""}">
      <span><span class="rank">${medalFor(a.rank)}</span></span>
      <span class="agent"><strong>${esc(a.name)}</strong><span>${esc(a.team)}</span></span>
      <span class="metric sales">${a.sales.toLocaleString()}</span>
      <span class="metric sales-hour">${a.salesPerWorkingHour.toFixed(2)}</span>
      <span class="metric">${fmtDuration(a.nonPauseSeconds)}</span>
    </article>`
  ).join("");
}

function renderSummary(payload) {
  const agents = payload.agents;
  topAgent.textContent = agents[0]?.name||"-";
  totalSales.textContent = agents.reduce((s,a)=>s+a.sales,0).toLocaleString();
  var totalHours = agents.reduce(function(s,a){ return s + a.nonPauseSeconds; }, 0) / 3600;
  var totalSalesAll = agents.reduce(function(s,a){ return s + a.sales; }, 0);
  bestSalesHour.textContent = totalHours > 0 ? (totalSalesAll / totalHours).toFixed(2) : "-";
  lastRefresh.textContent = fmtTime(payload.refreshedAt);
  if (payload.source==="vicidial") {
    sourceBadge.textContent = "✓ VICIdial live";
    sourceBadge.className = "badge badge-live";
  } else {
    sourceBadge.textContent = "Sample data";
    sourceBadge.className = "badge badge-sample";
  }
}

function renderBanner() {
  const from = dateFrom.value;
  const to = dateTo.value;
  if (isToday()) {
    dateRangeBanner.style.display = "none";
    return;
  }
  dateRangeBanner.style.display = "";
  if (from === to) {
    dateRangeBanner.textContent = `📅 Viewing: ${fmtDate(from)} — auto-refresh paused`;
  } else {
    dateRangeBanner.textContent = `📅 Viewing totals: ${fmtDate(from)} → ${fmtDate(to)} — auto-refresh paused`;
  }
}

function scheduleRefresh(secs) {
  if (refreshTimer) clearInterval(refreshTimer);
  if (secs > 0 && isToday()) {
    refreshTimer = setInterval(refreshLeaderboard, secs * 1000);
  }
}

// ── Fetch ──────────────────────────────────────────────────────────────
async function refreshLeaderboard() {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";
  errorMessage.textContent = "";
  renderBanner();
  try {
    const params = new URLSearchParams({
      campaign: activeCampaignId,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      ts: Date.now()
    });
    const res = await fetch(`/api/leaderboard?${params}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error||"Refresh failed");
    renderRows(payload.agents);
    renderSummary(payload);
    scheduleRefresh(payload.refreshInterval||60);
    if (payload.error) errorMessage.textContent = "⚠ "+payload.error+" (showing sample data)";
  } catch(err) {
    errorMessage.textContent = err.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh";
  }
}

refreshButton.addEventListener("click", refreshLeaderboard);
loadCampaigns().then(() => refreshLeaderboard());
