#!/usr/bin/env node
"use strict";

// This process is the providers' only file capability. It deliberately exposes no
// shell, deletion, links, configuration, or access to the reserved unredacted tree.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { once } = require("node:events");

const TEXT_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 2000;
const REQUEST_LIMIT = 8 * TEXT_LIMIT;
const PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const RESERVED_NAMES = new Set([
  "unredacted",
  "agents.md",
  "claude.md",
  "gemini.md",
]);
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const APPLICATION_DIRECTORY = path.resolve(__dirname);

class WorkspaceError extends Error {}

function assertAllowedRoot(root) {
  if (
    root.split(/[\\/]/).some(
      (part) =>
        part
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[. ]+$/, "") === "unredacted",
    )
  ) {
    throw new WorkspaceError(
      "The unredacted directory and its descendants cannot be agent workspaces.",
    );
  }
}

function assertOutsideApplication(candidate, applicationDirectory) {
  // Compare conservatively across case-insensitive and Unicode-normalizing
  // filesystems. Providers must never be able to replace their own guard code.
  const normalize = (value) => value.normalize("NFKC").toLowerCase();
  const relative = path.relative(
    normalize(applicationDirectory),
    normalize(candidate),
  );
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  ) {
    throw new WorkspaceError(
      "The application installation is not available to agents.",
    );
  }
}

function pathParts(value = "") {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\0-\x1f\x7f]/.test(value) ||
    /^[\\/]/.test(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new WorkspaceError("Use a relative path inside the workspace.");
  }
  const parts = value
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== ".");
  if (
    parts.length > 64 ||
    parts.some((part) => part === ".." || /[:]|[. ]$/.test(part))
  ) {
    throw new WorkspaceError(
      "Parent paths and ambiguous file names are not allowed.",
    );
  }
  for (const part of parts) {
    const normalized = part.normalize("NFKC").toLowerCase();
    if (normalized.startsWith(".") || RESERVED_NAMES.has(normalized)) {
      throw new WorkspaceError("That path is not available to agents.");
    }
  }
  return parts;
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function assertOrdinary(stat) {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new WorkspaceError(
      "Only ordinary files and directories are available.",
    );
  }
  if (stat.isFile() && stat.nlink !== 1) {
    throw new WorkspaceError(
      "Files with multiple links are not available to agents.",
    );
  }
}

function safeError(error) {
  if (error instanceof WorkspaceError) return error.message;
  switch (error.code) {
    case "ENOENT":
      return "The requested file or directory does not exist.";
    case "ENOTDIR":
      return "The requested parent is not a directory.";
    case "EISDIR":
      return "Choose a file, not a directory.";
    case "EEXIST":
      return "A file or directory already exists at that path.";
    case "EACCES":
    case "EPERM":
      return "The workspace does not permit that operation.";
    case "ENOSPC":
      return "There is not enough disk space to write the file.";
    default:
      return "The workspace operation could not be completed.";
  }
}

class WorkspaceTools {
  constructor(root) {
    this.ready = this.initialize(root);
  }

  async initialize(root) {
    if (typeof root !== "string" || !path.isAbsolute(root))
      throw new WorkspaceError("An absolute workspace directory is required.");
    assertAllowedRoot(root);
    assertOutsideApplication(root, APPLICATION_DIRECTORY);
    this.applicationDirectory = await fs.realpath(APPLICATION_DIRECTORY);
    assertOutsideApplication(root, this.applicationDirectory);
    const original = await fs.lstat(root);
    if (original.isSymbolicLink() || !original.isDirectory())
      throw new WorkspaceError("The workspace must be an ordinary directory.");
    const canonical = await fs.realpath(root);
    // A parent alias can conceal a protected directory in the selected path.
    // Recheck the canonical path before adopting or browsing this workspace.
    assertAllowedRoot(canonical);
    assertOutsideApplication(canonical, this.applicationDirectory);
    this.root = canonical;
    this.rootStat = await fs.lstat(this.root);
    if (!sameFile(original, this.rootStat))
      throw new WorkspaceError("The workspace changed while opening it.");
  }

  async resolve(value = "", allowMissingLeaf = false) {
    const parts = pathParts(value); // Reject protected paths before any filesystem access.
    await this.ready;
    assertOutsideApplication(
      path.join(this.root, ...parts),
      this.applicationDirectory,
    );
    let absolute = this.root;
    let stat = await fs.lstat(absolute);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !sameFile(stat, this.rootStat) ||
      (await fs.realpath(absolute)) !== this.root
    ) {
      throw new WorkspaceError(
        "The workspace changed. Open it again before using the agent.",
      );
    }
    for (let index = 0; index < parts.length; index++) {
      if (!stat.isDirectory())
        throw new WorkspaceError("The requested parent is not a directory.");
      absolute = path.join(absolute, parts[index]);
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        if (
          error.code === "ENOENT" &&
          allowMissingLeaf &&
          index === parts.length - 1
        ) {
          return { absolute, parts, stat: null };
        }
        throw error;
      }
      assertOrdinary(stat);
    }
    const canonical = await fs.realpath(absolute);
    assertOutsideApplication(canonical, this.applicationDirectory);
    if (canonical !== absolute)
      throw new WorkspaceError("Linked paths are not available to agents.");
    return { absolute, parts, stat };
  }

  async listDirectory(value = "") {
    const directory = await this.resolve(value);
    if (!directory.stat.isDirectory())
      throw new WorkspaceError("Choose a directory to list.");
    const entries = [];
    let visited = 0;
    let resultBytes = 0;
    const handle = await fs.opendir(directory.absolute);
    for await (const entry of handle) {
      if (++visited > ENTRY_LIMIT)
        throw new WorkspaceError(
          "This directory has more than 2,000 entries. Choose a smaller directory.",
        );
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const entryPath = [...directory.parts, entry.name].join("/");
      try {
        // Reserved names are filtered before lstat; neither their contents nor
        // metadata are sent to providers. Links are likewise invisible.
        const checked = await this.resolve(entryPath);
        const item = {
          name: entry.name,
          path: entryPath,
          type: checked.stat.isDirectory() ? "directory" : "file",
          ...(checked.stat.isFile() ? { size: checked.stat.size } : {}),
        };
        resultBytes += Buffer.byteLength(JSON.stringify(item));
        if (resultBytes > TEXT_LIMIT)
          throw new WorkspaceError(
            "The directory listing is too large. Choose a smaller directory.",
          );
        entries.push(item);
      } catch (error) {
        if (resultBytes > TEXT_LIMIT) throw error;
        if (!(error instanceof WorkspaceError) && error.code !== "ENOENT")
          throw error;
      }
    }
    const refreshed = await this.resolve(value);
    if (!sameFile(directory.stat, refreshed.stat))
      throw new WorkspaceError("The directory changed. Try again.");
    entries.sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
        a.name.localeCompare(b.name),
    );
    return { path: directory.parts.join("/"), entries };
  }

  async readFile(value) {
    const target = await this.resolve(value);
    if (!target.stat.isFile())
      throw new WorkspaceError("Choose a text file to read.");
    if (target.stat.size > TEXT_LIMIT)
      throw new WorkspaceError("Text files must be no larger than 1 MiB.");
    const handle = await fs.open(
      target.absolute,
      constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK || 0),
    );
    try {
      const opened = await handle.stat();
      assertOrdinary(opened);
      if (!sameFile(opened, target.stat))
        throw new WorkspaceError("The file changed. Try again.");
      const refreshed = await this.resolve(value);
      if (!sameFile(opened, refreshed.stat))
        throw new WorkspaceError("The file changed. Try again.");
      // Read at most one byte beyond the limit, including if the file grows.
      const buffer = Buffer.alloc(TEXT_LIMIT + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > TEXT_LIMIT)
        throw new WorkspaceError("Text files must be no larger than 1 MiB.");
      const bytes = buffer.subarray(0, total);
      if (bytes.includes(0))
        throw new WorkspaceError("Only UTF-8 text files can be read.");
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new WorkspaceError("Only UTF-8 text files can be read.");
      }
      assertOrdinary(await handle.stat());
      return { path: target.parts.join("/"), content };
    } finally {
      await handle.close();
    }
  }

  async writeFile(value, content) {
    if (typeof content !== "string" || content.includes("\0"))
      throw new WorkspaceError(
        "Content must be UTF-8 text without null bytes.",
      );
    if (Buffer.byteLength(content) > TEXT_LIMIT)
      throw new WorkspaceError("Text files must be no larger than 1 MiB.");
    const target = await this.resolve(value, true);
    if (!target.parts.length || (target.stat && !target.stat.isFile()))
      throw new WorkspaceError("Choose a file path to write.");
    const parentPath = target.parts.slice(0, -1).join("/");
    const parent = await this.resolve(parentPath);
    const temporary = path.join(parent.absolute, `.arma-write-${randomUUID()}`);
    let temporaryExists = false;
    try {
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const refreshedParent = await this.resolve(parentPath);
      const refreshedTarget = await this.resolve(value, true);
      if (
        !sameFile(parent.stat, refreshedParent.stat) ||
        Boolean(target.stat) !== Boolean(refreshedTarget.stat) ||
        (target.stat && !sameFile(target.stat, refreshedTarget.stat))
      ) {
        throw new WorkspaceError("The destination changed. Try again.");
      }
      await fs.rename(temporary, target.absolute);
      temporaryExists = false;
      return {
        path: target.parts.join("/"),
        bytesWritten: Buffer.byteLength(content),
      };
    } finally {
      if (temporaryExists) {
        try {
          const currentParent = await this.resolve(parentPath);
          if (sameFile(parent.stat, currentParent.stat))
            await fs.unlink(temporary);
        } catch {
          /* Do not follow a changed parent while cleaning up. */
        }
      }
    }
  }

  async createDirectory(value) {
    const target = await this.resolve(value, true);
    if (!target.parts.length || target.stat)
      throw new WorkspaceError(
        "A file or directory already exists at that path.",
      );
    await fs.mkdir(target.absolute, { mode: 0o700 });
    const created = await this.resolve(value);
    if (!created.stat.isDirectory())
      throw new WorkspaceError("The destination changed. Try again.");
    return { path: target.parts.join("/"), type: "directory" };
  }

  async call(name, args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new WorkspaceError("Tool arguments must be an object.");
    const definition = TOOLS.find((tool) => tool.name === name);
    if (!definition) throw new WorkspaceError("Unknown workspace tool.");
    if (
      Object.keys(args).some(
        (key) => !Object.hasOwn(definition.inputSchema.properties, key),
      )
    )
      throw new WorkspaceError("Unknown tool argument.");
    for (const key of definition.inputSchema.required || []) {
      if (typeof args[key] !== "string")
        throw new WorkspaceError(`The ${key} argument must be text.`);
    }
    switch (name) {
      case "list_directory":
        return this.listDirectory(args.path);
      case "read_file":
        return this.readFile(args.path);
      case "write_file":
        return this.writeFile(args.path, args.content);
      case "create_directory":
        return this.createDirectory(args.path);
      default:
        throw new WorkspaceError("Unknown workspace tool.");
    }
  }
}

const pathProperty = {
  type: "string",
  description:
    "Relative workspace path. The unredacted directory, hidden paths, agent configuration, and links are unavailable.",
};
const TOOLS = [
  {
    name: "list_directory",
    description:
      "List ordinary files and directories in the selected workspace. Protected paths are omitted.",
    inputSchema: {
      type: "object",
      properties: { path: { ...pathProperty, default: "" } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file in the selected workspace, up to 1 MiB.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or replace a UTF-8 text file in the selected workspace, up to 1 MiB. The parent directory must exist.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "create_directory",
    description:
      "Create one directory in the selected workspace. Its parent must already exist.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

async function handleRequest(workspace, request) {
  if (
    !request ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    (Object.hasOwn(request, "id") &&
      typeof request.id !== "string" &&
      typeof request.id !== "number")
  ) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request." },
    };
  }
  if (!Object.hasOwn(request, "id")) return null; // MCP notifications have no reply.
  const response = { jsonrpc: "2.0", id: request.id };
  switch (request.method) {
    case "initialize":
      return {
        ...response,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.has(
            request.params?.protocolVersion,
          )
            ? request.params.protocolVersion
            : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "arma-workspace", version: "0.2.0" },
        },
      };
    case "ping":
      return { ...response, result: {} };
    case "tools/list":
      return { ...response, result: { tools: workspace.tools || TOOLS } };
    case "tools/call":
      try {
        const result = await workspace.call(
          request.params?.name,
          request.params?.arguments,
        );
        return {
          ...response,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        };
      } catch (error) {
        return {
          ...response,
          result: {
            isError: true,
            content: [{ type: "text", text: safeError(error) }],
          },
        };
      }
    default:
      return {
        ...response,
        error: { code: -32601, message: "Method not found." },
      };
  }
}

async function serve(root, input = process.stdin, output = process.stdout) {
  const workspace = new WorkspaceTools(root);
  await workspace.ready;
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline > REQUEST_LIMIT)
        throw new WorkspaceError("The tool request is too large.");
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (!line.trim()) continue;
      let response;
      try {
        response = await handleRequest(workspace, JSON.parse(line));
      } catch {
        response = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON." },
        };
      }
      if (response && !output.write(`${JSON.stringify(response)}\n`))
        await once(output, "drain");
    }
    if (pending.length > REQUEST_LIMIT)
      throw new WorkspaceError("The tool request is too large.");
  }
}

if (require.main === module) {
  serve(process.argv[2]).catch((error) => {
    // Never print provider credentials, file contents, or filesystem error paths.
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WorkspaceTools,
  WorkspaceError,
  TOOLS,
  TEXT_LIMIT,
  ENTRY_LIMIT,
  handleRequest,
  serve,
  pathParts,
};
