"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const {
  WorkspaceTools,
  TOOLS,
  handleRequest,
} = require("./workspace-tools.cjs");
const {
  createRedactionTools,
  TOOL: REDACTION_TOOL,
} = require("./redaction-tools.cjs");
const { REDACTION_SKILL, DATABASE_SKILL, PATIENT_SUMMARY_SKILL, WORKFLOW_GUIDANCE } = require("./skills.cjs");
const { createDatabaseTools, TOOLS: DATABASE_TOOLS } = require("./database-tools.cjs");

// This protocol and the absence of environment tools are verified against this
// exact release. Updating it requires rechecking the runtime capability surface.
const { TOOLS: AGENT_TOOLS } = require("./agent-tools.cjs");
const CODEX_VERSION = "0.156.1";
const WORKSPACE_TOOLS = [
  "list_directory",
  "read_file",
  "write_file",
  "create_directory",
];
const FAILURE =
  "Codex could not complete this turn. Check its CLI login and try again.";
const LOGIN_FAILURE =
  "Sign in with the Codex CLI before using Codex testing. Run codex login in your terminal.";
const SYSTEM_PROMPT =
  "You are the ARMa workspace assistant. Use only the supplied workspace tools. All paths supplied to those tools are relative to the selected workspace. The operator authorizes write_file and create_directory within the workspace; the application enforces their protected path limits. The operator authorizes reading and writing redacted files through the workspace tools without additional permission prompts. The unredacted directory is protected and unavailable: do not inspect, read, modify, move, or delete it or anything inside it. Do not attempt to bypass the workspace tools. You have no shell, browser, unrestricted filesystem, or external integration access. Follow the operator's request and report actual tool results accurately." + WORKFLOW_GUIDANCE;

function readCodexAuth(env = process.env) {
  try {
    const directory =
      env.CODEX_HOME ||
      path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
    const filename = path.join(directory, "auth.json");
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid auth store");
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    const accessToken = value.tokens?.access_token;
    const chatgptAccountId = value.tokens?.account_id;
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      typeof chatgptAccountId !== "string" ||
      !chatgptAccountId
    )
      throw new Error("No ChatGPT login");
    // Select only the ephemeral access token and account routing id. In
    // particular, never copy, return, renew, or forward the cached refresh token.
    return { accessToken, chatgptAccountId };
  } catch {
    throw new Error(LOGIN_FAILURE);
  }
}

function runtimeConfig(workspace, runtimeDirectory) {
  const disabled = [
    "apps",
    "plugins",
    "remote_plugin",
    "plugin_sharing",
    "recommended_plugins",
    "tool_suggest",
    "hooks",
    "shell_tool",
    "shell_snapshot",
    "shell_snapshot_v2",
    "unified_exec",
    "unified_exec_tty",
    "view_image",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "in_app_browser",
    "in_app_chat",
    "in_app_dictation",
    "in_app_local_automation",
    "image_generation",
    "code_mode",
    "code_mode_only",
    "code_mode_prewarm",
    "multi_agent",
    "multi_agent_v2",
    "agent_message_board",
    "memories",
    "external_agent_memory_import",
    "skill_search",
    "skill_mcp_dependency_install",
    "workspace_dependencies",
    "goals",
    "request_permissions_tool",
    "standalone_web_search",
    "deferred_executor",
    "executor_capability_discovery",
    "current_time_reminder",
    "sleep_tool",
    "token_budget",
    "context_management",
    "send_message_to_user_async",
    "default_mode_request_user_input",
    "realtime_conversation",
    "daemon_auto_start",
    "auth_elicitation",
    "tool_call_mcp_elicitation",
  ];
  return {
    model_provider: "openai",
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    cli_auth_credentials_store: "ephemeral",
    mcp_oauth_credentials_store: "file",
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    notify: [],
    check_for_update_on_startup: false,
    include_environment_context: false,
    include_apps_instructions: false,
    // The CLI has no environment. Its native read-only description does not
    // describe the separately authorized, guarded application file tools.
    include_permissions_instructions: false,
    include_collaboration_mode_instructions: false,
    // Some model catalogs require CodeModeOnly regardless of feature flags.
    // The host dispatches only registered tools; it does not add file/shell tools.
    features: {
      ...Object.fromEntries(disabled.map((name) => [name, false])),
      skip_host_skill_discovery: true,
      code_mode_host: true,
    },
    agents: { enabled: false },
    apps: { _default: { enabled: false } },
    skills: { bundled: { enabled: false }, include_instructions: false },
    tools: {
      update_plan: { enabled: false },
      experimental_request_user_input: { enabled: false },
    },
    orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
    history: { persistence: "none" },
    analytics: { enabled: false },
    feedback: { enabled: false },
    // With no environment, Codex intentionally cannot launch stdio servers.
    // Dynamic calls below use the same application-owned boundary as Claude MCP.
    mcp_servers: {},
  };
}

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`)
      .join(", ")} }`;
  return JSON.stringify(value);
}

function runtimeEnvironment(source, runtimeDirectory, node) {
  const result = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  Object.assign(result, {
    HOME: path.join(runtimeDirectory, "home"),
    USERPROFILE: path.join(runtimeDirectory, "home"),
    CODEX_HOME: path.join(runtimeDirectory, "codex"),
    APPDATA: path.join(runtimeDirectory, "home"),
    LOCALAPPDATA: path.join(runtimeDirectory, "home"),
    XDG_CONFIG_HOME: path.join(runtimeDirectory, "home"),
    XDG_CACHE_HOME: path.join(runtimeDirectory, "home"),
    TMPDIR: path.join(runtimeDirectory, "tmp"),
    TMP: path.join(runtimeDirectory, "tmp"),
    TEMP: path.join(runtimeDirectory, "tmp"),
    NO_COLOR: "1",
    TERM: "dumb",
  });
  if (node) result.ELECTRON_RUN_AS_NODE = "1";
  return result;
}

function startCodexRun(
  {
    binary,
    workspace,
    runtimeDirectory,
    env = process.env,
    prompt,
    spawnProcess = spawn,
    readAuth = readCodexAuth,
    redaction,
    conversion,
    access,
    model,
    effort,
    onModels,
  },
  callbacks,
) {
  let child,
    stopped = false,
    finished = false,
    failed = false,
    completed = false;
  let requestId = 0,
    threadId,
    turnId,
    pending = new Map(),
    buffer = "";
  let shutdownTimer,
    startupTimer,
    streamedItems = new Map();
  let workspaceTools,
    toolQueue = Promise.resolve();
  const tools = access ? (access.tools || AGENT_TOOLS) : conversion ? DATABASE_TOOLS : redaction ? [REDACTION_TOOL] : TOOLS;
  const decoder = new StringDecoder("utf8");
  const done = (code = 1, signal = null) => {
    if (finished) return;
    finished = true;
    clearTimeout(shutdownTimer);
    clearTimeout(startupTimer);
    pending.clear();
    callbacks.done({ code, signal });
  };
  const kill = (signal) => {
    if (!child) return;
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* Already exited. */
      }
    }
  };
  const cancel = (signal = "SIGTERM") => {
    stopped = true;
    clearTimeout(startupTimer);
    kill(signal);
    if (!child) {
      queueMicrotask(() => done(null, signal));
      return;
    }
    clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
      kill("SIGKILL");
      done(completed ? 0 : null, completed ? null : signal);
    }, 2000);
    shutdownTimer.unref?.();
  };
  const fail = (message = FAILURE) => {
    if (finished || failed || stopped) return;
    failed = true;
    callbacks.failure(message);
    cancel();
  };
  const write = (message) => {
    if (!child?.stdin?.writable || finished) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      fail();
    }
  };
  const request = (method, params, receive) => {
    const id = ++requestId;
    pending.set(id, receive);
    write({ jsonrpc: "2.0", id, method, params });
  };
  const append = (id, text) => {
    if (!text) return;
    const previous = streamedItems.get(id) || "";
    if (!streamedItems.has(id) && streamedItems.size) callbacks.delta("\n\n");
    streamedItems.set(id, previous + text);
    callbacks.delta(text);
  };
  const notification = (event) => {
    const params = event.params || {};
    if (
      event.method === "item/agentMessage/delta" &&
      typeof params.delta === "string"
    )
      append(params.itemId || "message", params.delta);
    else if (
      event.method === "item/completed" &&
      params.item?.type === "agentMessage" &&
      typeof params.item.text === "string"
    ) {
      const id = params.item.id || "message",
        previous = streamedItems.get(id) || "";
      if (params.item.text.startsWith(previous))
        append(id, params.item.text.slice(previous.length));
    } else if (
      event.method === "item/started" &&
      params.item?.type !== "agentMessage"
    )
      callbacks.status("Codex is working…");
    else if (event.method === "turn/completed") {
      if (params.turn?.status !== "completed") {
        fail();
        return;
      }
      completed = true;
      cancel();
    } else if (event.method === "error" && !params.willRetry) fail();
  };
  const receive = (event) => {
    if (finished || stopped) return;
    if (event.id !== undefined && typeof event.method === "string") {
      // No provider request can expand the application's capabilities.
      if (event.method === "item/tool/call") {
        const params = event.params || {};
        toolQueue = toolQueue
          .then(async () => {
            if (stopped || finished) return;
            if (
              onModels || !tools.some((tool) => tool.name === params.tool) ||
              params.namespace ||
              params.threadId !== threadId ||
              (turnId && params.turnId !== turnId)
            ) {
              write({
                jsonrpc: "2.0",
                id: event.id,
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "This capability is unavailable.",
                    },
                  ],
                },
              });
              return;
            }
            workspaceTools ||= access || (conversion ? createDatabaseTools(conversion) : redaction
              ? createRedactionTools(redaction.run)
              : new WorkspaceTools(workspace));
            await workspaceTools.ready;
            const result = await handleRequest(workspaceTools, {
              jsonrpc: "2.0",
              id: event.id,
              method: "tools/call",
              params: { name: params.tool, arguments: params.arguments },
            });
            if (stopped || finished) return;
            write({
              jsonrpc: "2.0",
              id: event.id,
              result: {
                success: !result.result?.isError && !result.error,
                contentItems: (
                  result.result?.content || [
                    { text: "The workspace operation could not be completed." },
                  ]
                ).map((item) => ({ type: "inputText", text: item.text })),
              },
            });
          })
          .catch(() => {
            if (!stopped && !finished)
              write({
                jsonrpc: "2.0",
                id: event.id,
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "The workspace operation could not be completed.",
                    },
                  ],
                },
              });
          });
      } else if (
        event.method === "item/commandExecution/requestApproval" ||
        event.method === "item/fileChange/requestApproval"
      ) {
        write({
          jsonrpc: "2.0",
          id: event.id,
          result: { decision: "decline" },
        });
      } else if (event.method === "item/permissions/requestApproval") {
        write({
          jsonrpc: "2.0",
          id: event.id,
          result: { permissions: {}, scope: "turn" },
        });
      } else {
        write({
          jsonrpc: "2.0",
          id: event.id,
          error: { code: -32601, message: "This capability is unavailable." },
        });
      }
      return;
    }
    if (event.id !== undefined) {
      const next = pending.get(event.id);
      pending.delete(event.id);
      if (event.error) {
        fail();
        return;
      }
      if (next) next(event.result || {});
    } else notification(event);
  };
  const read = (chunk) => {
    buffer += decoder.write(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    );
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) {
        fail();
        return;
      }
      if (line.trim()) {
        try {
          receive(JSON.parse(line));
        } catch {
          fail();
          return;
        }
      }
    }
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) fail();
  };

  // Defer startup so the bridge can install the run and cancel immediately.
  queueMicrotask(() => {
    if (stopped) return;
    let auth;
    try {
      auth = readAuth(env);
      if (
        !auth ||
        typeof auth.accessToken !== "string" ||
        !auth.accessToken ||
        typeof auth.chatgptAccountId !== "string" ||
        !auth.chatgptAccountId
      )
        throw new Error("No login");
    } catch {
      fail(LOGIN_FAILURE);
      return;
    }
    try {
      for (const directory of ["home", "codex", "cwd", "tmp"])
        fs.mkdirSync(path.join(runtimeDirectory, directory), {
          recursive: true,
          mode: 0o700,
        });
      const config = runtimeConfig(workspace, runtimeDirectory);
      const args = [
        ...(binary.args || []),
        "app-server",
        "--stdio",
        "--strict-config",
        ...Object.entries(config).flatMap(([key, value]) => [
          "-c",
          `${key}=${toml(value)}`,
        ]),
      ];
      child = spawnProcess(binary.command, args, {
        cwd: path.join(runtimeDirectory, "cwd"),
        env: runtimeEnvironment(env, runtimeDirectory, binary.node),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", () => {
        fail();
        done(1);
      });
      child.on("close", (code, signal) => {
        if (!completed && !stopped) fail();
        done(completed ? 0 : code, completed ? null : signal);
      });
      child.stdout.on("data", read);
      child.stderr.on("data", () => {}); // Raw diagnostics may contain credentials or local paths.
      child.stdin.on("error", () => fail());
      startupTimer = setTimeout(() => fail(), onModels ? 10000 : 30000);
      startupTimer.unref?.();
      request(
        "initialize",
        {
          clientInfo: { name: "arma", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
        () => {
          write({ jsonrpc: "2.0", method: "initialized", params: {} });
          // The pinned app-server's externally supplied ChatGPT token mode is
          // ephemeral. It accepts no refresh token and never persists auth.json.
          request(
            "account/login/start",
            {
              type: "chatgptAuthTokens",
              accessToken: auth.accessToken,
              chatgptAccountId: auth.chatgptAccountId,
            },
            () => {
              auth = null;
              if (onModels) {
                const entries = [], cursors = new Set();
                const page = (cursor) => request("model/list", {
                  limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
                }, (result) => {
                  if (!Array.isArray(result.data)) return fail();
                  entries.push(...result.data);
                  if (result.nextCursor) {
                    if (cursors.has(result.nextCursor) || entries.length > 500) return fail();
                    cursors.add(result.nextCursor);
                    return page(result.nextCursor);
                  }
                  onModels(entries);
                  completed = true;
                  cancel();
                });
                page();
                return;
              }
              request(
                "thread/start",
                {
                  ...(model ? { model } : {}),
                  cwd: path.join(runtimeDirectory, "cwd"),
                  ephemeral: true,
                  environments: [],
                  runtimeWorkspaceRoots: [],
                  selectedCapabilityRoots: [],
                  dynamicTools: tools.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    deferLoading: false,
                  })),
                  approvalPolicy: "never",
                  sandbox: "read-only",
                  baseInstructions: access ? (access.systemPrompt || SYSTEM_PROMPT + "\n\n" + (access.instructions || DATABASE_SKILL + "\n\n" + PATIENT_SUMMARY_SKILL)) : conversion ? DATABASE_SKILL : redaction ? REDACTION_SKILL : SYSTEM_PROMPT,
                  config,
                },
                (result) => {
                  threadId = result.thread?.id;
                  if (typeof threadId !== "string") {
                    fail();
                    return;
                  }
                  request(
                    "turn/start",
                    {
                      threadId,
                      ...(model ? { model } : {}),
                      ...(effort ? { effort } : {}),
                      environments: [],
                      runtimeWorkspaceRoots: [],
                      input: [{ type: "text", text: prompt }],
                    },
                    (result) => {
                      turnId = result.turn?.id;
                      clearTimeout(startupTimer);
                      callbacks.status("Codex is working…");
                    },
                  );
                },
              );
            },
          );
        },
      );
    } catch {
      auth = null;
      fail();
    }
  });
  return {
    cancel,
    get child() {
      return child;
    },
    get threadId() {
      return threadId;
    },
    get turnId() {
      return turnId;
    },
  };
}

module.exports = {
  CODEX_VERSION,
  WORKSPACE_TOOLS,
  readCodexAuth,
  runtimeConfig,
  runtimeEnvironment,
  startCodexRun,
};
