"use strict";
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { RedactionError } = require("./redaction-schema.cjs");
const { WorkspaceError, handleRequest } = require("./workspace-tools.cjs");
const TOOL = {
  name: "run_redaction_script",
  description:
    "Generate and run a local redaction script from a regex schema on the single operator-selected source. Returns only the replacement count and filename. Originals and mapping never enter tool results. One execution per operator message; output requires local GUI review.",
  inputSchema: {
    type: "object",
    properties: {
      schema_json: {
        type: "string",
        description:
          "JSON schema version 1 with rules as specified in the bundled redact skill.",
      },
    },
    required: ["schema_json"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
};
function createRedactionTools(run) {
  return {
    ready: Promise.resolve(),
    tools: [TOOL],
    async call(name, args) {
      if (
        name !== TOOL.name ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).length !== 1 ||
        typeof args.schema_json !== "string"
      )
        throw new WorkspaceError(
          "Only run_redaction_script with schema_json is available.",
        );
      try {
        const result = await run(args.schema_json);
        if (
          !Number.isInteger(result?.items) ||
          result.items < 0 ||
          result.items > 100000 ||
          typeof result.file !== "string"
        )
          throw new Error("Invalid result");
        // Even an internal callback cannot accidentally forward worker data.
        return {
          items: result.items,
          file: result.file,
          status: "review_required",
        };
      } catch (error) {
        throw new WorkspaceError(
          error instanceof RedactionError
            ? error.message
            : "Local redaction could not complete. Check the document locally.",
        );
      }
    },
  };
}
async function startRedactionServer(runtime, run, suppliedTools) {
  // A short private directory avoids macOS's 104-byte Unix socket path limit,
  // including when the provider runtime has a deeply nested test parent.
  const socketDirectory =
    process.platform === "win32"
      ? null
      : await fs.mkdtemp(path.join(os.tmpdir(), "ar-"));
  if (socketDirectory) await fs.chmod(socketDirectory, 0o700);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\arma-redact-${randomUUID()}`
      : path.join(socketDirectory, "s");
  const sockets = new Set();
  const tools = suppliedTools || createRedactionTools(run);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "",
      submitted = false;
    socket.setEncoding("utf8");
    socket.setTimeout(65000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (submitted) return;
      input += chunk;
      if (input.length > (suppliedTools ? 8*1024*1024 : 128000)) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      submitted = true;
      (async () => {
        let result;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          result = { result: await tools.call(suppliedTools ? request.name : TOOL.name, suppliedTools ? request.args : request) };
        } catch (error) {
          result = {
            error:
              error instanceof WorkspaceError
                ? error.message
                : "Invalid redaction request.",
          };
        }
        socket.end(JSON.stringify(result) + "\n");
      })();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
  } catch (error) {
    if (socketDirectory)
      await fs.rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
  if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  return {
    endpoint,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        if (socketDirectory)
          fs.rm(socketDirectory, { recursive: true, force: true }).catch(
            () => {},
          );
      });
    },
  };
}
function remoteRun(endpoint, schema_json) {
  return remoteRequest(endpoint, { schema_json });
}
function remoteRequest(endpoint, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(65000, () => socket.destroy(new Error("Timeout")));
    socket.on("connect", () =>
      socket.write(JSON.stringify(request) + "\n"),
    );
    socket.on("error", () =>
      reject(new RedactionError("Local redaction connection is unavailable.")),
    );
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 8*1024*1024) socket.destroy();
    });
    socket.on("close", () => {
      try {
        const message = JSON.parse(input);
        message.error
          ? reject(new RedactionError(message.error))
          : resolve(message.result);
      } catch {
        reject(new RedactionError("Local redaction did not complete."));
      }
    });
  });
}
async function serve(endpoint, suppliedTools) {
  const tools = suppliedTools || createRedactionTools((schema) => remoteRun(endpoint, schema));
  const decoder = new StringDecoder("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += decoder.write(chunk);
    if (input.length > (suppliedTools ? 8*1024*1024 : 100000)) throw new Error("Oversized request");
    let newline;
    while ((newline = input.indexOf("\n")) !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line.trim()) continue;
      let response;
      try {
        response = await handleRequest(tools, JSON.parse(line));
      } catch {
        response = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid request." },
        };
      }
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}
if (require.main === module)
  serve(process.env.ARMA_REDACTION_PIPE).catch(() => {
    process.stderr.write("Local redaction connection stopped.\n");
    process.exitCode = 1;
  });
module.exports = {
  TOOL,
  createRedactionTools,
  startRedactionServer,
  remoteRun,
  remoteRequest,
  serve,
};
