// Plays reminder chimes for the service worker, which cannot play audio itself.
// Synthesized with Web Audio: no sound files, and each priority sounds different.

const PATTERNS = {
  0: [1047, 784],       // C6 G5 — a gentle "ding-dong" for plain reminders
  1: [880, 1109, 1319], // A5 C#6 E6 — rising, most insistent
  2: [784, 988],        // G5 B5
  3: [659],             // E5 — a single soft note
};
const NOTE_GAP = 0.16;
const NOTE_LENGTH = 0.7;

let context;

function chime(level, volume) {
  context ??= new AudioContext();
  (PATTERNS[level] ?? PATTERNS[3]).forEach((frequency, i) => {
    const start = context.currentTime + i * NOTE_GAP;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_LENGTH);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + NOTE_LENGTH);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === "offscreen" && msg.type === "chime") chime(msg.level, msg.volume);
});
