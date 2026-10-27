const mysql = require("mysql2/promise");
const { quoteIdent, sqlWhere, sqlOrderBy } = require("./common");

const backtick = (name) => quoteIdent(name, "`", "`");
const SYSTEM_SCHEMAS = ["information_schema", "mysql", "performance_schema", "sys"];

class MysqlAdapter {
  constructor(cfg, secret, { readOnly }) {
    this.options = {
      host: cfg.host,
      port: cfg.port || 3306,
      user: cfg.user,
      password: secret,
      database: cfg.database || undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 15000,
      // Keep idle connections from being silently dropped by firewalls/cloud load balancers.
      enableKeepAlive: true,
      // Several statements per run, like the other SQL adapters.
      multipleStatements: true,
      // Show dates and big numbers exactly as stored, without time zone or precision changes.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    };
    this.readOnly = readOnly;
    this.broken = false;
  }

  async connect() {
    this.conn = await mysql.createConnection(this.options);
    // A connection that failed can't be used again, so the manager reconnects.
    this.conn.on("error", () => (this.broken = true));
    this.conn.on("end", () => (this.broken = true));
    // Server-side guard in addition to the keyword check (MySQL 5.6.5+, MariaDB 10.0+).
    if (this.readOnly) await this.conn.query("SET SESSION TRANSACTION READ ONLY");
  }

  isBroken() {
    return this.broken;
  }

  async getSchemas() {
    const [rows] = await this.conn.query(
      `SELECT schema_name AS name FROM information_schema.schemata
       WHERE schema_name NOT IN (?) ORDER BY schema_name`,
      [SYSTEM_SCHEMAS]
    );
    return rows.map((x) => x.name);
  }

  async getTables(schema) {
    const [rows] = await this.conn.query(
      `SELECT table_name AS name, table_type AS type FROM information_schema.tables
       WHERE table_schema = ? ORDER BY table_name`,
      [schema]
    );
    return rows.map((x) => ({ name: x.name, type: x.type === "VIEW" ? "view" : "table" }));
  }

  async getColumns(schema, table) {
    const [rows] = await this.conn.query(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_key AS ckey
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [schema, table]
    );
    return rows.map((x) => ({ name: x.name, type: x.type, nullable: x.nullable === "YES", pk: x.ckey === "PRI" }));
  }

  async fetchTable(schema, table, limit, offset, { filters, sort } = {}) {
    const values = [];
    const param = (v) => {
      values.push(v);
      return "?";
    };
    const where = sqlWhere(filters, {
      col: backtick,
      param,
      text: (c) => `CAST(${c} AS CHAR)`,
      // Backslash is MySQL's default LIKE escape character.
      contains: (t, p) => `LOWER(${t}) LIKE LOWER(${p})`,
    });
    const sql =
      `SELECT * FROM ${backtick(schema)}.${backtick(table)}${where}${sqlOrderBy(sort, backtick)}` +
      ` LIMIT ${param(limit)} OFFSET ${param(offset)}`;
    const [rows, fields] = await this.conn.query({ sql, values, rowsAsArray: true });
    return toResult(rows, fields);
  }

  async runQuery(text, maxRows) {
    let [rows, fields] = await this.conn.query({ sql: text, rowsAsArray: true });
    // Several statements: rows/fields hold one entry per statement. Show the last.
    const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined);
    if (multi) {
      rows = rows[rows.length - 1];
      fields = fields[fields.length - 1];
    }
    return toResult(rows, fields, maxRows);
  }

  // Stream a query's rows in batches, for exports too big to hold in memory.
  // Yields { columns, rows } per batch.
  async *streamQuery(text, batchSize) {
    const conn = this.conn;
    let columns = null;
    const stream = conn.connection.query({ sql: text, rowsAsArray: true }).stream({ highWaterMark: batchSize });
    stream.on("fields", (fields) => {
      if (fields) columns = fields.map((f) => f.name);
    });
    let rows = [];
    let finished = false;
    try {
      for await (const row of stream) {
        if (!columns) throw new Error("The query returned no rows to export.");
        rows.push(row);
        if (rows.length >= batchSize) {
          yield { columns, rows };
          rows = [];
        }
      }
      finished = true;
    } finally {
      // Rows of an unfinished query are still on the wire: drop the connection.
      if (!finished) {
        conn.destroy();
        this.conn = null;
        this.broken = true;
      }
    }
    yield { columns: columns || [], rows };
  }

  // Stop the running statement from a second connection; the connection stays usable.
  async cancel() {
    if (!this.conn) return;
    const c = await mysql.createConnection(this.options);
    try {
      await c.query(`KILL QUERY ${Number(this.conn.threadId)}`);
    } finally {
      await c.end();
    }
  }

  async close() {
    if (this.conn) await this.conn.end();
  }
}

// SELECT: rows is an array of arrays and fields lists the columns.
// INSERT/UPDATE/DDL: rows is a ResultSetHeader and fields is undefined.
function toResult(rows, fields, maxRows) {
  if (!Array.isArray(rows) || !fields) {
    return { columns: [], rows: [], message: `OK, ${(rows && rows.affectedRows) || 0} row(s) affected` };
  }
  return {
    columns: fields.map((f) => f.name),
    rows: maxRows ? rows.slice(0, maxRows) : rows,
    truncated: maxRows ? rows.length > maxRows : false,
  };
}

module.exports = { MysqlAdapter };
