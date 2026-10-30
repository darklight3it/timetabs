const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./fake-chrome");

const { evaluate } = loadShared();
const fn = (name) => evaluate(name);

// Wednesday 28 Oct 2026, 14:00 local time.
const NOW = new Date(2026, 9, 28, 14, 0);
const at = (day, hours, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();
const inMinutes = (m) => NOW.getTime() + m * 60000;

describe("parseWhen", () => {
  const parseWhen = (text) => fn("parseWhen")(text, NOW);
  const cases = [
    ["45m", inMinutes(45)],
    ["in 2h", inMinutes(120)],
    ["1.5h", inMinutes(90)],
    ["2 days", inMinutes(2880)],
    ["15:30", at(28, 15, 30)],
    ["15.30", at(28, 15, 30)],
    ["3pm", at(28, 15)],
    ["12am", at(29, 0)],
    ["12pm", at(29, 12)], // noon already passed → tomorrow
    ["9", at(29, 9)], // already passed today → tomorrow
    ["tomorrow 10", at(29, 10)],
    ["tmrw", at(29, 9)],
    ["fri 9", at(30, 9)],
    ["friday at 3pm", at(30, 15)],
    ["wed 18", at(28, 18)], // later today
    ["wed 9", at(4 + 31, 9)], // passed today → next Wednesday (4 Nov)
    ["today 10", at(28, 10)], // explicit today stays today, even if past
    ["at 16", at(28, 16)],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}"`, () => assert.equal(parseWhen(input), expected));
  }

  for (const input of ["", "banana", "25:00", "13pm", "0am", "10:75", "tom", "tod", "monitor"]) {
    test(`rejects "${input}"`, () => assert.equal(parseWhen(input), null));
  }
});

describe("parseCommand", () => {
  const parse = (text) => JSON.parse(JSON.stringify(fn("parseCommand")(text, NOW)));
  const once = (when) => ({ type: "at", when });

  test("priority, time and note together", () => {
    assert.deepEqual(parse("1 30m review CR"), { level: 1, remind: once(inMinutes(30)), note: "review CR" });
  });
  test("priority with a day and hour", () => {
    assert.deepEqual(parse("p2 fri 9"), { level: 2, remind: once(at(30, 9)) });
  });
  test("time before priority", () => {
    assert.deepEqual(parse("fri at 3pm 2 deploy"), { level: 2, remind: once(at(30, 15)), note: "deploy" });
  });
  test("priority alone", () => assert.deepEqual(parse("3"), { level: 3 }));
  test("time alone", () => assert.deepEqual(parse("15:30"), { remind: once(at(28, 15, 30)) }));

  // Bare numbers are not clock times: they are far more often part of a note.
  test("a bare number after the priority stays in the note", () => {
    assert.deepEqual(parse("1 2 reviewers needed"), { level: 1, note: "2 reviewers needed" });
  });
  test("a second bare number is not a time", () => assert.deepEqual(parse("1 1"), { level: 1, note: "1" }));
  test("a bare number that is not a priority is a note", () => assert.deepEqual(parse("4"), { note: "4" }));
  test("'at' makes a bare number a time", () => assert.deepEqual(parse("at 16 standup"), { remind: once(at(28, 16)), note: "standup" }));

  test("every with a unit", () => assert.deepEqual(parse("every 1h"), { remind: { type: "every", minutes: 60 } }));
  test("every with a spaced unit and a note", () => {
    assert.deepEqual(parse("every 30 min check pipeline"), { remind: { type: "every", minutes: 30 }, note: "check pipeline" });
  });
  test("every with a bare number means minutes", () => assert.deepEqual(parse("every 10"), { remind: { type: "every", minutes: 10 } }));
  test("every with a bare number keeps the following note", () => {
    assert.deepEqual(parse("every 10 check"), { remind: { type: "every", minutes: 10 }, note: "check" });
  });

  test("'tom' is a name, not tomorrow", () => assert.deepEqual(parse("1 tom review"), { level: 1, note: "tom review" }));
  test("words after the note starts are not parsed", () => assert.deepEqual(parse("review CR at 3pm"), { note: "review CR at 3pm" }));
  test("invalid times fall through to the note", () => assert.deepEqual(parse("13pm lunch"), { note: "13pm lunch" }));
  test("quotes around a note are dropped", () => assert.deepEqual(parse('2 "call Bob"'), { level: 2, note: "call Bob" }));

  for (const [input, expected] of [
    ["done", { action: "clear" }],
    ["x", { action: "clear" }],
    ["clear", { action: "clear" }],
    ["off", { action: "off" }],
    ["next", { action: "next" }],
    ["snooze", { action: "snooze" }],
    ["snooze 15m", { action: "snooze", minutes: 15 }],
    ["s 1h", { action: "snooze", minutes: 60 }],
  ]) {
    test(`action "${input}"`, () => assert.deepEqual(parse(input), expected));
  }
  test("an action word followed by text is a note", () => assert.deepEqual(parse("snooze the CR"), { note: "snooze the CR" }));
  test("empty input", () => assert.equal(fn("parseCommand")("   ", NOW), null));
});

describe("describeCommand", () => {
  const describe_ = (text) => fn("describeCommand")(fn("parseCommand")(text, NOW), NOW.getTime());
  // Clock text follows the browser locale ("14:30" or "02:30 PM"), so build expectations the same way.
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const weekday = (ts) => new Date(ts).toLocaleDateString([], { weekday: "short" });
  test("summarises priority, time and note", () => {
    assert.equal(describe_("1 30m review CR"), `P1 · remind ${clock(inMinutes(30))} (in 30m) · note “review CR”`);
  });
  test("drops the countdown beyond a day", () => {
    assert.equal(describe_("p2 fri 9"), `P2 · remind ${weekday(at(30, 9))} ${clock(at(30, 9))}`);
  });
  test("flags a time that has passed", () => assert.equal(describe_("today 10"), `${clock(at(28, 10))} has passed`));
  test("repeating", () => assert.equal(describe_("every 90m"), "remind every 1h 30m"));
  test("snooze default", () => assert.equal(describe_("snooze"), "Snooze 10m"));
});

describe("formatDuration", () => {
  const cases = [[30, "30m"], [0.2, "1m"], [60, "1h"], [90, "1h 30m"], [25 * 60, "1d 1h"], [47 * 60, "1d 23h"], [48 * 60, "2d"], [8 * 1440 + 60, "8d"]];
  for (const [minutes, expected] of cases) {
    test(`${minutes} minutes → ${expected}`, () => assert.equal(fn("formatDuration")(minutes * 60000), expected));
  }
});

describe("describeTiming", () => {
  const describeTiming = (item) => JSON.parse(JSON.stringify(fn("describeTiming")(item, NOW.getTime())));
  test("overdue", () => assert.deepEqual(describeTiming({ firedAt: inMinutes(-5) }), { text: "5m late", tone: "late" }));
  test("repeating and due soon", () => {
    assert.deepEqual(describeTiming({ due: inMinutes(12), remind: { type: "every", minutes: 30 } }), { text: "in 12m · every 30m", tone: "due" });
  });
  test("no reminder", () => assert.deepEqual(describeTiming({}), { text: "no reminder", tone: "none" }));
});

describe("reminderTitle", () => {
  const title = (item) => fn("reminderTitle")(item);
  test("priority with note", () => assert.equal(title({ level: 1, note: "Review CR", label: "CR-1" }), "P1: Review CR"));
  test("priority without note", () => assert.equal(title({ level: 2, note: "", label: "CR-1" }), "P2: CR-1"));
  test("plain reminder", () => assert.equal(title({ level: 0, note: "", label: "CR-1" }), "⏰ CR-1"));
});

describe("alert keys", () => {
  test("a batch key expands to its marks", () => {
    assert.deepEqual([...fn("expandKey")("batch:tab-1,group-2")], ["tab-1", "group-2"]);
  });
  test("a single key expands to itself", () => assert.deepEqual([...fn("expandKey")("tab-1")], ["tab-1"]));
  test("keyOf builds mark keys", () => assert.equal(fn("keyOf")("tab", 5), "tab-5"));
});
