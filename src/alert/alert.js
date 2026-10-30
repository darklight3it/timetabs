// Pop-up reminder window: shown instead of (or alongside) a system notification.
// The key is a single mark ("tab-5") or a batch of marks that fired together ("batch:tab-5,tab-7").

const $ = (sel) => document.querySelector(sel);
const alertKey = new URLSearchParams(location.search).get("key");

async function run(type) {
  try {
    await send(type, { key: alertKey });
  } finally {
    window.close();
  }
}

function showTest() {
  $("#title").textContent = "Test reminder — it works.";
  $("#meta").textContent = "Real reminders show up here with Go, Snooze and Done.";
  $("#snooze").hidden = $("#done").hidden = true;
  $("#go").firstChild.textContent = "Close ";
  $("#go").onclick = () => window.close();
}

function showOne(item) {
  const timing = describeTiming(item);
  $("#title").textContent = reminderTitle(item);
  $("#meta").textContent = item.kind === "group" ? `${item.count} tabs in “${item.label}”` : item.label;
  $("#when").textContent = item.firedAt ? `Due ${formatDuration(Date.now() - item.firedAt)} ago` : "";
  $("#when").classList.toggle("late", timing.tone === "late");
  document.title = `Reminder: ${item.note || item.label}`;
}

// Same order as the combined notification: P1, P2, P3, then plain reminders.
function showMany(items) {
  items.sort((a, b) => (a.level || 4) - (b.level || 4));
  $("#title").textContent = `${items.length} reminders`;
  $("#meta").textContent = "Go opens the most urgent one; Snooze and Done apply to all.";
  $("#items").replaceChildren(...items.map((item) => Object.assign(document.createElement("li"), { textContent: reminderTitle(item) })));
  $("#items").hidden = false;
  document.title = `${items.length} reminders`;
}

(async () => {
  $("#snooze-label").textContent = `Snooze ${SNOOZE_MINUTES} min`;
  const keys = expandKey(alertKey);
  const items = (await send("list")).filter((i) => keys.includes(i.key));
  if (!items.length) return showTest();
  if (items.length === 1) showOne(items[0]);
  else showMany(items);

  $("#go").onclick = () => run("focus");
  $("#snooze").onclick = () => run("snooze");
  $("#done").onclick = () => run("done");
})();

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "s" && !$("#snooze").hidden) $("#snooze").click();
  if (k === "d" && !$("#done").hidden) $("#done").click();
});
