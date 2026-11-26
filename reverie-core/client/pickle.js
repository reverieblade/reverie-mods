"use strict";
// A small Python pickle reader and writer, enough for the client's own pickles, so that a
// player's machine needs no Python to take a Reverie client patch.
//
// The client files it was written for:
//   res:/localizationfsd/localization_fsd_<lang>.pickle   protocol 0 text: ('en-us', {messageID: (text, None, None)})
//   res:/staticdata/blueprintsbymaterialtypeids.pickle   protocol 2: {material typeID: [blueprint typeID, ...]}
//
// Values: int -> number (BigInt beyond 2^53), str (protocol 0 S, binary T and U) -> PyBytes,
// unicode -> string, None -> null, True and False -> booleans, float -> number, list -> Array,
// tuple -> Tuple (an Array subclass), dict -> Map. An opcode outside this set throws, so a file
// in a shape this reader does not know is never half read.

class Tuple extends Array {}
class PyBytes {
  constructor(buffer) { this.buffer = Buffer.from(buffer); }
  toString() { return this.buffer.toString("latin1"); }
}

const MARK = Symbol("mark");

function tuple(...items) {
  const result = new Tuple();
  for (const item of items) result.push(item);
  return result;
}

function decodeRawUnicodeEscape(bytes) {
  const text = bytes.toString("latin1");
  if (!text.includes("\\")) return text;
  return text.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (_, short, long) =>
    String.fromCodePoint(parseInt(short || long, 16)));
}

// Python 2 protocol 0 STRING: a repr in single or double quotes.
function decodeStringRepr(line) {
  const quote = line[0];
  if ((quote !== "'" && quote !== '"') || line[line.length - 1] !== quote) throw new Error(`pickle: bad string ${line.slice(0, 40)}`);
  const body = line.slice(1, -1);
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") { out.push(ch.charCodeAt(0) & 0xff); continue; }
    const next = body[++i];
    const simple = { n: 10, t: 9, r: 13, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, 0: 0 };
    if (next === "x") { out.push(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; }
    else if (/[0-7]/.test(next)) {
      let digits = next;
      while (digits.length < 3 && /[0-7]/.test(body[i + 1])) digits += body[++i];
      out.push(parseInt(digits, 8) & 0xff);
    } else if (next in simple) out.push(simple[next]);
    else { out.push(92, next.charCodeAt(0) & 0xff); }
  }
  return new PyBytes(Buffer.from(out));
}

function decodeLong(bytes) {
  if (!bytes.length) return 0;
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  if (bytes[bytes.length - 1] & 0x80) value -= 1n << BigInt(bytes.length * 8);
  return smallest(value);
}

function smallest(big) {
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

function loads(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const stack = [];
  const memo = new Map();
  let at = 0;
  const line = () => {
    const end = data.indexOf(10, at);
    if (end < 0) throw new Error("pickle: unterminated line");
    const text = data.toString("latin1", at, end);
    at = end + 1;
    return text;
  };
  const lineBytes = () => {
    const end = data.indexOf(10, at);
    if (end < 0) throw new Error("pickle: unterminated line");
    const bytes = data.subarray(at, end);
    at = end + 1;
    return bytes;
  };
  const take = (n) => {
    if (at + n > data.length) throw new Error("pickle: truncated");
    const bytes = data.subarray(at, at + n);
    at += n;
    return bytes;
  };
  const popMark = () => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i] === MARK) {
        const items = stack.splice(i + 1);
        stack.pop();
        return items;
      }
    }
    throw new Error("pickle: no mark");
  };
  const top = () => {
    if (!stack.length) throw new Error("pickle: empty stack");
    return stack[stack.length - 1];
  };
  const setItems = (dict, items) => {
    if (!(dict instanceof Map)) throw new Error("pickle: SETITEM on a non-dict");
    for (let i = 0; i < items.length; i += 2) dict.set(key(items[i]), items[i + 1]);
  };
  while (at < data.length) {
    const op = data[at++];
    switch (op) {
      case 0x80: { const proto = data[at++]; if (proto > 2) throw new Error(`pickle: protocol ${proto} not supported`); break; }
      case 0x2e: { // .
        if (stack.length !== 1) throw new Error(`pickle: ${stack.length} items left at STOP`);
        return stack[0];
      }
      case 0x28: stack.push(MARK); break; // (
      case 0x30: stack.pop(); break; // 0
      case 0x31: popMark(); break; // 1
      case 0x32: stack.push(top()); break; // 2
      case 0x4e: stack.push(null); break; // N
      case 0x88: stack.push(true); break;
      case 0x89: stack.push(false); break;
      case 0x49: { // I
        const text = line();
        if (text === "01") stack.push(true);
        else if (text === "00") stack.push(false);
        else stack.push(smallest(BigInt(text)));
        break;
      }
      case 0x4c: stack.push(smallest(BigInt(line().replace(/L$/, "")))); break; // L
      case 0x46: stack.push(Number(line())); break; // F
      case 0x47: stack.push(take(8).readDoubleBE(0)); break; // G
      case 0x4a: stack.push(take(4).readInt32LE(0)); break; // J
      case 0x4b: stack.push(take(1)[0]); break; // K
      case 0x4d: stack.push(take(2).readUInt16LE(0)); break; // M
      case 0x8a: { const n = take(1)[0]; stack.push(decodeLong(take(n))); break; }
      case 0x8b: { const n = take(4).readInt32LE(0); stack.push(decodeLong(take(n))); break; }
      case 0x53: stack.push(decodeStringRepr(line())); break; // S
      case 0x54: { const n = take(4).readInt32LE(0); stack.push(new PyBytes(take(n))); break; } // T
      case 0x55: { const n = take(1)[0]; stack.push(new PyBytes(take(n))); break; } // U
      case 0x56: stack.push(decodeRawUnicodeEscape(lineBytes())); break; // V
      case 0x58: { const n = take(4).readUInt32LE(0); stack.push(take(n).toString("utf8")); break; } // X
      case 0x29: stack.push(new Tuple()); break; // )
      case 0x74: stack.push(tuple(...popMark())); break; // t
      case 0x85: stack.push(tuple(stack.pop())); break;
      case 0x86: { const b = stack.pop(); const a = stack.pop(); stack.push(tuple(a, b)); break; }
      case 0x87: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push(tuple(a, b, c)); break; }
      case 0x5d: stack.push([]); break; // ]
      case 0x6c: stack.push(popMark()); break; // l
      case 0x61: { const value = stack.pop(); const list = top(); if (!Array.isArray(list)) throw new Error("pickle: APPEND on a non-list"); list.push(value); break; } // a
      case 0x65: { const items = popMark(); const list = top(); if (!Array.isArray(list)) throw new Error("pickle: APPENDS on a non-list"); for (const item of items) list.push(item); break; } // e
      case 0x7d: stack.push(new Map()); break; // }
      case 0x64: { const dict = new Map(); setItems(dict, popMark()); stack.push(dict); break; } // d
      case 0x73: { const value = stack.pop(); const k = stack.pop(); setItems(top(), [k, value]); break; } // s
      case 0x75: { const items = popMark(); setItems(top(), items); break; } // u
      case 0x70: memo.set(Number(line()), top()); break; // p
      case 0x71: memo.set(take(1)[0], top()); break; // q
      case 0x72: memo.set(take(4).readUInt32LE(0), top()); break; // r
      case 0x67: stack.push(memoGet(memo, Number(line()))); break; // g
      case 0x68: stack.push(memoGet(memo, take(1)[0])); break; // h
      case 0x6a: stack.push(memoGet(memo, take(4).readUInt32LE(0))); break; // j
      default:
        throw new Error(`pickle: opcode 0x${op.toString(16)} at ${at - 1} is not supported`);
    }
  }
  throw new Error("pickle: no STOP");
}

function memoGet(memo, index) {
  if (!memo.has(index)) throw new Error(`pickle: memo ${index} missing`);
  return memo.get(index);
}

// Dict keys: numbers and strings stay as they are; bytes keys become their latin1 text.
function key(value) {
  if (value instanceof PyBytes) return value.toString();
  return value;
}

// ------------------------------------------------------------------ writing (protocol 2)

function dumps(value) {
  const parts = [Buffer.from([0x80, 0x02])];
  const push = (...bytes) => parts.push(Buffer.from(bytes));
  const int32 = (op, n) => { const b = Buffer.alloc(5); b[0] = op; b.writeInt32LE(n, 1); parts.push(b); };
  const write = (item) => {
    if (item === null || item === undefined) return push(0x4e);
    if (item === true) return push(0x88);
    if (item === false) return push(0x89);
    if (typeof item === "bigint") return writeLong(item);
    if (typeof item === "number") {
      if (Number.isInteger(item)) {
        if (item >= 0 && item < 256) return push(0x4b, item);
        if (item >= 0 && item < 65536) return push(0x4d, item & 0xff, item >> 8);
        if (item >= -0x80000000 && item <= 0x7fffffff) return int32(0x4a, item);
        return writeLong(BigInt(item));
      }
      const b = Buffer.alloc(9); b[0] = 0x47; b.writeDoubleBE(item, 1); return parts.push(b);
    }
    if (typeof item === "string") {
      const bytes = Buffer.from(item, "utf8");
      const head = Buffer.alloc(5); head[0] = 0x58; head.writeUInt32LE(bytes.length, 1);
      return parts.push(head, bytes);
    }
    if (item instanceof PyBytes) {
      if (item.buffer.length < 256) parts.push(Buffer.from([0x55, item.buffer.length]));
      else { const head = Buffer.alloc(5); head[0] = 0x54; head.writeInt32LE(item.buffer.length, 1); parts.push(head); }
      return parts.push(item.buffer);
    }
    if (item instanceof Tuple) {
      if (!item.length) return push(0x29);
      if (item.length <= 3) { item.forEach(write); return push([0x85, 0x86, 0x87][item.length - 1]); }
      push(0x28); item.forEach(write); return push(0x74);
    }
    if (Array.isArray(item)) {
      push(0x5d);
      for (let i = 0; i < item.length; i += 1000) {
        const chunk = item.slice(i, i + 1000);
        if (chunk.length === 1) { write(chunk[0]); push(0x61); }
        else { push(0x28); chunk.forEach(write); push(0x65); }
      }
      return undefined;
    }
    if (item instanceof Map) {
      push(0x7d);
      const entries = [...item.entries()];
      for (let i = 0; i < entries.length; i += 1000) {
        push(0x28);
        for (const [k, v] of entries.slice(i, i + 1000)) { write(k); write(v); }
        push(0x75);
      }
      return undefined;
    }
    throw new Error(`pickle: cannot write ${Object.prototype.toString.call(item)}`);
  };
  const writeLong = (big) => {
    const bytes = [];
    let v = big;
    while (true) {
      const byte = Number(v & 0xffn);
      bytes.push(byte);
      v >>= 8n;
      if ((v === 0n && !(byte & 0x80)) || (v === -1n && (byte & 0x80))) break;
    }
    if (bytes.length > 255) throw new Error("pickle: long too large");
    parts.push(Buffer.from([0x8a, bytes.length, ...bytes]));
  };
  write(value);
  push(0x2e);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ localization

// Python 2's protocol 0 UNICODE: raw-unicode-escape with backslash and newline escaped.
function encodeRawUnicodeEscape(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) out.push(`\\U${cp.toString(16).padStart(8, "0")}`);
    else if (cp > 0xff || cp === 0x5c || cp === 0x0a || cp === 0x0d || cp === 0x00) out.push(`\\u${cp.toString(16).padStart(4, "0")}`);
    else out.push(String.fromCharCode(cp));
  }
  return Buffer.from(out.join(""), "latin1");
}

// A localization pickle is (language, {messageID: (text, None, None)}). Adds or replaces the
// given messages ({messageID: text}) and returns the new file. A protocol 0 file is extended in
// place: the new SETITEMs go just before the closing TUPLE and STOP, so CCP's bytes stay as they
// were and a later entry wins as a dict assignment does. Any other shape is decoded and written
// again as protocol 2. The result is always read back and checked.
function addMessages(original, messages) {
  const ids = Object.keys(messages).map(Number);
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`localization: bad message ID ${id}`);
    if (typeof messages[id] !== "string") throw new Error(`localization: message ${id} is not text`);
  }
  let result;
  const tail = original.subarray(original.length - 3).toString("latin1");
  if (original[0] === 0x28 && tail === "st.") {
    const added = ids.sort((a, b) => a - b).map((id) => Buffer.concat([
      Buffer.from(`I${id}\n(V`, "latin1"),
      encodeRawUnicodeEscape(messages[id]),
      Buffer.from("\nNNts", "latin1"),
    ]));
    result = Buffer.concat([original.subarray(0, original.length - 2), ...added, Buffer.from("t.", "latin1")]);
  } else {
    const decoded = loads(original);
    const dict = checkLocalization(decoded);
    for (const id of ids) dict.set(id, tuple(messages[id], null, null));
    result = dumps(decoded);
  }
  const back = checkLocalization(loads(result));
  for (const id of ids) {
    const entry = back.get(id);
    if (!(entry instanceof Tuple) || entry[0] !== messages[id]) throw new Error(`localization: message ${id} did not read back`);
  }
  return result;
}

function checkLocalization(decoded) {
  if (!(decoded instanceof Tuple) || decoded.length !== 2 || !(decoded[1] instanceof Map)) {
    throw new Error("localization: not a (language, {messageID: entry}) pickle");
  }
  return decoded[1];
}

function readMessages(buffer) {
  return checkLocalization(loads(buffer));
}

module.exports = { loads, dumps, addMessages, readMessages, tuple, Tuple, PyBytes, encodeRawUnicodeEscape };
