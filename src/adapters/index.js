// Registry of supported database types. Drivers are required lazily so a
// broken/missing driver for one database doesn't stop the others from working.
const { quoteIdent } = require("./common");

const bracket = (name) => quoteIdent(name, "[", "]");
const backtick = (name) => quoteIdent(name, "`", "`");

// Starter statement for a new query editor. kind is "select", "insert", "update"
// or "delete". cols are the table's columns ({ name, type, pk }) when known; each
// value starts as a default for the column type (0, '', today's date, ...).
function sqlSample(quote, select, end, dialect) {
  return (kind, schema, table, cols = []) => {
    const t = `${quote(schema)}.${quote(table)}`;
    if (!cols.length) cols = [{ name: "id", type: "integer", pk: true }, { name: "column1", type: "text" }];
    const val = (c) => defaultLiteral(c.type, dialect);
    const keys = cols.filter((c) => c.pk);
    const whereCols = keys.length ? keys : [cols[0]];
    const where = whereCols.map((c) => `${quote(c.name)} = ${val(c)}`).join(" AND ");
    const setCol = cols.find((c) => !whereCols.includes(c)) || cols[0];
    const ins = cols.slice(0, 20);
    const sql = {
      select: select(t),
      insert: insertSql(t, ins.map((c) => quote(c.name)), ins.map(val)),
      update: `UPDATE ${t}\nSET ${quote(setCol.name)} = ${val(setCol)}\nWHERE ${where}`,
      delete: `DELETE FROM ${t}\nWHERE ${where}`,
    }[kind];
    return `${sql}${end}\n`;
  };
}

// INSERT with a comment line naming each column right above its value:
//   --      "id", "name", "created_at"
//   VALUES (0,    '',     '2026-10-01 00:00:00')
function insertSql(table, names, values) {
  const widths = names.map((n, i) => Math.max(n.length, values[i].length));
  const row = (items) => items.map((x, i) => (i < items.length - 1 ? `${x},`.padEnd(widths[i] + 2) : x)).join("");
  return `INSERT INTO ${table} (${names.join(", ")})\n--      ${row(names)}\nVALUES (${row(values)})`;
}

const NUMERIC_TYPE =
  /^(smallint|mediumint|integer|bigint|tinyint|int\d*|(small|big)?serial|numeric|decimal|number|float\d*|double|real|(small)?money|binary_(float|double))\b/;

// Today as YYYY-MM-DD in local time (toISOString would give the UTC date).
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A default SQL literal for a column type: numbers unquoted, text quoted.
function defaultLiteral(type, dialect) {
  const t = String(type || "").toLowerCase();
  const day = today();
  if (t === "boolean") return "false";
  if (t === "bit" || NUMERIC_TYPE.test(t)) return "0";
  if (/timestamp|datetime/.test(t)) return dialect === "oracle" ? `TIMESTAMP '${day} 00:00:00'` : `'${day} 00:00:00'`;
  if (t === "date") return dialect === "oracle" ? `DATE '${day}'` : `'${day}'`;
  if (/^time\b/.test(t)) return "'00:00:00'";
  if (/^interval/.test(t)) return "'0'";
  if (/json/.test(t)) return "'{}'";
  return "''";
}

function mongoSample(kind, db, collection, cols = []) {
  const col = cols.find((c) => c.name !== "_id") || { name: "field", type: "string" };
  const value = /^(number|int32|double|long|decimal128)$/i.test(col.type)
    ? 0
    : col.type === "boolean"
      ? false
      : col.type === "date"
        ? { $date: `${today()}T00:00:00Z` }
        : "";
  const byId = { _id: { $oid: "<id>" } };
  const q = {
    select: { find: {}, sort: { _id: -1 }, limit: 100 },
    insert: { insert: { [col.name]: value } },
    update: { filter: byId, update: { $set: { [col.name]: value } } },
    delete: { delete: byId },
  }[kind];
  return JSON.stringify({ db, collection, ...q }, null, 2) + "\n";
}

const TYPES = {
  postgres: {
    label: "PostgreSQL",
    defaultPort: 5432,
    databaseLabel: "Database",
    defaultDatabase: "postgres",
    language: "sql",
    load: () => require("./postgres").PostgresAdapter,
    defaultSchema: () => "public",
    sample: sqlSample(quoteIdent, (t) => `SELECT * FROM ${t} LIMIT 100`, ";", "postgres"),
  },
  mysql: {
    label: "MySQL / MariaDB",
    defaultPort: 3306,
    databaseLabel: "Database",
    defaultDatabase: "",
    language: "sql",
    load: () => require("./mysql").MysqlAdapter,
    defaultSchema: (cfg) => cfg.database || "database_name",
    sample: sqlSample(backtick, (t) => `SELECT * FROM ${t} LIMIT 100`, ";", "mysql"),
  },
  mssql: {
    label: "SQL Server",
    defaultPort: 1433,
    databaseLabel: "Database",
    defaultDatabase: "master",
    language: "sql",
    load: () => require("./mssql").MssqlAdapter,
    defaultSchema: () => "dbo",
    sample: sqlSample(bracket, (t) => `SELECT TOP 100 * FROM ${t}`, ";", "mssql"),
  },
  oracle: {
    label: "Oracle",
    defaultPort: 1521,
    databaseLabel: "Service name",
    defaultDatabase: "FREEPDB1",
    language: "sql",
    load: () => require("./oracle").OracleAdapter,
    defaultSchema: (cfg) => (cfg.user || "").toUpperCase(),
    // Oracle runs one statement at a time, without a trailing ";".
    sample: sqlSample(quoteIdent, (t) => `SELECT * FROM ${t} FETCH FIRST 100 ROWS ONLY`, "", "oracle"),
  },
  mongo: {
    label: "MongoDB",
    language: "jsonc",
    load: () => require("./mongo").MongoAdapter,
    defaultSchema: (cfg) => cfg.database || "db",
    sample: mongoSample,
  },
};

function createAdapter(cfg, secret, opts) {
  const t = TYPES[cfg.type];
  if (!t) throw new Error(`Unsupported database type: ${cfg.type}`);
  const Adapter = t.load();
  return new Adapter(cfg, secret, opts);
}

module.exports = { TYPES, createAdapter };
