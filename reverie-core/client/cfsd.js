"use strict";

// Reader and writer for the EVE client's cFSD .fsdbinary files
// (res:/staticdata/*.fsdbinary), the files the client's staticDataLoaders
// .pyd modules read (typesLoader, groupsLoader, dogmaAttributesLoader,
// dogmaEffectsLoader, typeDogmaLoader). decode() + encode() reproduces CCP's
// files byte for byte (checked on all five); put() adds or replaces a record,
// and the writer lays out the file again, so records may grow.
//
// File:   [16 schema id][u64 checksum of file[32:]][u64 N = file length - 32][N bytes]
//         Every offset in the file counts from file offset 24 (the u64 N),
//         called "data offsets" here. The loader refuses a file whose checksum
//         is wrong ("Unexpected cFSD hash"): h = 0x25, then for each byte
//         h = (h * 0xd32b) ^ (byte * 0x12ca3), in 64 bits.
// Root:   at data 8: u64 24, u64 count, u64 nbuckets, nbuckets x u64 bucket
//         offset (data offset of each bucket's u64 count), then the buckets in
//         order, each starting at the record's alignment (8 in most files, 4
//         in marketgroups). The file end is not padded.
//         A key lives in bucket key % nbuckets; order inside a bucket is free.
// Bucket: u64 n, n entries, then the entries' variable data, in entry order
//         and field order (a list's items' own data follows the list).
// Entry:  u32 key, padded to the record's alignment, then the record.
// Record: fixed fields grouped by size (8-byte fields, then 4, then 1), each
//         group sorted by name; if the struct has optional fields, a u32 bit
//         field follows (bit i = i-th optional field by name); size padded
//         to the alignment. Strings and lists are u64 data offsets. An absent
//         field's slot keeps whatever was stored; the loader returns None.
// String: u64 length, bytes, NUL, 8-aligned. Equal strings are stored once in
//         the whole file (later records point at the first copy). An absent
//         optional string is still stored, as "".
// List:   u64 count, items, aligned to the item alignment; then the items'
//         own variable data, item by item. Not shared. An absent optional
//         list is still stored, as [].
//
// There are no secondary indexes: the client builds types-by-group and
// groups-by-category itself from GetTypes()/GetGroups().

// ------------------------------------------------------------------ schema

const SCALAR = {
  f64: { size: 8, align: 8 }, i64: { size: 8, align: 8 },
  u32: { size: 4, align: 4 }, i32: { size: 4, align: 4 }, f32: { size: 4, align: 4 },
  bool: { size: 1, align: 1 },
  str: { size: 8, align: 8, ptr: true }, list: { size: 8, align: 8, ptr: true },
};

// fields: [name, type, optional?]; type is a scalar name, "str", or
// { list: itemType } where itemType is a scalar name or a struct.
function struct(name, fields) {
  const list = fields.map(([fname, type, opt]) => {
    const kind = typeof type === "string" ? type : "list";
    return { name: fname, kind, item: typeof type === "string" ? null : type.list, opt: !!opt, ...SCALAR[kind] };
  });
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const optional = list.filter((f) => f.opt).sort(byName);
  optional.forEach((f, i) => { f.bit = i; });
  let off = 0;
  let align = 1;
  for (const size of [8, 4, 1]) {
    for (const f of list.filter((x) => x.size === size).sort(byName)) {
      off = Math.ceil(off / f.align) * f.align;
      f.off = off;
      off += f.size;
      align = Math.max(align, f.align);
    }
  }
  let bitsAt = -1;
  if (optional.length) {
    off = Math.ceil(off / 4) * 4;
    bitsAt = off;
    off += 4;
    align = Math.max(align, 4);
  }
  const size = Math.ceil(off / align) * align;
  const ordered = list.slice().sort((a, b) => a.off - b.off);
  return { name, fields: ordered, byName: Object.fromEntries(list.map((f) => [f.name, f])), optional, bitsAt, size, align };
}

const itemAlign = (item) => (typeof item === "string" ? SCALAR[item].align : item.align);
const itemSize = (item) => (typeof item === "string" ? SCALAR[item].size : item.size);

const MODIFIER = struct("modifier", [
  ["domain", "str"], ["func", "str"],
  ["effectID", "u32", 1], ["groupID", "u32", 1], ["modifiedAttributeID", "u32", 1],
  ["modifyingAttributeID", "u32", 1], ["operation", "i32", 1], ["skillTypeID", "u32", 1],
]);

const SCHEMAS = {
  types: struct("type", [
    ["basePrice", "f64", 1], ["capacity", "f64", 1], ["designerIDs", { list: "u32" }, 1], ["mass", "f64", 1],
    ["portionSize", "i64", 1], ["radius", "f64", 1], ["volume", "f64", 1],
    ["certificateTemplate", "u32", 1], ["descriptionID", "u32", 1], ["factionID", "u32", 1],
    // A required u32 with no accessor in typesLoader.pyd (the client never
    // reads it); 1 on 59 navy/Sansha NPC hulls, else 0. The name only has to
    // sort between factionID and graphicID.
    ["fz_unnamed", "u32"],
    ["graphicID", "u32", 1],
    ["groupID", "u32"], ["iconID", "u32", 1], ["isisGroupID", "u32", 1], ["marketGroupID", "u32", 1],
    ["metaGroupID", "u32", 1], ["metaLevel", "u32", 1], ["quoteAuthorID", "u32", 1], ["quoteID", "u32", 1],
    ["raceID", "u32", 1], ["soundID", "u32", 1], ["techLevel", "u32", 1], ["typeID", "u32"], ["typeNameID", "u32"],
    ["variationParentTypeID", "u32", 1], ["wreckTypeID", "u32", 1],
    ["isDynamicType", "bool", 1], ["published", "bool", 1],
  ]),
  groups: struct("group", [
    ["categoryID", "u32"], ["groupID", "u32"], ["groupNameID", "u32"], ["iconID", "u32", 1],
    ["anchorable", "bool", 1], ["anchored", "bool", 1], ["fittableNonSingleton", "bool", 1],
    ["published", "bool", 1], ["useBasePrice", "bool", 1],
  ]),
  dogmaattributes: struct("attribute", [
    ["description", "str", 1], ["name", "str"],
    ["attributeID", "u32"], ["categoryID", "u32", 1], ["chargeRechargeTimeID", "u32", 1], ["dataType", "u32"],
    ["defaultValue", "f32"], ["displayNameID", "u32", 1], ["iconID", "u32", 1], ["maxAttributeID", "u32", 1],
    ["minAttributeID", "u32", 1], ["tooltipDescriptionID", "u32", 1], ["tooltipTitleID", "u32", 1], ["unitID", "u32", 1],
    ["displayWhenZero", "bool", 1], ["highIsGood", "bool"], ["published", "bool"], ["stackable", "bool"],
  ]),
  dogmaeffects: struct("effect", [
    ["effectName", "str"], ["guid", "str", 1], ["modifierInfo", { list: MODIFIER }, 1], ["sfxName", "str", 1],
    ["descriptionID", "u32", 1], ["dischargeAttributeID", "u32", 1], ["displayNameID", "u32", 1],
    ["distribution", "u32", 1], ["durationAttributeID", "u32", 1], ["effectCategory", "u32"], ["effectID", "u32"],
    ["falloffAttributeID", "u32", 1], ["fittingUsageChanceAttributeID", "u32", 1], ["iconID", "u32", 1],
    ["npcActivationChanceAttributeID", "u32", 1], ["npcUsageChanceAttributeID", "u32", 1],
    ["rangeAttributeID", "u32", 1], ["resistanceAttributeID", "u32", 1], ["trackingSpeedAttributeID", "u32", 1],
    ["disallowAutoRepeat", "bool"], ["electronicChance", "bool"], ["isAssistance", "bool"], ["isOffensive", "bool"],
    ["isWarpSafe", "bool"], ["propulsionChance", "bool"], ["published", "bool"], ["rangeChance", "bool"],
  ]),
  // marketgroups.fsdbinary (marketGroupsLoader.pyd), keyed by marketGroupID.
  // Field names are the loader's accessors.
  marketgroups: struct("marketGroup", [
    ["descriptionID", "u32", 1], ["iconID", "u32", 1], ["nameID", "u32"], ["parentGroupID", "u32", 1],
    ["hasTypes", "bool"],
  ]),
  // CCP keeps each type's attribute list sorted by attributeID.
  typedogma: struct("typeDogma", [
    ["dogmaAttributes", { list: struct("attr", [["attributeID", "u32"], ["value", "f64"]]) }],
    ["dogmaEffects", { list: struct("eff", [["effectID", "u32"], ["isDefault", "bool"]]) }],
  ]),
};

// ----------------------------------------------------------------- reading

const DATA = 24;

function readScalar(b, kind, at) {
  switch (kind) {
    case "f64": return b.readDoubleLE(at);
    case "i64": return Number(b.readBigInt64LE(at));
    case "u32": return b.readUInt32LE(at);
    case "i32": return b.readInt32LE(at);
    case "f32": return b.readFloatLE(at);
    case "bool": return b[at];
    default: throw new Error(kind);
  }
}

function readString(b, off) {
  const at = DATA + off;
  const n = Number(b.readBigUInt64LE(at));
  return b.toString("utf8", at + 8, at + 8 + n);
}

function readList(b, item, off) {
  const at = DATA + off;
  const n = Number(b.readBigUInt64LE(at));
  const out = [];
  const size = itemSize(item);
  for (let i = 0; i < n; i += 1) {
    out.push(typeof item === "string" ? readScalar(b, item, at + 8 + i * size) : readStruct(b, item, at + 8 + i * size));
  }
  return out;
}

// A record as a plain object. Every field is kept, also absent optional ones
// (their stored value is not always 0; an absent string or list is "" or []),
// plus _bits, the presence bits of the optional fields.
function readStruct(b, s, at) {
  const out = {};
  if (s.bitsAt >= 0) out._bits = b.readUInt32LE(at + s.bitsAt);
  for (const f of s.fields) {
    if (!f.ptr) { out[f.name] = readScalar(b, f.kind, at + f.off); continue; }
    const ptr = Number(b.readBigUInt64LE(at + f.off));
    out[f.name] = f.kind === "str" ? readString(b, ptr) : readList(b, f.item, ptr);
  }
  return out;
}

function decode(buffer, schema) {
  const b = buffer;
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  if (u64(24) !== b.length - 32) throw new Error("size field does not match the file length");
  if (u64(32) !== 24) throw new Error("unexpected root header");
  const count = u64(40);
  const nbuckets = u64(48);
  const entryAt = Math.ceil(4 / schema.align) * schema.align;
  const records = new Map();
  const order = []; // [bucket][keys in stored order]
  for (let i = 0; i < nbuckets; i += 1) {
    const at = DATA + u64(56 + 8 * i);
    const n = u64(at);
    const keys = [];
    for (let j = 0; j < n; j += 1) {
      const e = at + 8 + j * (entryAt + schema.size);
      const key = b.readUInt32LE(e);
      if (key % nbuckets !== i) throw new Error(`key ${key} in bucket ${i}, expected ${key % nbuckets}`);
      records.set(key, readStruct(b, schema, e + entryAt));
      keys.push(key);
    }
    order.push(keys);
  }
  if (records.size !== count) throw new Error(`count ${count} but ${records.size} records`);
  return { schemaID: Buffer.from(b.subarray(0, 16)), nbuckets, records, order, schema };
}

// ----------------------------------------------------------------- writing

class Writer {
  constructor() { this.buf = Buffer.alloc(1 << 20); this.pos = 0; this.strings = new Map(); }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  align(a) { const p = Math.ceil(this.pos / a) * a; this.ensure(p - this.pos); this.pos = p; }
  reserve(n) { this.ensure(n); const at = this.pos; this.pos += n; return at; }
  u64(at, v) { this.buf.writeBigUInt64LE(BigInt(v), at); }
}

function writeScalar(w, kind, at, v) {
  switch (kind) {
    case "f64": w.buf.writeDoubleLE(v, at); break;
    case "i64": w.buf.writeBigInt64LE(BigInt(v), at); break;
    case "u32": w.buf.writeUInt32LE(v >>> 0, at); break;
    case "i32": w.buf.writeInt32LE(v | 0, at); break;
    case "f32": w.buf.writeFloatLE(v, at); break;
    case "bool": w.buf[at] = v ? 1 : 0; break;
    default: throw new Error(kind);
  }
}

// Bits of a record: its _bits, or else its optional fields that have a value
// (not undefined or null).
function bitsFor(s, rec) {
  if (rec._bits !== undefined) return rec._bits >>> 0;
  let bits = 0;
  for (const f of s.optional) if (rec[f.name] !== undefined && rec[f.name] !== null) bits |= 1 << f.bit;
  return bits >>> 0;
}

const defaultOf = (f) => (f.kind === "str" ? "" : f.kind === "list" ? [] : 0);

// Fixed part at `at`; returns the deferred variable data writers.
function writeFixed(w, s, at, rec) {
  const bits = bitsFor(s, rec);
  if (s.bitsAt >= 0) w.buf.writeUInt32LE(bits, at + s.bitsAt);
  const deferred = [];
  for (const f of s.fields) {
    const v = rec[f.name] === undefined || rec[f.name] === null ? defaultOf(f) : rec[f.name];
    if (!f.ptr) { writeScalar(w, f.kind, at + f.off, v); continue; }
    deferred.push(() => w.u64(at + f.off, f.kind === "str" ? writeString(w, v) : writeList(w, f.item, v)));
  }
  return deferred;
}

function writeString(w, str) {
  const bytes = Buffer.from(str, "utf8");
  const k = bytes.toString("latin1");
  if (w.strings.has(k)) return w.strings.get(k);
  w.align(8);
  const at = w.reserve(8 + bytes.length + 1);
  w.u64(at, bytes.length);
  bytes.copy(w.buf, at + 8);
  w.buf[at + 8 + bytes.length] = 0;
  w.strings.set(k, at);
  return at;
}

function writeList(w, item, values) {
  w.align(itemAlign(item));
  const size = itemSize(item);
  const at = w.reserve(8 + values.length * size);
  w.u64(at, values.length);
  const deferred = [];
  values.forEach((v, i) => {
    if (typeof item === "string") writeScalar(w, item, at + 8 + i * size, v);
    else deferred.push(...writeFixed(w, item, at + 8 + i * size, v));
  });
  for (const d of deferred) d();
  return at;
}

// The header checksum, in two 32-bit halves (BigInt is slow on 12 MB).
function checksum(file) {
  let lo = 0x25; let hi = 0;
  const M = 0xd32b;
  for (let i = 32; i < file.length; i += 1) {
    const loM = lo * M; // < 2^48, exact
    const carry = Math.floor(loM / 4294967296);
    hi = (Math.imul(hi, M) + carry) >>> 0;
    lo = ((loM >>> 0) ^ (file[i] * 0x12ca3)) >>> 0;
  }
  return (BigInt(hi) << 32n) | BigInt(lo);
}

// The same in BigInt, as a second opinion for tests.
function checksumSlow(file) {
  const mask = (1n << 64n) - 1n;
  let h = 0x25n;
  for (let i = 32; i < file.length; i += 1) h = ((h * 0xd32bn) & mask) ^ (BigInt(file[i]) * 0x12ca3n);
  return h;
}

function encode(dec) {
  const { schema, nbuckets, records, order } = dec;
  const w = new Writer();
  const entryAt = Math.ceil(4 / schema.align) * schema.align;
  const entrySize = entryAt + schema.size;
  w.reserve(32 + 8 * nbuckets);
  w.u64(8, 24);
  w.u64(16, records.size);
  w.u64(24, nbuckets);
  for (let i = 0; i < nbuckets; i += 1) {
    // Buckets start at the record's alignment: 8 for every file but
    // marketgroups, whose 28-byte entries leave buckets 4-aligned.
    w.align(schema.align);
    w.u64(32 + 8 * i, w.pos);
    const keys = order[i];
    const at = w.reserve(8 + keys.length * entrySize);
    w.u64(at, keys.length);
    const deferred = [];
    keys.forEach((key, j) => {
      const e = at + 8 + j * entrySize;
      w.buf.writeUInt32LE(key, e);
      deferred.push(...writeFixed(w, schema, e + entryAt, records.get(key)));
    });
    for (const d of deferred) d();
  }
  w.u64(0, w.pos - 8);
  const file = Buffer.alloc(24 + w.pos);
  dec.schemaID.copy(file, 0);
  w.buf.copy(file, 24, 0, w.pos);
  file.writeBigUInt64LE(checksum(file), 16);
  return file;
}

// Add or replace a record. New keys go at the end of their bucket.
function put(dec, key, record) {
  if (!dec.records.has(key)) dec.order[key % dec.nbuckets].push(key);
  dec.records.set(key, record);
}

// Bit mask of the named optional fields of a struct.
function bitsOf(schema, names) {
  let bits = 0;
  for (const name of names) {
    const f = schema.byName[name];
    if (!f || !f.opt) throw new Error(`${schema.name}.${name} is not an optional field`);
    bits |= 1 << f.bit;
  }
  return bits >>> 0;
}

function hasField(schema, rec, name) {
  const f = schema.byName[name];
  return !f.opt || ((rec._bits >>> f.bit) & 1) === 1;
}

// ------------------------------------------- dictionaries of dictionaries
//
// requiredSkillsForTypes.fsdbinary: the same root, but each entry is
//   u32 typeID, pad to 8, u64 data offset of an inner dictionary, u64 its length
// and the inner dictionary is u64 nbuckets, nbuckets x u64 bucket offset, then
// buckets of u64 n, n x { u32 skillTypeID, u32 level }.
// emptyInnerDicts() makes the inner dictionaries of `keys` empty in place
// (length 0, every inner bucket n = 0) and fixes the checksum; the file keeps
// its size and every other byte. Returns the keys it found.
function emptyInnerDicts(buffer, keys) {
  const b = Buffer.from(buffer);
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  if (u64(24) !== b.length - 32 || u64(32) !== 24) throw new Error("not a cFSD dictionary file");
  const nbuckets = u64(48);
  const found = [];
  for (const key of keys) {
    const at = DATA + u64(56 + 8 * (key % nbuckets));
    const n = u64(at);
    for (let j = 0; j < n; j += 1) {
      const e = at + 8 + j * 24;
      if (b.readUInt32LE(e) !== key) continue;
      const inner = DATA + u64(e + 8);
      const innerBuckets = u64(inner);
      for (let k = 0; k < innerBuckets; k += 1) b.writeBigUInt64LE(0n, DATA + u64(inner + 8 + 8 * k));
      b.writeBigUInt64LE(0n, e + 16);
      found.push(key);
    }
  }
  b.writeBigUInt64LE(checksum(b), 16);
  return { buffer: b, found };
}

// { typeID: { skillTypeID: level } } of a requiredSkillsForTypes file.
function readInnerDicts(buffer) {
  const b = buffer;
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  const nbuckets = u64(48);
  const out = new Map();
  for (let i = 0; i < nbuckets; i += 1) {
    const at = DATA + u64(56 + 8 * i);
    const n = u64(at);
    for (let j = 0; j < n; j += 1) {
      const e = at + 8 + j * 24;
      const inner = DATA + u64(e + 8);
      const skills = {};
      const innerBuckets = u64(inner);
      for (let k = 0; k < innerBuckets; k += 1) {
        const bucket = DATA + u64(inner + 8 + 8 * k);
        for (let m = 0; m < u64(bucket); m += 1) skills[b.readUInt32LE(bucket + 8 + 8 * m)] = b.readUInt32LE(bucket + 12 + 8 * m);
      }
      out.set(b.readUInt32LE(e), { length: u64(e + 16), skills });
    }
  }
  return out;
}

// The whole file, to add entries (emptyInnerDicts only rewrites in place).
// Layout as CCP writes it: each bucket's u64 n and its n entries, then each
// entry's inner dictionary in entry order (u64 inner nbuckets, the inner
// bucket offsets, then the inner buckets), all 8-aligned, padding zero.
// decodeInnerDicts() + encodeInnerDicts() reproduce CCP's file byte for byte;
// each entry keeps its inner buckets as read. An inner skill lives in bucket
// skillTypeID % inner nbuckets.
function decodeInnerDicts(buffer) {
  const b = buffer;
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  if (u64(24) !== b.length - 32 || u64(32) !== 24) throw new Error("not a cFSD dictionary file");
  const count = u64(40);
  const nbuckets = u64(48);
  const order = [];
  const entries = new Map();
  for (let i = 0; i < nbuckets; i += 1) {
    const at = DATA + u64(56 + 8 * i);
    const keys = [];
    for (let j = 0; j < u64(at); j += 1) {
      const e = at + 8 + j * 24;
      const key = b.readUInt32LE(e);
      const inner = DATA + u64(e + 8);
      const buckets = [];
      for (let k = 0; k < u64(inner); k += 1) {
        const bucket = DATA + u64(inner + 8 + 8 * k);
        const items = [];
        for (let m = 0; m < u64(bucket); m += 1) items.push([b.readUInt32LE(bucket + 8 + 8 * m), b.readUInt32LE(bucket + 12 + 8 * m)]);
        buckets.push(items);
      }
      entries.set(key, { length: u64(e + 16), buckets });
      keys.push(key);
    }
    order.push(keys);
  }
  if (entries.size !== count) throw new Error(`count ${count} but ${entries.size} entries`);
  return { schemaID: Buffer.from(b.subarray(0, 16)), nbuckets, order, entries };
}

function encodeInnerDicts(dec) {
  const { nbuckets, order, entries } = dec;
  const w = new Writer();
  w.reserve(32 + 8 * nbuckets);
  w.u64(8, 24);
  w.u64(16, entries.size);
  w.u64(24, nbuckets);
  for (let i = 0; i < nbuckets; i += 1) {
    w.align(8);
    w.u64(32 + 8 * i, w.pos);
    const keys = order[i];
    const at = w.reserve(8 + keys.length * 24);
    w.u64(at, keys.length);
    keys.forEach((key, j) => w.buf.writeUInt32LE(key, at + 8 + j * 24));
    keys.forEach((key, j) => {
      const entry = entries.get(key);
      const e = at + 8 + j * 24;
      w.align(8);
      w.u64(e + 8, w.pos);
      w.u64(e + 16, entry.length);
      const table = w.reserve(8 + 8 * entry.buckets.length);
      w.u64(table, entry.buckets.length);
      entry.buckets.forEach((items, k) => {
        w.align(8);
        w.u64(table + 8 + 8 * k, w.pos);
        const bucket = w.reserve(8 + 8 * items.length);
        w.u64(bucket, items.length);
        items.forEach(([skillTypeID, level], m) => {
          w.buf.writeUInt32LE(skillTypeID >>> 0, bucket + 8 + 8 * m);
          w.buf.writeUInt32LE(level >>> 0, bucket + 12 + 8 * m);
        });
      });
    });
  }
  w.u64(0, w.pos - 8);
  const file = Buffer.alloc(24 + w.pos);
  dec.schemaID.copy(file, 0);
  w.buf.copy(file, 24, 0, w.pos);
  file.writeBigUInt64LE(checksum(file), 16);
  return file;
}

// Add or replace a type's skills ({ skillTypeID: level }); {} empties it. A
// new type goes at the end of its bucket; inner buckets as CCP sizes them
// (one for one skill, two for more).
function putInnerDict(dec, key, skills) {
  const list = Object.entries(skills || {}).map(([skillTypeID, level]) => [Number(skillTypeID), Number(level)]);
  const existing = dec.entries.get(key);
  const nb = existing ? existing.buckets.length : Math.max(1, Math.min(2, list.length));
  const buckets = Array.from({ length: nb }, () => []);
  for (const item of list) buckets[item[0] % nb].push(item);
  if (!existing) dec.order[key % dec.nbuckets].push(key);
  dec.entries.set(key, { length: list.length, buckets });
}

module.exports = {
  SCHEMAS, MODIFIER, struct, decode, encode, put, bitsOf, hasField,
  checksum, checksumSlow, readStruct, emptyInnerDicts, readInnerDicts,
  decodeInnerDicts, encodeInnerDicts, putInnerDict,
};
