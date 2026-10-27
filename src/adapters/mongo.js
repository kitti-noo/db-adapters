const { MongoClient, BSON } = require("mongodb");
const { MONGO_WRITE_OPS, stripLineComments } = require("./common");

const { EJSON, ObjectId } = BSON;
const WRITE_STAGES = ["$out", "$merge"];
const SAMPLE_SIZE = 100;

class MongoAdapter {
  // For MongoDB the secret is the full connection string (it may embed a password).
  constructor(cfg, secret) {
    this.client = new MongoClient(secret, { serverSelectionTimeoutMS: 15000 });
    this.defaultDb = cfg.database;
  }

  async connect() {
    await this.client.connect();
  }

  // "Schemas" are databases for MongoDB.
  async getSchemas() {
    try {
      const r = await this.client.db("admin").admin().listDatabases({ nameOnly: true });
      return r.databases.map((d) => d.name).sort();
    } catch (err) {
      // Users without listDatabases privilege: fall back to the configured database.
      const db = this.defaultDb || this.client.db().databaseName;
      if (db) return [db];
      throw err;
    }
  }

  async getTables(db) {
    const cols = await this.client.db(db).listCollections({}, { nameOnly: true }).toArray();
    return cols
      .map((c) => ({ name: c.name, type: c.type === "view" ? "view" : "collection" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Collections have no fixed schema: infer fields from a sample of documents.
  async getColumns(db, collection) {
    const docs = await this.client.db(db).collection(collection).find({}).limit(SAMPLE_SIZE).toArray();
    const fields = new Map();
    for (const doc of docs) {
      for (const [k, v] of Object.entries(doc)) {
        if (!fields.has(k)) fields.set(k, bsonType(v));
      }
    }
    return [...fields].map(([name, type]) => ({ name, type, nullable: true, pk: name === "_id" }));
  }

  async fetchTable(db, collection, limit, offset, { filters, sort } = {}) {
    let cur = this.client.db(db).collection(collection).find(mongoFilter(filters));
    if (sort && sort.col) cur = cur.sort({ [sort.col]: sort.dir === "desc" ? -1 : 1 });
    const docs = await cur.skip(offset).limit(limit).toArray();
    return docsToResult(docs);
  }

  // Query text is Extended JSON, e.g.
  //   { "db": "shop", "collection": "orders", "find": { "status": "paid" }, "sort": { "_id": -1 }, "limit": 50 }
  //   { "collection": "orders", "aggregate": [ { "$group": { "_id": "$status", "n": { "$sum": 1 } } } ] }
  // Writes (blocked in read-only mode):
  //   { "collection": "orders", "insert": { ... } | [ { ... }, ... ] }
  //   { "collection": "orders", "filter": { ... }, "update": { "$set": { ... } }, "many": true }
  //   { "collection": "orders", "delete": { ...filter }, "many": true }
  //   { "collection": "orders", "create": true }
  async runQuery(text, maxRows, { readOnly }) {
    const q = parseQuery(text);
    const dbName = q.db || this.defaultDb;
    const coll = this.client.db(dbName).collection(q.collection);
    const limit = Math.min(q.limit || maxRows, maxRows);

    const writeOp = MONGO_WRITE_OPS.find((op) => q[op] !== undefined);
    if (writeOp) {
      if (readOnly) throw new Error(`Read-only mode: "${writeOp}" is blocked. Disable read-only to allow writes.`);
      return runWrite(this.client.db(dbName), q, writeOp);
    }

    let docs;
    if (q.aggregate) {
      const writeStage = q.aggregate.find((s) => WRITE_STAGES.some((w) => w in s));
      if (readOnly && writeStage) {
        throw new Error('Read-only mode: $out / $merge are blocked. Disable "dbViewer.readOnly" to allow writes.');
      }
      const pipeline = writeStage ? q.aggregate : [...q.aggregate, { $limit: limit + 1 }];
      docs = await coll.aggregate(pipeline).toArray();
    } else if (q.count !== undefined) {
      const n = await coll.countDocuments(q.count || {});
      return { columns: ["count"], rows: [[n]] };
    } else {
      docs = await findCursor(coll, q).limit(limit + 1).toArray();
    }
    const truncated = docs.length > limit;
    return { ...docsToResult(docs.slice(0, limit)), truncated };
  }

  // Read a find / aggregate / count query in batches, for exports too big to hold
  // in memory. Yields { columns, rows } per batch; columns can differ per batch.
  async *streamQuery(text, batchSize) {
    const q = parseQuery(text);
    const coll = this.client.db(q.db || this.defaultDb).collection(q.collection);
    if (q.count !== undefined && !q.aggregate) {
      yield { columns: ["count"], rows: [[await coll.countDocuments(q.count || {})]] };
      return;
    }
    let cur = q.aggregate ? coll.aggregate(q.aggregate) : findCursor(coll, q);
    if (!q.aggregate && q.limit) cur = cur.limit(q.limit);
    let docs = [];
    try {
      for await (const doc of cur) {
        docs.push(doc);
        if (docs.length >= batchSize) {
          yield docsToResult(docs);
          docs = [];
        }
      }
    } finally {
      await cur.close().catch(() => {});
    }
    yield docsToResult(docs);
  }

  async close() {
    await this.client.close();
  }
}

function parseQuery(text) {
  let q;
  try {
    const json = stripLineComments(text).trim();
    if (!json) throw new Error("the query is empty (only comments).");
    q = EJSON.parse(json, { relaxed: false });
  } catch (err) {
    throw new Error(`MongoDB query must be JSON: ${err.message}`);
  }
  if (!q.collection) throw new Error('MongoDB query needs a "collection" field.');
  if (q.aggregate && !Array.isArray(q.aggregate)) throw new Error('"aggregate" must be an array of pipeline stages.');
  return q;
}

function findCursor(coll, q) {
  let cur = coll.find(q.find || {}, { projection: q.projection });
  if (q.sort) cur = cur.sort(q.sort);
  if (q.skip) cur = cur.skip(q.skip);
  return cur;
}

async function runWrite(db, q, op) {
  const coll = db.collection(q.collection);
  if (op === "insert") {
    const docs = Array.isArray(q.insert) ? q.insert : [q.insert];
    const r = await coll.insertMany(docs);
    return { columns: [], rows: [], message: `Inserted ${r.insertedCount} document(s)` };
  }
  if (op === "update") {
    if (!q.filter) throw new Error('"update" needs a "filter" field (use {} to match every document).');
    const r = q.many ? await coll.updateMany(q.filter, q.update) : await coll.updateOne(q.filter, q.update);
    return { columns: [], rows: [], message: `Matched ${r.matchedCount}, modified ${r.modifiedCount} document(s)` };
  }
  if (op === "delete") {
    if (typeof q.delete !== "object" || Array.isArray(q.delete)) throw new Error('"delete" must be a filter object.');
    const r = q.many ? await coll.deleteMany(q.delete) : await coll.deleteOne(q.delete);
    return { columns: [], rows: [], message: `Deleted ${r.deletedCount} document(s)` };
  }
  await db.createCollection(q.collection);
  return { columns: [], rows: [], message: `Created collection ${q.collection}` };
}

// { field: { op, value } } from the table view -> MongoDB filter (see FILTER_OPS in common.js).
function mongoFilter(filters) {
  const out = {};
  const ops = { ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte" };
  for (const [field, f] of Object.entries(filters || {})) {
    if (field.startsWith("$")) throw new Error(`Invalid field name: ${field}`);
    if (f.op === "null") out[field] = null;
    else if (f.op === "notnull") out[field] = { $ne: null };
    else if (f.op === "contains") out[field] = { $regex: escapeRegex(f.value), $options: "i" };
    else if (f.op === "like") out[field] = { $regex: likeToRegex(f.value) };
    else if (f.op === "notlike") out[field] = { $not: new RegExp(likeToRegex(f.value)) };
    else if (f.op === "=") out[field] = { $in: filterValue(field, f.value) };
    else if (f.op === "!=") out[field] = { $nin: filterValue(field, f.value) };
    else if (ops[f.op]) {
      const v = filterValue(field, f.value);
      out[field] = { [ops[f.op]]: v.length > 1 ? v[1] : v[0] };
    } else throw new Error(`Unknown filter operator: ${f.op}`);
  }
  return out;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// SQL LIKE pattern (% = any run, _ = one char) -> anchored regex source.
function likeToRegex(pattern) {
  let out = "";
  for (const ch of pattern) out += ch === "%" ? "[\\s\\S]*" : ch === "_" ? "[\\s\\S]" : escapeRegex(ch);
  return `^${out}$`;
}

// A typed value can mean a string, number, boolean or ObjectId: return the candidates
// (the string first) so "=" matches any of them.
function filterValue(field, s) {
  const v = [s];
  if (s !== "" && Number.isFinite(Number(s))) v.push(Number(s));
  else if (s === "true" || s === "false") v.push(s === "true");
  else if (field === "_id" && ObjectId.isValid(s) && /^[0-9a-f]{24}$/i.test(s)) v.push(new ObjectId(s));
  return v;
}

function bsonType(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  if (v && v._bsontype) return v._bsontype;
  return typeof v;
}

// Union of top-level keys across documents, _id first; nested values shown as JSON.
function docsToResult(docs) {
  const keys = [];
  const seen = new Set();
  for (const d of docs) {
    for (const k of Object.keys(d)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const idx = keys.indexOf("_id");
  if (idx > 0) keys.unshift(keys.splice(idx, 1)[0]);
  const rows = docs.map((d) => keys.map((k) => (k in d ? toCell(d[k]) : undefined)));
  return { columns: keys, rows };
}

function toCell(v) {
  if (v === null || v === undefined || v instanceof Date) return v;
  if (typeof v !== "object") return v;
  if (v._bsontype === "ObjectId") return v.toHexString();
  return EJSON.stringify(v, { relaxed: true });
}

module.exports = { MongoAdapter };
