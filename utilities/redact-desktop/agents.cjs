const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { promisify } = require("node:util");
const { REDACTION_SKILL, DATABASE_SKILL, PATIENT_SUMMARY_SKILL, WORKFLOW_GUIDANCE } = require("./skills.cjs");
const { createDatabaseTools, TOOLS: DATABASE_TOOLS } = require("./database-tools.cjs");
const { startRedactionServer } = require("./redaction-tools.cjs");
const {
  CLAUDE_MODELS,
  DEFAULT_MODEL,
  codexModels,
  validateSelection,
} = require("./model-options.cjs");

const execFileAsync = promisify(execFile);
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROVIDERS = {
  claude: {
    name: "Claude Code",
    package: "@anthropic-ai/claude-code",
    bin: "claude",
  },
  codex: { name: "Codex · testing", package: "@openai/codex", bin: "codex" },
};

function providerEnvironment(provider, source = process.env) {
  const env = {};
  const systemKeys = new Set([
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "WINDIR",
    "PATH",
    "Path",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]);
  const ownKeys =
    provider === "claude"
      ? new Set([
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
        ])
      : new Set([
          "CODEX_HOME",
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_ACCESS_TOKEN",
        ]);
  for (const [key, value] of Object.entries(source)) {
    if (
      (systemKeys.has(key) || ownKeys.has(key) || key.startsWith("LC_")) &&
      typeof value === "string"
    )
      env[key] = value;
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

function commandForFile(filename) {
  if (/\.(?:c?js|mjs)$/i.test(filename)) {
    return { command: process.execPath, args: [filename], node: true };
  }
  return { command: filename, args: [] };
}

function findBinary(provider, env = process.env) {
  const info = PROVIDERS[provider];
  try {
    const manifestPath = require.resolve(`${info.package}/package.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin?.[info.bin];
    if (bin) {
      const filename = path.resolve(path.dirname(manifestPath), bin);
      if (fs.existsSync(filename)) return commandForFile(filename);
    }
  } catch {
    /* A separately installed CLI can be used when the package is absent. */
  }
  const directories = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
  // Finder-launched applications do not inherit a terminal's PATH.
  directories.push(
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  );
  const extensions = process.platform === "win32" ? [".exe", ".com", ""] : [""];
  for (const directory of [...new Set(directories)]) {
    for (const extension of extensions) {
      const filename = path.join(directory, info.bin + extension);
      try {
        fs.accessSync(filename, fs.constants.X_OK);
        const resolved = fs.realpathSync(filename);
        return commandForFile(resolved);
      } catch {
        /* Continue looking. */
      }
    }
  }
  return null;
}

function makeLineReader(onLine, onFailure) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let failed = false;
  function consume(text, final = false) {
    if (failed) return;
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        failed = true;
        onFailure("The agent returned an oversized event.");
        return;
      }
      if (line) onLine(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      failed = true;
      onFailure("The agent returned an oversized event.");
    } else if (final && buffer.trim()) {
      onLine(buffer.trim());
      buffer = "";
    }
  }
  return {
    write(chunk) {
      consume(
        decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
    },
    end() {
      consume(decoder.end(), true);
    },
  };
}

function createEventParser(provider, handlers) {
  let output = "";
  let partialText = "";
  let completed = false;
  const codexItems = new Map();
  function append(text) {
    if (!text) return;
    output += text;
    handlers.delta(text);
  }
  return {
    get output() {
      return output;
    },
    get completed() {
      return completed;
    },
    line(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        handlers.failure("The agent returned an invalid streaming response.");
        return;
      }
      if (!event || typeof event !== "object") return;
      if (provider === "claude") {
        if (event.session_id && typeof event.session_id === "string")
          handlers.session(event.session_id);
        if (
          event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta"
        ) {
          const text = event.event.delta.text;
          if (typeof text === "string") {
            partialText += text;
            append(text);
          }
        } else if (event.type === "assistant" && !event.parent_tool_use_id) {
          const text = (event.message?.content || [])
            .filter(
              (part) => part.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n");
          if (text) {
            if (partialText) {
              if (text.startsWith(partialText))
                append(text.slice(partialText.length));
            } else append((output ? "\n\n" : "") + text);
          }
          partialText = "";
          const tools = (event.message?.content || []).filter(
            (part) => part.type === "tool_use",
          );
          if (tools.length) handlers.status("Agent is working…");
        } else if (event.type === "result") {
          completed = true;
          if (
            event.is_error ||
            (event.subtype && event.subtype !== "success")
          ) {
            handlers.failure(
              "Claude Code could not complete this turn. Check its CLI login and try again.",
            );
          } else if (!output && typeof event.result === "string")
            append(event.result);
          if (event.permission_denials?.length)
            handlers.status(
              "A tool needs permission. This turn did not approve it.",
            );
        }
      } else {
        if (
          event.type === "thread.started" &&
          typeof event.thread_id === "string"
        )
          handlers.session(event.thread_id);
        if (
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.item?.type === "agent_message" &&
          typeof event.item.text === "string"
        ) {
          const key = event.item.id || "message";
          const previous = codexItems.get(key) || "";
          const next = event.item.text;
          if (next.startsWith(previous))
            append(
              (previous || !output ? "" : "\n\n") + next.slice(previous.length),
            );
          codexItems.set(key, next);
        } else if (
          event.type === "item.started" &&
          event.item?.type !== "agent_message"
        ) {
          handlers.status("Agent is working…");
        } else if (event.type === "turn.completed") {
          completed = true;
        } else if (event.type === "turn.failed" || event.type === "error") {
          handlers.failure(
            "Codex could not complete this turn. Check its CLI login and try again.",
          );
        }
      }
    },
  };
}

const WORKSPACE_TOOL_NAMES = [
  "list_directory",
  "read_file",
  "write_file",
  "create_directory",
];
const { TOOLS: AGENT_TOOLS } = require("./agent-tools.cjs");
const SYSTEM_PROMPT =
  "You are the ARMa workspace assistant. Use only the supplied workspace tools to work on the operator's selected files. The operator authorizes reading and writing redacted files through the workspace tools without additional permission prompts. The unredacted directory is protected: never inspect, read, change, move, or delete it or anything inside it. Workspace tools enforce this restriction. Do not attempt to bypass it. Follow the operator's request, and report actual tool results accurately. You do not have shell, browser, external integration, or unrestricted filesystem access." + WORKFLOW_GUIDANCE;

function claudeArguments(workspace, runtimeDirectory, redactionEndpoint, conversion = false, access = false) {
  const mcp = {
    mcpServers: {
      workspace: {
        type: "stdio",
        command: process.execPath,
        args: redactionEndpoint
          ? [path.join(__dirname, access ? (access.adapter || "agent-tools.cjs") : conversion ? "database-tools.cjs" : "redaction-tools.cjs")]
          : [path.join(__dirname, "workspace-tools.cjs"), workspace],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: "",
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          CODEX_ACCESS_TOKEN: "",
          HOME: runtimeDirectory,
          ...(redactionEndpoint
            ? { ARMA_REDACTION_PIPE: redactionEndpoint }
            : {}),
        },
      },
    },
  };
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcp),
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--allowedTools",
    (access ? (access.tools || AGENT_TOOLS).map(t => t.name) : conversion ? DATABASE_TOOLS.map(t => t.name) : redactionEndpoint ? ["run_redaction_script"] : WORKSPACE_TOOL_NAMES)
      .map((name) => `mcp__workspace__${name}`)
      .join(","),
    "--settings",
    JSON.stringify({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
    }),
    "--system-prompt",
    access ? (access.systemPrompt || SYSTEM_PROMPT + "\n\n" + (access.instructions || DATABASE_SKILL + "\n\n" + PATIENT_SUMMARY_SKILL)) : conversion ? DATABASE_SKILL : redactionEndpoint ? REDACTION_SKILL : SYSTEM_PROMPT,
  ];
}

class AgentBridge {
  constructor({
    allowCodex = false,
    binaries = {},
    spawnProcess = spawn,
    probe,
    env = process.env,
    readCodexAuth,
    killProcessGroup,
    runtimeParent = os.tmpdir(),
  } = {}) {
    this.allowCodex = allowCodex;
    this.binaries = binaries;
    this.spawnProcess = spawnProcess;
    this.probe = probe || this.probeBinary.bind(this);
    this.env = env;
    this.readCodexAuth = readCodexAuth;
    this.killProcessGroup =
      killProcessGroup ||
      ((child, signal) => {
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
      });
    this.runtimeParent = runtimeParent;
    this.detected = new Map();
    this.history = new Map();
    this.runs = new Map();
    this.disposed = false;
    this.starting = false;
    this.modelCatalog = null;
    this.catalogRun = null;
  }

  async probeBinary(provider, binary) {
    const env = providerEnvironment(provider, this.env);
    if (binary.node) env.ELECTRON_RUN_AS_NODE = "1";
    const { stdout: version } = await execFileAsync(
      binary.command,
      [...binary.args, "--version"],
      { env, timeout: 10000, maxBuffer: 4096, windowsHide: true },
    );
    const { stdout: help } = await execFileAsync(
      binary.command,
      [...binary.args, ...(provider === "codex" ? ["exec"] : []), "--help"],
      { env, timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true },
    );
    return { version: version.trim().split("\n")[0].slice(0, 120), help };
  }

  async detect(provider) {
    if (this.detected.has(provider)) return this.detected.get(provider);
    const info = PROVIDERS[provider];
    const binary = this.binaries[provider] || findBinary(provider, this.env);
    const result = { id: provider, name: info.name, available: false };
    if (!binary) return { ...result, error: `${info.name} is not installed.` };
    try {
      const { version, help } = await this.probe(provider, binary);
      const required =
        provider === "claude"
          ? [
              "--restricted",
              "--tools",
              "--strict-mcp-config",
              "--setting-sources",
              "--permission-prompts",
            ]
          : ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--json"];
      if (required.some((flag) => !help.includes(flag))) {
        return {
          ...result,
          version,
          error: `Update ${info.name} to use the protected workspace connection.`,
        };
      }
      if (
        (provider === "claude" && !/^2\.1\.280\b/.test(version)) ||
        (provider === "codex" && !/^codex-cli 0\.156\.1\b/.test(version))
      ) {
        return {
          ...result,
          version,
          error: `Reinstall the app's pinned ${info.name} dependency to use the protected workspace connection.`,
        };
      }
      this.detected.set(provider, {
        ...result,
        available: true,
        version,
        binary,
      });
      return this.detected.get(provider);
    } catch {
      return {
        ...result,
        error: `${info.name} could not start. Reinstall its CLI and try again.`,
      };
    }
  }

  async models(provider, info) {
    if (provider === "claude") return { models: CLAUDE_MODELS };
    if (!info.available) return { models: [DEFAULT_MODEL] };
    if (!this.modelCatalog) this.modelCatalog = this.loadCodexModels(info);
    return this.modelCatalog;
  }

  async loadCodexModels(info) {
    const runtime = await fs.promises.mkdtemp(
      path.join(this.runtimeParent, "arma-models-"),
    );
    try {
      if (this.disposed) return { models: [DEFAULT_MODEL] };
      return await new Promise((resolve) => {
        let models, error;
        this.catalogRun = require("./codex-runtime.cjs").startCodexRun(
          {
            binary: info.binary,
            workspace: runtime,
            runtimeDirectory: runtime,
            env: providerEnvironment("codex", this.env),
            spawnProcess: this.spawnProcess,
            readAuth: this.readCodexAuth,
            onModels: (entries) => { models = codexModels(entries); },
          },
          {
            delta() {},
            status() {},
            failure: () => {
              error = "Could not load Codex models. Check its CLI login and refresh Connections.";
            },
            done: () => {
              this.catalogRun = null;
              resolve({
                models: models || [DEFAULT_MODEL],
                ...(error ? { modelError: error } : {}),
              });
            },
          },
        );
      });
    } finally {
      await fs.promises.rm(runtime, { recursive: true, force: true });
    }
  }

  async status(refresh = false) {
    if (refresh && !this.catalogRun) this.modelCatalog = null;
    const providers = this.allowCodex ? ["claude", "codex"] : ["claude"];
    return Promise.all(
      providers.map(async (provider) => {
        const detected = await this.detect(provider);
        const { binary, ...info } = detected;
        return { ...info, ...(await this.models(provider, detected)) };
      }),
    );
  }

  async start(
    {
      provider = "claude",
      prompt,
      workspace,
      conversationId = "default",
      redaction,
      conversion,
      access,
      model = "",
      effort = "",
    },
    emit,
  ) {
    if (this.disposed) throw new Error("The agent connection is closed.");
    if (
      !Object.hasOwn(PROVIDERS, provider) ||
      (provider === "codex" && !this.allowCodex)
    )
      throw new Error("This agent is not available.");
    if (this.starting || this.runs.size)
      throw new Error(
        "Wait for the current agent turn to finish or stop it first.",
      );
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 200000)
      throw new Error("Enter a message of at most 200,000 characters.");
    if (typeof workspace !== "string" || !path.isAbsolute(workspace))
      throw new Error("Choose a working directory first.");
    if (
      typeof conversationId !== "string" ||
      !conversationId ||
      conversationId.length > 128
    )
      throw new Error("Invalid conversation.");
    if (typeof emit !== "function")
      throw new Error("An agent event listener is required.");
    this.starting = true;
    let runtime, redactionServer;
    try {
      const root = await fs.promises.realpath(workspace);
      const protectedPath = (value) =>
        value
          .split(/[\\/]/)
          .some(
            (part) => part.normalize("NFKC").toLowerCase() === "unredacted",
          );
      if (protectedPath(workspace) || protectedPath(root))
        throw new Error(
          "The unredacted directory is protected. Choose its parent workspace.",
        );
      if (!(await fs.promises.stat(root)).isDirectory())
        throw new Error("Choose a working directory first.");
      const info = await this.detect(provider);
      if (!info.available) throw new Error(info.error);
      if (model || effort || typeof model !== "string" || typeof effort !== "string")
        validateSelection((await this.models(provider, info)).models, model, effort);
      if (this.disposed) throw new Error("The agent connection is closed.");
      runtime = await fs.promises.mkdtemp(
        path.join(this.runtimeParent, "arma-agent-"),
      );
      await fs.promises.chmod(runtime, 0o700);
      if (this.disposed) throw new Error("The agent connection is closed.");
      const env = providerEnvironment(provider, this.env);
      const historyKey = JSON.stringify([
        provider,
        root,
        conversationId,
        redaction ? "redaction" : access?.historyScope || "workspace",
      ]);
      const history = this.history.get(historyKey) || [];
      const message = (redaction || conversion)
        ? `Operator-selected filename: ${JSON.stringify((redaction || conversion).sourceName)}\n\n${prompt}`
        : access ? `Workspace report context: ${access.context}\n\n${prompt}` : prompt;
      const input = history.length
        ? `Previous conversation (context only):\n${JSON.stringify(history)}\n\nCurrent operator message:\n${message}`
        : message;
      let args;
      if (provider === "claude") {
        Object.assign(env, {
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        });
        if (redaction)
          redactionServer = await startRedactionServer(runtime, redaction.run);
        if (conversion)
          redactionServer = await startRedactionServer(runtime, null, createDatabaseTools(conversion));
        if (access) redactionServer = await startRedactionServer(runtime, null, access);
        args = claudeArguments(root, runtime, redactionServer?.endpoint, !!conversion, access || false);
        if (model) args.push("--model", model);
        if (effort) args.push("--effort", effort);
      } else {
        return this.startCodex(
          {
            info,
            root,
            runtime,
            env,
            input,
            historyKey,
            history,
            prompt: message,
            redaction,
            conversion,
            access,
            model,
            effort,
          },
          emit,
        );
      }
      if (info.binary.node) env.ELECTRON_RUN_AS_NODE = "1";
      const child = this.spawnProcess(
        info.binary.command,
        [...info.binary.args, ...args],
        {
          cwd: runtime,
          env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const runId = randomUUID();
      const run = {
        runId,
        child,
        runtime,
        provider,
        redaction,
        conversion,
        access,
        redactionServer,
        done: false,
        cancelled: false,
        failed: false,
        bytes: 0,
        killTimer: null,
      };
      this.runs.set(runId, run);
      const send = (event) => {
        if (!run.done) {
          try {
            emit({ runId, ...event });
          } catch {
            /* A closed renderer must not crash the main process. */
          }
        }
      };
      const fail = (text) => {
        if (run.failed || run.cancelled || run.done) return;
        run.failed = true;
        send({ type: "error", text });
        this.terminate(run);
      };
      const parser = createEventParser(provider, {
        delta: (text) => send({ type: "delta", text }),
        status: (text) => send({ type: "status", text }),
        session() {},
        failure: fail,
      });
      const reader = makeLineReader((line) => parser.line(line), fail);
      child.stdout.on("data", (chunk) => {
        run.bytes += chunk.length;
        if (run.bytes > MAX_OUTPUT_BYTES)
          fail("The agent output exceeded this turn's size limit.");
        else if (!run.failed && !run.cancelled) reader.write(chunk);
      });
      // Drain stderr without exposing environment values, auth errors, or tool arguments.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () =>
        fail(`${info.name} stopped before receiving the message.`),
      );
      child.on("error", () =>
        fail(
          `${info.name} could not start. Check its installation and CLI login.`,
        ),
      );
      child.once("close", (code, signal) => {
        if (run.done) return;
        if (!run.cancelled && !run.failed) reader.end();
        if (
          !run.cancelled &&
          !run.failed &&
          (code !== 0 || !parser.completed)
        ) {
          fail(
            `${info.name} did not finish this turn. Check its CLI login and try again.`,
          );
        }
        if (!run.cancelled && !run.failed) {
          this.remember(historyKey, history, message, parser.output);
        }
        send({
          type: "done",
          cancelled: run.cancelled,
          failed: run.failed,
          exitCode: code,
          signal,
        });
        run.done = true;
        clearTimeout(run.killTimer);
        redaction?.cancel();
        conversion?.cancel();
        access?.cancel();
        redactionServer?.close();
        this.runs.delete(runId);
        fs.promises
          .rm(runtime, { recursive: true, force: true })
          .catch(() => {});
      });
      child.stdin.end(input);
      setImmediate(() => send({ type: "status", text: "Working…" }));
      return { runId };
    } catch (error) {
      redaction?.cancel();
      conversion?.cancel();
      access?.cancel();
      redactionServer?.close();
      if (runtime)
        await fs.promises.rm(runtime, { recursive: true, force: true });
      throw error;
    } finally {
      this.starting = false;
    }
  }

  remember(key, history, prompt, output) {
    const next = [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: output },
    ];
    while (
      next.length > 40 ||
      (next.length > 2 && JSON.stringify(next).length > 300000)
    )
      next.splice(0, 2);
    this.history.set(key, next);
  }

  startCodex(
    { info, root, runtime, env, input, historyKey, history, prompt, redaction, conversion, access, model, effort },
    emit,
  ) {
    const { startCodexRun } = require("./codex-runtime.cjs");
    const runId = randomUUID();
    const run = {
      runId,
      runtime,
      redaction,
      conversion,
      access,
      provider: "codex",
      done: false,
      cancelled: false,
      failed: false,
      bytes: 0,
    };
    this.runs.set(runId, run);
    let output = "";
    const send = (event) => {
      if (!run.done) {
        try {
          emit({ runId, ...event });
        } catch {}
      }
    };
    run.controller = startCodexRun(
      {
        binary: info.binary,
        workspace: root,
        runtimeDirectory: runtime,
        env,
        prompt: input,
        spawnProcess: this.spawnProcess,
        readAuth: this.readCodexAuth,
        redaction,
        conversion,
        access,
        model,
        effort,
      },
      {
        delta: (text) => {
          if (run.cancelled || run.failed) return;
          run.bytes += Buffer.byteLength(text);
          if (run.bytes > MAX_OUTPUT_BYTES) {
            run.failed = true;
            send({
              type: "error",
              text: "The agent output exceeded this turn's size limit.",
            });
            run.controller.cancel();
          } else {
            output += text;
            send({ type: "delta", text });
          }
        },
        status: (text) => send({ type: "status", text }),
        failure: (text) => {
          if (run.cancelled || run.failed) return;
          run.failed = true;
          send({ type: "error", text });
        },
        done: ({ code, signal }) => {
          redaction?.cancel();
          conversion?.cancel();
          access?.cancel();
          if (!run.cancelled && !run.failed)
            this.remember(historyKey, history, prompt, output);
          send({
            type: "done",
            cancelled: run.cancelled,
            failed: run.failed,
            exitCode: code,
            signal,
          });
          run.done = true;
          this.runs.delete(runId);
          fs.promises
            .rm(runtime, { recursive: true, force: true })
            .catch(() => {});
        },
      },
    );
    return { runId };
  }

  terminate(run) {
    run.redaction?.cancel();
    run.conversion?.cancel();
    run.access?.cancel();
    if (run.controller) {
      run.controller.cancel();
      return;
    }
    this.killProcessGroup(run.child, "SIGTERM");
    if (!run.killTimer) {
      run.killTimer = setTimeout(() => {
        if (!run.done) this.killProcessGroup(run.child, "SIGKILL");
      }, 1500);
      run.killTimer.unref?.();
    }
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || run.done) return false;
    run.cancelled = true;
    this.terminate(run);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.catalogRun?.cancel();
    for (const runId of this.runs.keys()) this.cancel(runId);
    this.history.clear();
  }
}

module.exports = {
  AgentBridge,
  providerEnvironment,
  findBinary,
  makeLineReader,
  createEventParser,
  claudeArguments,
};
