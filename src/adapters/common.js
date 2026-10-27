// Helpers shared by the SQL adapters.

// Statements allowed in read-only mode (first keyword of the statement).
const READ_KEYWORDS = new Set(["SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE"]);

// Keywords that mean the statement writes data/schema, even inside a CTE.
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|EXEC|EXECUTE|CALL|COPY|BEGIN|COMMIT|ROLLBACK|DECLARE|INTO)\b/i;

// Top-level fields of a MongoDB query document that write (see mongo.js runQuery).
const MONGO_WRITE_OPS = ["insert", "update", "delete", "create"];

// MongoDB query editors may contain whole-line // comments (JSON strings can't span lines).
function stripLineComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, "");
}

// Remove comments and string/quoted-identifier literals so keyword checks
// don't trip on text like 'please delete me' or a column named "update".
function stripLiterals(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\[[^\]]*\]/g, "[]")
    .replace(/`[^`]*`/g, "``");
}

function assertReadOnlySql(sql) {
  const clean = stripLiterals(sql);
  const statements = clean.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length === 0) throw new Error("Query is empty.");
  for (const stmt of statements) {
    const first = stmt.split(/\s+/)[0].replace(/^\(+/, "").toUpperCase();
    if (!READ_KEYWORDS.has(first)) {
      throw new Error(`Read-only mode: "${first}" statements are blocked. Disable "dbViewer.readOnly" to allow writes.`);
    }
    const m = stmt.match(WRITE_KEYWORDS);
    if (m) {
      throw new Error(`Read-only mode: "${m[1].toUpperCase()}" is blocked. Disable "dbViewer.readOnly" to allow writes.`);
    }
  }
}

// Quote an identifier with the given quote chars, escaping embedded closers.
function quoteIdent(name, open = '"', close = '"') {
  return open + String(name).split(close).join(close + close) + close;
}

function isWriteSql(sql) {
  try {
    assertReadOnlySql(sql);
    return false;
  } catch {
    return true;
  }
}

// Column filter operators offered by the result grid. A filter is { op, value }:
//   contains -> case-insensitive substring, like / notlike -> SQL LIKE pattern (% and _),
//   = != > >= < <= -> compare, null / notnull -> IS [NOT] NULL (value ignored).
const FILTER_OPS = ["contains", "=", "!=", ">", ">=", "<", "<=", "like", "notlike", "null", "notnull"];

// "%abc%" with LIKE wildcards in the value escaped by backslash.
function likePattern(value, special = "%_\\") {
  let out = "";
  for (const ch of value) out += special.includes(ch) ? "\\" + ch : ch;
  return `%${out}%`;
}

// Build " WHERE ..." from { column: { op, value } }. The dialect supplies:
//   col(name) -> quoted column, param(value) -> placeholder,
//   text(colExpr) -> column as text, contains(textExpr, placeholder) -> case-insensitive LIKE.
function sqlWhere(filters, d) {
  const parts = [];
  for (const [name, f] of Object.entries(filters || {})) {
    const c = d.col(name);
    if (f.op === "null") parts.push(`${c} IS NULL`);
    else if (f.op === "notnull") parts.push(`${c} IS NOT NULL`);
    else if (f.op === "contains") parts.push(d.contains(d.text(c), d.param(likePattern(f.value, d.likeSpecial))));
    else if (f.op === "like") parts.push(`${d.text(c)} LIKE ${d.param(f.value)}`);
    else if (f.op === "notlike") parts.push(`${d.text(c)} NOT LIKE ${d.param(f.value)}`);
    else if (FILTER_OPS.includes(f.op)) parts.push(`${c} ${f.op === "!=" ? "<>" : f.op} ${d.param(f.value)}`);
    else throw new Error(`Unknown filter operator: ${f.op}`);
  }
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
}

function sqlOrderBy(sort, col) {
  if (!sort || !sort.col) return "";
  return ` ORDER BY ${col(sort.col)} ${sort.dir === "desc" ? "DESC" : "ASC"}`;
}

module.exports = { MONGO_WRITE_OPS, FILTER_OPS, stripLineComments, assertReadOnlySql, isWriteSql, likePattern, sqlWhere, sqlOrderBy, quoteIdent, stripLiterals };
