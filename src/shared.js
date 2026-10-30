// Helpers shared by the service worker (via importScripts), popup, alert window and welcome page.

const MINUTE = 60000;
const SNOOZE_MINUTES = 10;
const DEFAULT_SETTINGS = { alertStyle: "notification", groupByPriority: true, sound: "normal" };

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? "No response from the extension — try reloading it.");
  return res.data;
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get("settings")).settings };
}

// ─── Keys ─────────────────────────────────────────────────────────────────────
// A mark is keyed "tab-<id>" or "group-<id>". An alert covering several marks that
// fired together is keyed "batch:<key>,<key>,…".

const keyOf = (kind, id) => `${kind}-${id}`;

function parseKey(key) {
  const [kind, id] = key.split("-");
  return { kind, id: Number(id) };
}

const expandKey = (alertKey) => (alertKey.startsWith("batch:") ? alertKey.slice("batch:".length).split(",") : [alertKey]);

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours && days < 7 ? `${days}d ${restHours}h` : `${days}d`;
}

// "15:30" today, "Fri 15:30" within a week, "Nov 12 15:30" beyond.
function formatClock(ts, now = Date.now()) {
  const date = new Date(ts);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  const day = ts - now < 6 * 24 * 60 * MINUTE
    ? date.toLocaleDateString([], { weekday: "short" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day} ${time}`;
}

// tone: "late" | "due" | "none"
function describeTiming(item, now = Date.now()) {
  if (item.firedAt) return { text: `${formatDuration(now - item.firedAt)} late`, tone: "late" };
  if (item.due) {
    const until = item.due - now;
    const when = until < 12 * 60 * MINUTE ? `in ${formatDuration(until)}` : formatClock(item.due, now);
    const repeat = item.remind?.type === "every" ? ` · every ${item.remind.minutes}m` : "";
    return { text: when + repeat, tone: "due" };
  }
  return { text: "no reminder", tone: "none" };
}

// "P1".."P3", or an alarm clock for plain reminders without a priority.
const levelLabel = (level) => (level ? `P${level}` : "⏰");

// Title for a notification or alert window: "P1: Review CR" or "⏰ Review CR".
function reminderTitle({ level, note, label }) {
  const text = note || label;
  return level ? `P${level}: ${text}` : `⏰ ${text}`;
}

function itemTitle(item) {
  const label = item.kind === "group" ? `${item.label} (${item.count} tabs)` : item.label;
  return item.note ? `${item.note} — ${label}` : label;
}

// ─── Parsing times ────────────────────────────────────────────────────────────
// Parses what people type: "45m", "2h", "15:30", "3pm", "tomorrow 10", "fri 9", "today 18:00".
// A bare time that has already passed means tomorrow; a bare day means 9:00.
// Day words must be exact so notes like "monitor CR" are never read as Monday, and
// short forms that are also names ("tom", "tod") are left out.
const DAY_WORDS = {
  today: "today",
  tomorrow: "tomorrow", tmrw: "tomorrow", tmr: "tomorrow",
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

function parseDuration(text) {
  const match = text.match(/^(?:in )?(\d+(?:\.\d+)?) ?(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/);
  if (!match) return null;
  return parseFloat(match[1]) * { m: 1, h: 60, d: 1440 }[match[2][0]];
}

function parseWhen(input, now = new Date()) {
  const text = input.trim().toLowerCase().replace(/\bat\b/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const minutesFromNow = parseDuration(text);
  if (minutesFromNow) return now.getTime() + minutesFromNow * MINUTE;

  const match = text.match(/^(?:([a-z]+) ?)?(?:(\d{1,2})(?:[:.](\d{2}))? ?(am|pm)?)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const [, word, h, m, meridiem] = match;
  const day = word ? DAY_WORDS[word] : "auto";
  if (day === undefined) return null;

  let hours = h ? Number(h) : 9;
  const minutes = m ? Number(m) : 0;
  if (meridiem && (hours < 1 || hours > 12)) return null;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  const date = new Date(now);
  if (day === "tomorrow") date.setDate(date.getDate() + 1);
  if (typeof day === "number") date.setDate(date.getDate() + ((day - date.getDay() + 7) % 7));
  date.setHours(hours, minutes, 0, 0);

  if (date <= now && day === "auto") date.setDate(date.getDate() + 1);
  if (date <= now && typeof day === "number") date.setDate(date.getDate() + 7);
  return date.getTime();
}

// ─── Command bar ──────────────────────────────────────────────────────────────
// Tokens are read left to right; the first word that is not a priority, time or
// "every …" starts the note, which runs to the end.
//   "1 30m review CR"   → P1, remind in 30m, note "review CR"
//   "p2 fri 9"          → P2, remind Friday 9:00
//   "every 1h"          → repeating reminder ("every 10" means minutes)
//   "done" "clear" "x" "off" "next" "snooze [15m]"
// A bare number ("2 reviewers") is never a clock time unless preceded by "at".
const ACTIONS = { done: "clear", clear: "clear", x: "clear", off: "off", stop: "off", next: "next", n: "next", snooze: "snooze", s: "snooze" };
const BARE_NUMBER = /^\d+(\.\d+)?$/;
const UNIT = /^(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;

// Minutes and token count for "every <n> <unit>", "every <n><unit>" or "every <n>".
function parseEvery(tokens, i) {
  const [amount, unit] = [tokens[i + 1] ?? "", tokens[i + 2] ?? ""];
  if (BARE_NUMBER.test(amount) && UNIT.test(unit)) return { minutes: parseDuration(`${amount} ${unit}`.toLowerCase()), used: 3 };
  const minutes = parseDuration(amount.toLowerCase()) ?? (BARE_NUMBER.test(amount) ? Number(amount) : null);
  return minutes ? { minutes, used: 2 } : null;
}

// Longest run of tokens (up to 4) starting at i that reads as a time.
function parseTimeSpan(tokens, i, now) {
  for (const n of [4, 3, 2, 1]) {
    if (i + n > tokens.length) continue;
    const text = tokens.slice(i, i + n).join(" ");
    if (BARE_NUMBER.test(text)) continue;
    const when = parseWhen(text, now);
    if (when) return { when, used: n };
  }
  return null;
}

function parseCommand(input, now = new Date()) {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const action = ACTIONS[tokens[0].toLowerCase()];
  if (action) {
    const minutes = action === "snooze" && tokens.length > 1 ? parseDuration(tokens.slice(1).join(" ").toLowerCase()) : null;
    if (tokens.length === 1) return { action };
    if (minutes) return { action, minutes };
  }

  const command = {};
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i].toLowerCase();
    const priority = token.match(/^p?([1-3])$/);
    if (priority && !command.level) {
      command.level = Number(priority[1]);
      i += 1;
      continue;
    }
    if (command.remind === undefined) {
      const every = token === "every" ? parseEvery(tokens, i) : null;
      if (every) {
        command.remind = { type: "every", minutes: Math.max(1, Math.round(every.minutes)) };
        i += every.used;
        continue;
      }
      const span = parseTimeSpan(tokens, i, now);
      if (span) {
        command.remind = { type: "at", when: span.when };
        i += span.used;
        continue;
      }
    }
    break;
  }
  const note = tokens.slice(i).join(" ").replace(/^["“]|["”]$/g, "");
  if (note) command.note = note;
  return command;
}

// Human summary of a parsed command, for the live preview.
function describeCommand(command, now = Date.now()) {
  if (!command) return null;
  const labels = { clear: "Clear (done)", off: "Turn reminder off", next: "Jump to the most urgent tab" };
  if (command.action === "snooze") return `Snooze ${formatDuration((command.minutes ?? SNOOZE_MINUTES) * MINUTE)}`;
  if (command.action) return labels[command.action];
  const parts = [];
  if (command.level) parts.push(`P${command.level}`);
  if (command.remind?.type === "every") parts.push(`remind every ${formatDuration(command.remind.minutes * MINUTE)}`);
  if (command.remind?.type === "at") {
    const { when } = command.remind;
    const until = when - now;
    const countdown = until < 24 * 60 * MINUTE ? ` (in ${formatDuration(until)})` : "";
    parts.push(until <= 0 ? `${formatClock(when, now)} has passed` : `remind ${formatClock(when, now)}${countdown}`);
  }
  if (command.note) parts.push(`note “${command.note}”`);
  return parts.join(" · ");
}

function tomorrowAt9(now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

// datetime-local wants local time without seconds or zone.
function toLocalInput(ts) {
  return new Date(ts - new Date(ts).getTimezoneOffset() * MINUTE).toISOString().slice(0, 16);
}
