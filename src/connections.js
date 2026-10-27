// Saved connection configs (globalState) + passwords (SecretStorage) + live adapters.
const vscode = require("vscode");
const crypto = require("crypto");
const { TYPES, createAdapter } = require("./adapters");

const STATE_KEY = "dbViewer.connections";
const secretKey = (id) => `dbViewer.secret.${id}`;

class ConnectionManager {
  constructor(context) {
    this.context = context;
    this.live = new Map(); // id -> Promise<adapter>
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  list() {
    return this.context.globalState.get(STATE_KEY, []);
  }

  get(id) {
    return this.list().find((c) => c.id === id);
  }

  isConnected(id) {
    return this.live.has(id);
  }

  async save(cfg, secret) {
    const all = this.list();
    if (!cfg.id) cfg.id = crypto.randomUUID();
    const i = all.findIndex((c) => c.id === cfg.id);
    if (i >= 0) all[i] = cfg;
    else all.push(cfg);
    await this.context.globalState.update(STATE_KEY, all);
    if (secret !== undefined) await this.context.secrets.store(secretKey(cfg.id), secret);
    await this.disconnect(cfg.id);
    this._onDidChange.fire();
    return cfg;
  }

  async remove(id) {
    await this.disconnect(id);
    await this.context.globalState.update(STATE_KEY, this.list().filter((c) => c.id !== id));
    await this.context.secrets.delete(secretKey(id));
    this._onDidChange.fire();
  }

  getSecret(id) {
    return this.context.secrets.get(secretKey(id));
  }

  // Connect lazily and share one adapter per connection. An adapter whose
  // connection dropped (isBroken) is replaced by a fresh one.
  async adapter(id) {
    const cur = this.live.get(id);
    if (cur) {
      const a = await cur.catch(() => null);
      // Another caller may already have replaced it while we waited.
      if (a && a.isBroken && a.isBroken() && this.live.get(id) === cur) await this.disconnect(id);
    }
    if (!this.live.has(id)) {
      const p = this._connect(id);
      this.live.set(id, p);
      p.then(
        () => this._onDidChange.fire(),
        () => this.live.delete(id)
      );
    }
    return this.live.get(id);
  }

  async _connect(id) {
    const cfg = this.get(id);
    if (!cfg) throw new Error("Connection not found.");
    const secret = (await this.getSecret(id)) || "";
    const a = createAdapter(cfg, secret, { readOnly: readOnly(cfg) });
    await a.connect();
    return a;
  }

  // A connection of its own for a long export, so the shared one stays free.
  // The caller closes it.
  open(id) {
    return this._connect(id);
  }

  async disconnect(id) {
    const p = this.live.get(id);
    if (!p) return;
    this.live.delete(id);
    try {
      await (await p).close();
    } catch {
      // Connection already failed or closed.
    }
    this._onDidChange.fire();
  }

  // Stop the statement running on a connection. Adapters without a cancel()
  // (MongoDB) are disconnected instead and reconnect on the next use.
  async cancel(id) {
    const p = this.live.get(id);
    if (!p) return;
    const a = await p.catch(() => null);
    if (a && a.cancel) await a.cancel();
    else await this.disconnect(id);
  }

  async disconnectAll() {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }

  describe(cfg) {
    const t = TYPES[cfg.type];
    const mode = readOnly(cfg) ? "read-only" : "read-write";
    if (cfg.type === "mongo") return `${t.label} · ${cfg.hostLabel || ""} · ${mode}`;
    return `${t.label} · ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} · ${mode}`;
  }
}

// A connection can override the dbViewer.readOnly setting with its own mode.
function readOnly(cfg) {
  if (cfg && typeof cfg.readOnly === "boolean") return cfg.readOnly;
  return vscode.workspace.getConfiguration("dbViewer").get("readOnly", true);
}

module.exports = { ConnectionManager, readOnly };
