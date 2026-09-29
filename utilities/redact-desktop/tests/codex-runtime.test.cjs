"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const {
  startCodexRun,
  readCodexAuth,
  runtimeConfig,
  CODEX_VERSION,
} = require("../codex-runtime.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arma-codex-unit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const messages = [],
    output = [],
    failures = [],
    done = [],
    kills = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      messages.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  child.kill = (signal) => {
    kills.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
  };
  let launch;
  const run = startCodexRun(
    {
      binary: { command: "/test/codex", args: [], node: false },
      workspace: "/private/workspace",
      runtimeDirectory: directory,
      prompt: "List the available files.",
      env: {
        HOME: "/operator",
        CODEX_HOME: "/operator/.codex",
        PATH: "/usr/bin",
        OPENAI_API_KEY: "should-not-forward",
        CODEX_ACCESS_TOKEN: "wrong-token-kind",
        ANTHROPIC_API_KEY: "claude-secret",
        NODE_OPTIONS: "--require unsafe",
      },
      readAuth: () => ({
        accessToken: "only-access-token",
        chatgptAccountId: "account-route",
        refreshToken: "never-forward-refresh",
      }),
      spawnProcess: (command, args, options) => {
        launch = { command, args, options };
        return child;
      },
      ...overrides,
    },
    {
      delta: (text) => output.push(text),
      status: () => {},
      failure: (text) => failures.push(text),
      done: (value) => done.push(value),
    },
  );
  t.after(() => run.cancel("SIGKILL"));
  const send = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
  const reply = (method, result = {}) => {
    const request = messages.findLast((message) => message.method === method);
    assert.ok(request, method);
    send({ id: request.id, result });
  };
  return {
    directory,
    run,
    child,
    messages,
    output,
    failures,
    done,
    kills,
    send,
    reply,
    get launch() {
      return launch;
    },
  };
}
async function handshake(f) {
  await tick();
  f.reply("initialize", { userAgent: `codex-cli/${CODEX_VERSION}` });
  f.reply("account/login/start", { type: "chatgptAuthTokens" });
  f.reply("thread/start", { thread: { id: "thread-one" } });
  f.reply("turn/start", { turn: { id: "turn-one" } });
}

test("Codex database turns expose and dispatch only the selected report tools", async (t) => {
  const calls = [];
  const f = fixture(t, { conversion: { call: async (name,args) => { calls.push({name,args}); return [{ columns:["count"],values:[[3]] }]; } } });
  await handshake(f);
  const thread = f.messages.find(m=>m.method === "thread/start").params;
  assert.deepEqual(thread.dynamicTools.map(t=>t.name),["report_sql","save_database"]);
  assert.match(thread.baseInstructions,/name: database/);
  f.send({ id: 501, method: "item/tool/call", params: { threadId:"thread-one",turnId:"turn-one",callId:"database-query",tool:"report_sql",arguments:{sql:"SELECT COUNT(*) FROM source_rows"} } });
  await tick(); await tick();
  assert.deepEqual(calls,[{name:"report_sql",args:{sql:"SELECT COUNT(*) FROM source_rows"}}]);
  assert.equal(f.messages.find(m=>m.id===501).result.success,true);
  f.send({ id: 502, method: "item/tool/call", params: { threadId:"thread-one",turnId:"turn-one",callId:"forbidden",tool:"read_file",arguments:{path:"unredacted/private.csv"} } });
  await tick();
  assert.equal(f.messages.find(m=>m.id===502).result.success,false);
  assert.equal(calls.length,1);
});

test("ordinary Codex chat knows how to open the spreadsheet workflow", async t => {
  const f=fixture(t);
  await handshake(f);
  const thread=f.messages.find(m=>m.method==='thread/start').params;
  assert.match(thread.baseInstructions,/open_report/);
  assert.match(thread.baseInstructions,/follow-up questions/);
  assert.equal(thread.dynamicTools.some(tool=>tool.name==='report_sql'),false);
});

test("model discovery paginates without starting a conversation or exposing tools", async (t) => {
  let entries;
  const f = fixture(t, { onModels: (value) => { entries = value; } });
  await tick();
  f.reply("initialize");
  f.reply("account/login/start");
  f.reply("model/list", { data: [{ model: "first" }], nextCursor: "next-page" });
  assert.equal(f.messages.findLast((item) => item.method === "model/list").params.cursor, "next-page");
  f.reply("model/list", { data: [{ model: "second" }], nextCursor: null });
  await tick();
  assert.deepEqual(entries, [{ model: "first" }, { model: "second" }]);
  assert(!f.messages.some((item) => ["thread/start", "turn/start"].includes(item.method)));
  assert.deepEqual(f.failures, []);
  assert.equal(f.done[0].code, 0);
});

test("selected Codex model and effort reach the thread and turn", async (t) => {
  const f = fixture(t, { model: "gpt-6-astra", effort: "xhigh" });
  await handshake(f);
  assert.equal(f.messages.find((item) => item.method === "thread/start").params.model, "gpt-6-astra");
  const turn = f.messages.find((item) => item.method === "turn/start").params;
  assert.equal(turn.model, "gpt-6-astra");
  assert.equal(turn.effort, "xhigh");
});

test("Codex redaction has only the bound runner and never exposes general file capabilities", async (t) => {
  const calls = [];
  const f = fixture(t, {
    redaction: {
      run: async (schema) => {
        calls.push(schema);
        return {
          items: 2,
          file: "source.xlsx",
          privateData: "never-return-this",
        };
      },
    },
  });
  await handshake(f);
  const thread = f.messages.find(
    (message) => message.method === "thread/start",
  ).params;
  assert.deepEqual(
    thread.dynamicTools.map((tool) => tool.name),
    ["run_redaction_script"],
  );
  assert.match(thread.baseInstructions, /name: redact/);
  f.send({
    id: 80,
    method: "item/tool/call",
    params: {
      threadId: "thread-one",
      turnId: "turn-one",
      tool: "read_file",
      arguments: { path: "unredacted/source.xlsx" },
    },
  });
  await tick();
  assert.equal(
    f.messages.find((message) => message.id === 80).result.success,
    false,
  );
  f.send({
    id: 81,
    method: "item/tool/call",
    params: {
      threadId: "thread-one",
      turnId: "turn-one",
      tool: "run_redaction_script",
      arguments: { schema_json: '{"version":1}' },
    },
  });
  await tick();
  assert.equal(
    f.messages.find((message) => message.id === 81).result.success,
    true,
  );
  assert.deepEqual(calls, ['{"version":1}']);
  assert.doesNotMatch(JSON.stringify(f.messages), /never-return-this/);
});

test("Codex runs without an environment and receives access auth only over the protocol pipe", async (t) => {
  const f = fixture(t);
  await handshake(f);
  const { args, options } = f.launch;
  assert.ok(args.includes("app-server"));
  assert.ok(args.includes("--strict-config"));
  assert.equal(options.cwd, path.join(f.directory, "cwd"));
  assert.equal(options.env.HOME, path.join(f.directory, "home"));
  assert.equal(options.env.CODEX_HOME, path.join(f.directory, "codex"));
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "NODE_OPTIONS",
  ])
    assert.equal(options.env[key], undefined);
  const login = f.messages.find(
    (message) => message.method === "account/login/start",
  ).params;
  assert.deepEqual(login, {
    type: "chatgptAuthTokens",
    accessToken: "only-access-token",
    chatgptAccountId: "account-route",
  });
  assert.equal(JSON.stringify(f.launch).includes("only-access-token"), false);
  assert.equal(
    JSON.stringify(f.messages).includes("never-forward-refresh"),
    false,
  );
  for (const method of ["thread/start", "turn/start"]) {
    const params = f.messages.find(
      (message) => message.method === method,
    ).params;
    assert.deepEqual(params.environments, []);
    assert.deepEqual(params.runtimeWorkspaceRoots, []);
  }
  const thread = f.messages.find(
    (message) => message.method === "thread/start",
  ).params;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.approvalPolicy, "never");
  assert.deepEqual(thread.selectedCapabilityRoots, []);
  assert.equal(thread.config.features.skip_host_skill_discovery, true);
  for (const feature of [
    "shell_tool",
    "view_image",
    "browser_use",
    "computer_use",
    "hooks",
    "plugins",
    "apps",
    "multi_agent",
    "code_mode",
    "image_generation",
  ])
    assert.equal(thread.config.features[feature], false);
  assert.equal(thread.config.project_doc_max_bytes, 0);
  assert.equal(thread.config.cli_auth_credentials_store, "ephemeral");
  assert.equal(
    fs.existsSync(path.join(options.env.CODEX_HOME, "auth.json")),
    false,
  );
  assert.deepEqual(thread.config.mcp_servers, {});
  assert.deepEqual(
    thread.dynamicTools.map((tool) => tool.name),
    ["list_directory", "read_file", "write_file", "create_directory"],
  );
  assert.deepEqual(thread.config.orchestrator, {
    skills: { enabled: false },
    mcp: { enabled: false },
  });
  assert.equal(
    JSON.stringify(thread.baseInstructions).includes("/private/workspace"),
    false,
  );
});

test("Codex stream handles split Unicode, completed messages and clean shutdown", async (t) => {
  const f = fixture(t);
  await handshake(f);
  const data = Buffer.from(
    `${JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "one", delta: "héllo 🌱" } })}\n`,
  );
  for (const byte of data) f.child.stdout.write(Buffer.from([byte]));
  f.send({
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "one", text: "héllo 🌱!" } },
  });
  f.send({
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "one", text: "héllo 🌱!" } },
  });
  f.send({
    method: "turn/completed",
    params: { turn: { id: "turn-one", status: "completed" } },
  });
  await tick();
  assert.equal(f.output.join(""), "héllo 🌱!");
  assert.deepEqual(f.done, [{ code: 0, signal: null }]);
  assert.deepEqual(f.failures, []);
});

test("unexpected approvals and token refresh requests cannot grant capabilities", async (t) => {
  const f = fixture(t);
  await handshake(f);
  f.send({
    id: 101,
    method: "item/commandExecution/requestApproval",
    params: { command: "cat /private/file" },
  });
  f.send({ id: 102, method: "item/fileChange/requestApproval", params: {} });
  f.send({ id: 103, method: "account/chatgptAuthTokens/refresh", params: {} });
  assert.deepEqual(f.messages.find((message) => message.id === 101).result, {
    decision: "decline",
  });
  assert.deepEqual(f.messages.find((message) => message.id === 102).result, {
    decision: "decline",
  });
  assert.equal(
    f.messages.find((message) => message.id === 103).error.code,
    -32601,
  );
});

test("startup cancellation is effective before spawning or reading authentication", async (t) => {
  const f = fixture(t, {
    readAuth: () => assert.fail("authentication read after cancellation"),
  });
  f.run.cancel();
  await tick();
  assert.equal(f.launch, undefined);
  assert.equal(f.done.length, 1);
  assert.deepEqual(f.failures, []);
});

test("missing authentication fails once without starting a process", async (t) => {
  const f = fixture(t, {
    readAuth: () => {
      throw new Error("secret-auth-content");
    },
  });
  await tick();
  assert.equal(f.launch, undefined);
  assert.equal(f.failures.length, 1);
  assert.equal(f.done.length, 1);
  assert.equal(f.failures.join("").includes("secret-auth-content"), false);
});

test("raw server errors and stderr are never shown or logged", async (t) => {
  const f = fixture(t);
  await tick();
  f.child.stderr.write("Bearer credential-value");
  f.send({
    id: f.messages[0].id,
    error: { message: "Bearer credential-value" },
  });
  await tick();
  assert.equal(f.failures.length, 1);
  assert.equal(f.done.length, 1);
  assert.equal(
    JSON.stringify([f.output, f.failures, f.done]).includes("credential-value"),
    false,
  );
});

test("auth reader selects access token and account id without exposing the cached refresh token", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arma-codex-auth-unit-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "access",
        account_id: "account",
        refresh_token: "refresh-must-stay-here",
        id_token: "identity",
      },
    }),
  );
  assert.deepEqual(readCodexAuth({ CODEX_HOME: directory }), {
    accessToken: "access",
    chatgptAccountId: "account",
  });
  fs.writeFileSync(path.join(directory, "auth.json"), "{invalid-secret");
  assert.throws(
    () => readCodexAuth({ CODEX_HOME: directory }),
    /Sign in with the Codex CLI/,
  );
});

test("Codex does not initialize native MCP or skill discovery", () => {
  const config = runtimeConfig("/selected/workspace", "/temporary/runtime");
  assert.deepEqual(config.mcp_servers, {});
  assert.equal(config.orchestrator.mcp.enabled, false);
  assert.equal(config.orchestrator.skills.enabled, false);
});

test("dynamic tool calls share the protected workspace boundary and reject unknown capabilities", async (t) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "arma-codex-workspace-unit-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "redacted"));
  fs.mkdirSync(path.join(workspace, "unredacted"));
  fs.writeFileSync(
    path.join(workspace, "unredacted", "secret.txt"),
    "protected-content",
  );
  const f = fixture(t, { workspace });
  await handshake(f);
  const call = (id, tool, args) =>
    f.send({
      id,
      method: "item/tool/call",
      params: {
        callId: `call-${id}`,
        threadId: "thread-one",
        turnId: "turn-one",
        tool,
        arguments: args,
      },
    });
  call(201, "write_file", {
    path: "redacted/created.txt",
    content: "synthetic-output",
  });
  call(202, "read_file", { path: "unredacted/secret.txt" });
  call(203, "exec_command", { cmd: "ls" });
  for (
    let index = 0;
    index < 30 && !f.messages.some((message) => message.id === 203);
    index++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    f.messages.find((message) => message.id === 201).result.success,
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, "redacted", "created.txt"), "utf8"),
    "synthetic-output",
  );
  assert.equal(
    f.messages.find((message) => message.id === 202).result.success,
    false,
  );
  assert.equal(
    f.messages.find((message) => message.id === 203).result.success,
    false,
  );
  assert.equal(JSON.stringify(f.messages).includes("protected-content"), false);
});

test('normal Codex chat can dispatch report tools without activating a conversion mode', async t => {
  const calls=[];
  const f=fixture(t,{access:{ready:Promise.resolve(),call:async(name,args)=>{calls.push({name,args});return {path:'redacted/example.sqlite'};}}});
  await handshake(f);
  const thread=f.messages.find(m=>m.method==='thread/start').params;
  assert.deepEqual(thread.dynamicTools.map(t=>t.name),['list_directory','read_file','write_file','create_directory','open_report','report_sql','save_database','create_patient_summaries']);
  f.send({id:888,method:'item/tool/call',params:{threadId:'thread-one',turnId:'turn-one',callId:'open',tool:'open_report',arguments:{path:'redacted/example.sqlite'}}});
  await tick();await tick();
  assert.equal(f.messages.find(m=>m.id===888).result.success,true);
  assert.deepEqual(calls,[{name:'open_report',args:{path:'redacted/example.sqlite'}}]);
});

test('Codex summary turns expose only the read-only report capability and summary skill', async t => {
  const calls = [];
  const access = {
    ready: Promise.resolve(),
    instructions: require('../skills.cjs').PATIENT_SUMMARY_SKILL,
    tools: [require('../database-tools.cjs').TOOLS[0], ...require('../patient-summary-tools.cjs').TOOLS],
    call: async (name, args) => { calls.push({ name, args }); return { status: 'saved', patientCount: 4 }; },
  };
  const f = fixture(t, { access }); await handshake(f);
  const thread = f.messages.find(m => m.method === 'thread/start').params;
  assert.deepEqual(thread.dynamicTools.map(t => t.name), ['report_sql', 'create_patient_summaries']);
  assert.match(thread.baseInstructions, /name: patient-summaries/);
  f.send({ id: 900, method: 'item/tool/call', params: { threadId: 'thread-one', turnId: 'turn-one', callId: 'summary', tool: 'create_patient_summaries', arguments: { mapping: {} } } });
  await tick(); await tick();
  assert.equal(f.messages.find(m => m.id === 900).result.success, true);
  f.send({ id: 901, method: 'item/tool/call', params: { threadId: 'thread-one', turnId: 'turn-one', callId: 'blocked', tool: 'write_file', arguments: { path: 'redacted/other.txt', content: 'bad' } } });
  await tick();
  assert.equal(f.messages.find(m => m.id === 901).result.success, false);
  assert.equal(calls.length, 1);
});

test('Codex restoration uses the private workflow instructions and never offers filesystem tools', async t => {
  const { TOOL, PLAN } = require('../unredaction-tools.cjs'), calls = [];
  const access = { ready: Promise.resolve(), tools: [TOOL], systemPrompt: require('../skills.cjs').UNREDACTION_SKILL,
    call: async (name, args) => { calls.push({ name, args }); return { status: 'saved', documentCount: 1, replacements: 2, path: 'unredacted/Patient Summaries/generated-set' }; } };
  const f = fixture(t, { access }); await handshake(f);
  const thread = f.messages.find(m => m.method === 'thread/start').params;
  assert.deepEqual(thread.dynamicTools.map(t => t.name), [TOOL.name]);
  assert.match(thread.baseInstructions, /name: unredact-summaries/);
  f.send({ id: 910, method: 'item/tool/call', params: { threadId: 'thread-one', turnId: 'turn-one', callId: 'restore', tool: TOOL.name, arguments: { schema_json: JSON.stringify(PLAN) } } });
  await tick(); await tick(); assert.equal(f.messages.find(m => m.id === 910).result.success, true);
  f.send({ id: 911, method: 'item/tool/call', params: { threadId: 'thread-one', turnId: 'turn-one', callId: 'blocked', tool: 'read_file', arguments: { path: 'unredacted/mapping.csv' } } });
  await tick(); assert.equal(f.messages.find(m => m.id === 911).result.success, false); assert.equal(calls.length, 1);
});
