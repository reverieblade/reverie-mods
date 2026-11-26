"use strict";

// Offline tests for Reverie's core: node mods/reverie-core/test/run.js
// Builds a throwaway EveJS tree in the temp folder (a fake server, a copy of the core and six
// small mods), starts the fake server the way StartServer.bat does, and checks what each process
// saw. Nothing here touches the real server or its data.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CORE = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverie-test-"));
let failures = 0;

const pending = [];
function test(name, fn) {
  const failed = (error) => {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") pending.push(out.then(() => console.log(`ok    ${name}`), failed));
    else console.log(`ok    ${name}`);
  } catch (error) { failed(error); }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function manifest(id, extra = {}) {
  return JSON.stringify({ schemaVersion: 3, id, displayName: id, version: "1.0.0", kind: "loader", activation: { strategy: "loader_rename" }, restart: "game_server", ...extra }, null, 2);
}

function mod(id, { extra, reverie, index, disabled } = {}) {
  write(`mods/${id}/evejs-launcher.mod.json`, manifest(id, extra));
  write(`mods/${id}/${disabled ? "loader.js.disabled" : "loader.js"}`, 'require("../reverie-core/register")(__dirname);\n');
  if (reverie) write(`mods/${id}/reverie.json`, JSON.stringify(reverie, null, 2));
  if (index) write(`mods/${id}/server/index.js`, index);
}

// The core, copied without its tests.
fs.cpSync(CORE, path.join(root, "mods", "reverie-core"), { recursive: true, filter: (src) => !src.startsWith(path.join(CORE, "test")) });

// A fake server: index.js boots, then reports what it sees in each process.
write("server/package.json", JSON.stringify({ name: "fake", type: "commonjs", main: "index.js" }));
write("server/bootstrap.js", `"use strict";
async function bootWorld() { await new Promise((r) => setTimeout(r, 20)); return { world: true }; }
module.exports = { bootWorld };
`);
write("server/src/lib/math.js", `"use strict";
function add(a, b) { return a + b; }
function mul(a, b) { return a * b; }
class Thing { greet() { return "hi"; } }
function note(value) {
  const hooks = globalThis[Symbol.for("reverie.hooks")];
  return hooks ? hooks.run("math.note", value) : value;
}
module.exports = { add, mul, Thing, note };
`);
write("server/src/lib/workerJob.js", `"use strict";
const { parentPort } = require("worker_threads");
const { add } = require("./math");
const core = globalThis[Symbol.for("reverie.core")];
parentPort.postMessage({ add: add(1, 2), role: core && core.role });
`);
write("server/src/lib/child.js", `"use strict";
const { add } = require("./math");
const core = globalThis[Symbol.for("reverie.core")];
process.send({ add: add(1, 2), role: core && core.role });
`);
write("server/index.js", `"use strict";
const path = require("path");
const { fork } = require("child_process");
const { Worker } = require("worker_threads");
const { bootWorld } = require("./bootstrap");
const math = require("./src/lib/math");
const { add } = math;
(async () => {
  await bootWorld();
  await new Promise((r) => setTimeout(r, 50));
  const out = { add: add(1, 2), mul: math.mul(2, 3), greet: new math.Thing().greet(), note: math.note("x"), inits: [...(globalThis.__inits || [])] };
  out.role = globalThis[Symbol.for("reverie.core")].role;
  delete require.cache[require.resolve("./src/lib/math")];
  out.addAfterReload = require("./src/lib/math").add(1, 2);
  out.worker = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "src/lib/workerJob.js"));
    worker.once("message", resolve); worker.once("error", reject);
  });
  out.child = await new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "src/lib/child.js"));
    child.once("message", (m) => { resolve(m); child.kill(); }); child.once("error", reject);
  });
  // A live change to alpha's code, reloaded directly.
  const fs = require("fs");
  const modsDir = path.join(__dirname, "..", "mods");
  const core = globalThis[Symbol.for("reverie.core")];
  const alphaFile = path.join(modsDir, "alpha", "server", "index.js");
  fs.writeFileSync(alphaFile, fs.readFileSync(alphaFile, "utf8").replace("result * 10", "result * 100"));
  out.alphaReload = (await core.reloadMod("alpha")).result;
  out.addAfterAlphaReload = math.add(1, 2);
  // beta disabled on disk, then reloaded through the watched request file.
  fs.renameSync(path.join(modsDir, "beta", "loader.js"), path.join(modsDir, "beta", "loader.js.disabled"));
  fs.writeFileSync(path.join(__dirname, "..", "_local", "reverie", "reload.json"), JSON.stringify({ mods: ["beta"] }));
  await new Promise((r) => setTimeout(r, 600));
  out.addAfterBetaOff = math.add(1, 2);
  out.mulAfterBetaOff = math.mul(2, 3);
  out.noteAfterBetaOff = math.note("x");
  out.disposed = globalThis.__disposed || [];
  out.svc = globalThis.__svc || [];
  const services = globalThis[Symbol.for("reverie.services")];
  out.svcFromGame = services && services.use("eps.counter", "1.1") ? services.use("eps.counter", "1.1").value() : null;
  out.svcWrongMajor = services ? services.use("eps.counter", 2) : "no registry";
  out.betaState = core.status().mods.find((m) => m.id === "beta").state;
  console.log("RESULT " + JSON.stringify(out));
})();
`);

// alpha: adds 1 to the first argument and multiplies the result by 10; records its init.
mod("alpha", { index: `"use strict";
module.exports = {
  patches(api) {
    api.patch("lib/math", "add", { prefix(ctx, args) { args[0] += 1; }, postfix(ctx, result) { return result * 10; } });
  },
  init(api) {
    (globalThis.__inits = globalThis.__inits || []).push(api.id + (api.mods.has("beta") ? "+beta" : ""));
    // eps loads later and provides this; alpha must attach when it does, and again after a reload.
    const seen = (globalThis.__svc = globalThis.__svc || []);
    api.when("eps.counter", 1, (counter, from) => { seen.push("attach:" + counter.value() + ":" + from.mod); return () => seen.push("detach"); });
  },
};
` });
// beta: needs alpha, loads after it, adds 1 to add's result, replaces mul, patches a class method, hooks a hook point.
mod("beta", {
  extra: { requires: ["reverie-core", "alpha"] },
  reverie: { reverieVersion: 1, id: "beta", claims: { types: [[1000, 1999]] }, edits: { types: [587] } },
  index: `"use strict";
module.exports = {
  patches(api) {
    api.patch("lib/math", "add", { postfix(ctx, result) { return result + 1; } });
    api.replace("lib/math", "mul", (original, a, b) => original(a, b) + 1000);
    api.patch("lib/math", "Thing.prototype.greet", { postfix(ctx, result) { return result + "!"; } });
    api.hooks.on("math.note", (value) => value + "-beta");
  },
  init(api) { (globalThis.__inits = globalThis.__inits || []).push(api.id); },
  dispose(api) { (globalThis.__disposed = globalThis.__disposed || []).push(api.id); },
};
` });
// gamma: requires a mod nobody has.
mod("gamma", { extra: { requires: ["missing-mod"] }, index: 'module.exports = { patches() { throw new Error("gamma should never load"); } };\n' });
// delta: disabled.
mod("delta", { disabled: true, index: 'module.exports = { patches() { throw new Error("delta should never load"); } };\n' });
// eps: a prefix that throws on every call, which must not stop add.
mod("eps", { index: `"use strict";
module.exports = {
  patches(api) { api.patch("lib/math", "add", { prefix() { throw new Error("eps is broken"); } }); },
  init(api) { api.provide("eps.counter", "1.2.0", { value: () => 7 }); },
};
` });
// zeta: replaces mul too, after beta, and claims an overlapping type range.
mod("zeta", {
  reverie: { reverieVersion: 1, id: "zeta", claims: { types: [[1500, 1600]] }, edits: { types: [587] } },
  index: `"use strict";
module.exports = { patches(api) { api.replace("lib/math", "mul", () => -1); } };
` });

const loader = path.join(root, "mods", "reverie-core", "loader.js");
// NODE_OPTIONS reads a backslash as an escape, so a Windows path must use forward slashes.
const env = { ...process.env, NODE_OPTIONS: `--require "${loader.split(path.sep).join("/")}"`, REVERIE_STANDALONE: "1", REVERIE_RELOAD_POLL_MS: "100" };
delete env.REVERIE_ROLE; delete env.REVERIE_SERVER_ROOT; delete env.REVERIE_LOCAL_DIR; delete env.REVERIE_DISABLE; delete env.REVERIE_GAME_PID;

const run = spawnSync(process.execPath, ["."], { cwd: path.join(root, "server"), env, encoding: "utf8", timeout: 30000 });
const line = (run.stdout || "").split(/\r?\n/).find((text) => text.startsWith("RESULT "));
const result = line ? JSON.parse(line.slice(7)) : null;

test("the fake server ran with the core preloaded", () => {
  assert.ok(result, `no RESULT line\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
});
if (result) {
  test("main thread is the game role", () => assert.strictEqual(result.role, "game"));
  test("prefixes in load order, postfixes in reverse, a throwing prefix is skipped", () => assert.strictEqual(result.add, 50));
  test("destructured import sees the patch", () => assert.strictEqual(result.add, 50));
  test("one replacement wins and the second mod's is refused", () => assert.strictEqual(result.mul, 1006));
  test("a dotted path patches a class method", () => assert.strictEqual(result.greet, "hi!"));
  test("hook points run handlers", () => assert.strictEqual(result.note, "x-beta"));
  test("init runs after boot, in load order, and sees other mods", () => assert.deepStrictEqual(result.inits, ["alpha+beta", "beta"]));
  test("a reloaded module is patched again", () => assert.strictEqual(result.addAfterReload, 50));
  test("worker threads get the patches", () => assert.deepStrictEqual(result.worker, { add: 50, role: "worker" }));
  test("child processes are left alone", () => assert.deepStrictEqual(result.child, { add: 3, role: "other" }));
  test("a mod's changed code reloads live and keeps its place in the order", () => {
    assert.strictEqual(result.alphaReload, "running");
    assert.strictEqual(result.addAfterAlphaReload, 500);
  });
  test("a mod disabled on disk unloads live through reload.json", () => {
    assert.strictEqual(result.betaState, "disabled");
    assert.deepStrictEqual(result.disposed, ["beta"]);
    assert.strictEqual(result.addAfterBetaOff, 400);
    assert.strictEqual(result.mulAfterBetaOff, 6);
    assert.strictEqual(result.noteAfterBetaOff, "x");
  });
  test("a mod attaches to a service a later mod provides, and again after its own reload", () => {
    assert.deepStrictEqual(result.svc, ["attach:7:eps", "detach", "attach:7:eps"]);
  });
  test("game files reach services through the global, by compatible version only", () => {
    assert.strictEqual(result.svcFromGame, 7);
    assert.strictEqual(result.svcWrongMajor, null);
  });
}
test("a broken prefix is reported against its mod", () => assert.match(run.stderr, /\[eps\] prefix on lib\/math#add failed/));

const statusFile = path.join(root, "_local", "reverie", "status.json");
const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : null;
test("status.json is written after boot", () => assert.ok(status && status.booted));
if (status) {
  const state = Object.fromEntries(status.mods.map((m) => [m.id, m.state]));
  test("mod states", () => assert.deepStrictEqual(state, { "reverie-core": "running", alpha: "running", beta: "disabled", eps: "running", zeta: "degraded" }));
  test("missing requirement is skipped with a reason", () => assert.ok(status.skipped.some((s) => s.id === "gamma" && /missing-mod/.test(s.reason))));
  test("double replacement is a reported problem", () => assert.ok(status.patches.problems.some((p) => p.kind === "replace" && /zeta/.test(p.message))));
}

// The fake server disabled beta on disk; the CLI tests want it back.
if (fs.existsSync(path.join(root, "mods", "beta", "loader.js.disabled"))) {
  fs.renameSync(path.join(root, "mods", "beta", "loader.js.disabled"), path.join(root, "mods", "beta", "loader.js"));
}

function cli(...args) {
  return spawnSync(process.execPath, [path.join(root, "mods", "reverie-core", "cli.js"), ...args], { encoding: "utf8", env: { ...env, NODE_OPTIONS: "" } });
}
test("cli check finds the double replacement, the claim overlap and the shared edit", () => {
  const out = cli("check");
  assert.strictEqual(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /lib\/math#mul is replaced by both beta and zeta/);
  assert.match(out.stdout, /types 1500-1600 claimed by zeta overlaps 1000-1999 claimed by beta/);
  assert.match(out.stdout, /types 587 is edited by beta, zeta/);
  assert.match(out.stdout, /gamma will not load/);
});
test("cli refuses to disable a mod another enabled mod requires", () => {
  const out = cli("disable", "alpha");
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /beta requires alpha/);
});
test("cli enable and disable rename the loader like the launcher", () => {
  assert.strictEqual(cli("enable", "delta").status !== 2, true);
  assert.ok(fs.existsSync(path.join(root, "mods", "delta", "loader.js")));
  assert.strictEqual(cli("disable", "delta").status, 0);
  assert.ok(fs.existsSync(path.join(root, "mods", "delta", "loader.js.disabled")));
});
test("cli move changes the saved order and the resolver keeps requirements first", () => {
  cli("move", "beta", "1");
  const out = cli("order");
  const ids = out.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
  assert.ok(ids.indexOf("alpha") < ids.indexOf("beta"), out.stdout);
});

// File edits at install: text regions, staged files and config keys, by the CLI and the helper.
const CRLF = String.fromCharCode(13, 10);
const sharedOriginal = ["// head", "// <a>", "exports.a = 1;", "// </a>", "// <b>", "exports.b = 2;", "// </b>", "// user", ""].join(CRLF);
write("server/src/lib/shared.js", sharedOriginal);
const sharedFile = path.join(root, "server", "src", "lib", "shared.js");
const readShared = () => fs.readFileSync(sharedFile, "utf8");
const region = (start, end, value, more = {}) => ({ path: "server/src/lib/shared.js", format: "text", start, end, value, ...more });
mod("eta", { disabled: true, reverie: { reverieVersion: 1, id: "eta", files: [
  region("// <a>", "// </a>", "\nexports.a = 10;\n"),
  { path: "server/src/lib/etaNew.js", format: "file", source: "staged/etaNew.js" },
  { path: "config/mods/eta.json", format: "json", key: ["eta", "on"], value: true },
] } });
write("mods/eta/staged/etaNew.js", "module.exports = 'eta';\n");
mod("theta", { disabled: true, reverie: { reverieVersion: 1, id: "theta", files: [region("// <b>", "// </b>", "\nexports.b = 20;\n")] } });
write("mods/theta/helper.js", 'require("../reverie-core/helper").main(__dirname);\n');
mod("iota", { disabled: true, reverie: { reverieVersion: 1, id: "iota", files: [region("// head", "// </a>", "\n")] } });
mod("kappa", { disabled: true, reverie: { reverieVersion: 1, id: "kappa", files: [region("// <b>", "// </b>", "\nexports.b = 99;\n")] } });
mod("lambda", { disabled: true, reverie: { reverieVersion: 1, id: "lambda", files: [region("// <a>", "// </a>", "\n", { originalSha256: "0".repeat(64) })] } });

function helper(modID, action) {
  const request = { protocol: "evejs_launcher_mod_v1", requestId: `r-${action}`, action,
    mod: { id: modID, version: "1.0.0", identity: "x", root, path: path.join(root, "mods", modID) },
    runtime: { backend: "native", evejsRoot: root, clientRoot: "" }, profile: null, settings: { global: {}, profile: {} } };
  const requestFile = path.join(root, `${modID}-${action}.request.json`);
  const resultFile = path.join(root, `${modID}-${action}.result.json`);
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const helperFile = path.join(root, "mods", modID, "helper.js");
  if (!fs.existsSync(helperFile)) fs.writeFileSync(helperFile, 'require("../reverie-core/helper").main(__dirname);\n');
  const out = spawnSync(process.execPath, [helperFile, "--request", requestFile, "--result", resultFile], { encoding: "utf8", env: { ...env, NODE_OPTIONS: "" } });
  assert.ok(fs.existsSync(resultFile), out.stdout + out.stderr);
  return JSON.parse(fs.readFileSync(resultFile, "utf8"));
}

test("helper install hands the launcher a text region in the file's own line endings", () => {
  const result = helper("theta", "install");
  assert.strictEqual(result.state, "ready", result.message);
  assert.strictEqual(result.requestId, "r-install");
  assert.deepStrictEqual(Object.keys(result).sort(), ["arguments", "contributions", "environment", "message", "protocol", "requestId", "restartRequired", "state", "success"]);
  assert.deepStrictEqual(result.contributions, [{ base: "evejs", path: "server/src/lib/shared.js", format: "text", key: ["// <b>", "// </b>"], value: `${CRLF}exports.b = 20;${CRLF}` }]);
  assert.strictEqual(readShared(), sharedOriginal, "the helper must not write the file itself");
});
test("helper install refuses an edit written for another build", () => {
  const result = helper("lambda", "install");
  assert.strictEqual(result.state, "failed");
  assert.strictEqual(result.success, false);
  assert.match(result.message, /originalSha256/);
});
test("helper install counts an installed client package as a met requirement", () => {
  // A client package has no loader.js, so the catalog never reads it as enabled.
  write("mods/mu-data/evejs-launcher.mod.json", manifest("mu-data", { kind: "client-package", activation: undefined, restart: "none" }));
  mod("nu", { disabled: true, extra: { requires: ["mu-data"] } });
  const result = helper("nu", "install");
  assert.strictEqual(result.state, "ready", result.message);
  mod("xi", { disabled: true, extra: { requires: ["missing-data"] } });
  const missing = helper("xi", "install");
  assert.strictEqual(missing.state, "failed");
  assert.match(missing.message, /requires missing-data/);
});
test("helper verify fails while the edit is missing", () => assert.strictEqual(helper("theta", "verify").state, "failed"));
test("cli enable applies a region, a staged file and a config key", () => {
  // enable ends with check, which fails on this tree's deliberate errors, so look for the line.
  const out = cli("enable", "eta");
  assert.match(out.stdout, /eta is enabled/, out.stdout + out.stderr);
  assert.strictEqual(readShared(), sharedOriginal.replace("exports.a = 1;", "exports.a = 10;"));
  assert.strictEqual(fs.readFileSync(path.join(root, "server", "src", "lib", "etaNew.js"), "utf8"), "module.exports = 'eta';\n");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, "config", "mods", "eta.json"), "utf8")).eta.on, true);
});
test("a second mod's region in the same file sits beside the first", () => {
  const out = cli("enable", "theta");
  assert.match(out.stdout, /theta is enabled/, out.stdout + out.stderr);
  assert.match(readShared(), /exports\.a = 10;\r\n\/\/ <\/a>\r\n\/\/ <b>\r\nexports\.b = 20;/);
});
test("helper verify is ready once the edit is in place", () => assert.strictEqual(helper("theta", "verify").state, "ready"));
test("a region that overlaps another mod's is refused and nothing changes", () => {
  const before = readShared();
  const out = cli("enable", "iota");
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /overlaps one held by eta/);
  assert.strictEqual(readShared(), before);
  assert.ok(fs.existsSync(path.join(root, "mods", "iota", "loader.js.disabled")));
});
test("the same region with different text is refused", () => {
  const out = cli("enable", "kappa");
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /theta already holds this region with different text/);
});
test("disable restores only its own edits and keeps the user's", () => {
  fs.writeFileSync(sharedFile, readShared().replace("// user", "// user edit"));
  const out = cli("disable", "eta");
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.strictEqual(readShared(), sharedOriginal.replace("exports.b = 2;", "exports.b = 20;").replace("// user", "// user edit"));
  assert.ok(!fs.existsSync(path.join(root, "server", "src", "lib", "etaNew.js")));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, "config", "mods", "eta.json"), "utf8")), { eta: {} });
});
test("disable refuses when its region was edited by hand, and changes nothing", () => {
  const edited = readShared().replace("exports.b = 20;", "exports.b = 21;");
  fs.writeFileSync(sharedFile, edited);
  const out = cli("disable", "theta");
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /edited after this mod changed it/);
  assert.strictEqual(readShared(), edited);
  assert.ok(fs.existsSync(path.join(root, "mods", "theta", "loader.js")));
});

// Login scripts: the core's own client script goes first whenever the layer adds or edits types.
const loginScripts = require(path.join(CORE, "lib", "loginScripts"));
test("login scripts send the core's icon fix first when the layer has types", () => {
  const emptyMods = path.join(root, "no-mods");
  fs.mkdirSync(emptyMods, { recursive: true });
  const none = loginScripts.buildSources({ types: [], typeEdits: [], scripts: [] }, { modsDir: emptyMods });
  assert.strictEqual(none.sources.length, 0);
  const { sources, problems } = loginScripts.buildSources({ types: [{ typeID: 990001 }], scripts: [] }, { modsDir: emptyMods });
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].id, "reverie.reverie-core");
  assert.match(sources[0].source, /^# Reverie preamble/);
  assert.match(sources[0].source, /def patch_icons\(\):/);
  assert.ok(!sources[0].source.includes("\r"));
  const edits = loginScripts.buildSources({ typeEdits: [{ typeID: 34 }] }, { modsDir: emptyMods });
  assert.strictEqual(edits.sources[0].id, "reverie.reverie-core");
});

// The resolver alone.
const order = require(path.join(CORE, "lib", "order"));
const rec = (id, more = {}) => ({ id, folder: id, kind: "loader", enabled: true, errors: [], requires: [], loadAfter: [], loadBefore: [], conflicts: [], ...more });
test("resolver keeps the saved order where edges allow", () => {
  const { order: list } = order.resolve([rec("a"), rec("b"), rec("c")], ["c", "a", "b"]);
  assert.deepStrictEqual(list.map((m) => m.id), ["c", "a", "b"]);
});
test("resolver honours loadBefore and loadAfter", () => {
  const { order: list } = order.resolve([rec("a", { loadAfter: ["c"] }), rec("b", { loadBefore: ["a"] }), rec("c")], ["a", "b", "c"]);
  assert.deepStrictEqual(list.map((m) => m.id), ["b", "c", "a"]);
});
test("resolver reports a cycle and loads the rest", () => {
  const { order: list, skipped } = order.resolve([rec("a", { loadAfter: ["b"] }), rec("b", { loadAfter: ["a"] }), rec("c")]);
  assert.deepStrictEqual(list.map((m) => m.id), ["c"]);
  assert.strictEqual(skipped.filter((s) => /cycle/.test(s.reason)).length, 2);
});
test("resolver: a declared conflict leaves out the later mod, and its dependents", () => {
  const { order: list, skipped } = order.resolve([rec("a", { conflicts: ["b"] }), rec("b"), rec("c", { requires: ["b"] })], ["a", "b", "c"]);
  assert.deepStrictEqual(list.map((m) => m.id), ["a"]);
  assert.deepStrictEqual(skipped.map((s) => s.id).sort(), ["b", "c"]);
});
test("resolver: a requirement on an installed client package is met, a missing one is not", () => {
  const client = rec("client-data", { kind: "client-package", enabled: false });
  const { order: list } = order.resolve([rec("core"), client, rec("feature", { requires: ["core", "client-data"] })]);
  assert.deepStrictEqual(list.map((m) => m.id), ["core", "feature"]);
  const { skipped } = order.resolve([rec("core"), rec("feature", { requires: ["core", "client-data"] })]);
  assert.deepStrictEqual(skipped.map((s) => s.id), ["feature"]);
});

// The service registry alone.
const servicesLib = require(path.join(CORE, "lib", "services"));
function registry() {
  const errors = [];
  return { errors, services: servicesLib.createServices({ log: { info() {}, warn() {}, error: (m) => errors.push(m) } }) };
}
test("service versions: same major, same or newer minor", () => {
  const ok = servicesLib.satisfies;
  assert.ok(ok("1.4.2", 1) && ok("1.4.2", "1.3") && ok("1.4.2", "1.4.2") && ok("1.4.2", undefined));
  assert.ok(!ok("1.4.2", 2) && !ok("1.4.2", "1.5") && !ok("1.4.2", "1.4.3") && !ok("2.0", 1));
});
test("services: when() attaches now or later, cleans up when the provider goes, and follows it back", () => {
  const { services, errors } = registry();
  const log = [];
  services.when("bots", "bot-jobs", 1, (jobs, from) => { log.push(`attach ${jobs.name} ${from.mod}`); return () => log.push("detach"); });
  services.provide("botmod", "bot-jobs", "1.0.0", { name: "a" });
  services.removeMod("botmod");
  services.provide("botmod", "bot-jobs", "1.1.0", { name: "b" });
  services.when("late", "bot-jobs", "1.1", (jobs) => { log.push(`late ${jobs.name}`); });
  assert.deepStrictEqual(log, ["attach a botmod", "detach", "attach b botmod", "late b"]);
  assert.deepStrictEqual(errors, []);
});
test("services: a second provider of one name is refused; a wrong major is not attached", () => {
  const { services } = registry();
  services.provide("one", "holds", "2.0", {});
  assert.throws(() => services.provide("two", "holds", "2.0", {}), /already provided by one/);
  let attached = false;
  services.when("user", "holds", 1, () => { attached = true; });
  assert.strictEqual(attached, false);
  assert.strictEqual(services.use("holds", 1), null);
  assert.ok(services.use("holds", 2));
});
test("services: removing the user mod runs its cleanups in reverse, and a throwing attach is logged", () => {
  const { services, errors } = registry();
  const log = [];
  services.provide("p", "s", "1", {});
  services.when("u", "s", () => () => log.push("first"));
  services.when("u", "s", () => () => log.push("second"));
  services.when("u", "s", () => { throw new Error("boom"); });
  services.removeMod("u");
  assert.deepStrictEqual(log, ["second", "first"]);
  assert.ok(errors.some((e) => /boom/.test(e)));
  assert.deepStrictEqual(services.status().used, []);
});
test("services: an async attach that settles after the provider left still cleans up", async () => {
  const { services } = registry();
  const log = [];
  services.provide("p", "s", "1", {});
  let release;
  services.when("u", "s", () => new Promise((resolve) => { release = () => resolve(() => log.push("cleaned")); }));
  services.removeMod("p");
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(log, ["cleaned"]);
});

// ---------------------------------------------------------------- market stock
// A market database with only the seed_stock table (market-common's own definition), and a stand-in
// market server that answers Health and AdjustSeedStock the way the real one does.
const marketLocal = path.join(root, "market-local");
process.env.REVERIE_LOCAL_DIR = marketLocal;
for (const name of ["paths", "marketStock"]) delete require.cache[require.resolve(path.join(CORE, "lib", name))];
const marketStockLib = require(path.join(CORE, "lib", "marketStock"));
const repoServer = path.resolve(CORE, "..", "..", "server");
let Sqlite = null;
try { Sqlite = require(require.resolve("better-sqlite3", { paths: [repoServer] })); } catch (_) { /* no SQLite here */ }
const marketFile = path.join(root, "market.sqlite");
function marketDb() { const db = new Sqlite(marketFile); db.pragma("busy_timeout = 5000"); return db; }
function seedMarket() {
  const db = marketDb();
  db.exec(`CREATE TABLE IF NOT EXISTS seed_stock (station_id INTEGER NOT NULL, solar_system_id INTEGER NOT NULL,
    constellation_id INTEGER NOT NULL, region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, price REAL NOT NULL,
    quantity INTEGER NOT NULL, initial_quantity INTEGER NOT NULL, price_version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, PRIMARY KEY (station_id, type_id)) WITHOUT ROWID`);
  const put = db.prepare("INSERT INTO seed_stock VALUES (?, 30, 20, 10, ?, ?, ?, ?, 1, 'then')");
  put.run(1, 100, 1000, 50, 50);   // the type to stock like, at two stations
  put.run(2, 100, 1100, 40, 40);
  put.run(2, 300, 5, 9, 9);        // the seeder already sells the new type at station 2
  db.close();
}
const rowsOf = (typeID) => { const db = marketDb(); const out = db.prepare("SELECT station_id, price, quantity FROM seed_stock WHERE type_id = ? ORDER BY station_id").all(typeID); db.close(); return out; };
function fakeMarket() {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (method === "Health") return { database_path: marketFile };
      if (method === "AdjustSeedStock") {
        const db = marketDb();
        const row = db.prepare("SELECT quantity FROM seed_stock WHERE station_id = ? AND type_id = ?").get(params.station_id, params.type_id);
        if (!row) { db.close(); throw new Error(`seed stock not found for station ${params.station_id} type ${params.type_id}`); }
        if (params.new_quantity !== undefined) db.prepare("UPDATE seed_stock SET quantity = ? WHERE station_id = ? AND type_id = ?").run(params.new_quantity, params.station_id, params.type_id);
        db.close();
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
if (Sqlite) {
  test("market stock: stocked like another type, at its price ratio, beside the seeder's own rows, and taken back", async () => {
    seedMarket();
    let active = true;
    const market = fakeMarket();
    const logs = [];
    const stock = marketStockLib.createMarketStock({
      typeLayer: { layer: () => ({ marketStock: [{ typeID: 300, like: 100, basePrice: 2000, likeBasePrice: 1000, mod: "m" }] }) },
      host: { isModActive: () => active },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      client: market,
    });
    const first = await stock.sync("test");
    assert.match(first.result, /added 1 rows/, JSON.stringify(first));
    assert.deepStrictEqual(rowsOf(300), [{ station_id: 1, price: 2000, quantity: 50 }, { station_id: 2, price: 5, quantity: 9 }]);
    assert.ok(market.calls.some(([m, p]) => m === "AdjustSeedStock" && p.station_id === 1 && p.delta_quantity === 0), "caches dropped for the new row");
    const ledger = JSON.parse(fs.readFileSync(marketStockLib.LEDGER(), "utf8"));
    assert.deepStrictEqual(ledger.databases[marketFile].rows, [{ stationID: 1, typeID: 300, mod: "m" }]);

    market.calls.length = 0;
    assert.strictEqual((await stock.sync("again")).result, "in place");
    assert.ok(!market.calls.some(([m]) => m === "AdjustSeedStock"), "a second sync changes nothing");

    // A reseed drops the row; the next sync puts it back.
    { const db = marketDb(); db.prepare("DELETE FROM seed_stock WHERE station_id = 1 AND type_id = 300").run(); db.close(); }
    assert.match((await stock.sync("reseed")).result, /added 1 rows, 1 lost to a reseed/);

    active = false;
    assert.match((await stock.sync("off")).result, /removed 1/);
    assert.deepStrictEqual(rowsOf(300), [{ station_id: 2, price: 5, quantity: 9 }], "only the seeder's row is left");
    assert.ok(market.calls.some(([m, p]) => m === "AdjustSeedStock" && p.station_id === 1 && p.new_quantity === 0), "emptied through the market first");
    assert.strictEqual(rowsOf(100).length, 2, "the type it was stocked like is untouched");
  });
  test("market stock: with the core gone, the helper's offline removal deletes only recorded rows", async () => {
    let active = true;
    const stock = marketStockLib.createMarketStock({
      typeLayer: { layer: () => ({ marketStock: [{ typeID: 300, like: 100, basePrice: 2000, likeBasePrice: 1000, mod: "m" }] }) },
      host: { isModActive: () => active },
      log: { info() {}, warn() {}, error() {} },
      client: fakeMarket(),
    });
    // Runs after the test above has settled (this test's own promise is not in the list yet).
    await Promise.all([...pending]);
    await stock.sync("offline");
    assert.strictEqual(rowsOf(300).length, 2);
    assert.match(marketStockLib.removeAllOffline(repoServer), /1 rows\) was taken out/);
    assert.deepStrictEqual(rowsOf(300), [{ station_id: 2, price: 5, quantity: 9 }]);
    assert.strictEqual(marketStockLib.removeAllOffline(repoServer), "", "nothing left to remove the second time");
  });
} else {
  console.log("--    market stock tests skipped: better-sqlite3 is not in the repo's server folder");
}

Promise.all(pending).then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `${failures} failed` : "all passed");
  process.exitCode = failures ? 1 : 0;
});
