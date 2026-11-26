"use strict";
// The EveJS Launcher helper for Reverie's client data (launcher helper API 1, a client-package
// helper). The launcher runs it only while the EVE client is closed:
//
//   install, recover   compose the installed Reverie mods' type layer and write it into the client
//   verify             before each launch: the client has the layer the installed mods compose to
//                      now, and gets it if a Reverie mod was enabled, disabled or updated since
//   prepare_disable,   put every client file Reverie changed back to the client's own
//   prepare_remove
//
// The real work is reverie-core/client/run.js, the same code as `cli.js client apply`. Each ready
// reply carries a bound receipt at <client tq>/_local/mod-receipts/reverie-client.json.

const fs = require("fs");
const path = require("path");

const PROTOCOL = "evejs_launcher_mod_v1";
const RECEIPT = "_local/mod-receipts/reverie-client.json";
const ACTIONS = new Set(["install", "verify", "recover", "prepare_disable", "prepare_remove"]);

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 2 || !argv[index + 1]) throw new Error(`Missing ${name}`);
  return argv[index + 1];
}

function reply(request, fields) {
  const out = {
    protocol: PROTOCOL,
    requestId: request && typeof request.requestId === "string" ? request.requestId : "",
    success: fields.state !== "failed",
    state: fields.state,
    message: String(fields.message || "").slice(0, 4096),
    restartRequired: fields.restartRequired || [],
    contributions: [],
    environment: {},
    arguments: [],
  };
  if (fields.receipt) out.receipt = { base: "client", path: RECEIPT, state: fields.receipt, schemaVersion: 1 };
  return out;
}

function receiptFile(clientRoot) { return path.join(clientRoot, ...RECEIPT.split("/")); }

function readReceipt(request) {
  const file = receiptFile(request.runtime.clientRoot);
  if (!fs.existsSync(file)) return null;
  const receipt = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (receipt.schemaVersion !== 1 || receipt.modIdentity !== request.mod.identity || receipt.clientRoot !== request.runtime.clientRoot) {
    throw new Error("The client's Reverie receipt belongs to another install of this mod or another client folder.");
  }
  return receipt;
}

function writeReceipt(request, state, extra) {
  const file = receiptFile(request.runtime.clientRoot);
  for (const dir of [path.dirname(path.dirname(file)), path.dirname(file)]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link; the receipt is not written through links.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { schemaVersion: 1, modIdentity: request.mod.identity, clientRoot: request.runtime.clientRoot, state, at: new Date().toISOString(), ...extra };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(body, null, 2));
  fs.renameSync(temp, file);
}

const modList = (mods) => (mods || []).map((m) => `${m.id} ${m.version}`).join(", ") || "no mods";

function handle(request, coreDir) {
  if (!request || request.protocol !== PROTOCOL) return reply(request, { state: "failed", message: "Unsupported helper protocol." });
  if (!ACTIONS.has(request.action)) return reply(request, { state: "failed", message: `Reverie Client Data does not handle ${request.action}.` });
  const runtime = request.runtime || {};
  if (!runtime.clientRoot || !fs.existsSync(path.join(runtime.clientRoot, "resfileindex.txt"))) {
    return reply(request, { state: "failed", message: "The client folder the launcher gave has no resfileindex.txt." });
  }
  if (!runtime.evejsRoot || !fs.existsSync(path.join(runtime.evejsRoot, "server"))) {
    return reply(request, { state: "failed", message: "The EveJS folder the launcher gave has no server folder." });
  }
  // Paths resolve against the launcher's EveJS root before any core module loads.
  process.env.REVERIE_REPO_ROOT = runtime.evejsRoot;
  const run = require(path.join(coreDir, "client", "run"));
  const lines = [];
  const log = (line) => lines.push(line);
  const receipt = readReceipt(request);
  const tq = runtime.clientRoot;

  const doInstall = (verb) => {
    const out = run.install({ tq, log });
    writeReceipt(request, "active", { layerSha256: out.layerSha256, mods: out.layer.mods });
    const message = out.unchanged
      ? `The client already has the items of ${modList(out.layer.mods)}.`
      : `${verb} the items of ${modList(out.layer.mods)} into the client. A running game server takes them within a few seconds.`;
    return reply(request, { state: "ready", message, receipt: "active", restartRequired: [] });
  };
  const doRestore = () => {
    const out = run.remove({ tq, log });
    if (out.left.length) {
      writeReceipt(request, "recoverable", { left: out.left });
      return reply(request, { state: "failed", message: `Another tool changed ${out.left.join(", ")} after Reverie did, so those were left. Restore that tool's patch, then disable this again.` });
    }
    writeReceipt(request, "restored", {});
    return reply(request, { state: "ready", message: "The client's own files are back in place.", receipt: "restored", restartRequired: [] });
  };

  switch (request.action) {
    case "install": return doInstall("Wrote");
    case "prepare_disable":
    case "prepare_remove": return doRestore();
    case "recover": return receipt && receipt.state === "restored" ? doRestore() : doInstall("Recovered and wrote");
    case "verify": {
      if (receipt && receipt.state === "restored") return reply(request, { state: "ready", message: "Reverie Client Data is off.", receipt: "restored" });
      const state = run.check({ tq });
      if (state.ok && receipt && receipt.state === "active") return reply(request, { state: "ready", message: `The client has the items of ${modList(state.mods)}.`, receipt: "active" });
      // The mod list changed since install: bring the client up to it now, while it is closed.
      return doInstall("Updated the client with");
    }
    default: return reply(request, { state: "failed", message: `Reverie Client Data does not handle ${request.action}.` });
  }
}

function main(argv = process.argv) {
  let request = null;
  let result;
  try {
    request = JSON.parse(fs.readFileSync(option(argv, "--request"), "utf8").replace(/^﻿/, ""));
    const coreDir = path.join(path.dirname(__dirname), "reverie-core");
    if (!fs.existsSync(path.join(coreDir, "client", "run.js"))) throw new Error("Reverie Core is not installed beside this mod.");
    result = handle(request, coreDir);
  } catch (error) {
    result = reply(request, { state: "failed", message: error && error.message ? error.message : String(error) });
  }
  fs.writeFileSync(option(argv, "--result"), JSON.stringify(result));
  if (!result.success) process.exitCode = 1;
}

module.exports = { handle, main, PROTOCOL, RECEIPT };

if (require.main === module) main();
