// CSV export: the rows on screen, or a whole query / table read in batches and
// written as they arrive, so a large result never sits in memory.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const BATCH_SIZE = 5000;

// Writes rows to a CSV file (UTF-8 with BOM so Excel reads non-ASCII text, CRLF per RFC 4180).
class CsvWriter {
  constructor(file) {
    this.out = fs.createWriteStream(file);
    this.error = null;
    this.out.on("error", (err) => (this.error = err));
    this.out.write("﻿");
  }

  async write(rows) {
    if (this.error) throw this.error;
    if (!rows.length) return;
    if (!this.out.write(rows.map(csvLine).join(""))) await once(this.out, "drain");
  }

  close() {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      this.out.end(() => (this.error ? reject(this.error) : resolve()));
    });
  }
}

function csvLine(values) {
  return values.map(csvValue).join(",") + "\r\n";
}

// NULL / missing -> empty field. Quote when the value has a comma, quote or line break.
function csvValue(v) {
  if (v === null || v === undefined) return "";
  let s;
  if (v instanceof Date) s = isNaN(v) ? String(v) : v.toISOString();
  else if (Buffer.isBuffer(v)) s = `0x${v.toString("hex")}`;
  else if (typeof v === "object") {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else s = String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

async function pickFile(name) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const dir = folder ? folder.uri.fsPath : os.homedir();
  const base = String(name || "export").replace(/[\\/:*?"<>|\s]+/g, "_");
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, `${base}.csv`)),
    filters: { CSV: ["csv"] },
  });
  return uri && uri.fsPath;
}

async function done(file, count, note) {
  const pick = await vscode.window.showInformationMessage(
    `Exported ${count.toLocaleString()} row(s) to ${path.basename(file)}.${note ? ` ${note}` : ""}`,
    "Open",
    "Reveal"
  );
  if (pick === "Open") vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
  if (pick === "Reveal") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
}

// Rows already in memory (what the grid shows).
async function exportRows(name, columns, rows) {
  const file = await pickFile(name);
  if (!file) return;
  const w = new CsvWriter(file);
  try {
    await w.write([columns, ...rows]);
  } finally {
    await w.close();
  }
  done(file, rows.length);
}

// open() -> async iterable of { columns, rows } batches; it runs only after a file
// is picked. cancel() stops the statement in the database. The header comes from
// the first batch; later batches are matched to it by column name (MongoDB
// documents can have fields the first batch didn't).
async function exportBatches(name, open, cancel) {
  const file = await pickFile(name);
  if (!file) return;
  const w = new CsvWriter(file);
  let header = null;
  let count = 0;
  let cancelled = false;
  const dropped = new Set();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(file)}`, cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          cancelled = true;
          Promise.resolve(cancel && cancel()).catch(() => {});
        });
        for await (const b of open()) {
          if (cancelled) break;
          if (!header) {
            if (!b.columns.length) throw new Error("The query returned no rows to export.");
            header = b.columns;
            await w.write([header]);
          }
          let rows = b.rows;
          if (b.columns.join("\0") !== header.join("\0")) {
            const idx = header.map((c) => b.columns.indexOf(c));
            for (const c of b.columns) if (!header.includes(c)) dropped.add(c);
            rows = rows.map((r) => idx.map((i) => (i < 0 ? undefined : r[i])));
          }
          await w.write(rows);
          count += rows.length;
          progress.report({ message: `${count.toLocaleString()} row(s)` });
        }
      }
    );
  } catch (err) {
    // A cancelled statement fails; that's expected.
    if (!cancelled) {
      await w.close().catch(() => {});
      throw err;
    }
  }
  await w.close();
  if (cancelled) {
    vscode.window.showWarningMessage(
      `Export cancelled after ${count.toLocaleString()} row(s); ${path.basename(file)} is incomplete.`
    );
    return;
  }
  done(file, count, dropped.size ? `Fields missing from the first batch were left out: ${[...dropped].join(", ")}` : "");
}

module.exports = { exportRows, exportBatches, BATCH_SIZE, csvValue };
