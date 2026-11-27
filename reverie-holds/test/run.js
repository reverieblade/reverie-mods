"use strict";

// Offline test of Reverie's Holds and Bays against a clean EveJS:
//
//   node mods/reverie-holds/test/run.js "<EveJS root>"      (or REVERIE_TEST_EVEJS)
//
// Builds a throwaway install in the temp folder from that EveJS (its server/src copied, its
// node_modules linked, nothing of it changed), copies the core and this mod into it, enables the
// mod with the core's own CLI so the file edit goes in the way a player's would, runs the probe
// (probe.js, type layer off) and the pilot's way through the bays (workflow.js, type layer on
// from boot), then disables the mod and checks that the game files are byte for byte what they
// were.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MOD = path.resolve(__dirname, "..");
const CORE = path.resolve(MOD, "..", "reverie-core");
// Reverie's Salvage and Reclamation, when it sits beside this mod, joins for partners.js.
const SALVAGE = path.resolve(MOD, "..", "reverie-salvage");
const withSalvage = fs.existsSync(path.join(SALVAGE, "reverie.json"));
const source = path.resolve(process.argv[2] || process.env.REVERIE_TEST_EVEJS || "");
if (!process.argv[2] && !process.env.REVERIE_TEST_EVEJS) {
  console.error("Name a clean EveJS root: node mods/reverie-holds/test/run.js \"D:/path/to/EveJS\"");
  process.exit(2);
}
if (!fs.existsSync(path.join(source, "server", "src"))) {
  console.error(`${source} has no server/src`);
  process.exit(2);
}
if (fs.existsSync(path.join(source, "server", "src", "services", "inventory", "bayOverflow.js"))) {
  console.error(`${source} already has bay extensions in its own files; give a clean EveJS`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverie-holds-test-"));
const EDITED = ["server/src/services/agent/agentMissionRuntime.js"];

function step(text) { console.log(`--    ${text}`); }

step(`building a test install in ${root}`);
fs.cpSync(path.join(source, "server", "src"), path.join(root, "server", "src"), { recursive: true });
for (const file of ["package.json", "index.js", "bootstrap.js"]) {
  if (fs.existsSync(path.join(source, "server", file))) fs.copyFileSync(path.join(source, "server", file), path.join(root, "server", file));
}
for (const dir of ["server/node_modules", "node_modules"]) {
  const from = path.join(source, ...dir.split("/"));
  if (fs.existsSync(from)) fs.symlinkSync(fs.realpathSync(from), path.join(root, ...dir.split("/")), "junction");
}
if (fs.existsSync(path.join(source, "package.json"))) fs.copyFileSync(path.join(source, "package.json"), path.join(root, "package.json"));
// The static tables the tests read (copies, so nothing can write to the source's store).
for (const table of ["itemTypes", "typeDogma", "shipTypes", "skillTypes", "industryBlueprints", "reprocessingStatic", "stations"]) {
  const from = path.join(source, "_local", "gameStore", "data", table);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(root, "_local", "gameStore", "data", table), { recursive: true });
}
fs.cpSync(CORE, path.join(root, "mods", "reverie-core"), { recursive: true, filter: (src) => src !== path.join(CORE, "test") });
fs.cpSync(MOD, path.join(root, "mods", "reverie-holds"), { recursive: true, filter: (src) => path.basename(src) !== "preferences.json" });
if (withSalvage) {
  fs.cpSync(SALVAGE, path.join(root, "mods", "reverie-salvage"), { recursive: true,
    filter: (src) => path.basename(src) !== "preferences.json" && src !== path.join(SALVAGE, "test") });
}
for (const id of ["reverie-core", "reverie-holds", "reverie-salvage"]) {
  const enabled = path.join(root, "mods", id, "loader.js");
  if (fs.existsSync(enabled)) fs.renameSync(enabled, `${enabled}.disabled`);
}
{
  const seeded = spawnSync(process.execPath, [path.join(MOD, "test", "seedStore.js"), path.join(root, "server", "src"),
    path.join(root, "_local", "gameStore", "gamestore.sqlite")], { cwd: path.join(root, "server"), encoding: "utf8" });
  if (seeded.status !== 0) console.log(`--    no empty game store: ${seeded.stderr.split("\n").slice(0, 3).join(" ")}`);
}
const originals = new Map(EDITED.map((rel) => [rel, fs.readFileSync(path.join(root, ...rel.split("/")))]));

const env = { ...process.env };
delete env.REVERIE_REPO_ROOT; delete env.REVERIE_SERVER_ROOT; delete env.REVERIE_LOCAL_DIR;
const cli = (...args) => spawnSync(process.execPath, [path.join(root, "mods", "reverie-core", "cli.js"), ...args], { cwd: root, env, encoding: "utf8" });

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok    ${name}`); } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}

function runInGame(script, extraEnv = {}) {
  const out = spawnSync(process.execPath, ["-r", path.join(root, "mods", "reverie-core", "loader.js"), path.join(root, "mods", "reverie-holds", "test", script)], {
    cwd: path.join(root, "server"),
    // The store is the throwaway one above, so the script may own it. A short store lease: the
    // script exits without releasing it, and the next one waits it out.
    env: { ...env, REVERIE_ROLE: "game", REVERIE_STANDALONE: "1", REVERIE_RELOAD_POLL_MS: "600000", EVEJS_GAMESTORE_OWNER_ROLE: "maintenance",
      EVEJS_PERSISTENCE_OWNER_LEASE_MS: "3000", ...extraEnv },
    encoding: "utf8",
    timeout: 240000,
  });
  const shown = process.env.REVERIE_TEST_VERBOSE === "1"
    ? out.stdout.split("\n")
    : out.stdout.split("\n").filter((line) => /^(ok|FAIL|--) /.test(line) || /^ {6}\S/.test(line) && !/^ {6}at /.test(line));
  process.stdout.write(shown.map((line) => `   ${line}`).join("\n") + "\n");
  assert.strictEqual(out.status, 0, `${script} exited ${out.status}${out.stderr ? `\n${out.stderr.slice(-2000)}` : ""}`);
}

check("enabling the core puts its hook points in", () => {
  const out = cli("enable", "reverie-core");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
});

check("enable puts the file edit in and turns the mod on", () => {
  const out = cli("enable", "reverie-holds");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /changed one game file/);
  assert.match(out.stdout, /0 errors/);
  for (const rel of EDITED) {
    const after = fs.readFileSync(path.join(root, ...rel.split("/")));
    assert.notDeepStrictEqual(after, originals.get(rel), `${rel} unchanged`);
    assert.ok(after.toString("utf8").includes('"holds.deliveryStacks"'), `${rel} has no hook point`);
    assert.ok(/\r\n/.test(after.toString("utf8")) === /\r\n/.test(originals.get(rel).toString("utf8")), "line endings kept");
  }
});

check("the patched game files load and every way in answers (probe.js)", () => runInGame("probe.js"));

check("a pilot's ship gains, fills, guards and empties its bays with the layer on from boot (workflow.js)", () => {
  // The probe's 3 s store lease runs out first.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  runInGame("workflow.js", { REVERIE_TYPE_LAYER: "server" });
});

if (withSalvage) {
  check("with salvage beside it, salvagers carry a Salvage Hold and Loot All is Holds' alone (partners.js)", () => {
    const out = cli("enable", "reverie-salvage");
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
    runInGame("partners.js", { REVERIE_TYPE_LAYER: "server" });
    const off = cli("disable", "reverie-salvage");
    assert.strictEqual(off.status, 0, off.stdout + off.stderr);
  });
} else {
  console.log("--    partner test skipped: reverie-salvage is not beside this mod");
}

check("a modder's own mod adds a bay through the service and the layer, and the rest of Holds uses it (framework.js)", () => {
  // The test mod's manifest ships as .fixture, so the launcher never counts a second mod in
  // Holds' package; it gets its real name in the test install.
  const specimen = path.join(root, "mods", "reverie-specimen");
  fs.cpSync(path.join(MOD, "test", "fixtures", "reverie-specimen"), specimen, { recursive: true });
  fs.renameSync(path.join(specimen, "evejs-launcher.mod.json.fixture"), path.join(specimen, "evejs-launcher.mod.json"));
  const out = cli("enable", "reverie-specimen");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  runInGame("composeLayer.js");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  try {
    // framework.js disables the test mod itself, live, as its last check.
    runInGame("framework.js", { REVERIE_TYPE_LAYER: "server" });
  } finally {
    const loader = path.join(root, "mods", "reverie-specimen", "loader.js");
    if (fs.existsSync(loader)) fs.renameSync(loader, `${loader}.disabled`);
  }
});

check("disable puts the game files back byte for byte", () => {
  const out = cli("disable", "reverie-holds");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  for (const rel of EDITED) assert.deepStrictEqual(fs.readFileSync(path.join(root, ...rel.split("/"))), originals.get(rel), `${rel} differs`);
});

// The node_modules links go first, as links, so the clean removal never reaches into the source.
// REVERIE_TEST_KEEP=1 leaves the install for a look.
let linksGone = process.env.REVERIE_TEST_KEEP !== "1";
if (!linksGone) console.log(`--    kept ${root}`);
else
for (const dir of ["server/node_modules", "node_modules"]) {
  const link = path.join(root, ...dir.split("/"));
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) continue;
    try { fs.rmdirSync(link); } catch (_) { fs.unlinkSync(link); }
  } catch (error) {
    if (error.code !== "ENOENT") { linksGone = false; console.log(`--    left ${root} in place: ${dir} could not be unlinked (${error.message})`); }
  }
}
if (linksGone) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp */ } }
console.log(failures ? `${failures} failed` : "all passed");
process.exitCode = failures ? 1 : 0;
