const { Client } = require("pg");
const { quoteIdent, sqlWhere, sqlOrderBy } = require("./common");

class PostgresAdapter {
  constructor(cfg, secret, { readOnly }) {
    this.config = {
      host: cfg.host,
      port: cfg.port || 5432,
      user: cfg.user,
      password: secret,
      database: cfg.database || "postgres",
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 15000,
      // Keep idle connections from being silently dropped by firewalls/cloud load balancers.
      keepAlive: true,
    };
    this.client = new Client(this.config);
    this.readOnly = readOnly;
    // Without a listener, a dropped connection would throw in the extension host.
    // A client that failed can't be used again, so the manager reconnects.
    this.broken = false;
    this.client.on("error", () => (this.broken = true));
    this.client.on("end", () => (this.broken = true));
  }

  isBroken() {
    return this.broken;
  }

  async connect() {
    await this.client.connect();
    // Server-side guard in addition to the keyword check.
    if (this.readOnly) await this.client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  }

  async getSchemas() {
    const r = await this.client.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
         AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
       ORDER BY schema_name`
    );
    return r.rows.map((x) => x.schema_name);
  }

  async getTables(schema) {
    const r = await this.client.query(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    );
    return r.rows.map((x) => ({ name: x.table_name, type: x.table_type === "VIEW" ? "view" : "table" }));
  }

  async getColumns(schema, table) {
    const r = await this.client.query(
      `SELECT c.column_name, c.data_type, c.is_nullable,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage k
                  ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name AND k.column_name = c.column_name
              ) AS pk
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table]
    );
    return r.rows.map((x) => ({ name: x.column_name, type: x.data_type, nullable: x.is_nullable === "YES", pk: x.pk }));
  }

  async fetchTable(schema, table, limit, offset, { filters, sort } = {}) {
    const values = [];
    const param = (v) => {
      values.push(v);
      return `$${values.length}`;
    };
    const col = (n) => quoteIdent(n);
    const where = sqlWhere(filters, {
      col,
      param,
      text: (c) => `CAST(${c} AS TEXT)`,
      contains: (t, p) => `${t} ILIKE ${p}`,
    });
    const sql =
      `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)}${where}${sqlOrderBy(sort, col)}` +
      ` LIMIT ${param(limit)} OFFSET ${param(offset)}`;
    return toResult(await this.client.query({ text: sql, values, rowMode: "array" }));
  }

  async runQuery(text, maxRows) {
    let r = await this.client.query({ text, rowMode: "array" });
    if (Array.isArray(r)) r = r[r.length - 1]; // multiple statements: show the last result
    return toResult(r, maxRows);
  }

  // Read a SELECT in batches through a cursor, for exports too big to hold in memory.
  // Yields { columns, rows } per batch. Use a connection of its own: the cursor
  // needs a transaction for as long as it is read.
  async *streamQuery(text, batchSize) {
    const sql = text.trim().replace(/;+\s*$/, "");
    await this.client.query("BEGIN");
    try {
      await this.client.query(`DECLARE db_adapters_export NO SCROLL CURSOR FOR ${sql}`);
      for (;;) {
        const r = await this.client.query({ text: `FETCH ${batchSize} FROM db_adapters_export`, rowMode: "array" });
        yield { columns: r.fields.map((f) => f.name), rows: r.rows };
        if (r.rows.length < batchSize) break;
      }
    } finally {
      // Ends the transaction (as a rollback if a statement failed).
      await this.client.query("COMMIT").catch(() => {});
    }
  }

  // Stop the running statement from a second connection; the client stays usable.
  async cancel() {
    const c = new Client(this.config);
    await c.connect();
    try {
      await c.query("SELECT pg_cancel_backend($1)", [this.client.processID]);
    } finally {
      await c.end();
    }
  }

  async close() {
    await this.client.end();
  }
}

function toResult(r, maxRows) {
  const rows = r.rows || [];
  const columns = (r.fields || []).map((f) => f.name);
  if (!columns.length) return { columns: [], rows: [], message: `${r.command || "OK"} ${r.rowCount ?? ""}`.trim() };
  return {
    columns,
    rows: maxRows ? rows.slice(0, maxRows) : rows,
    truncated: maxRows ? rows.length > maxRows : false,
  };
}

module.exports = { PostgresAdapter };
