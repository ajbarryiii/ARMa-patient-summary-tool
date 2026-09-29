const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  AgentBridge,
  providerEnvironment,
  makeLineReader,
  createEventParser,
  claudeArguments,
} = require("../agents.cjs");
const { codexModels } = require("../model-options.cjs");

test("model catalogs filter hidden and invalid entries and restrict efforts to supported values", () => {
  assert.deepEqual(codexModels([
    null,
    { model: "hidden", hidden: true },
    { model: "--flag" },
    { model: "available", displayName: "Available model", isDefault: true,
      supportedReasoningEfforts: [null, { reasoningEffort: "high" }, { reasoningEffort: "high" }, { reasoningEffort: "bogus" }],
      defaultReasoningEffort: "bogus" },
    { model: "available" },
  ]), [{ id: "available", name: "Available model", efforts: ["high"], defaultEffort: "", isDefault: true }]);
  assert.equal(codexModels([])[0].id, "");
});

test("each provider receives only its own authentication environment", () => {
  const env = {
    HOME: "/home/operator",
    PATH: "/bin",
    TERM: "xterm",
    OPENAI_API_KEY: "openai-private",
    CODEX_ACCESS_TOKEN: "codex-private",
    ANTHROPIC_API_KEY: "anthropic-private",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-private",
    GITHUB_TOKEN: "unrelated-private",
    NODE_OPTIONS: "--require untrusted.cjs",
    ELECTRON_RUN_AS_NODE: "unexpected",
    ARM_ENABLE_CODEX: "1",
  };
  const claude = providerEnvironment("claude", env);
  assert.equal(claude.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(claude.OPENAI_API_KEY, undefined);
  assert.equal(claude.CODEX_ACCESS_TOKEN, undefined);
  const codex = providerEnvironment("codex", env);
  assert.equal(codex.OPENAI_API_KEY, env.OPENAI_API_KEY);
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  assert.equal(codex.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  for (const output of [claude, codex]) {
    assert.equal(output.HOME, env.HOME);
    assert.equal(output.GITHUB_TOKEN, undefined);
    assert.equal(output.NODE_OPTIONS, undefined);
    assert.equal(output.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(output.TERM, "dumb");
  }
});

test("JSONL reader handles split Unicode, several events, and an unterminated final event", () => {
  const lines = [];
  const reader = makeLineReader((line) => lines.push(line), assert.fail);
  const first = Buffer.from(
    '{"text":"héllo 🌱"}\n{"second":true}\n{"last":true}',
  );
  for (const byte of first) reader.write(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [{ text: "héllo 🌱" }, { second: true }, { last: true }],
  );
});

test("JSONL reader bounds partial and complete lines", () => {
  for (const ending of ["", "\n"]) {
    const failures = [];
    const reader = makeLineReader(
      () => assert.fail("oversized event accepted"),
      (text) => failures.push(text),
    );
    reader.write("x".repeat(2 * 1024 * 1024 + 1) + ending);
    reader.end();
    assert.equal(failures.length, 1);
  }
});

function parserFixture(provider) {
  const deltas = [],
    sessions = [],
    statuses = [],
    failures = [];
  const parser = createEventParser(provider, {
    delta: (text) => deltas.push(text),
    session: (id) => sessions.push(id),
    status: (text) => statuses.push(text),
    failure: (text) => failures.push(text),
  });
  return {
    parser,
    deltas,
    sessions,
    statuses,
    failures,
    send: (event) => parser.line(JSON.stringify(event)),
  };
}

test("Claude partial output is not duplicated by assistant and result messages", () => {
  const f = parserFixture("claude");
  f.send({ type: "system", session_id: "claude-one" });
  for (const text of ["Hello", " world"]) {
    f.send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    });
  }
  f.send({
    type: "assistant",
    message: { content: [{ type: "text", text: "Hello world" }] },
  });
  f.send({ type: "result", subtype: "success", result: "Hello world" });
  assert.equal(f.deltas.join(""), "Hello world");
  assert.equal(f.parser.completed, true);
  assert.deepEqual(f.sessions, ["claude-one"]);
  assert.deepEqual(f.failures, []);
});

test("Claude supports older message-level streaming and ignores tool payloads", () => {
  const f = parserFixture("claude");
  f.send({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { secret: "private" } },
      ],
    },
  });
  f.send({
    type: "assistant",
    message: { content: [{ type: "text", text: "Ready." }] },
  });
  f.send({
    type: "result",
    subtype: "success",
    result: "Ready.",
    permission_denials: [{ tool_name: "Write" }],
  });
  assert.equal(f.deltas.join(""), "Ready.");
  assert.equal(JSON.stringify(f.statuses).includes("private"), false);
  assert.equal(f.statuses.length, 2);
});

test("Codex streaming items and completion normalize to a single response", () => {
  const f = parserFixture("codex");
  f.send({ type: "thread.started", thread_id: "codex-one" });
  f.send({
    type: "item.started",
    item: {
      id: "tool",
      type: "command_execution",
      command: "sensitive command",
    },
  });
  f.send({
    type: "item.updated",
    item: { id: "one", type: "agent_message", text: "Hello" },
  });
  f.send({
    type: "item.completed",
    item: { id: "one", type: "agent_message", text: "Hello world" },
  });
  f.send({
    type: "item.completed",
    item: { id: "one", type: "agent_message", text: "Hello world" },
  });
  f.send({
    type: "item.completed",
    item: { id: "two", type: "agent_message", text: "Done." },
  });
  f.send({ type: "turn.completed", usage: { input_tokens: 20 } });
  assert.equal(f.deltas.join(""), "Hello world\n\nDone.");
  assert.deepEqual(f.sessions, ["codex-one"]);
  assert.equal(f.parser.completed, true);
  assert.equal(JSON.stringify(f.statuses).includes("sensitive"), false);
});

test("provider diagnostics are not forwarded as raw credential-bearing messages", () => {
  for (const provider of ["claude", "codex"]) {
    const f = parserFixture(provider);
    f.send(
      provider === "claude"
        ? { type: "result", is_error: true, result: "Bearer secret-token" }
        : { type: "error", message: "Bearer secret-token" },
    );
    assert.equal(f.failures.length, 1);
    assert.equal(JSON.stringify(f).includes("secret-token"), false);
  }
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1000;
  child.input = "";
  child.stdin.on("data", (data) => {
    child.input += data;
  });
  child.kill = (signal) => {
    child.emit("close", null, signal);
  };
  child.event = (event) => child.stdout.write(JSON.stringify(event) + "\n");
  child.finish = (text) => {
    child.event({ type: "result", subtype: "success", result: text });
    child.emit("close", 0, null);
  };
  return child;
}

async function bridgeFixture(t, options = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "arma-bridge-test-"),
  );
  const workspace = path.join(directory, "claims");
  await fs.mkdir(workspace);
  const launches = [];
  const bridge = new AgentBridge({
    runtimeParent: directory,
    binaries: {
      claude: { command: "/fake/claude", args: [] },
      codex: { command: "/fake/codex", args: [] },
    },
    probe: async (provider) => ({
      version:
        provider === "claude" ? "2.1.280 (Claude Code)" : "codex-cli 0.156.1",
      help: "--restricted --tools --strict-mcp-config --setting-sources --permission-prompts --ephemeral --ignore-user-config --ignore-rules --json",
    }),
    spawnProcess: (command, args, spawnOptions) => {
      const child = fakeProcess();
      launches.push({ command, args, options: spawnOptions, child });
      return child;
    },
    killProcessGroup: (child, signal) => child.kill(signal),
    env: {
      HOME: directory,
      PATH: "/bin",
      ANTHROPIC_API_KEY: "private-claude-key",
      OPENAI_API_KEY: "private-openai-key",
    },
    ...options,
  });
  t.after(async () => {
    bridge.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { bridge, directory, workspace, launches };
}

test("Claude redaction loads the bundled skill, isolates conversation history, and exposes only the private runner", async (t) => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  await bridge.start(
    {
      workspace,
      prompt: "Earlier general conversation",
      conversationId: "same",
    },
    () => {},
  );
  launches[0].child.finish("Earlier allowed file contents");
  let cancelled = false;
  await bridge.start(
    {
      workspace,
      prompt: "Redact column B",
      conversationId: "same",
      redaction: {
        sourceName: "source.xlsx",
        run: () => assert.fail("unexpected call"),
        cancel: () => {
          cancelled = true;
        },
      },
    },
    () => {},
  );
  const launch = launches[1],
    args = launch.args;
  assert.equal(
    args[args.indexOf("--allowedTools") + 1],
    "mcp__workspace__run_redaction_script",
  );
  assert.match(args[args.indexOf("--system-prompt") + 1], /name: redact/);
  assert.match(launch.child.input, /source.xlsx/);
  assert.doesNotMatch(launch.child.input, /Earlier/);
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.equal(config.mcpServers.workspace.args.length, 1);
  assert.match(config.mcpServers.workspace.args[0], /redaction-tools.cjs$/);
  assert.ok(config.mcpServers.workspace.env.ARMA_REDACTION_PIPE);
  launch.child.finish(
    "2 items redacted from source.xlsx. Ready for local review.",
  );
  assert.equal(cancelled, true);
});

test("production provider list omits Codex and never exposes binary details", async (t) => {
  const { bridge } = await bridgeFixture(t);
  const status = await bridge.status();
  assert.equal(status.length, 1);
  assert.equal(status[0].id, "claude");
  assert.equal(status[0].available, true);
  assert.equal(status[0].binary, undefined);
  await assert.rejects(
    bridge.start(
      { provider: "codex", prompt: "hello", workspace: "/tmp" },
      () => {},
    ),
    /not available/,
  );
});

test("Claude selections reach CLI flags and unsupported model/effort pairs never spawn", async (t) => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  for (const selection of [
    { model: "--unsafe" },
    { model: "gpt-6-astra" },
    { model: "haiku", effort: "high" },
    { model: "sonnet", effort: "ultracode" },
    { model: {}, effort: "" },
    { effort: "high" },
  ]) await assert.rejects(bridge.start({ workspace, prompt: "Hello", ...selection }, () => {}), /model|effort/);
  assert.equal(launches.length, 0);
  await bridge.start({ workspace, prompt: "Hello", model: "sonnet", effort: "high" }, () => {});
  const args = launches[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  launches[0].child.finish("Done");
});

test("Codex selections are checked against the catalog before starting", async (t) => {
  const { bridge, workspace } = await bridgeFixture(t, { allowCodex: true });
  bridge.modelCatalog = Promise.resolve({ models: [{ id: "gpt-6-astra", efforts: ["low", "xhigh"] }] });
  const calls = [];
  bridge.startCodex = (args) => { calls.push(args); return { runId: "selected" }; };
  await assert.rejects(bridge.start({ provider: "codex", workspace, prompt: "Hello", model: "sonnet" }, () => {}), /model/);
  await assert.rejects(bridge.start({ provider: "codex", workspace, prompt: "Hello", model: "gpt-6-astra", effort: "high" }, () => {}), /effort/);
  await bridge.start({ provider: "codex", workspace, prompt: "Hello", model: "gpt-6-astra", effort: "xhigh" }, () => {});
  assert.equal(calls[0].model, "gpt-6-astra");
  assert.equal(calls[0].effort, "xhigh");
});

test("unreviewed CLI versions fail closed", async (t) => {
  const { bridge } = await bridgeFixture(t, {
    probe: async () => ({
      version: "9.0.0",
      help: "--restricted --tools --strict-mcp-config --setting-sources --permission-prompts",
    }),
  });
  assert.equal((await bridge.status())[0].available, false);
});

test("Claude launches without built-in tools or host customizations and sends prompt only on stdin", async (t) => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  const events = [];
  const { runId } = await bridge.start(
    {
      prompt: "A private message $(do not execute)",
      workspace,
      conversationId: "one",
    },
    (event) => events.push(event),
  );
  const launch = launches[0];
  assert.equal(launch.options.shell, false);
  assert.notEqual(launch.options.cwd, workspace);
  assert.equal(
    launch.args.includes("A private message $(do not execute)"),
    false,
  );
  assert.equal(launch.child.input, "A private message $(do not execute)");
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
  assert.equal(launch.args[launch.args.indexOf("--setting-sources") + 1], "");
  assert.equal(
    launch.args[launch.args.indexOf("--permission-mode") + 1],
    "dontAsk",
  );
  assert.equal(launch.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(launch.options.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  const mcp = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["workspace"]);
  assert.equal(mcp.mcpServers.workspace.args[1], await fs.realpath(workspace));
  assert.equal(mcp.mcpServers.workspace.env.ANTHROPIC_API_KEY, "");
  assert.equal(
    JSON.stringify(launch.args).includes("private-claude-key"),
    false,
  );
  launch.child.finish("Completed.");
  assert.deepEqual(
    events.filter((e) => e.type === "delta"),
    [{ runId, type: "delta", text: "Completed." }],
  );
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).failed, false);
});

test("conversation context is isolated by provider, workspace, and conversation", async (t) => {
  const { bridge, workspace, directory, launches } = await bridgeFixture(t);
  await bridge.start(
    { prompt: "remember apples", workspace, conversationId: "one" },
    () => {},
  );
  launches.at(-1).child.finish("Remembered apples.");
  await bridge.start(
    { prompt: "what did I say?", workspace, conversationId: "one" },
    () => {},
  );
  assert.match(launches.at(-1).child.input, /Remembered apples/);
  launches.at(-1).child.finish("Apples.");
  await bridge.start(
    { prompt: "hello", workspace, conversationId: "two" },
    () => {},
  );
  assert.equal(launches.at(-1).child.input, "hello");
  launches.at(-1).child.finish("Hello.");
  const second = path.join(directory, "other");
  await fs.mkdir(second);
  await bridge.start(
    { prompt: "new workspace", workspace: second, conversationId: "one" },
    () => {},
  );
  assert.equal(launches.at(-1).child.input, "new workspace");
  launches.at(-1).child.finish("Ready.");
});

test("cancellation terminates the process and does not preserve a partial turn", async (t) => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  const events = [];
  const { runId } = await bridge.start(
    { prompt: "cancel this prompt", workspace },
    (event) => events.push(event),
  );
  launches
    .at(-1)
    .child.event({
      type: "assistant",
      message: { content: [{ type: "text", text: "Partial." }] },
    });
  assert.equal(bridge.cancel(runId), true);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).cancelled, true);
  assert.equal(bridge.cancel(runId), false);
  await bridge.start({ prompt: "fresh", workspace }, () => {});
  assert.equal(launches.at(-1).child.input, "fresh");
  launches.at(-1).child.finish("Done.");
});

test("malformed output and abrupt exit emit one generic error and completion", async (t) => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  const events = [];
  await bridge.start({ prompt: "hello", workspace }, (event) =>
    events.push(event),
  );
  launches.at(-1).child.stdout.write("Not JSON with secret-token\n");
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(JSON.stringify(events).includes("secret-token"), false);
});

test("an active turn cannot be replaced by another turn", async (t) => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  await bridge.start({ prompt: "first", workspace }, () => {});
  await assert.rejects(
    bridge.start({ prompt: "second", workspace }, () => {}),
    /current agent turn/,
  );
  launches.at(-1).child.finish("Done.");
});

test("agents reject protected paths even when selected as the working directory", async (t) => {
  const { bridge, directory, launches } = await bridgeFixture(t);
  for (const name of ["unredacted", "UNREDACTED", "ｕｎｒｅｄａｃｔｅｄ"]) {
    const protectedRoot = path.join(directory, name);
    await fs.mkdir(protectedRoot, { recursive: true });
    await assert.rejects(
      bridge.start({ prompt: "inspect", workspace: protectedRoot }, () => {}),
      /protected/,
    );
  }
  const link = path.join(directory, "innocent");
  await fs.symlink(path.join(directory, "unredacted"), link);
  await assert.rejects(
    bridge.start({ prompt: "inspect", workspace: link }, () => {}),
    /protected/,
  );
  assert.equal(launches.length, 0);
});

test("disposing while detection is pending prevents a late process launch", async (t) => {
  let release;
  const { bridge, workspace, launches } = await bridgeFixture(t, {
    probe: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            version: "2.1.280",
            help: "--restricted --tools --strict-mcp-config --setting-sources --permission-prompts",
          });
      }),
  });
  const pending = bridge.start({ prompt: "hello", workspace }, () => {});
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  bridge.dispose();
  release();
  await assert.rejects(pending, /closed/);
  assert.equal(launches.length, 0);
});


test("ordinary Claude chat describes the bundled Database workflow", () => {
  const args=claudeArguments("/workspace","/runtime");
  assert.match(args[args.indexOf("--system-prompt")+1],/open_report/);
  assert.match(args[args.indexOf("--system-prompt")+1],/follow-up questions/);
});

test("restoration isolates model history and exposes only its dedicated local tool", async t => {
  const { bridge, workspace, launches } = await bridgeFixture(t);
  await bridge.start({ workspace, prompt: "General question", conversationId: "same" }, () => {});
  launches.at(-1).child.finish("Earlier workspace file contents");
  const access = {
    ready: Promise.resolve(), tools: [require("../unredaction-tools.cjs").TOOL],
    adapter: "unredaction-tools.cjs", historyScope: "restoration",
    systemPrompt: require("../skills.cjs").UNREDACTION_SKILL,
    context: JSON.stringify({ document_count: 1, mapping_count: 1 }),
    call: () => assert.fail("No automatic restoration calls"), cancel: () => {},
  };
  await bridge.start({ workspace, prompt: "Restore selected summaries", conversationId: "same", access }, () => {});
  const launch = launches.at(-1);
  assert.doesNotMatch(launch.child.input, /Earlier workspace file contents|General question/);
  assert.equal(launch.args[launch.args.indexOf("--allowedTools") + 1], "mcp__workspace__run_unredaction_script");
  assert.match(launch.args[launch.args.indexOf("--system-prompt") + 1], /name: unredact-summaries/);
  launch.child.finish("One report restored locally");
  await bridge.start({ workspace, prompt: "Workspace follow-up", conversationId: "same" }, () => {});
  assert.doesNotMatch(launches.at(-1).child.input, /One report restored locally/);
  launches.at(-1).child.finish("Done");
});
