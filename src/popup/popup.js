// Popup: a command bar (focused on open) plus one-click buttons; the "Now" list shows what needs attention.

const $ = (sel) => document.querySelector(sel);
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;

let targets = {}; // scope -> { scope, tabIds | groupId, label, title }
let scope = "tab";
let items = [];
let flashUntil = 0;
let acting = 0; // while an action runs, act() refreshes; skip the storage-change refresh

const target = () => {
  const { scope: s, tabIds, groupId } = targets[scope];
  return { scope: s, tabIds, groupId };
};
const targetKeys = () => {
  const t = targets[scope];
  return t.scope === "group" ? [keyOf("group", t.groupId)] : t.tabIds.map((id) => keyOf("tab", id));
};
const currentMarks = () => {
  const keys = targetKeys();
  return items.filter((item) => keys.includes(item.key));
};

// ─── Status line ──────────────────────────────────────────────────────────────

function flash(text, tone = "success") {
  flashUntil = Date.now() + 4000;
  $("#status").textContent = text;
  $("#status").className = `status ${tone}`;
}

function describeCurrent() {
  if (Date.now() < flashUntil) return;
  const marks = currentMarks();
  const status = $("#status");
  status.className = "status";
  if (!marks.length) status.textContent = "Not marked yet.";
  else if (marks.length === 1 && targetKeys().length === 1) status.textContent = `${marks[0].level ? `P${marks[0].level}` : "Reminder"} · ${describeTiming(marks[0]).text}`;
  else status.textContent = `${marks.length} of ${targetKeys().length} tabs marked`;
}

async function act(fn, message) {
  acting += 1;
  try {
    await fn();
    await refresh();
    flash(message);
    return true;
  } catch (err) {
    flash(err.message, "error");
    return false;
  } finally {
    acting -= 1;
  }
}

// ─── Target ("apply to") ──────────────────────────────────────────────────────

async function loadTargets() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const selected = await chrome.tabs.query({ highlighted: true, currentWindow: true });

  targets = { tab: { scope: "tab", tabIds: [active.id], label: "This tab" } };
  if (selected.length > 1) {
    targets.tabs = { scope: "tabs", tabIds: selected.map((t) => t.id), label: `${selected.length} tabs`, title: `${selected.length} selected tabs` };
  }
  if (active.groupId !== NO_GROUP) {
    const group = await chrome.tabGroups.get(active.groupId);
    targets.group = { scope: "group", groupId: group.id, label: "Group", title: `Whole group “${group.title || "untitled"}”` };
  }
  scope = targets.tabs ? "tabs" : "tab";
}

function renderTargets() {
  const options = Object.entries(targets);
  const container = $("#target");
  if (options.length === 1) {
    container.textContent = "This tab";
    return;
  }
  const group = Object.assign(document.createElement("div"), { className: "segmented" });
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Apply to");
  for (const [value, t] of options) {
    const input = Object.assign(document.createElement("input"), { type: "radio", name: "scope", value, checked: value === scope });
    input.onchange = () => {
      scope = value;
      flashUntil = 0;
      renderState();
    };
    const label = document.createElement("label");
    label.title = t.title ?? t.label;
    label.append(input, Object.assign(document.createElement("span"), { textContent: t.label }));
    group.append(label);
  }
  container.replaceChildren(group);
}

// ─── Current state ────────────────────────────────────────────────────────────

function renderState() {
  const marks = currentMarks();
  const allMarked = marks.length === targetKeys().length;
  const levels = new Set(marks.map((m) => m.level));
  document.querySelectorAll(".prio").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(allMarked && levels.size === 1 && levels.has(Number(btn.dataset.level))));
  });
  $("#group-form").hidden = targets[scope].scope === "group";
  describeCurrent();
}

// ─── Command bar ──────────────────────────────────────────────────────────────

const COMMAND_HINT = "Type a priority (1–3), a time (30m, 15:30, fri 9), a note — or done, snooze, next.";

function updatePreview() {
  const text = $("#command").value;
  const command = parseCommand(text);
  const preview = $("#command-preview");
  const late = command?.remind?.type === "at" && command.remind.when <= Date.now();
  preview.textContent = command ? `→ ${describeCommand(command)}` : COMMAND_HINT;
  preview.className = `preview${command ? (late ? " error" : " ok") : ""}`;
}

async function runCommand(command) {
  const t = target();
  const keys = targetKeys();
  switch (command.action) {
    case "clear": return act(() => send("clear", { target: t }), "Cleared");
    case "off": return act(() => send("remind", { target: t, remind: null }), "Reminder off");
    case "next": return jumpNext();
    case "snooze": {
      const marked = currentMarks().map((m) => m.key);
      if (!marked.length) return flash("Nothing to snooze here — mark it or set a time first.", "error"), false;
      return act(() => Promise.all(marked.map((key) => send("snooze", { key, minutes: command.minutes }))),
        `Snoozed ${formatDuration((command.minutes ?? SNOOZE_MINUTES) * MINUTE)}`);
    }
  }
  if (command.remind?.type === "at" && command.remind.when <= Date.now()) {
    flash("That time has already passed.", "error");
    return false;
  }
  return act(async () => {
    if (command.level) await send("prioritize", { target: t, level: command.level });
    if (command.remind !== undefined) await send("remind", { target: t, remind: command.remind });
    if (command.note) await send("note", { target: t, note: command.note });
  }, describeCommand(command) + (keys.length > 1 ? ` · ${keys.length} tabs` : ""));
}

$("#command").oninput = updatePreview;
$("#command-form").onsubmit = async (e) => {
  e.preventDefault();
  const command = parseCommand($("#command").value);
  if (!command) return flash(COMMAND_HINT, "error");
  if (await runCommand(command)) {
    $("#command").value = "";
    updatePreview();
  }
};

// ─── "Now" list ───────────────────────────────────────────────────────────────

function renderRow(item, isCurrent) {
  const timing = describeTiming(item);
  const title = itemTitle(item);
  const li = Object.assign(document.createElement("li"), { className: `row ${timing.tone}` });
  if (isCurrent) li.setAttribute("aria-current", "true");

  const main = Object.assign(document.createElement("button"), { type: "button", className: "row-main", title });
  main.dataset.key = item.key;
  main.setAttribute("aria-label", `Go to ${item.level ? `P${item.level}` : "reminder"}: ${title}, ${timing.text}. S to snooze, D for done.`);
  main.append(
    Object.assign(document.createElement("span"), { className: `tag tag-${item.level}`, textContent: levelLabel(item.level) }),
    Object.assign(document.createElement("span"), { className: "row-title", textContent: title }),
    Object.assign(document.createElement("span"), { className: "row-when", textContent: timing.tone === "none" ? "" : timing.text }),
  );
  main.onclick = async () => {
    await send("focus", { key: item.key });
    window.close();
  };

  const snooze = Object.assign(document.createElement("button"), { type: "button", className: "row-action", textContent: `+${SNOOZE_MINUTES}m`, title: `Snooze ${SNOOZE_MINUTES} min`, tabIndex: -1 });
  snooze.setAttribute("aria-label", `Snooze ${SNOOZE_MINUTES} minutes: ${title}`);
  snooze.onclick = () => snoozeItem(item.key);

  const done = Object.assign(document.createElement("button"), { type: "button", className: "row-action", textContent: "✓", title: "Done", tabIndex: -1 });
  done.setAttribute("aria-label", `Done: ${title}`);
  done.onclick = () => doneItem(item.key);

  li.append(main, snooze, done);
  return li;
}

const snoozeItem = (key) => act(() => send("snooze", { key }), `Snoozed ${SNOOZE_MINUTES} min`);
const doneItem = (key) => act(() => send("done", { key }), "Done — nice.");

function renderList() {
  const container = $("#list");
  if (!items.length) {
    container.innerHTML = `<div class="empty" role="status">
      <p>Nothing marked yet.</p>
      <p>Type <kbd>1</kbd> and press <kbd>↵</kbd> to mark this tab P1, or <kbd>30m</kbd> to be reminded.</p>
    </div>`;
    $("#next").hidden = true;
    return;
  }
  $("#next").hidden = false;

  const currentKeys = targetKeys();
  const sections = [
    { title: "Overdue", tone: "late", rows: items.filter((i) => i.firedAt) },
    { title: "Up next", tone: "due", rows: items.filter((i) => !i.firedAt && i.due) },
    { title: "No reminder", tone: "none", rows: items.filter((i) => !i.firedAt && !i.due) },
  ].filter((s) => s.rows.length);

  container.replaceChildren(...sections.flatMap((section) => {
    const heading = Object.assign(document.createElement("h3"), { className: `group-title ${section.tone}`, textContent: `${section.title} (${section.rows.length})` });
    const ul = Object.assign(document.createElement("ul"), { className: "rows" });
    ul.append(...section.rows.map((item) => renderRow(item, currentKeys.includes(item.key))));
    return [heading, ul];
  }));
}

async function refresh() {
  items = await send("list");
  renderState();
  renderList();
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

const remindAt = (when, label) => act(() => send("remind", { target: target(), remind: { type: "at", when } }), `Reminder set: ${label}`);

async function jumpNext() {
  const item = await send("focusNext");
  if (item) window.close();
  return Boolean(item);
}

function toggleCalendar(open = $("#calendar-form").hidden) {
  $("#calendar-form").hidden = !open;
  $("#calendar").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const at = $("#at");
  at.min = toLocalInput(Date.now());
  at.value ||= toLocalInput(Date.now() + 60 * MINUTE);
  at.focus();
}

document.querySelectorAll(".prio").forEach((btn) => {
  btn.onclick = () => act(() => send("prioritize", { target: target(), level: Number(btn.dataset.level) }), `Marked P${btn.dataset.level}`);
});
document.querySelectorAll("[data-in]").forEach((btn) => {
  const minutes = Number(btn.dataset.in);
  btn.onclick = () => remindAt(Date.now() + minutes * MINUTE, `in ${formatDuration(minutes * MINUTE)}`);
});
$("#tomorrow").onclick = () => remindAt(tomorrowAt9(), "tomorrow 9:00");
$("#calendar").onclick = () => toggleCalendar();
$("#off").onclick = () => act(() => send("remind", { target: target(), remind: null }), "Reminder off");
$("#clear").onclick = () => act(() => send("clear", { target: target() }), "Cleared");
$("#next").onclick = jumpNext;

$("#calendar-form").onsubmit = (e) => {
  e.preventDefault();
  const when = new Date($("#at").value).getTime();
  if (!(when > Date.now())) return flash("Pick a time in the future.", "error");
  toggleCalendar(false);
  remindAt(when, formatClock(when));
};

$("#group-form").onsubmit = (e) => {
  e.preventDefault();
  const name = $("#group-name").value.trim();
  const { tabIds } = targets[scope];
  act(() => send("groupAs", { target: { scope: "tabs", tabIds }, name }), `Grouped as “${name}”`);
};

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await getSettings();
  $("#group-by-priority").checked = settings.groupByPriority;
  $("#alert-style").value = settings.alertStyle;
  $("#sound").value = settings.sound;
}

async function saveSetting(patch) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  flash("Saved");
}

$("#group-by-priority").onchange = (e) => saveSetting({ groupByPriority: e.target.checked });
$("#alert-style").onchange = (e) => saveSetting({ alertStyle: e.target.value });
// Changing the sound plays a P1 chime at the new volume so you can hear it.
$("#sound").onchange = async (e) => {
  await saveSetting({ sound: e.target.value });
  await send("chime", { level: 1 });
};
$("#test").onclick = () => act(() => send("test"), "Test alert sent");
$("#welcome").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });

// ─── Keyboard: ↓ from the command bar into the list; ↑↓ ↵ S D inside it ──────

const rowButtons = () => [...document.querySelectorAll(".row-main")];

$("#command").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && rowButtons().length) {
    e.preventDefault();
    rowButtons()[0].focus();
  }
});

$("#list").addEventListener("keydown", (e) => {
  const rows = rowButtons();
  const index = rows.indexOf(document.activeElement);
  if (index < 0 || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = rows[index].dataset.key;
  const moves = {
    ArrowDown: () => rows[Math.min(index + 1, rows.length - 1)].focus(),
    ArrowUp: () => (index === 0 ? $("#command").focus() : rows[index - 1].focus()),
    s: () => snoozeItem(key).then(() => $("#command").focus()),
    d: () => doneItem(key).then(() => $("#command").focus()),
  };
  const run = moves[e.key] ?? moves[e.key.toLowerCase()];
  if (run) {
    e.preventDefault();
    run();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.marks && !acting && !$("#list").contains(document.activeElement)) refresh();
});

// Keep countdowns fresh, but don't yank focus away from someone moving through the list.
setInterval(() => {
  renderState();
  updatePreview();
  if (!$("#list").contains(document.activeElement)) renderList();
}, 30000);

(async () => {
  try {
    await loadTargets();
    renderTargets();
    await loadSettings();
    updatePreview();
    await refresh();
  } catch (err) {
    flash(err.message, "error");
  }
  $("#command").focus();
})();
