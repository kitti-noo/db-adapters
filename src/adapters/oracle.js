const oracledb = require("oracledb");
const { quoteIdent, sqlWhere, sqlOrderBy } = require("./common");

// Thin mode (default) needs no Oracle Client libraries. Return LOBs as values.
oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

class OracleAdapter {
  constructor(cfg, secret) {
    this.options = {
      user: cfg.user,
      password: secret,
      connectString: `${cfg.host}:${cfg.port || 1521}/${cfg.database}`,
      connectTimeout: 15,
    };
  }

  async connect() {
    this.conn = await oracledb.getConnection(this.options);
  }

  isBroken() {
    return !this.conn || !this.conn.isHealthy();
  }

  async getSchemas() {
    // Only owners that actually have tables or views visible to this user.
    const r = await this.conn.execute(
      `SELECT owner FROM all_tables UNION SELECT owner FROM all_views ORDER BY 1`
    );
    const owners = r.rows.map((x) => x[0]);
    // Current user first — that's usually the schema people want.
    const me = this.options.user.toUpperCase();
    return owners.includes(me) ? [me, ...owners.filter((o) => o !== me)] : owners;
  }

  async getTables(schema) {
    const r = await this.conn.execute(
      `SELECT table_name, 'table' FROM all_tables WHERE owner = :o
       UNION ALL
       SELECT view_name, 'view' FROM all_views WHERE owner = :o
       ORDER BY 1`,
      { o: schema }
    );
    return r.rows.map((x) => ({ name: x[0], type: x[1] }));
  }

  async getColumns(schema, table) {
    const r = await this.conn.execute(
      `SELECT c.column_name, c.data_type, c.nullable,
              (SELECT COUNT(*) FROM all_constraints k
               JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
               WHERE k.constraint_type = 'P' AND k.owner = c.owner
                 AND k.table_name = c.table_name AND cc.column_name = c.column_name) AS pk
       FROM all_tab_columns c
       WHERE c.owner = :o AND c.table_name = :t
       ORDER BY c.column_id`,
      { o: schema, t: table }
    );
    return r.rows.map((x) => ({ name: x[0], type: x[1], nullable: x[2] === "Y", pk: x[3] > 0 }));
  }

  async fetchTable(schema, table, limit, offset, { filters, sort } = {}) {
    const binds = { off: offset, lim: limit };
    let n = 0;
    const col = (name) => quoteIdent(name);
    const where = sqlWhere(filters, {
      col,
      param: (v) => {
        const name = `f${n++}`;
        binds[name] = v;
        return `:${name}`;
      },
      text: (c) => `TO_CHAR(${c})`,
      contains: (t, p) => `UPPER(${t}) LIKE UPPER(${p}) ESCAPE '\\'`,
    });
    const r = await this.conn.execute(
      `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)}${where}${sqlOrderBy(sort, col)}
       OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      binds
    );
    return toResult(r);
  }

  async runQuery(text, maxRows) {
    const sql = trimSemicolon(text);
    // Commit each statement like the other adapters do, so writes aren't lost on disconnect.
    const r = await this.conn.execute(sql, [], { maxRows: maxRows ? maxRows + 1 : 0, autoCommit: true });
    return toResult(r, maxRows);
  }

  // Read a query's rows in batches, for exports too big to hold in memory.
  // Yields { columns, rows } per batch.
  async *streamQuery(text, batchSize) {
    const r = await this.conn.execute(trimSemicolon(text), [], { resultSet: true });
    if (!r.resultSet) throw new Error("The query returned no rows to export.");
    const columns = r.metaData.map((m) => m.name);
    try {
      for (;;) {
        const rows = await r.resultSet.getRows(batchSize);
        yield { columns, rows };
        if (rows.length < batchSize) break;
      }
    } finally {
      await r.resultSet.close().catch(() => {});
    }
  }

  // Interrupts the running statement; the connection stays usable.
  async cancel() {
    if (this.conn) await this.conn.break();
  }

  async close() {
    if (this.conn) await this.conn.close();
  }
}

// Oracle rejects a trailing ";" on plain SQL (but PL/SQL blocks need "END;").
function trimSemicolon(text) {
  return /\bEND\s*;\s*$/i.test(text) ? text.trim() : text.trim().replace(/;+\s*$/, "");
}

function toResult(r, maxRows) {
  if (!r.metaData) return { columns: [], rows: [], message: `OK, ${r.rowsAffected ?? 0} row(s) affected` };
  const rows = r.rows || [];
  return {
    columns: r.metaData.map((m) => m.name),
    rows: maxRows ? rows.slice(0, maxRows) : rows,
    truncated: maxRows ? rows.length > maxRows : false,
  };
}

module.exports = { OracleAdapter };
