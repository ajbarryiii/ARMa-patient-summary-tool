"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const MAX_BYTES = 32 * 1024 * 1024;
const providers = new Set(["claude", "codex"]);
function string(value, limit) {
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid session data.");
  return value;
}
function sessionView(value) {
  if (!value || !Array.isArray(value.sessions) || value.sessions.length > 1000)
    throw new Error("Invalid session list.");
  const ids = new Set(), conversationIds = new Set();
  const sessions = value.sessions.map(session => {
    const id = string(session.id, 128);
    if (!id || ids.has(id) || !providers.has(session.provider) ||
        !Array.isArray(session.conversations) || session.conversations.length > 2)
      throw new Error("Invalid session data.");
    ids.add(id);
    const seen = new Set();
    return {
      id, title: string(session.title, 120), provider: session.provider,
      model: string(session.model, 200), effort: string(session.effort, 40),
      conversations: session.conversations.map(thread => {
        const id = string(thread.id, 128);
        if (!id || conversationIds.has(id) || !providers.has(thread.provider) || seen.has(thread.provider) ||
            !Array.isArray(thread.messages) || thread.messages.length > 10000)
          throw new Error("Invalid session conversation.");
        conversationIds.add(id);
        seen.add(thread.provider);
        return {
          id, provider: thread.provider, draft: string(thread.draft, 200000),
          redact: thread.redact === true, database: thread.database === true, summaries: thread.summaries === true,
          unredact: thread.unredact === true,
          interrupted: thread.interrupted === true,
          messages: thread.messages.map(message => {
            if (!["user", "assistant", "error", "stopped"].includes(message.role)) throw new Error("Invalid session message.");
            return { role: message.role, text: string(message.text, 8 * 1024 * 1024) };
          }),
        };
      }),
    };
  });
  const activeId = string(value.activeId, 128);
  if (sessions.length && !ids.has(activeId)) throw new Error("Invalid active session.");
  return { activeId, sessions };
}

function modelHistory(entries, root) {
  if (!Array.isArray(entries)) throw new Error("Invalid session history.");
  return entries.map(([key, messages]) => {
    const parts = JSON.parse(string(key, 8192));
    if (!Array.isArray(parts) || parts.length !== 4 || !providers.has(parts[0]) || parts[1] !== root ||
        typeof parts[2] !== "string" || !parts[2] || parts[2].length > 128 || !["workspace", "redaction", "restoration"].includes(parts[3]) ||
        !Array.isArray(messages) || messages.length > 40)
      throw new Error("Session history belongs to a different workspace or provider.");
    return [key, messages.map(message => {
      if (!["user", "assistant"].includes(message.role)) throw new Error("Invalid model history.");
      return { role: message.role, content: string(message.content, 8 * 1024 * 1024) };
    })];
  });
}

class SessionStore {
  constructor(directory) {
    this.directory = directory;
    this.entries = new Map();
  }
  filename(root) {
    return path.join(this.directory, `${createHash("sha256").update(root).digest("hex")}.json`);
  }
  async load(root) {
    if (!this.entries.has(root)) this.entries.set(root, (async () => {
      let record = { version: 1, workspace: root, view: { activeId: "", sessions: [] }, history: [] };
      try {
        const file = this.filename(root);
        if ((await fs.stat(file)).size > MAX_BYTES) throw new Error("Saved sessions exceed the local storage limit.");
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (saved.version !== 1 || saved.workspace !== root) throw new Error("Saved sessions do not match this workspace.");
        record = { ...record, view: sessionView(saved.view), history: modelHistory(saved.history, root) };
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error("Could not read this workspace's saved sessions. The saved file has been left intact.");
      }
      return { record, dirty: false, writing: null };
    })());
    return this.entries.get(root);
  }
  async view(root) { return (await this.load(root)).record.view; }
  async history(root) { return new Map((await this.load(root)).record.history); }
  async saveView(root, view) {
    const clean = sessionView(view);
    const entry = await this.load(root);
    if (Buffer.byteLength(JSON.stringify(clean)) > MAX_BYTES / 2)
      throw new Error("This workspace's sessions exceed the local storage limit.");
    entry.record.view = clean;
    return this.write(root, entry);
  }
  async saveHistory(root, history) {
    const clean = modelHistory([...history], root);
    const entry = await this.load(root);
    entry.record.history = clean;
    return this.write(root, entry);
  }
  write(root, entry) {
    entry.dirty = true;
    if (!entry.writing) {
      entry.writing = (async () => {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        while (entry.dirty) {
          entry.dirty = false;
          const data = JSON.stringify(entry.record);
          if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("This workspace's sessions exceed the local storage limit.");
          const filename = this.filename(root), temporary = `${filename}.${randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
            await fs.rename(temporary, filename);
          } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        }
      })().finally(() => { entry.writing = null; });
    }
    return entry.writing;
  }
  async flush() {
    for (const pending of this.entries.values()) {
      const entry = await pending;
      if (entry.writing) await entry.writing;
    }
  }
}

module.exports = { SessionStore };
