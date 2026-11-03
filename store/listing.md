# Chrome Web Store listing

Copy-paste source for the Developer Dashboard. Images in this folder are built by `scripts/store-assets.sh`.

## Store listing

**Name:** Timetabs

**Summary** (from `src/manifest.json`, max 132 characters):
Reminders for time-blind brains. Mark the tabs that matter and get nudged back before you forget them.

**Category:** Productivity → Tools

**Language:** English

**Description:**

```
Reminders for time-blind brains. Mark the tabs that matter and get nudged back before you forget them.

Built for neurodivergent brains — the ones that keep twenty tabs open and lose track of the one that mattered. One shortcut and a few typed words do everything, reminders keep coming until you deal with them, and the toolbar icon tells you when something is overdue.

• Command bar (Alt+Shift+P): type "1 30m review CR", "fri 9", "every 1h", "done" or "snooze 15m".
• Priorities: mark tabs P1, P2 or P3, optionally collected into colored tab groups that never touch your own groups.
• Reminders: one-off or repeating, on a tab, several tabs, or a named group of tabs.
• Overdue badge: a red count on the toolbar icon shows reminders you haven't acted on.
• Now list: overdue, up next and unscheduled tabs, with one-click snooze and done.
• Alerts that reach you: system notifications or a small pop-up window, with a chime that gets more insistent for higher priorities.
• Shortcuts: Alt+Shift+N jumps to the most urgent tab, Alt+Shift+S snoozes everything overdue.

Private by design: everything stays in your browser. No accounts, no network requests, no analytics.
```

**Graphics:**
- Store icon: `src/icons/icon-128.png`
- Screenshots: `store/screenshot-popup-640x400.png`, `store/screenshot-alert-640x400.png`
- Small promo tile: `store/promo-small-440x280.png`

## Privacy practices

**Single purpose:**
Lets you mark browser tabs with a priority and a reminder time, and brings you back to those tabs when the reminder is due.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabs` | Reads tab titles and URLs to show marked tabs in the popup and in reminders, and focuses a tab when you open a reminder. |
| `tabGroups` | Creates and colors the optional P1/P2/P3 tab groups and named reminder groups. |
| `storage` | Saves your marks (session storage, cleared on restart) and settings (local storage). |
| `alarms` | Schedules reminders so they fire on time while the background worker is asleep. |
| `notifications` | Shows a system notification when a reminder is due. |
| `contextMenus` | Adds the Timetabs right-click menu on pages and the toolbar icon. |
| `offscreen` | Plays the reminder chime; background service workers can't play audio. |

**Remote code:** No, I am not using remote code.

**Data usage:** collects none of the listed data types. Certify all three disclosures (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://github.com/darklight3it/timetabs/blob/main/PRIVACY.md
