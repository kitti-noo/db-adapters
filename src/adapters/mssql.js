const sql = require("mssql");
const { quoteIdent, sqlWhere, sqlOrderBy } = require("./common");

const bracket = (name) => quoteIdent(name, "[", "]");

class MssqlAdapter {
  constructor(cfg, secret) {
    this.pool = new sql.ConnectionPool({
      server: cfg.host,
      port: cfg.port || 1433,
      user: cfg.user,
      password: secret,
      database: cfg.database || "master",
      connectionTimeout: 15000,
      options: {
        encrypt: cfg.ssl !== false,
        trustServerCertificate: !!cfg.trustServerCertificate,
      },
    });
  }

  async connect() {
    await this.pool.connect();
  }

  async getSchemas() {
    const r = await this.pool.request().query(
      `SELECT s.name FROM sys.schemas s
       WHERE EXISTS (SELECT 1 FROM sys.objects o WHERE o.schema_id = s.schema_id AND o.type IN ('U', 'V'))
       ORDER BY s.name`
    );
    return r.recordset.map((x) => x.name);
  }

  async getTables(schema) {
    const r = await this.pool
      .request()
      .input("schema", sql.NVarChar, schema)
      .query(
        `SELECT name, type FROM sys.objects
         WHERE schema_id = SCHEMA_ID(@schema) AND type IN ('U', 'V')
         ORDER BY name`
      );
    return r.recordset.map((x) => ({ name: x.name, type: x.type.trim() === "V" ? "view" : "table" }));
  }

  async getColumns(schema, table) {
    const r = await this.pool
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query(
        `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
                CASE WHEN EXISTS (
                  SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                    ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA
                  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA
                    AND tc.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
                ) THEN 1 ELSE 0 END AS PK
         FROM INFORMATION_SCHEMA.COLUMNS c
         WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
         ORDER BY c.ORDINAL_POSITION`
      );
    return r.recordset.map((x) => ({
      name: x.COLUMN_NAME,
      type: x.DATA_TYPE,
      nullable: x.IS_NULLABLE === "YES",
      pk: x.PK === 1,
    }));
  }

  async fetchTable(schema, table, limit, offset, { filters, sort } = {}) {
    const req = this.pool.request().input("limit", sql.Int, limit).input("offset", sql.Int, offset);
    req.arrayRowMode = true;
    let n = 0;
    const where = sqlWhere(filters, {
      col: bracket,
      param: (v) => {
        const name = `f${n++}`;
        req.input(name, sql.NVarChar, v);
        return `@${name}`;
      },
      text: (c) => `CAST(${c} AS NVARCHAR(MAX))`,
      contains: (t, p) => `${t} LIKE ${p} ESCAPE '\\'`,
      likeSpecial: "%_[\\",
    });
    const r = await req.query(
      `SELECT * FROM ${bracket(schema)}.${bracket(table)}${where}
       ${sqlOrderBy(sort, bracket) || "ORDER BY (SELECT NULL)"} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
    );
    return toResult(r);
  }

  async runQuery(text, maxRows) {
    const req = this.pool.request();
    req.arrayRowMode = true;
    this.running = req;
    try {
      return toResult(await req.query(text), maxRows);
    } finally {
      if (this.running === req) this.running = null;
    }
  }

  // Stream a query's rows in batches, for exports too big to hold in memory.
  // Yields { columns, rows } per batch.
  async *streamQuery(text, batchSize) {
    const req = this.pool.request();
    req.arrayRowMode = true;
    let columns = [];
    req.on("recordset", (cols) => (columns = cols.map((c) => c.name)));
    const stream = req.toReadableStream({ highWaterMark: batchSize });
    // Errors also reach the stream, which is where they are handled.
    req.query(text).catch(() => {});
    this.running = req;
    let rows = [];
    let finished = false;
    try {
      for await (const row of stream) {
        rows.push(row);
        if (rows.length >= batchSize) {
          yield { columns, rows };
          rows = [];
        }
      }
      finished = true;
    } finally {
      if (this.running === req) this.running = null;
      if (!finished) req.cancel();
    }
    yield { columns, rows };
  }

  async cancel() {
    if (this.running) this.running.cancel();
  }

  async close() {
    await this.pool.close();
  }
}

// With arrayRowMode, recordsets[i] are arrays of arrays and columns[i] holds
// the column metadata of each recordset. Show the last one that has columns.
function toResult(r, maxRows) {
  const sets = r.recordsets || [];
  for (let i = sets.length - 1; i >= 0; i--) {
    const cols = (r.columns && r.columns[i]) || [];
    if (!cols.length) continue;
    const rows = sets[i];
    return {
      columns: cols.map((c) => c.name),
      rows: maxRows ? rows.slice(0, maxRows) : rows,
      truncated: maxRows ? rows.length > maxRows : false,
    };
  }
  const affected = (r.rowsAffected || []).reduce((a, b) => a + b, 0);
  return { columns: [], rows: [], message: `OK, ${affected} row(s) affected` };
}

module.exports = { MssqlAdapter };
