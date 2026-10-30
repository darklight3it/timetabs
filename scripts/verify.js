#!/usr/bin/env node
// Checks that every file the extension refers to exists: manifest entries, <script>/<link>/<img>
// in pages, and chrome.runtime.getURL / importScripts / offscreen URLs in code.
// Run: npm run verify

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const problems = [];

function check(fromFile, ref, base) {
  const clean = ref.split(/[?#]/)[0];
  if (!clean || /^(https?:|chrome:|data:|#)/.test(ref)) return;
  const target = path.resolve(clean.startsWith("/") ? SRC : base, clean.replace(/^\//, ""));
  if (!fs.existsSync(target)) problems.push(`${path.relative(SRC, fromFile)}: missing ${ref}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

const manifestFile = path.join(SRC, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const manifestRefs = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const ref of manifestRefs) check(manifestFile, ref, SRC);

for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".html")) {
    for (const [, ref] of text.matchAll(/(?:src|href)="([^"]+)"/g)) check(file, ref, path.dirname(file));
  } else if (file.endsWith(".js")) {
    // Extension URLs in code resolve from the extension root, not the script's folder.
    const patterns = [/getURL\(\s*[`"']([^`"'$]+)/g, /importScripts\(\s*"([^"]+)"/g, /createDocument\(\{\s*url:\s*"([^"]+)"/g];
    for (const pattern of patterns) for (const [, ref] of text.matchAll(pattern)) check(file, ref, SRC);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
if (pkg.version !== manifest.version) problems.push(`package.json v${pkg.version} ≠ manifest.json v${manifest.version}`);

const suggested = Object.values(manifest.commands ?? {}).filter((c) => c.suggested_key).length;
if (suggested > 4) problems.push(`manifest.json: ${suggested} suggested shortcuts; Chrome allows 4`);
if ((manifest.description ?? "").length > 132) problems.push("manifest.json: description over 132 characters");

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok — manifest v${manifest.version}, all references resolve`);
