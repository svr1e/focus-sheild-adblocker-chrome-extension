// ============================================================
// FocusShield v2.0 — background.js (Service Worker)
//
// STATE MACHINE:
//   IDLE      → sites accessible (with delay gate)
//   SESSION   → timer running, sites accessible, strict lock optional
//   COOLDOWN  → sites BLOCKED, countdown to re-access
//
// Anti-cheat features:
//   • Strict mode: session cannot be stopped once started
//   • Tab monitoring: redirect any bypass attempt in real time
//   • incognito: service worker spans incognito (manifest setting)
//   • Bypass attempts: recorded, add penalty time to cooldown
//   • Streak: counts sessions completed without bypass
//   • Delay gate: 10-second pause before accessing sites in IDLE
// ============================================================

// ─── CONSTANTS ───────────────────────────────────────────────

// All YouTube domain variants to block
const YOUTUBE_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "music.youtube.com",
  "studio.youtube.com",
  "gaming.youtube.com",
  "m.youtube.com",
];

// declarativeNetRequest URL filters for YouTube (covers all subdomains)
const YOUTUBE_URL_FILTERS = [
  "||youtube.com^",
  "||youtu.be^",
];

const ALARM = {
  SESSION_END:  "fs_session_end",
  COOLDOWN_END: "fs_cooldown_end",
  WARN_5MIN:    "fs_warn_5min",
};

// Default values for first install
const DEFAULTS = {
  phase:               "IDLE",       // "IDLE" | "SESSION" | "COOLDOWN"
  strictMode:          false,        // Locked during session; cannot be disabled
  sessionStartTime:    null,
  sessionEndTime:      null,
  sessionDurationMin:  30,
  cooldownEndTime:     null,
  cooldownDurationMin: 15,
  bypassAttempts:      0,            // Per-session bypass counter
  streak:              0,            // Consecutive clean sessions
  totalSessions:       0,
  sites:               [],           // User-added sites (YouTube always blocked)
};

// In-memory: tab IDs that passed the delay gate (resets on SW restart — intentional)
const approvedTabs = new Set();

// ─── INIT ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    await chrome.storage.local.set(DEFAULTS);
    console.log("[FS] Installed.");
  }
  if (reason === "update") {
    // Merge new defaults without wiping existing user data
    const existing = await chrome.storage.local.get(null);
    await chrome.storage.local.set({ ...DEFAULTS, ...existing });
  }
  await restoreOnStartup();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[FS] Browser started — restoring session state.");
  await restoreOnStartup();
});

// Called on install/startup: re-sync timers and blocking rules
async function restoreOnStartup() {
  const st = await getState();
  const now = Date.now();

  // Session expired while browser was closed → start cooldown
  if (st.phase === "SESSION" && st.sessionEndTime && now >= st.sessionEndTime) {
    await beginCooldown(st);
    return;
  }

  // Cooldown expired while browser was closed → go idle
  if (st.phase === "COOLDOWN" && st.cooldownEndTime && now >= st.cooldownEndTime) {
    await goIdle();
    return;
  }

  // Re-apply blocking rules for current phase
  await syncRules(st);

  // Re-schedule alarms that may have been lost
  if (st.phase === "SESSION" && st.sessionEndTime) {
    const leftMs = st.sessionEndTime - now;
    if (leftMs > 0) scheduleSessionAlarms(leftMs);
  }
  if (st.phase === "COOLDOWN" && st.cooldownEndTime) {
    const leftMs = st.cooldownEndTime - now;
    if (leftMs > 0) {
      chrome.alarms.create(ALARM.COOLDOWN_END, { delayInMinutes: leftMs / 60000 });
    }
  }
}

// ─── STATE HELPERS ───────────────────────────────────────────

async function getState() {
  return await chrome.storage.local.get(null);
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// ─── PHASE TRANSITIONS ───────────────────────────────────────

// Begin a new focus session
async function beginSession(durationMin, strict) {
  const now = Date.now();
  await setState({
    phase:              "SESSION",
    strictMode:         strict,
    sessionStartTime:   now,
    sessionEndTime:     now + durationMin * 60000,
    sessionDurationMin: durationMin,
    bypassAttempts:     0,
  });
  const st = await getState();
  await syncRules(st);
  scheduleSessionAlarms(durationMin * 60000);
  console.log(`[FS] Session started: ${durationMin}min strict=${strict}`);
}

// Session → Cooldown
async function beginCooldown(st) {
  const now = Date.now();
  const coolMin  = st.cooldownDurationMin || 15;
  // Clean session (no bypasses) extends streak; bypass attempts reset it
  const newStreak = st.bypassAttempts === 0 ? (st.streak || 0) + 1 : 0;

  await setState({
    phase:           "COOLDOWN",
    sessionEndTime:  null,
    cooldownEndTime: now + coolMin * 60000,
    streak:          newStreak,
    totalSessions:   (st.totalSessions || 0) + 1,
    strictMode:      false,     // Strict lock released only after cooldown
  });
  const newSt = await getState();
  await syncRules(newSt);
  chrome.alarms.create(ALARM.COOLDOWN_END, { delayInMinutes: coolMin });
  notify("⏰ Session Complete!", `Cooldown: ${coolMin} min 🔥 Streak: ${newStreak}`);
  console.log(`[FS] Cooldown: ${coolMin}min — streak: ${newStreak}`);
}

// Cooldown → Idle
async function goIdle() {
  await setState({
    phase:           "IDLE",
    cooldownEndTime: null,
    bypassAttempts:  0,
    strictMode:      false,
  });
  const st = await getState();
  await syncRules(st);
  notify("✅ Cooldown Over!", "Sites are accessible again. Stay intentional!");
  console.log("[FS] Back to IDLE.");
}

// ─── BLOCKING RULES (declarativeNetRequest) ──────────────────

// Sync DNR rules to match current phase.
// Sites are blocked ONLY during COOLDOWN.
// During SESSION, sites are accessible (that's the whole point).
async function syncRules(st) {
  if (st.phase === "COOLDOWN") {
    await applyBlockRules(st.sites || []);
  } else {
    await removeAllRules();
  }
}

async function applyBlockRules(customSites) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);

  const rules = [];
  let id = 1;

  // YouTube (all variants)
  for (const filter of YOUTUBE_URL_FILTERS) {
    rules.push({
      id: id++,
      priority: 2,
      action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: { urlFilter: filter, resourceTypes: ["main_frame"] },
    });
  }

  // User-added custom sites
  for (const site of customSites) {
    // Skip if already covered by YouTube filters
    if (YOUTUBE_URL_FILTERS.some(f => f.includes(site.domain))) continue;
    rules.push({
      id: id++,
      priority: 1,
      action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: { urlFilter: `||${site.domain}^`, resourceTypes: ["main_frame"] },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
  console.log(`[FS] Applied ${rules.length} blocking rules.`);
}

async function removeAllRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.map(r => r.id);
  if (ids.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: [] });
  }
}

// ─── TAB MONITORING ──────────────────────────────────────────
// Uses changeInfo.url which fires when address bar URL changes,
// giving us the navigation intent BEFORE the page loads.
// This catches attempts even when DNR has already redirected.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only act on URL changes (navigation intent)
  const rawUrl = changeInfo.url;
  if (!rawUrl) return;
  // Skip extension pages (blocked.html, delay-gate.html, chrome:// pages)
  if (rawUrl.startsWith("chrome") || rawUrl.startsWith("about:")) return;

  let url;
  try { url = new URL(rawUrl); } catch { return; }

  const st = await getState();
  if (!isTracked(url.hostname, st)) return;

  // ── COOLDOWN: block every access attempt ──
  if (st.phase === "COOLDOWN") {
    await recordBypass(st);  // Add penalty if needed
    const cooldownLeft = Math.max(0, Math.ceil(((st.cooldownEndTime || 0) - Date.now()) / 60000));
    redirectTab(tabId, `blocked.html?site=${enc(url.hostname)}&cooldown=${cooldownLeft}`);
    return;
  }

  // ── IDLE: enforce 10-second delay gate ──
  if (st.phase === "IDLE") {
    if (approvedTabs.has(tabId)) return; // Already passed gate
    redirectTab(tabId, `delay-gate.html?site=${enc(url.hostname)}&next=${enc(rawUrl)}&tabId=${tabId}`);
    return;
  }

  // ── SESSION: sites are accessible — no action needed ──
});

function isTracked(hostname, st) {
  // Remove www. prefix for cleaner matching
  const h = hostname.replace(/^www\./, "");
  // Check YouTube
  if (YOUTUBE_DOMAINS.some(d => h === d || h.endsWith("." + d))) return true;
  // Check user-added sites
  return (st.sites || []).some(s => h === s.domain || h.endsWith("." + s.domain));
}

function redirectTab(tabId, extensionPath) {
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL(extensionPath) })
    .catch(e => console.warn("[FS] Could not redirect tab:", e.message));
}

const enc = encodeURIComponent;

// ─── BYPASS / PENALTY SYSTEM ─────────────────────────────────

async function recordBypass(st) {
  const attempts = (st.bypassAttempts || 0) + 1;
  let patch = { bypassAttempts: attempts, streak: 0 }; // Any bypass resets streak

  // Every 3 bypass attempts → extend cooldown by 10 minutes
  if (attempts % 3 === 0) {
    const extension  = 10 * 60000;
    const newCooldown = Math.max(st.cooldownEndTime || Date.now(), Date.now()) + extension;
    patch.cooldownEndTime = newCooldown;

    // Re-schedule cooldown alarm for extended time
    chrome.alarms.clear(ALARM.COOLDOWN_END);
    chrome.alarms.create(ALARM.COOLDOWN_END, { delayInMinutes: extension / 60000 });

    notify("⚠️ Bypass Detected!", `+10 min penalty. ${attempts} attempt(s) logged.`);
  }

  await setState(patch);
}

// ─── ALARM HANDLERS ──────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const st = await getState();

  if (alarm.name === ALARM.WARN_5MIN) {
    notify("⏰ 5 Minutes Left", "Wrap up — your session ends soon!");
    return;
  }

  if (alarm.name === ALARM.SESSION_END) {
    if (st.phase === "SESSION") await beginCooldown(st);
    return;
  }

  if (alarm.name === ALARM.COOLDOWN_END) {
    if (st.phase === "COOLDOWN") await goIdle();
    return;
  }
});

function scheduleSessionAlarms(durationMs) {
  chrome.alarms.clear(ALARM.SESSION_END);
  chrome.alarms.clear(ALARM.WARN_5MIN);
  const min = durationMs / 60000;
  if (min > 5) chrome.alarms.create(ALARM.WARN_5MIN, { delayInMinutes: min - 5 });
  chrome.alarms.create(ALARM.SESSION_END, { delayInMinutes: min });
}

// ─── NOTIFICATIONS ───────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message,
    priority: 2,
  });
}

// ─── MESSAGE HANDLER (from popup.js and delay-gate.html) ─────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMsg(msg, sender).then(sendResponse).catch(err => {
    console.error("[FS] Message error:", err);
    sendResponse({ ok: false, error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMsg(msg, sender) {
  const st = await getState();

  switch (msg.action) {

    // Popup asks for full state snapshot
    case "getState":
      return { ok: true, state: st };

    // Start a new session (only from IDLE)
    case "startSession": {
      if (st.phase !== "IDLE") return { ok: false, error: `Phase is ${st.phase}` };
      await beginSession(msg.durationMin || 30, !!msg.strict);
      return { ok: true };
    }

    // Stop session early — ONLY allowed if NOT strict mode
    case "stopSession": {
      if (st.phase !== "SESSION") return { ok: false, error: "No active session." };
      if (st.strictMode) return { ok: false, error: "🔒 Strict Mode: cannot stop early." };
      chrome.alarms.clear(ALARM.SESSION_END);
      chrome.alarms.clear(ALARM.WARN_5MIN);
      await beginCooldown(st);
      return { ok: true };
    }

    // Add a custom site
    case "addSite": {
      if (st.phase === "SESSION" && st.strictMode)
        return { ok: false, error: "Cannot modify sites in Strict Mode." };
      const { domain } = msg;
      const sites = st.sites || [];
      if (sites.find(s => s.domain === domain)) return { ok: false, error: "Already tracked." };
      const newSites = [...sites, { domain }];
      await setState({ sites: newSites });
      if (st.phase === "COOLDOWN") await applyBlockRules(newSites);
      return { ok: true };
    }

    // Remove a custom site
    case "removeSite": {
      if (st.phase === "SESSION" && st.strictMode)
        return { ok: false, error: "Cannot modify sites in Strict Mode." };
      const sites = (st.sites || []).filter(s => s.domain !== msg.domain);
      await setState({ sites });
      const newSt = await getState();
      await syncRules(newSt);
      return { ok: true };
    }

    // delay-gate.html signals approval for a tab
    case "delayGateApproved": {
      const tabId = parseInt(msg.tabId);
      if (!isNaN(tabId)) {
        approvedTabs.add(tabId);
        // Auto-revoke approval after 5 minutes
        setTimeout(() => approvedTabs.delete(tabId), 5 * 60000);
      }
      return { ok: true };
    }

    // Update session/cooldown duration settings
    case "updateSettings": {
      if (st.phase === "SESSION" && st.strictMode)
        return { ok: false, error: "Cannot change settings in Strict Mode." };
      const patch = {};
      if (msg.sessionDurationMin)  patch.sessionDurationMin  = msg.sessionDurationMin;
      if (msg.cooldownDurationMin) patch.cooldownDurationMin = msg.cooldownDurationMin;
      await setState(patch);
      return { ok: true };
    }
  }

  return { ok: false, error: "Unknown action." };
}
