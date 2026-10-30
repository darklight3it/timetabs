const $ = (sel) => document.querySelector(sel);

function report(text) {
  $("#result").textContent = text;
  $("#result").className = "success";
}

async function setAlertStyle(alertStyle) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, alertStyle } });
}

$("#test").onclick = async () => {
  await setAlertStyle("notification");
  await send("test");
  report("Sent. No banner? Check System Settings → Notifications → Google Chrome, or use the pop-up window.");
};

$("#use-window").onclick = async () => {
  await setAlertStyle("window");
  await send("test");
  report("Reminders will now open a small window. You can change this under More options in the popup.");
};

$("#shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
