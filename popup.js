// ============================================================
// FocusShield v2.0 — popup.js
// Reads state from background via chrome.runtime.sendMessage,
// renders the correct view (IDLE / SESSION / COOLDOWN),
// and handles all user interactions.
// ============================================================

// ─── DOM REFS ────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const views = {
  idle:     $("view-idle"),
  session:  $("view-session"),
  cooldown: $("view-cooldown"),
};

const phaseBadge    = $("phaseBadge");
const statStreak    = $("statStreak");
const statBypasses  = $("statBypasses");
const statSessions  = $("statSessions");

// IDLE
const inpDuration   = $("inpDuration");
const inpCooldown   = $("inpCooldown");
const chkStrict     = $("chkStrict");
const btnStart      = $("btnStart");
const idleError     = $("idleError");

// SESSION
const sessionTimer  = $("sessionTimer");
const sessionProg   = $("sessionProg");
const strictBadge   = $("strictBadge");
const btnStop       = $("btnStop");
const stopError     = $("stopError");

// COOLDOWN
const cooldownTimer = $("cooldownTimer");
const cooldownProg  = $("cooldownProg");
const penaltyBanner = $("penaltyBanner");

// Sites
const siteList      = $("siteList");
const siteCount     = $("siteCount");
const inpDomain     = $("inpDomain");
const btnAddSite    = $("btnAddSite");
const addSiteRow    = $("addSiteRow");
const addError      = $("addError");
const footerMsg     = $("footerMsg");

// ─── STATE ───────────────────────────────────────────────────
let currentState = null;
let tickInterval  = null;

// ─── INIT ────────────────────────────────────────────────────
async function init() {
  await refresh();
  // Poll state every second for live countdown
  tickInterval = setInterval(refresh, 1000);
}

// Fetch state from service worker and re-render
async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "getState" });
    if (!res || !res.ok) return;
    currentState = res.state;
    render(currentState);
  } catch (e) {
    // Service worker may be inactive — will retry next tick
  }
}

// ─── RENDER ──────────────────────────────────────────────────
function render(st) {
  updateStats(st);
  renderSites(st);

  const phase = st.phase || "IDLE";

  // Show the right view, hide others
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== phase.toLowerCase());
  });

  if (phase === "IDLE")     renderIdle(st);
  if (phase === "SESSION")  renderSession(st);
  if (phase === "COOLDOWN") renderCooldown(st);

  // Phase badge
  const badgeCfg = {
    IDLE:     ["badge-idle",     "● IDLE"],
    SESSION:  ["badge-session",  "⏳ SESSION"],
    COOLDOWN: ["badge-cooldown", "❄️ COOLDOWN"],
  };
  const [cls, label] = badgeCfg[phase] || badgeCfg["IDLE"];
  phaseBadge.className = `phase-badge ${cls}`;
  phaseBadge.textContent = label;

  // Lock add-site UI in strict-mode session
  const locked = phase === "SESSION" && st.strictMode;
  addSiteRow.style.opacity = locked ? "0.4" : "1";
  addSiteRow.style.pointerEvents = locked ? "none" : "auto";
}

function updateStats(st) {
  statStreak.textContent   = st.streak          || 0;
  statBypasses.textContent = st.bypassAttempts  || 0;
  statSessions.textContent = st.totalSessions   || 0;
}

// IDLE VIEW
function renderIdle(st) {
  // Restore last-used settings
  if (st.sessionDurationMin)  inpDuration.value = st.sessionDurationMin;
  if (st.cooldownDurationMin) inpCooldown.value = st.cooldownDurationMin;
}

// SESSION VIEW
function renderSession(st) {
  const now  = Date.now();
  const left = Math.max(0, (st.sessionEndTime || now) - now);
  const total = (st.sessionDurationMin || 30) * 60000;

  sessionTimer.textContent = fmtMs(left);
  sessionProg.style.width  = `${100 - (left / total) * 100}%`;

  strictBadge.classList.toggle("hidden", !st.strictMode);

  // Disable stop button in strict mode
  if (st.strictMode) {
    btnStop.disabled = true;
    btnStop.textContent = "🔒 Strict Mode — Cannot Stop";
    btnStop.classList.add("btn-disabled");
  } else {
    btnStop.disabled = false;
    btnStop.textContent = "■  End Session Early";
    btnStop.classList.remove("btn-disabled");
  }
}

// COOLDOWN VIEW
function renderCooldown(st) {
  const now  = Date.now();
  const left = Math.max(0, (st.cooldownEndTime || now) - now);
  const total = (st.cooldownDurationMin || 15) * 60000;

  cooldownTimer.textContent = fmtMs(left);
  cooldownProg.style.width  = `${100 - (left / total) * 100}%`;
  penaltyBanner.classList.toggle("hidden", !st.bypassAttempts || st.bypassAttempts < 3);
}

// ─── SITE LIST ───────────────────────────────────────────────
function renderSites(st) {
  const sites = st.sites || [];
  siteCount.textContent = sites.length;
  siteList.innerHTML = "";

  for (const site of sites) {
    const row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML = `
      <div class="site-fav">
        <img src="https://www.google.com/s2/favicons?domain=${site.domain}&sz=16"
             onerror="this.style.display='none'" alt="" />
      </div>
      <span class="site-domain">${site.domain}</span>
      <button class="btn-remove" data-domain="${site.domain}" title="Remove">✕</button>
    `;
    row.querySelector(".btn-remove").addEventListener("click", () => removeSite(site.domain));
    siteList.appendChild(row);
  }
}

// ─── ACTIONS ─────────────────────────────────────────────────

// Start session
btnStart.addEventListener("click", async () => {
  hideMsg(idleError);
  const durationMin  = parseInt(inpDuration.value) || 30;
  const cooldownMin  = parseInt(inpCooldown.value) || 15;
  const strict       = chkStrict.checked;

  // Save settings first
  await send({ action: "updateSettings", sessionDurationMin: durationMin, cooldownDurationMin: cooldownMin });

  const res = await send({ action: "startSession", durationMin, strict });
  if (!res.ok) showMsg(idleError, res.error);
  else setFooter("Session started!");
});

// Stop session early (only works when not strict)
btnStop.addEventListener("click", async () => {
  hideMsg(stopError);
  const res = await send({ action: "stopSession" });
  if (!res.ok) showMsg(stopError, res.error);
  else setFooter("Session ended — cooldown started.");
});

// Add site
btnAddSite.addEventListener("click", async () => {
  hideMsg(addError);
  const raw    = inpDomain.value.trim().toLowerCase();
  const domain = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  if (!domain || !domain.includes(".")) {
    showMsg(addError, "Enter a valid domain (e.g. reddit.com)");
    return;
  }

  const res = await send({ action: "addSite", domain });
  if (!res.ok) showMsg(addError, res.error);
  else { inpDomain.value = ""; setFooter("Site added!"); }
});

// Remove site
async function removeSite(domain) {
  const res = await send({ action: "removeSite", domain });
  if (!res.ok) setFooter(res.error);
  else setFooter("Site removed.");
}

// ─── HELPERS ─────────────────────────────────────────────────

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: "Background not reachable." };
  }
}

// Format milliseconds → hh:mm:ss or mm:ss
function fmtMs(ms) {
  const s   = Math.floor(ms / 1000);
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (hrs > 0) return `${hrs}:${pad(min)}:${pad(sec)}`;
  return `${pad(min)}:${pad(sec)}`;
}

const pad = n => String(n).padStart(2, "0");

function showMsg(el, text) { el.textContent = text; el.classList.remove("hidden"); }
function hideMsg(el)       { el.classList.add("hidden"); }

let footerTimer;
function setFooter(msg) {
  footerMsg.textContent = msg;
  clearTimeout(footerTimer);
  footerTimer = setTimeout(() => { footerMsg.textContent = "Anti-cheat active"; }, 3000);
}

// Kick off
init();
