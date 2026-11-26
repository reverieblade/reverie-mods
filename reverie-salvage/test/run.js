"use strict";

// Offline test of Reverie Salvage against a clean EveJS:
//
//   node mods/reverie-salvage/test/run.js "<EveJS root>"      (or REVERIE_TEST_EVEJS)
//
// Builds a throwaway install in the temp folder from that EveJS (its server/src copied, its
// node_modules linked, nothing of it changed), copies the core and this mod into it, enables the
// mod with the core's own CLI so the file edits go in the way a player's would, runs the probe
// (probe.js) in a process that loads the patched game modules, then disables the mod and checks
// that the game files are byte for byte what they were.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MOD = path.resolve(__dirname, "..");
const CORE = path.resolve(MOD, "..", "reverie-core");
const source = path.resolve(process.argv[2] || process.env.REVERIE_TEST_EVEJS || "");
if (!process.argv[2] && !process.env.REVERIE_TEST_EVEJS) {
  console.error("Name a clean EveJS root: node mods/reverie-salvage/test/run.js \"D:/path/to/EveJS\"");
  process.exit(2);
}
if (!fs.existsSync(path.join(source, "server", "src"))) {
  console.error(`${source} has no server/src`);
  process.exit(2);
}
if (fs.existsSync(path.join(source, "server", "src", "services", "salvage", "wreckCutting.js"))) {
  console.error(`${source} already has wreck cutting in its own files; give a clean EveJS`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverie-salvage-test-"));
const EDITED = ["server/src/space/modules/salvagerRuntime.js", "server/src/services/mining/miningRuntime.js", "server/src/services/mining/miningDogma.js",
  "server/src/space/npc/npcLoot.js"];
// The core's own edits (its type layer hook points), in before the mod's.
const CORE_EDITED = ["server/src/services/_shared/referenceData.js", "server/src/services/industry/industryStaticData.js", "server/src/services/inventory/itemTypeRegistry.js"];

function step(text) { console.log(`--    ${text}`); }

step(`building a test install in ${root}`);
fs.cpSync(path.join(source, "server", "src"), path.join(root, "server", "src"), { recursive: true });
for (const file of ["package.json", "index.js", "bootstrap.js"]) {
  if (fs.existsSync(path.join(source, "server", file))) fs.copyFileSync(path.join(source, "server", file), path.join(root, "server", file));
}
for (const dir of ["server/node_modules", "node_modules"]) {
  const from = path.join(source, ...dir.split("/"));
  if (fs.existsSync(from)) fs.symlinkSync(from, path.join(root, ...dir.split("/")), "junction");
}
if (fs.existsSync(path.join(source, "package.json"))) fs.copyFileSync(path.join(source, "package.json"), path.join(root, "package.json"));
// The static tables the probe reads (copies, so nothing can write to the source's store).
for (const table of ["itemTypes", "typeDogma", "shipTypes", "skillTypes", "industryBlueprints", "reprocessingStatic"]) {
  const from = path.join(source, "_local", "gameStore", "data", table);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(root, "_local", "gameStore", "data", table), { recursive: true });
}
fs.cpSync(CORE, path.join(root, "mods", "reverie-core"), { recursive: true, filter: (src) => src !== path.join(CORE, "test") });
fs.cpSync(MOD, path.join(root, "mods", "reverie-salvage"), { recursive: true });
// The client package the mod requires, installed as the launcher leaves it.
fs.cpSync(path.join(MOD, "..", "reverie-client"), path.join(root, "mods", "reverie-client"), { recursive: true });
for (const id of ["reverie-core", "reverie-salvage"]) {
  const enabled = path.join(root, "mods", id, "loader.js");
  if (fs.existsSync(enabled)) fs.renameSync(enabled, `${enabled}.disabled`);
}
{
  const seeded = spawnSync(process.execPath, [path.join(MOD, "test", "seedStore.js"), path.join(root, "server", "src"),
    path.join(root, "_local", "gameStore", "gamestore.sqlite")], { cwd: path.join(root, "server"), encoding: "utf8" });
  if (seeded.status !== 0) console.log(`--    no empty game store: ${seeded.stderr.split("\n").slice(0, 3).join(" ")}`);
}
const originals = new Map(EDITED.map((rel) => [rel, fs.readFileSync(path.join(root, ...rel.split("/")))]));

const env = { ...process.env, REVERIE_REPO_ROOT: "", REVERIE_SERVER_ROOT: "", REVERIE_LOCAL_DIR: "" };
delete env.REVERIE_REPO_ROOT; delete env.REVERIE_SERVER_ROOT; delete env.REVERIE_LOCAL_DIR;
const cli = (...args) => spawnSync(process.execPath, [path.join(root, "mods", "reverie-core", "cli.js"), ...args], { cwd: root, env, encoding: "utf8" });

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok    ${name}`); } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}

check("enabling the core puts its type layer hook points in", () => {
  const before = CORE_EDITED.map((rel) => fs.readFileSync(path.join(root, ...rel.split("/"))));
  const out = cli("enable", "reverie-core");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  CORE_EDITED.forEach((rel, index) => {
    const after = fs.readFileSync(path.join(root, ...rel.split("/")));
    assert.notDeepStrictEqual(after, before[index], `${rel} unchanged`);
  });
  assert.ok(fs.readFileSync(path.join(root, ...CORE_EDITED[0].split("/")), "utf8").includes('"data.staticTable"'));
  assert.ok(fs.readFileSync(path.join(root, ...CORE_EDITED[1].split("/")), "utf8").includes('"data.blueprintDefinitions"'));
  assert.ok(fs.readFileSync(path.join(root, ...CORE_EDITED[2].split("/")), "utf8").includes('"reverie.typeLayer.generation"'));
});

check("enable puts the file edits in and turns the mod on", () => {
  const out = cli("enable", "reverie-salvage");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /changed 4 game files/);
  assert.match(out.stdout, /0 errors/);
  for (const rel of EDITED) assert.notDeepStrictEqual(fs.readFileSync(path.join(root, ...rel.split("/"))), originals.get(rel), `${rel} unchanged`);
  const text = fs.readFileSync(path.join(root, ...EDITED[0].split("/")), "utf8");
  assert.ok(/\r\n/.test(text) === /\r\n/.test(originals.get(EDITED[0]).toString("utf8")), "line endings kept");
});

check("the patched game files load and every hook answers (probe.js)", () => {
  const out = spawnSync(process.execPath, ["-r", path.join(root, "mods", "reverie-core", "loader.js"), path.join(root, "mods", "reverie-salvage", "test", "probe.js")], {
    cwd: path.join(root, "server"),
    // The store is the throwaway one above, so the probe may own it and make the tables it reads.
    // A short store lease: the probe exits without releasing it, and workflow.js waits it out.
    env: { ...env, REVERIE_ROLE: "game", REVERIE_STANDALONE: "1", REVERIE_RELOAD_POLL_MS: "600000", EVEJS_GAMESTORE_OWNER_ROLE: "maintenance",
      EVEJS_PERSISTENCE_OWNER_LEASE_MS: "3000" },
    encoding: "utf8",
    timeout: 240000,
  });
  const shown = process.env.REVERIE_TEST_VERBOSE === "1"
    ? out.stdout.split("\n")
    : out.stdout.split("\n").filter((line) => /^(ok|FAIL|--) /.test(line) || /^ {6}\S/.test(line) && !/^ {6}at /.test(line));
  process.stdout.write(shown.map((line) => `   ${line}`).join("\n") + "\n");
  assert.strictEqual(out.status, 0, `probe exited ${out.status}${out.stderr ? `\n${out.stderr.slice(-2000)}` : ""}`);
});

// The pilot's whole way from the market to alloys, with the type layer on from boot as on a
// trial server (probe.js saved the composed layer; REVERIE_TYPE_LAYER=server stands in for the
// patched client's ledger).
check("a pilot gets from a blueprint to alloys with the layer on from boot (workflow.js)", () => {
  // The probe's 3 s store lease runs out first (the store does not wait for it on this path).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  const out = spawnSync(process.execPath, ["-r", path.join(root, "mods", "reverie-core", "loader.js"), path.join(root, "mods", "reverie-salvage", "test", "workflow.js")], {
    cwd: path.join(root, "server"),
    env: { ...env, REVERIE_ROLE: "game", REVERIE_STANDALONE: "1", REVERIE_RELOAD_POLL_MS: "600000", EVEJS_GAMESTORE_OWNER_ROLE: "maintenance", REVERIE_TYPE_LAYER: "server",
      EVEJS_PERSISTENCE_OWNER_LEASE_MS: "3000" },
    encoding: "utf8",
    timeout: 240000,
  });
  const shown = process.env.REVERIE_TEST_VERBOSE === "1"
    ? out.stdout.split("\n")
    : out.stdout.split("\n").filter((line) => /^(ok|FAIL|--) /.test(line) || /^ {6}\S/.test(line) && !/^ {6}at /.test(line));
  process.stdout.write(shown.map((line) => `   ${line}`).join("\n") + "\n");
  assert.strictEqual(out.status, 0, `workflow exited ${out.status}${out.stderr ? `\n${out.stderr.slice(-2000)}` : ""}`);
});

check("disable puts the game files back byte for byte", () => {
  const out = cli("disable", "reverie-salvage");
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
