const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createChrome, loadBackground, sleep } = require("./fake-chrome");

let chrome, state, browser, events, bg;
let win, tabs;

beforeEach(async () => {
  ({ chrome, state, browser, events } = createChrome());
  win = browser.addWindow({ focused: true });
  tabs = [0, 1, 2, 3, 4].map((i) => browser.addTab({ windowId: win, title: `Tab ${i}`, active: i === 0 }));
  bg = loadBackground(chrome);
  await sleep(10); // let startup work (menus, badge) finish
});

const marks = () => state.session.marks ?? {};
const key = (id) => `tab-${id}`;
const target = (ids) => ({ scope: ids.length > 1 ? "tabs" : "tab", tabIds: ids });
const remindIn = (ids, ms) => bg.send("remind", { target: target(ids), remind: { type: "at", when: Date.now() + ms } });
const waitForAlerts = () => sleep(bg.evaluate("ALERT_BATCH_MS") + 50);
const chimes = () => state.messages.filter((m) => m.target === "offscreen" && m.type === "chime");

describe("concurrent updates (storage races)", () => {
  test("alarms firing together mark every tab overdue", async () => {
    browser.focusWindow(browser.addWindow()); // user is elsewhere, so nothing counts as seen
    await remindIn(tabs, 60000);
    await browser.fireAlarms(tabs.map(key));
    for (const id of tabs) assert.ok(marks()[key(id)].firedAt, `tab ${id} should be overdue`);
    assert.equal(state.badge, "5");
  });

  test("closing a window removes every mark", async () => {
    await bg.send("prioritize", { target: target(tabs), level: 2 });
    assert.equal(Object.keys(marks()).length, 5);
    await browser.closeTabs(tabs);
    await sleep(20);
    assert.deepEqual(marks(), {});
  });

  test("simultaneous popup actions on different tabs are all kept", async () => {
    await Promise.all([
      bg.send("prioritize", { target: target([tabs[0]]), level: 1 }),
      bg.send("note", { target: target([tabs[1]]), note: "read later" }),
      remindIn([tabs[2]], 60000),
    ]);
    assert.equal(marks()[key(tabs[0])].level, 1);
    assert.equal(marks()[key(tabs[1])].note, "read later");
    assert.ok(marks()[key(tabs[2])].remind);
  });
});

describe("alerts", () => {
  test("reminders firing together produce one combined alert and one chime", async () => {
    await bg.send("prioritize", { target: target([tabs[1]]), level: 1 });
    await remindIn(tabs.slice(0, 3), 60000);
    browser.focusWindow(browser.addWindow()); // user is elsewhere
    await browser.fireAlarms(tabs.slice(0, 3).map(key));
    await waitForAlerts();

    assert.equal(state.notifications.size, 1);
    const [[id, notification]] = state.notifications;
    assert.match(id, /^batch:/);
    assert.match(notification.title, /3 reminders/);
    assert.equal(chimes().length, 1);
    assert.equal(chimes()[0].level, 1, "chime uses the highest priority in the batch");
  });

  test("a single reminder gets its own alert", async () => {
    await bg.send("prioritize", { target: target([tabs[1]]), level: 2 });
    await bg.send("note", { target: target([tabs[1]]), note: "Review CR" });
    await remindIn([tabs[1]], 60000);
    await browser.fireAlarms([key(tabs[1])]);
    await waitForAlerts();
    const [[id, notification]] = state.notifications;
    assert.match(id, new RegExp(`^${key(tabs[1])}@`));
    assert.equal(notification.title, "P2: Review CR");
  });

  test("Done on a combined notification clears every reminder in it", async () => {
    await remindIn(tabs.slice(1, 4), 60000);
    await browser.fireAlarms(tabs.slice(1, 4).map(key));
    await waitForAlerts();
    const [[id]] = state.notifications;
    await events.notificationButtonClicked.dispatch(id, 1);
    await sleep(20);
    assert.deepEqual(marks(), {});
    assert.equal(state.badge, "");
  });

  test("Snooze on a combined notification snoozes every reminder in it", async () => {
    await remindIn(tabs.slice(1, 3), 60000);
    await browser.fireAlarms(tabs.slice(1, 3).map(key));
    await waitForAlerts();
    const [[id]] = state.notifications;
    await events.notificationButtonClicked.dispatch(id, 0);
    await sleep(20);
    for (const id of tabs.slice(1, 3)) {
      assert.equal(marks()[key(id)].firedAt, null);
      assert.ok(state.alarms.get(key(id)).scheduledTime > Date.now() + 9 * 60000);
    }
  });

  test("the alert closes once nothing in it is overdue", async () => {
    await remindIn(tabs.slice(1, 3), 60000);
    await browser.fireAlarms(tabs.slice(1, 3).map(key));
    await waitForAlerts();
    await chrome.tabs.update(tabs[1], { active: true });
    await sleep(20);
    assert.equal(state.notifications.size, 1, "still open: tab 2 is overdue");
    await chrome.tabs.update(tabs[2], { active: true });
    await sleep(20);
    assert.equal(state.notifications.size, 0);
  });

  test("pop-up window alerts are tracked and closed reliably", async () => {
    state.local.settings = { alertStyle: "window" };
    await remindIn([tabs[1]], 60000);
    await remindIn([tabs[2]], 120000);
    await Promise.all([
      browser.fireAlarms([key(tabs[1])]).then(waitForAlerts),
      sleep(bg.evaluate("ALERT_BATCH_MS") + 100).then(() => browser.fireAlarms([key(tabs[2])])).then(waitForAlerts),
    ]);
    const popups = () => [...state.windows.values()].filter((w) => w.type === "popup");
    assert.equal(popups().length, 2);
    await chrome.tabs.update(tabs[1], { active: true });
    await chrome.tabs.update(tabs[2], { active: true });
    await sleep(30);
    assert.equal(popups().length, 0);
    assert.deepEqual(state.session.alertWindows, {});
  });

  test("a reminder firing on the tab you are looking at is not left overdue", async () => {
    await remindIn([tabs[0]], 60000); // tabs[0] is active in the focused window
    await browser.fireAlarms([key(tabs[0])]);
    await waitForAlerts();
    assert.equal(chimes().length, 1, "still chimes");
    assert.equal(marks()[key(tabs[0])], undefined, "plain one-off reminder is done");
    assert.equal(state.badge, "");
  });

  test("focusing a window acknowledges its active tab", async () => {
    const other = browser.addWindow({ focused: true });
    await remindIn([tabs[0]], 60000);
    await bg.send("prioritize", { target: target([tabs[0]]), level: 1 });
    await browser.fireAlarms([key(tabs[0])]);
    assert.ok(marks()[key(tabs[0])].firedAt);
    browser.focusWindow(win);
    await events.windowFocusChanged.dispatch(win);
    assert.equal(marks()[key(tabs[0])].firedAt, null);
    void other;
  });
});

describe("marks lifecycle", () => {
  test("turning a reminder off on an unmarked tab creates nothing", async () => {
    await bg.send("remind", { target: target([tabs[1]]), remind: null });
    await bg.send("note", { target: target([tabs[2]]), note: "" });
    assert.deepEqual(marks(), {});
  });

  test("turning off a plain reminder removes it", async () => {
    await remindIn([tabs[1]], 60000);
    await bg.send("remind", { target: target([tabs[1]]), remind: null });
    assert.deepEqual(marks(), {});
    assert.equal(state.alarms.has(key(tabs[1])), false);
  });

  test("a prioritized tab keeps its mark when its reminder is turned off", async () => {
    await bg.send("prioritize", { target: target([tabs[1]]), level: 1 });
    await bg.send("remind", { target: target([tabs[1]]), remind: null });
    assert.equal(marks()[key(tabs[1])].level, 1);
  });

  test("a fired plain reminder disappears once seen", async () => {
    browser.focusWindow(browser.addWindow());
    await remindIn([tabs[1]], 60000);
    await browser.fireAlarms([key(tabs[1])]);
    assert.ok(marks()[key(tabs[1])].firedAt);
    browser.focusWindow(win);
    await chrome.tabs.update(tabs[1], { active: true });
    await sleep(20);
    assert.deepEqual(marks(), {});
  });

  test("browser restart clears alarms left over from the previous session", async () => {
    chrome.alarms.create(key(tabs[1]), { delayInMinutes: 5 });
    await events.startup.dispatch();
    assert.equal(state.alarms.size, 0);
  });

  test("a new mark never inherits a stale alarm with the same key", async () => {
    chrome.alarms.create(key(tabs[1]), { delayInMinutes: 5 });
    await bg.send("note", { target: target([tabs[1]]), note: "fresh" });
    assert.equal(state.alarms.has(key(tabs[1])), false);
  });

  test("an alarm whose mark is gone is cleaned up without alerting", async () => {
    chrome.alarms.create(key(tabs[1]), { delayInMinutes: 5 });
    await browser.fireAlarms([key(tabs[1])]);
    await waitForAlerts();
    assert.equal(state.alarms.has(key(tabs[1])), false);
    assert.equal(state.notifications.size, 0);
  });

  test("repeating reminders stay scheduled after firing; one-offs do not", async () => {
    browser.focusWindow(browser.addWindow());
    await bg.send("remind", { target: target([tabs[1]]), remind: { type: "every", minutes: 30 } });
    await remindIn([tabs[2]], 60000);
    await browser.fireAlarms([key(tabs[1]), key(tabs[2])]);
    assert.deepEqual(marks()[key(tabs[1])].remind, { type: "every", minutes: 30 });
    assert.equal(marks()[key(tabs[2])].remind, null);
  });
});

describe("windows, shortcuts and menus", () => {
  test("marking a tab in a non-normal window saves the mark without grouping", async () => {
    const popupWin = browser.addWindow({ type: "popup" });
    const appTab = browser.addTab({ windowId: popupWin });
    const reply = await bg.send("prioritize", { target: target([appTab]), level: 1 });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(marks()[key(appTab)].level, 1);
    assert.equal(state.tabs.get(appTab).groupId, -1);
    assert.deepEqual(state.groupAttempts, [], "doesn't try to group where Chrome can't");
  });

  test("shortcuts act on the last focused normal window, not a focused alert pop-up", async () => {
    const alertWin = browser.addWindow({ type: "popup" });
    browser.addTab({ windowId: alertWin, active: true });
    browser.focusWindow(alertWin);
    await events.command.dispatch("set-p1");
    assert.deepEqual(Object.keys(marks()), [key(tabs[0])]);
  });

  test("the context menu acts on the tab that was clicked, not the last focused window", async () => {
    const other = browser.addWindow();
    const clicked = browser.addTab({ windowId: other, active: true });
    browser.focusWindow(win);
    await events.menuClicked.dispatch({ menuItemId: "p2" }, { ...state.tabs.get(clicked) });
    assert.deepEqual(Object.keys(marks()), [key(clicked)]);
  });

  test("the context menu acts on all highlighted tabs in the clicked tab's window", async () => {
    state.tabs.get(tabs[1]).highlighted = true;
    await events.menuClicked.dispatch({ menuItemId: "p3" }, { ...state.tabs.get(tabs[0]) });
    assert.deepEqual(Object.keys(marks()).sort(), [key(tabs[0]), key(tabs[1])].sort());
  });

  test("priority groups only move ungrouped tabs or tabs in our own P groups", async () => {
    const mine = browser.addGroup({ windowId: win, title: "My research", tabIds: [tabs[3]] });
    await bg.send("prioritize", { target: target([tabs[3], tabs[4]]), level: 1 });
    assert.equal(state.tabs.get(tabs[3]).groupId, mine, "left in the user's group");
    assert.equal(state.groups.get(state.tabs.get(tabs[4]).groupId).title, "P1");
    await bg.send("prioritize", { target: target([tabs[4]]), level: 2 });
    assert.equal(state.groups.get(state.tabs.get(tabs[4]).groupId).title, "P2", "moved between our groups");
  });

  test("'Group as' with a wildcard name does not join an unrelated group", async () => {
    const existing = browser.addGroup({ windowId: win, title: "Launch", tabIds: [tabs[3]] });
    await bg.send("groupAs", { target: target([tabs[1]]), name: "Launch*" });
    const gid = state.tabs.get(tabs[1]).groupId;
    assert.notEqual(gid, existing);
    assert.equal(state.groups.get(gid).title, "Launch*");
  });

  test("Clear only ungroups tabs the extension grouped", async () => {
    const mine = browser.addGroup({ windowId: win, title: "My research", tabIds: [tabs[3]] });
    await bg.send("prioritize", { target: target([tabs[3], tabs[4]]), level: 1 });
    await bg.send("clear", { target: target([tabs[3], tabs[4]]) });
    assert.equal(state.tabs.get(tabs[3]).groupId, mine);
    assert.equal(state.tabs.get(tabs[4]).groupId, -1);
    assert.deepEqual(marks(), {});
  });
});

describe("messages", () => {
  test("unknown actions reply with a helpful error", async () => {
    const reply = await bg.send("nope");
    assert.equal(reply.ok, false);
    assert.match(reply.error, /reload the extension/);
  });

  test("messages addressed to the offscreen page are ignored", async () => {
    let replied = false;
    chrome.runtime.onMessage.dispatch({ target: "offscreen", type: "chime" }, {}, () => (replied = true));
    await sleep(10);
    assert.equal(replied, false);
  });

  test("list puts overdue first, then soonest due, then by priority", async () => {
    browser.focusWindow(browser.addWindow());
    await bg.send("prioritize", { target: target([tabs[1]]), level: 3 });
    await bg.send("prioritize", { target: target([tabs[2]]), level: 1 }); // default: every 30m
    await remindIn([tabs[3]], 5 * 60000);
    await remindIn([tabs[4]], 60000);
    await browser.fireAlarms([key(tabs[4])]);
    const { data } = await bg.send("list");
    assert.deepEqual(Array.from(data, (i) => i.key), [key(tabs[4]), key(tabs[3]), key(tabs[2]), key(tabs[1])]);
  });
});
