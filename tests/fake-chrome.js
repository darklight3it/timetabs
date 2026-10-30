// In-memory stand-in for the Chrome extension APIs that background.js uses.
//
// Two properties matter for finding real bugs:
//  - storage calls resolve after a small random delay, like Chrome's IPC-backed storage;
//  - events call every listener without awaiting it, the way Chrome dispatches them.
// Together they expose read-modify-write races that a synchronous fake would hide.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");

function createEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    hasListeners: () => listeners.length > 0,
    // Returns the listeners' promises so tests can wait for them to settle.
    dispatch: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
  };
}

// Chrome's tabGroups.query treats `title` as a pattern where * matches anything.
const matchesPattern = (pattern, value) =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);

function createChrome({ jitterMs = 3 } = {}) {
  const delay = () => new Promise((resolve) => setTimeout(resolve, Math.random() * jitterMs));
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  const state = {
    session: {},
    local: {},
    alarms: new Map(),
    tabs: new Map(),
    groups: new Map(),
    windows: new Map(),
    notifications: new Map(),
    badge: "",
    messages: [],
    menus: [],
    offscreen: false,
    groupAttempts: [],
    lastFocusedWindowId: null,
    nextId: 1000,
  };

  const events = {
    storageChanged: createEvent(),
    alarm: createEvent(),
    tabActivated: createEvent(),
    tabRemoved: createEvent(),
    groupRemoved: createEvent(),
    windowRemoved: createEvent(),
    windowFocusChanged: createEvent(),
    notificationClicked: createEvent(),
    notificationButtonClicked: createEvent(),
    command: createEvent(),
    menuClicked: createEvent(),
    message: createEvent(),
    installed: createEvent(),
    startup: createEvent(),
  };

  const storageArea = (name) => ({
    async get(keys) {
      await delay();
      const store = state[name];
      const wanted = keys == null ? Object.keys(store) : [].concat(keys);
      return clone(Object.fromEntries(wanted.filter((k) => k in store).map((k) => [k, store[k]])));
    },
    async set(items) {
      await delay();
      Object.assign(state[name], clone(items));
      events.storageChanged.dispatch(Object.fromEntries(Object.keys(items).map((k) => [k, { newValue: items[k] }])), name);
    },
    async remove(keys) {
      await delay();
      for (const k of [].concat(keys)) delete state[name][k];
    },
  });

  const tabOrThrow = (id) => {
    const tab = state.tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  };

  const removeEmptyGroups = () => {
    for (const [id, group] of state.groups) {
      if (![...state.tabs.values()].some((t) => t.groupId === id)) {
        state.groups.delete(id);
        events.groupRemoved.dispatch(clone(group));
      }
    }
  };

  const chrome = {
    storage: { session: storageArea("session"), local: storageArea("local"), onChanged: events.storageChanged },

    tabs: {
      async get(id) {
        await delay();
        return clone(tabOrThrow(id));
      },
      async query(q = {}) {
        await delay();
        return clone([...state.tabs.values()].filter((t) =>
          (q.highlighted === undefined || t.highlighted === q.highlighted) &&
          (q.active === undefined || t.active === q.active) &&
          (q.windowId === undefined || t.windowId === q.windowId) &&
          (q.groupId === undefined || t.groupId === q.groupId) &&
          // In a service worker "current window" means the last focused one, of any type.
          (!q.currentWindow || t.windowId === state.lastFocusedWindowId)));
      },
      async group({ tabIds, groupId, createProperties }) {
        await delay();
        const ids = [].concat(tabIds);
        state.groupAttempts.push(ids);
        for (const id of ids) {
          if (state.windows.get(tabOrThrow(id).windowId)?.type !== "normal") {
            throw new Error("Tabs can only be moved to and from normal windows.");
          }
        }
        let gid = groupId;
        if (gid === undefined) {
          gid = state.nextId++;
          state.groups.set(gid, { id: gid, windowId: createProperties?.windowId ?? tabOrThrow(ids[0]).windowId, title: "", color: "grey", collapsed: false });
        }
        for (const id of ids) tabOrThrow(id).groupId = gid;
        removeEmptyGroups();
        return gid;
      },
      async ungroup(tabIds) {
        await delay();
        for (const id of [].concat(tabIds)) tabOrThrow(id).groupId = -1;
        removeEmptyGroups();
      },
      async update(id, props) {
        await delay();
        const tab = tabOrThrow(id);
        if (props.active) {
          for (const t of state.tabs.values()) if (t.windowId === tab.windowId) t.active = false;
          tab.active = true;
          events.tabActivated.dispatch({ tabId: id, windowId: tab.windowId });
        }
        return clone(tab);
      },
      async create({ url }) {
        return { id: state.nextId++, url };
      },
      onActivated: events.tabActivated,
      onRemoved: events.tabRemoved,
    },

    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async get(id) {
        await delay();
        const group = state.groups.get(id);
        if (!group) throw new Error(`No group with id: ${id}.`);
        return clone(group);
      },
      async query(q = {}) {
        await delay();
        return clone([...state.groups.values()].filter((g) =>
          (q.windowId === undefined || g.windowId === q.windowId) &&
          (q.title === undefined || matchesPattern(q.title, g.title))));
      },
      async update(id, props) {
        await delay();
        Object.assign(state.groups.get(id), props);
        return clone(state.groups.get(id));
      },
      onRemoved: events.groupRemoved,
    },

    windows: {
      WINDOW_ID_NONE: -1,
      async get(id) {
        await delay();
        const win = state.windows.get(id);
        if (!win) throw new Error(`No window with id: ${id}.`);
        return clone(win);
      },
      async getLastFocused({ windowTypes } = {}) {
        await delay();
        const candidates = [...state.windows.values()].filter((w) => !windowTypes || windowTypes.includes(w.type));
        return clone(candidates.find((w) => w.id === state.lastFocusedWindowId) ?? candidates.at(-1));
      },
      async update(id, props) {
        await delay();
        if (props.focused) state.lastFocusedWindowId = id;
        for (const w of state.windows.values()) w.focused = w.id === state.lastFocusedWindowId;
        return clone(state.windows.get(id));
      },
      async create({ url, type }) {
        await delay();
        const id = state.nextId++;
        state.windows.set(id, { id, type, url, focused: false });
        return clone(state.windows.get(id));
      },
      async remove(id) {
        await delay();
        if (!state.windows.delete(id)) throw new Error(`No window with id: ${id}.`);
        events.windowRemoved.dispatch(id);
      },
      onRemoved: events.windowRemoved,
      onFocusChanged: events.windowFocusChanged,
    },

    alarms: {
      create(name, info) {
        const scheduledTime = info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60000;
        state.alarms.set(name, { name, scheduledTime, periodInMinutes: info.periodInMinutes });
      },
      async clear(name) {
        return state.alarms.delete(name);
      },
      async clearAll() {
        const had = state.alarms.size > 0;
        state.alarms.clear();
        return had;
      },
      async get(name) {
        return clone(state.alarms.get(name));
      },
      async getAll() {
        return clone([...state.alarms.values()]);
      },
      onAlarm: events.alarm,
    },

    notifications: {
      async create(id, options) {
        await delay();
        state.notifications.set(id, clone(options));
        return id;
      },
      async clear(id) {
        return state.notifications.delete(id);
      },
      async getAll() {
        return Object.fromEntries([...state.notifications.keys()].map((id) => [id, true]));
      },
      onClicked: events.notificationClicked,
      onButtonClicked: events.notificationButtonClicked,
    },

    action: {
      async setBadgeText({ text }) {
        state.badge = text;
      },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
      async openPopup() {},
    },

    runtime: {
      lastError: undefined,
      getURL: (p) => `chrome-extension://test/${p}`,
      async getContexts() {
        return state.offscreen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
      },
      async sendMessage(msg) {
        state.messages.push(clone(msg));
      },
      onMessage: events.message,
      onInstalled: events.installed,
      onStartup: events.startup,
    },

    offscreen: {
      async createDocument() {
        await delay();
        state.offscreen = true;
      },
    },

    contextMenus: {
      async removeAll() {
        state.menus = [];
      },
      create(item) {
        state.menus.push(item);
      },
      onClicked: events.menuClicked,
    },

    commands: { onCommand: events.command },
  };

  // ─── Helpers for building a browser ─────────────────────────────────────────

  const browser = {
    addWindow({ type = "normal", focused = false } = {}) {
      const id = state.nextId++;
      state.windows.set(id, { id, type, focused });
      if (focused) chrome.windows.update(id, { focused: true });
      return id;
    },
    addTab({ windowId, title = "Tab", active = false, highlighted = active, groupId = -1 } = {}) {
      const id = state.nextId++;
      state.tabs.set(id, { id, windowId, title, url: `https://example.com/${id}`, active, highlighted, groupId });
      return id;
    },
    addGroup({ windowId, title, tabIds }) {
      const id = state.nextId++;
      state.groups.set(id, { id, windowId, title, color: "grey", collapsed: false });
      for (const t of tabIds) state.tabs.get(t).groupId = id;
      return id;
    },
    focusWindow(id) {
      state.lastFocusedWindowId = id;
      for (const w of state.windows.values()) w.focused = w.id === id;
    },
    // Closing a window fires tabs.onRemoved for every tab at once, like Chrome.
    closeTabs(ids) {
      for (const id of ids) state.tabs.delete(id);
      removeEmptyGroups();
      return Promise.all(ids.map((id) => events.tabRemoved.dispatch(id, { isWindowClosing: true })));
    },
    fireAlarms(names) {
      return Promise.all(names.map((name) => events.alarm.dispatch(clone(state.alarms.get(name)) ?? { name })));
    },
  };

  return { chrome, state, events, browser };
}

// Loads background.js (and the scripts it imports) into an isolated context.
// Top-level functions become properties of the returned context; `evaluate` reads
// top-level consts and lets tests call into the worker.
function loadBackground(chrome) {
  const context = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    structuredClone,
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(SRC, file), "utf8"), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(SRC, "background.js"), "utf8"), context, { filename: "background.js" });
  const evaluate = (expr) => vm.runInContext(expr, context);

  // Sends a message the way the popup does and resolves with the handler's reply.
  const send = (type, payload = {}) => new Promise((resolve) => {
    chrome.runtime.onMessage.dispatch({ type, ...payload }, {}, resolve);
  });
  return { context, evaluate, send };
}

// Loads only shared.js, for testing its pure helpers.
function loadShared(globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(fs.readFileSync(path.join(SRC, "shared.js"), "utf8"), context, { filename: "shared.js" });
  return { context, evaluate: (expr) => vm.runInContext(expr, context) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { createChrome, loadBackground, loadShared, sleep };
