"use strict";
// The client's resource index and the files behind it.
//
// The client finds every resource through <tq>/resfileindex*.txt, one line per resource:
//   res:/staticdata/types.fsdbinary,3c/3cc5bf8ff5e9099a_<md5>,<md5>,<size>,<download size>
// and loads ResFiles/<relative>, checking the md5. A patched resource is written beside CCP's as
// ResFiles/<dir>/<prefix>_<new md5> and the line is pointed at it, so CCP's file is never touched
// and putting the old line back restores it exactly. Every index file that names a resource must
// name the same file. The ledger (_local/reverie/clientPatch.json) keeps each line Reverie changed
// and the one it replaced.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const INDEX_FILES = ["resfileindex.txt", "resfileindex_Windows.txt", "resfileindex_prefetch.txt"];
// A client folder holding this file is a test copy, where the running-client check does not apply.
const TEST_CLIENT_MARKER = "EVEJS_TEST_CLIENT";

const md5 = (buffer) => crypto.createHash("md5").update(buffer).digest("hex");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const writeFileAtomic = require("../lib/atomicWrite").writeAtomic;

function parseLine(line) {
  const [resource, relative, hash, size, compressed] = String(line).split(",");
  return { resource, relative, hash, size: Number(size), compressed };
}

function clientIsRunning(tq) {
  if (fs.existsSync(path.join(tq, TEST_CLIENT_MARKER))) return false;
  if (process.platform !== "win32") return false;
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq exefile.exe"], { encoding: "utf8" });
  return String(out.stdout || "").toLowerCase().includes("exefile.exe");
}

// The client's tq folder: the one given, else the launcher's setting, else the EveJS client
// config the repo's Play.bat uses.
function findClientTq({ explicit, repoRoot } = {}) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.REVERIE_CLIENT_TQ) candidates.push(process.env.REVERIE_CLIENT_TQ);
  if (repoRoot) {
    const config = path.join(repoRoot, "tools", "ClientSETUP", "scripts", "EvEJSConfig.bat");
    const match = fs.existsSync(config) && fs.readFileSync(config, "utf8").match(/set\s+"EVEJS_CLIENT_PATH=([^"]+)"/i);
    if (match) candidates.push(match[1].trim());
  }
  for (const candidate of candidates) {
    const tq = path.basename(candidate).toLowerCase() === "tq" ? candidate : path.join(candidate, "tq");
    if (fs.existsSync(path.join(tq, INDEX_FILES[0]))) return path.resolve(tq);
    if (fs.existsSync(path.join(candidate, INDEX_FILES[0]))) return path.resolve(candidate);
  }
  return null;
}

class Indexes {
  constructor(tq) {
    this.tq = path.resolve(tq);
    this.resFiles = path.join(path.dirname(this.tq), "ResFiles");
    this.files = INDEX_FILES.map((name) => path.join(this.tq, name)).filter((file) => fs.existsSync(file))
      .map((file) => ({ file, text: fs.readFileSync(file, "utf8"), changed: false }));
    if (!this.files.length) throw new Error(`${this.tq} has no ${INDEX_FILES[0]}; it is not an EVE client's tq folder.`);
    if (!fs.existsSync(this.resFiles)) throw new Error(`${this.resFiles} is missing.`);
  }

  // The one line the index files have for a resource, or null when none has it.
  find(resource) {
    const prefix = `${resource},`;
    const lines = new Set();
    for (const index of this.files) {
      const start = index.text.startsWith(prefix) ? 0 : index.text.indexOf(`\n${prefix}`);
      if (start < 0) continue;
      const from = start === 0 ? 0 : start + 1;
      const end = index.text.indexOf("\n", from);
      lines.add(index.text.slice(from, end < 0 ? undefined : end).replace(/\r$/, ""));
    }
    if (lines.size > 1) throw new Error(`The index files disagree about ${resource}; not touching it.`);
    return lines.size ? [...lines][0] : null;
  }

  line(resource) {
    const line = this.find(resource);
    if (!line) throw new Error(`${resource} is not in the client's resource index.`);
    return line;
  }

  replace(from, to) {
    if (from === to) return 0;
    let count = 0;
    for (const index of this.files) {
      const at = index.text.indexOf(from);
      if (at < 0) continue;
      if (index.text.indexOf(from, at + 1) >= 0) throw new Error(`${path.basename(index.file)} names ${parseLine(from).resource} twice.`);
      index.text = index.text.slice(0, at) + to + index.text.slice(at + from.length);
      index.changed = true;
      count += 1;
    }
    return count;
  }

  // Backups the first time, then each changed index file is replaced whole.
  save() {
    for (const index of this.files) {
      if (!index.changed) continue;
      const backup = `${index.file}.reverie-original`;
      if (!fs.existsSync(backup)) fs.copyFileSync(index.file, backup);
      writeFileAtomic(index.file, index.text);
      index.changed = false;
    }
  }

  read(line) {
    const info = parseLine(line);
    const file = path.join(this.resFiles, info.relative);
    if (!fs.existsSync(file)) throw new Error(`${info.resource}: ${file} is missing.`);
    const buffer = fs.readFileSync(file);
    if (md5(buffer) !== info.hash) throw new Error(`${info.relative} does not match its md5; not touching it.`);
    return buffer;
  }

  // Writes the buffer beside the original and returns the line that names it.
  write(originalLine, buffer, { dryRun = false } = {}) {
    const original = parseLine(originalLine);
    const hash = md5(buffer);
    const dir = path.posix.dirname(original.relative);
    const prefix = path.posix.basename(original.relative).split("_")[0];
    const relative = dir && dir !== "." ? `${dir}/${prefix}_${hash}` : `${prefix}_${hash}`;
    const target = path.join(this.resFiles, relative);
    if (!dryRun && (!fs.existsSync(target) || md5(fs.readFileSync(target)) !== hash)) writeFileAtomic(target, buffer);
    // The download size stays CCP's, as the repo's patch tools keep it.
    return [original.resource, relative, hash, buffer.length, original.compressed].join(",");
  }
}

module.exports = { INDEX_FILES, TEST_CLIENT_MARKER, Indexes, parseLine, md5, sha256, writeFileAtomic, clientIsRunning, findClientTq };
