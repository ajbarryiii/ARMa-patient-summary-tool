"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SessionStore } = require("../sessions.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arma-sessions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new SessionStore(directory) };
}
function view(title = "Synthetic review") {
  return { activeId: "session-1", sessions: [{
    id: "session-1", title, provider: "claude", model: "sonnet", effort: "high",
    conversations: [{ id: "thread-1", provider: "claude", draft: "Unfinished question", redact: false, database: false, summaries: false, unredact: false,
      interrupted: false, messages: [{ role: "user", text: "Synthetic question" }, { role: "assistant", text: "Synthetic response" }] }],
  }] };
}

test("saved sessions and bounded model context survive reopening and isolate workspaces/providers/modes", async t => {
  const { directory, store } = await fixture(t);
  const first = path.join(directory, "first"), second = path.join(directory, "second");
  const history = new Map(["claude", "codex"].flatMap(provider => ["workspace", "redaction", "restoration"].map(mode => [
    JSON.stringify([provider, first, "thread-1", mode]), [{ role: "user", content: `${provider} ${mode}` }],
  ])));
  await Promise.all([store.saveView(first, view()), store.saveHistory(first, history), store.saveView(second, view("Other workspace"))]);
  await store.flush();
  const reopened = new SessionStore(directory);
  assert.deepEqual(await reopened.view(first), view());
  assert.deepEqual(await reopened.history(first), history);
  assert.equal((await reopened.view(second)).sessions[0].title, "Other workspace");
  assert.equal((await reopened.history(second)).size, 0);
  assert.deepEqual(await reopened.view(path.join(directory, "new")), { activeId: "", sessions: [] });
  if (process.platform !== "win32") assert.equal((await fs.stat(store.filename(first))).mode & 0o777, 0o600);
  await assert.rejects(store.saveHistory(second, history), /different workspace/);
});

test("session persistence excludes runtime handles, bound sources and incidental credential fields", async t => {
  const { store, directory } = await fixture(t);
  const saved = view();
  Object.assign(saved.sessions[0].conversations[0], {
    source: { id: "ephemeral-source", path: "unredacted/private.csv" },
    runId: "runtime-run", pending: [{ secret: "private" }], credentials: "synthetic-secret", interrupted: true,
  });
  await store.saveView(directory, saved);
  const disk = await fs.readFile(store.filename(directory), "utf8");
  assert(!/ephemeral-source|unredacted\/private|runtime-run|synthetic-secret/.test(disk));
  assert.equal((await new SessionStore(directory).view(directory)).sessions[0].conversations[0].interrupted, true);
});

test("overlapping saves keep the newest draft and both view and model context", async t => {
  const { store, directory } = await fixture(t);
  const history = new Map([[JSON.stringify(["claude", directory, "thread-1", "workspace"]), [{ role: "assistant", content: "Reply" }]]]);
  const saves = [];
  for (let index = 0; index < 50; index++) {
    const value = view();
    value.sessions[0].conversations[0].draft = `Draft ${index}`;
    saves.push(store.saveView(directory, value));
  }
  saves.push(store.saveHistory(directory, history));
  await Promise.all(saves);
  const reopened = new SessionStore(directory);
  assert.equal((await reopened.view(directory)).sessions[0].conversations[0].draft, "Draft 49");
  assert.deepEqual(await reopened.history(directory), history);
  assert.equal((await fs.readdir(directory)).length, 1);
});

test("invalid and corrupt session data cannot overwrite saved chats", async t => {
  const { store, directory } = await fixture(t);
  await store.saveView(directory, view());
  const original = await fs.readFile(store.filename(directory), "utf8");
  const duplicate = view();
  duplicate.sessions.push(duplicate.sessions[0]);
  await assert.rejects(store.saveView(directory, duplicate), /Invalid session/);
  const wrongActive = view();
  wrongActive.activeId = "missing";
  await assert.rejects(store.saveView(directory, wrongActive), /Invalid active/);
  assert.equal(await fs.readFile(store.filename(directory), "utf8"), original);
  await fs.writeFile(store.filename(directory), "damaged synthetic data");
  const reopened = new SessionStore(directory);
  await assert.rejects(reopened.view(directory), /left intact/);
  await assert.rejects(reopened.saveView(directory, view()), /left intact/);
  assert.equal(await fs.readFile(store.filename(directory), "utf8"), "damaged synthetic data");
});
