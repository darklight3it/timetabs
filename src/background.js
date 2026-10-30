// Timetabs — service worker.
// Marks live in storage.session: tab and group ids are only valid until the browser restarts.
// A mark is keyed "tab-<id>" or "group-<id>"; the same key names its alarm.
// remind: null = none, { type: "every", minutes } = repeating, { type: "at", when } = one-off.
// firedAt: set when a reminder fires, cleared once you see the tab — drives "overdue" and the badge.

importScripts("shared.js");

// Level 0 is a plain reminder: an alarm on a tab without any priority.
const LEVELS = {
  0: { title: "Reminder", color: "grey", defaultRemind: 0 },
  1: { title: "P1", color: "red", defaultRemind: 30 },
  2: { title: "P2", color: "yellow", defaultRemind: 60 },
  3: { title: "P3", color: "blue", defaultRemind: 0 },
};
const LEVEL_TITLES = new Set([1, 2, 3].map((level) => LEVELS[level].title));
const VOLUMES = { off: 0, soft: 0.12, normal: 0.25, loud: 0.5 };
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;
// Reminders firing within this window are announced together as one alert.
const ALERT_BATCH_MS = 750;

const logErrors = (fn) => (...args) =>
  Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => console.error("Timetabs:", err));

// ─── Storage ──────────────────────────────────────────────────────────────────
// Chrome runs event listeners concurrently, so an unserialized "read the whole object,
// change it, write it back" loses updates. Every write goes through this one queue.

let writeQueue = Promise.resolve();

function mutate(name, fn) {
  const run = writeQueue.then(async () => {
    const value = (await chrome.storage.session.get(name))[name] ?? {};
    const before = JSON.stringify(value);
    const result = await fn(value);
    if (JSON.stringify(value) !== before) {
      await chrome.storage.session.set({ [name]: value });
      if (name === "marks") await updateBadge(value);
    }
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

const updateMarks = (fn) => mutate("marks", fn);

async function getMarks() {
  return (await chrome.storage.session.get("marks")).marks ?? {};
}

async function updateBadge(marks) {
  const overdue = Object.values(marks).filter((m) => m.firedAt).length;
  await chrome.action.setBadgeText({ text: overdue ? String(overdue) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#f38ba8" });
  await chrome.action.setBadgeTextColor?.({ color: "#11111b" });
}

// ─── Marks ────────────────────────────────────────────────────────────────────

function defaultRemind(level) {
  const minutes = LEVELS[level].defaultRemind;
  return minutes ? { type: "every", minutes } : null;
}

// A mark with no priority, reminder, note or pending alert has nothing left to track.
const isEmptyMark = (m) => !m.level && !m.remind && !m.note && !m.firedAt;

async function schedule(key, remind) {
  await chrome.alarms.clear(key);
  if (remind?.type === "every") {
    chrome.alarms.create(key, { delayInMinutes: remind.minutes, periodInMinutes: remind.minutes });
  } else if (remind?.type === "at") {
    chrome.alarms.create(key, { when: remind.when });
  }
}

// Creates, patches or (when it ends up empty) removes a mark. `patch` may be a function
// of the previous mark. The alarm is rescheduled when the reminder changes; a new mark
// also clears any alarm left under the same key, since tab ids are reused after a restart.
// grouped: the extension put these tabs into their group, so Clear may ungroup them.
async function upsert(key, patch) {
  const { changedRemind, created, next } = await updateMarks((marks) => {
    const prev = marks[key];
    const applied = typeof patch === "function" ? patch(prev) : patch;
    const merged = { ...parseKey(key), level: 0, note: "", remind: null, grouped: false, firedAt: null, ...prev, ...applied };
    merged.since = prev?.since ?? Date.now();
    if ("remind" in applied) merged.firedAt = null;
    if (isEmptyMark(merged)) delete marks[key];
    else marks[key] = merged;
    return { changedRemind: "remind" in applied, created: !prev, next: marks[key] ?? null };
  });
  if (changedRemind || created || !next) await schedule(key, next?.remind ?? null);
  if (changedRemind || !next) await sweepAlerts();
  return next;
}

async function unmark(key) {
  const existed = await updateMarks((marks) => {
    const had = key in marks;
    delete marks[key];
    return had;
  });
  await chrome.alarms.clear(key);
  if (existed) await sweepAlerts();
}

// scope: "tab" | "tabs" (highlighted tabs, each marked individually) | "group" (active tab's group).
const targetKeys = ({ scope, tabIds, groupId }) =>
  scope === "group" ? [keyOf("group", groupId)] : tabIds.map((id) => keyOf("tab", id));

const keysForTab = (tab) => (tab.groupId === NO_GROUP ? [keyOf("tab", tab.id)] : [keyOf("tab", tab.id), keyOf("group", tab.groupId)]);

// Joins the group with exactly this title in the window, or creates one. (Filtering
// ourselves: tabGroups.query treats `title` as a pattern, so "Launch*" would match others.)
async function ensureGroup(tabIds, windowId, title, color) {
  const existing = (await chrome.tabGroups.query({ windowId })).find((g) => g.title === title);
  const groupId = existing
    ? await chrome.tabs.group({ groupId: existing.id, tabIds })
    : await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title, color });
  return groupId;
}

// A tab may be moved into a P1/P2/P3 group only in a normal window (Chrome can't group
// tabs in pop-ups or app windows), and only if it is ungrouped or already in one of ours.
async function canRegroup(tab) {
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.type !== "normal") return false;
  if (tab.groupId === NO_GROUP) return true;
  const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
  return LEVEL_TITLES.has(group?.title);
}

async function prioritize(target, level) {
  const { groupByPriority } = await getSettings();
  const { title, color } = LEVELS[level];
  // An existing mark keeps its reminder; a new one gets the level's default.
  const patchFor = (extra) => (prev) => (prev ? { level, ...extra } : { level, remind: defaultRemind(level), ...extra });

  if (target.scope === "group") {
    if (groupByPriority) await chrome.tabGroups.update(target.groupId, { color });
    return upsert(keyOf("group", target.groupId), patchFor({}));
  }

  for (const id of target.tabIds) {
    const tab = await chrome.tabs.get(id);
    let grouped = false;
    if (groupByPriority && (await canRegroup(tab))) {
      grouped = await ensureGroup([id], tab.windowId, title, color).then(() => true, () => false);
    }
    await upsert(keyOf("tab", id), patchFor(grouped ? { grouped } : {}));
  }
}

async function remind(target, remindValue) {
  for (const key of targetKeys(target)) await upsert(key, { remind: remindValue });
}

async function setNote(target, note) {
  for (const key of targetKeys(target)) await upsert(key, { note });
}

// Puts the tabs into a named group that carries its own mark (one shared reminder).
async function groupAs(target, name) {
  const marks = await getMarks();
  const tabs = await Promise.all(target.tabIds.map((id) => chrome.tabs.get(id)));
  const levels = target.tabIds.map((id) => marks[keyOf("tab", id)]?.level).filter(Boolean);
  const level = levels.length ? Math.min(...levels) : 0;
  const groupId = await ensureGroup(target.tabIds, tabs[0].windowId, name, LEVELS[level].color);
  await upsert(keyOf("group", groupId), { level, grouped: true });
}

// Only ungroups tabs the extension grouped, never a group you made yourself.
async function clear(target) {
  if (target.scope === "group") return unmark(keyOf("group", target.groupId));
  const marks = await getMarks();
  const tabs = await Promise.all(target.tabIds.map((id) => chrome.tabs.get(id).catch(() => null)));
  const ours = tabs.filter((t) => t && (marks[keyOf("tab", t.id)]?.grouped || marks[keyOf("group", t.groupId)]?.grouped));
  if (ours.length) await chrome.tabs.ungroup(ours.map((t) => t.id)).catch(() => {});
  for (const id of target.tabIds) await unmark(keyOf("tab", id));
}

async function snooze(key, minutes = SNOOZE_MINUTES) {
  const entry = (await getMarks())[key];
  if (!entry) return;
  if (entry.remind?.type === "every") {
    await upsert(key, { firedAt: null });
    chrome.alarms.create(key, { delayInMinutes: minutes, periodInMinutes: entry.remind.minutes });
    await sweepAlerts();
  } else {
    await upsert(key, { remind: { type: "at", when: Date.now() + minutes * MINUTE } });
  }
}

// ⌥⇧S: snooze everything that is currently overdue, without opening anything.
async function snoozeOverdue() {
  const overdue = Object.entries(await getMarks()).filter(([, m]) => m.firedAt).map(([key]) => key);
  for (const key of overdue) await snooze(key);
}

async function done(key) {
  const { kind, id } = parseKey(key);
  return kind === "tab" ? clear({ scope: "tab", tabIds: [id] }) : unmark(key);
}

// Alert keys may cover several marks ("batch:…"); act on each in turn.
async function forEachKey(alertKey, fn) {
  for (const key of expandKey(alertKey)) await fn(key);
}

// ─── Targets and the "Now" list ───────────────────────────────────────────────

async function resolveTarget({ kind, id }) {
  if (kind === "tab") {
    const tab = await chrome.tabs.get(id).catch(() => null);
    return tab && { tabs: [tab], label: tab.title || tab.url };
  }
  const group = await chrome.tabGroups.get(id).catch(() => null);
  if (!group) return null;
  const tabs = await chrome.tabs.query({ groupId: id });
  return { tabs, group, label: group.title || "Untitled group" };
}

// Most urgent first: overdue (oldest first), then next due, then no reminder by priority.
const priorityRank = (level) => level || 4;

function urgency(item) {
  if (item.firedAt) return [0, item.firedAt];
  if (item.due) return [1, item.due];
  return [2, priorityRank(item.level)];
}

async function list() {
  const items = [];
  for (const [key, entry] of Object.entries(await getMarks())) {
    const target = await resolveTarget(entry);
    if (!target) {
      await unmark(key);
      continue;
    }
    const alarm = await chrome.alarms.get(key);
    items.push({ ...entry, key, label: target.label, count: target.tabs.length, due: alarm?.scheduledTime ?? null });
  }
  return items.sort((a, b) => {
    const [ua, ub] = [urgency(a), urgency(b)];
    return ua[0] - ub[0] || ua[1] - ub[1] || priorityRank(a.level) - priorityRank(b.level);
  });
}

async function acknowledge(keys) {
  const changed = await updateMarks((marks) => {
    let any = false;
    for (const key of keys) {
      const mark = marks[key];
      if (!mark?.firedAt) continue;
      mark.firedAt = null;
      if (isEmptyMark(mark)) delete marks[key];
      any = true;
    }
    return any;
  });
  if (changed) await sweepAlerts();
}

async function focus(key) {
  const target = await resolveTarget(parseKey(key));
  if (!target?.tabs.length) return;
  if (target.group?.collapsed) await chrome.tabGroups.update(target.group.id, { collapsed: false });
  const tab = await chrome.tabs.update(target.tabs[0].id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await acknowledge([key]);
}

async function focusNext() {
  const [first] = await list();
  if (first) await focus(first.key);
  return first ?? null;
}

// You are looking at a target if one of its tabs is active in the focused window.
async function isWatching(target) {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  return Boolean(win?.focused && target.tabs.some((t) => t.active && t.windowId === win.id));
}

// Seeing a tab counts as dealing with its reminder: switching to it, or focusing its window.
chrome.tabs.onActivated.addListener(logErrors(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await acknowledge(keysForTab(tab));
}));

chrome.windows.onFocusChanged.addListener(logErrors(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active) await acknowledge(keysForTab(active));
}));

chrome.tabs.onRemoved.addListener(logErrors((tabId) => unmark(keyOf("tab", tabId))));
chrome.tabGroups.onRemoved.addListener(logErrors((group) => unmark(keyOf("group", group.id))));

// Alarms survive a browser restart but marks (and tab ids) don't, so old alarms could
// otherwise fire on unrelated new tabs that reuse an id.
chrome.runtime.onStartup.addListener(logErrors(() => chrome.alarms.clearAll()));

// ─── Firing reminders ─────────────────────────────────────────────────────────

const pendingAlerts = new Map(); // key -> alert content, waiting to be announced
let flushTimer = null;

chrome.alarms.onAlarm.addListener(logErrors(async ({ name: key }) => {
  const entry = (await getMarks())[key];
  const target = entry && (await resolveTarget(entry));
  if (!target) return unmark(key);

  const watching = await isWatching(target);
  await updateMarks((marks) => {
    const mark = marks[key];
    if (!mark) return;
    if (mark.remind?.type === "at") mark.remind = null;
    if (!watching) mark.firedAt ??= Date.now();
    if (isEmptyMark(mark)) delete marks[key];
  });

  const oneOff = entry.remind?.type === "at";
  const what = entry.kind === "group" ? `${target.tabs.length} tabs in “${target.label}”` : target.label;
  const minutes = Math.round((Date.now() - entry.since) / MINUTE);
  queueAlert({
    key,
    level: entry.level,
    title: reminderTitle({ level: entry.level, note: entry.note, label: target.label }),
    message: oneOff ? what : `${what}\nMarked ${minutes} min ago — still on it?`,
    sticky: oneOff || entry.level === 1,
  });
}));

function queueAlert(alert) {
  pendingAlerts.set(alert.key, alert);
  flushTimer ??= setTimeout(logErrors(flushAlerts), ALERT_BATCH_MS);
}

async function flushAlerts() {
  flushTimer = null;
  const alerts = [...pendingAlerts.values()].sort((a, b) => priorityRank(a.level) - priorityRank(b.level));
  pendingAlerts.clear();
  if (alerts.length === 1) return raiseAlert(alerts[0].key, alerts[0]);
  if (!alerts.length) return;
  const [top] = alerts;
  await raiseAlert(`batch:${alerts.map((a) => a.key).join(",")}`, {
    title: `${alerts.length} reminders${top.level ? ` · top ${levelLabel(top.level)}` : ""}`,
    message: alerts.map((a) => a.title).join("\n"),
    sticky: alerts.some((a) => a.sticky),
    level: top.level,
  });
}

// ─── Alerts: system notification and/or a small pop-up window ────────────────
// Notification ids are "<alert key>@<timestamp>": reusing an id makes Chrome update the
// old notification silently instead of showing a new banner. Pop-up windows are tracked
// in session storage as { <alert key>: windowId }.

const alertKeyOf = (notificationId) => notificationId.split("@")[0];

async function openAlerts() {
  const notifications = Object.keys(await chrome.notifications.getAll()).map((id) => ({
    alertKey: alertKeyOf(id),
    close: () => chrome.notifications.clear(id),
  }));
  const { alertWindows = {} } = await chrome.storage.session.get("alertWindows");
  const windows = Object.entries(alertWindows).map(([alertKey, windowId]) => ({
    alertKey,
    close: async () => {
      await chrome.windows.remove(windowId).catch(() => {});
      await mutate("alertWindows", (w) => void delete w[alertKey]);
    },
  }));
  return [...notifications, ...windows];
}

async function closeAlertsWhere(shouldClose) {
  for (const alert of await openAlerts()) {
    if (shouldClose(expandKey(alert.alertKey), alert.alertKey)) await alert.close();
  }
}

// Closes alerts once nothing they announce is still overdue.
async function sweepAlerts() {
  const marks = await getMarks();
  await closeAlertsWhere((keys, alertKey) => alertKey !== "test" && !keys.some((k) => marks[k]?.firedAt));
}

// ─── Sound: the service worker can't play audio, so an offscreen page does it ──

let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: "offscreen/offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "Play reminder chimes" })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function playChime(level) {
  const { sound } = await getSettings();
  const volume = VOLUMES[sound] ?? VOLUMES.normal;
  if (!volume) return;
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "chime", level, volume });
  } catch (err) {
    console.error("Timetabs: could not play sound", err);
  }
}

async function notify(alertKey, { title, message, sticky, silent }) {
  await chrome.notifications.create(`${alertKey}@${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    priority: 2,
    title,
    message,
    buttons: [{ title: `Snooze ${SNOOZE_MINUTES} min` }, { title: "Done" }],
    requireInteraction: sticky,
    silent,
  });
}

async function openAlertWindow(alertKey, count) {
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`alert/alert.html?key=${encodeURIComponent(alertKey)}`),
    type: "popup",
    width: 380,
    height: count > 1 ? 200 + 24 * Math.min(count, 6) : 200,
    focused: true,
  });
  await mutate("alertWindows", (w) => void (w[alertKey] = win.id));
}

// Replaces older alerts about the same marks. Our own chime replaces the system
// notification sound so you never hear two.
async function raiseAlert(alertKey, { title, message, sticky, level }) {
  const { alertStyle, sound } = await getSettings();
  const keys = expandKey(alertKey);
  await closeAlertsWhere((alertKeys) => alertKeys.some((k) => keys.includes(k)));
  if (alertStyle !== "window") {
    await notify(alertKey, { title, message, sticky, silent: sound !== "off" }).catch((err) => console.error("Timetabs: notification failed", err));
  }
  if (alertStyle !== "notification") await openAlertWindow(alertKey, keys.length);
  await playChime(level);
}

chrome.windows.onRemoved.addListener(logErrors((windowId) =>
  mutate("alertWindows", (w) => {
    for (const [alertKey, id] of Object.entries(w)) if (id === windowId) delete w[alertKey];
  })));

chrome.notifications.onClicked.addListener(logErrors(async (id) => {
  await chrome.notifications.clear(id);
  await focus(expandKey(alertKeyOf(id))[0]);
}));

chrome.notifications.onButtonClicked.addListener(logErrors(async (id, button) => {
  await chrome.notifications.clear(id);
  await forEachKey(alertKeyOf(id), button === 0 ? (key) => snooze(key) : done);
}));

// ─── Shortcuts and context menu (page and toolbar icon; Chrome has no tab-strip menu) ─

// The highlighted tabs of a window. Defaults to the last focused *normal* window: a
// service worker's "current window" may be an alert pop-up or app window.
async function highlightedTarget(windowId) {
  windowId ??= (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
  if (windowId === undefined) return { scope: "tabs", tabIds: [] };
  const tabs = await chrome.tabs.query({ highlighted: true, windowId });
  return { scope: "tabs", tabIds: tabs.map((t) => t.id) };
}

chrome.commands.onCommand.addListener(logErrors(async (command) => {
  if (command === "next") return focusNext();
  if (command === "snooze-overdue") return snoozeOverdue();
  const target = await highlightedTarget();
  if (!target.tabIds.length) return;
  if (command === "clear") return clear(target);
  if (command.startsWith("set-p")) return prioritize(target, Number(command.replace("set-p", "")));
}));

const inMinutes = (minutes) => ({ type: "at", when: Date.now() + minutes * MINUTE });

const MENU = [
  { id: "p1", title: "Mark P1", run: (t) => prioritize(t, 1) },
  { id: "p2", title: "Mark P2", run: (t) => prioritize(t, 2) },
  { id: "p3", title: "Mark P3", run: (t) => prioritize(t, 3) },
  { separator: true },
  { id: "once-15", title: "Remind me in 15 min", run: (t) => remind(t, inMinutes(15)) },
  { id: "once-30", title: "Remind me in 30 min", run: (t) => remind(t, inMinutes(30)) },
  { id: "once-60", title: "Remind me in 1 hour", run: (t) => remind(t, inMinutes(60)) },
  { id: "once-180", title: "Remind me in 3 hours", run: (t) => remind(t, inMinutes(180)) },
  { id: "once-tomorrow", title: "Remind me tomorrow at 9:00", run: (t) => remind(t, { type: "at", when: tomorrowAt9() }) },
  { id: "once-pick", title: "Remind me at… (type a time)", run: openPopup },
  { separator: true },
  { id: "every-15", title: "Remind every 15 min", run: (t) => remind(t, { type: "every", minutes: 15 }) },
  { id: "every-30", title: "Remind every 30 min", run: (t) => remind(t, { type: "every", minutes: 30 }) },
  { id: "every-60", title: "Remind every hour", run: (t) => remind(t, { type: "every", minutes: 60 }) },
  { separator: true },
  { id: "stop", title: "Stop reminder", run: (t) => remind(t, null) },
  { id: "clear", title: "Clear priority", run: clear },
];

// The popup opens with the command bar focused, ready for "15:30" or "fri 9".
async function openPopup() {
  await chrome.action.openPopup().catch((err) => console.error("Timetabs: could not open popup", err));
}

// Rebuilt on every worker start, not just onInstalled, so a reload always picks up changes.
const logMenuError = () => {
  if (chrome.runtime.lastError) console.error("Timetabs: context menu", chrome.runtime.lastError.message);
};

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  const contexts = ["all", "action"];
  chrome.contextMenus.create({ id: "root", title: "Timetabs", contexts }, logMenuError);
  MENU.forEach((item, i) => chrome.contextMenus.create({
    parentId: "root",
    contexts,
    ...(item.separator ? { id: `sep-${i}`, type: "separator" } : { id: item.id, title: item.title }),
  }, logMenuError));
}

// Acts on the clicked tab — and the tabs highlighted with it — not the last focused window.
chrome.contextMenus.onClicked.addListener(logErrors(async ({ menuItemId }, tab) => {
  const item = MENU.find((m) => m.id === menuItemId);
  if (!item) return;
  const target = !tab
    ? await highlightedTarget()
    : tab.highlighted
      ? await highlightedTarget(tab.windowId)
      : { scope: "tab", tabIds: [tab.id] };
  await item.run(target);
}));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
});

setupMenus().catch((err) => console.error("Timetabs: menus", err));
getMarks().then(updateBadge);

// ─── Messages from popup, alert window and welcome page ───────────────────────

const handlers = {
  list,
  prioritize: ({ target, level }) => prioritize(target, level),
  remind: ({ target, remind: value }) => remind(target, value),
  note: ({ target, note }) => setNote(target, note),
  groupAs: ({ target, name }) => groupAs(target, name),
  clear: ({ target }) => clear(target),
  snooze: ({ key, minutes }) => forEachKey(key, (k) => snooze(k, minutes)),
  done: ({ key }) => forEachKey(key, done),
  focus: ({ key }) => focus(expandKey(key)[0]),
  focusNext,
  test: () => raiseAlert("test", { title: "Timetabs", message: "Test reminder — if you see this, reminders work.", sticky: false, level: 1 }),
  chime: ({ level }) => playChime(level),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen") return;
  const handler = handlers[msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown action "${msg.type}" — reload the extension in chrome://extensions.` });
    return;
  }
  handler(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true;
});
