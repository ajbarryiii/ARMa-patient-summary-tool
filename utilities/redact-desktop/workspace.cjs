"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");

const TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const DOCUMENT_LIMIT = 40 * 1024 * 1024;
const SPREADSHEET_EXTENSIONS = new Set([
  ".xlsx",
  ".xlsm",
  ".xls",
  ".csv",
  ".tsv",
]);
const ENTRY_LIMIT = 10000;
const SIDEBAR_SYSTEM_NAMES = new Set([
  ".ds_store",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
  ".temporaryitems",
  ".documentrevisions-v100",
  "__macosx",
  "thumbs.db",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "desktop.ini",
  "$recycle.bin",
  "system volume information",
]);

function sidebarSystemEntry(name) {
  return (
    SIDEBAR_SYSTEM_NAMES.has(name.toLowerCase()) ||
    name.startsWith("._") ||
    name.startsWith("~$")
  );
}
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".html",
  ".css",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".sql",
  ".toml",
  ".ini",
  ".cfg",
  ".sh",
  ".r",
  ".rst",
]);
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function partsFor(relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  ) {
    throw new Error("Choose a path inside the working directory.");
  }
  // Treat both separators as separators, including on macOS, to keep IPC paths portable.
  const parts = relative
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== ".");
  if (parts.includes(".."))
    throw new Error("Paths cannot leave the working directory.");
  return parts;
}

function publicPath(parts) {
  return parts.join("/");
}

async function directoryWithoutLink(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Choose a regular directory, not a symbolic link.");
  return fs.realpath(directory);
}

function safeSegment(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\0]/.test(name) &&
    !/^[A-Za-z]:/.test(name)
  );
}

function validName(name) {
  return safeSegment(name) && name.trim() === name;
}

const normalizedPart = (name) => name.normalize("NFKC").toLowerCase();
function privateArtifacts(parts) {
  const names = parts.map(normalizedPart);
  return names[0] === "unredacted" && names[1] === "redaction-runs";
}
function movablePath(relative) {
  const parts = partsFor(relative);
  return parts.length > 0 &&
    !(parts.length === 1 && ["redacted", "unredacted"].includes(normalizedPart(parts[0]))) &&
    !privateArtifacts(parts);
}
function entryName(name) {
  if (!validName(name) || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name.normalize("NFKC")) ||
      Buffer.byteLength(name) > 255)
    throw new Error("Enter a valid filename without slashes, reserved characters, or a trailing dot or space.");
  return name;
}

function assertWorkspaceRoot(canonical) {
  if (
    canonical
      .split(path.sep)
      .some((part) => part.normalize("NFKC").toLowerCase() === "unredacted")
  ) {
    throw new Error(
      "Open the working directory above unredacted. The unredacted folder and its subfolders cannot be working directories.",
    );
  }
}

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error("Import cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function snapshot(workspace) {
  const current = new Workspace();
  current.root = workspace.root;
  return current;
}

class Workspace {
  constructor() {
    this.root = null;
  }

  async open(root) {
    if (typeof root !== "string" || !path.isAbsolute(root))
      throw new Error("Choose an absolute working directory.");
    const canonical = await directoryWithoutLink(root);
    assertWorkspaceRoot(canonical);
    const reserved = ["unredacted", "redacted"];
    // Check both names before creating either, so a conflicting file does not partly initialize a workspace.
    for (const name of reserved) {
      try {
        const target = path.join(canonical, name);
        const actual = await directoryWithoutLink(target);
        if (!inside(canonical, actual))
          throw new Error(
            "Workspace folders must stay inside the working directory.",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    for (const name of reserved) {
      const target = path.join(canonical, name);
      try {
        await fs.mkdir(target);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await directoryWithoutLink(target);
    }
    this.root = canonical;
    await require("./mapping-format.cjs").ensureMappingReference(this);
    return { path: canonical, name: path.basename(canonical) || canonical };
  }

  async create(parent, name) {
    if (!validName(name))
      throw new Error("Enter a directory name without slashes.");
    if (typeof parent !== "string" || !path.isAbsolute(parent))
      throw new Error("Choose an absolute parent directory.");
    const canonical = await directoryWithoutLink(parent);
    const target = path.join(canonical, name);
    assertWorkspaceRoot(target);
    await fs.mkdir(target); // Never adopt or replace a directory when creating a new one.
    return this.open(target);
  }

  async resolve(relativePath = "") {
    const root = this.root;
    if (!root) throw new Error("Open a working directory first.");
    const parts = partsFor(relativePath);
    let current = root;
    const rootStat = await fs.lstat(current);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      (await fs.realpath(current)) !== root
    ) {
      throw new Error("The working directory has changed. Open it again.");
    }
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(
          "Symbolic links are not supported in the working directory.",
        );
      if (!stat.isDirectory() && !stat.isFile())
        throw new Error("Only regular files and directories are supported.");
    }
    const canonical = await fs.realpath(current);
    if (!inside(root, canonical) || canonical !== current)
      throw new Error("The path is outside the working directory.");
    return canonical;
  }

  async list(relativePath = "") {
    const workspace = snapshot(this);
    const parts = partsFor(relativePath);
    const directory = await workspace.resolve(relativePath);
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory())
      throw new Error("Choose a directory to browse.");
    const entries = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (entries.length >= ENTRY_LIMIT)
        throw new Error("This folder contains too many files to display.");
      if (
        (!entry.isFile() && !entry.isDirectory()) ||
        !safeSegment(entry.name) ||
        sidebarSystemEntry(entry.name)
      )
        continue;
      const entryPath = publicPath([...parts, entry.name]);
      try {
        const absolute = await workspace.resolve(entryPath);
        const stat = await fs.lstat(absolute);
        entries.push({
          name: entry.name,
          path: entryPath,
          kind: stat.isDirectory() ? "directory" : "file",
          size: stat.isFile() ? stat.size : 0,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return entries.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
    );
  }

  async importPaths(
    sourcePaths,
    destinationRelative = "unredacted",
    options = {},
  ) {
    // Pin each operation to the selected root even if the operator opens another workspace meanwhile.
    return snapshot(this)._importPaths(
      sourcePaths,
      destinationRelative,
      options,
    );
  }

  async rename(relative, name) {
    const parts = partsFor(relative);
    return snapshot(this)._relocate(relative, publicPath(parts.slice(0, -1)), entryName(name));
  }

  async move(relative, destination) {
    const parts = partsFor(relative);
    return snapshot(this)._relocate(relative, destination, parts.at(-1));
  }

  async _relocate(relative, destination, name) {
    if (!movablePath(relative))
      throw new Error("Workspace folders and saved redaction artifacts cannot be moved or renamed.");
    const fromParts = partsFor(relative), toParts = [...partsFor(destination), entryName(name)];
    if (privateArtifacts(toParts))
      throw new Error("Saved redaction artifacts cannot be changed.");
    if (fromParts.some(part => normalizedPart(part) === "unredacted") &&
        !toParts.some(part => normalizedPart(part) === "unredacted") &&
        normalizedPart(toParts[0]) !== "redacted")
      throw new Error("Move originals to redacted or keep them within unredacted.");
    const from = publicPath(fromParts), to = publicPath(toParts);
    const source = await this.resolve(from);
    const directory = await this.resolve(publicPath(toParts.slice(0, -1)));
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Choose a destination folder.");
    const stat = await fs.lstat(source), target = path.join(directory, name);
    if (stat.isFile() && stat.nlink !== 1) throw new Error("Linked files cannot be moved or renamed.");
    const result = { from, path: to, kind: stat.isDirectory() ? "directory" : "file", changed: from !== to };
    if (from === to) return result;
    if (stat.isDirectory() && inside(source, target))
      throw new Error("A folder cannot be moved into itself or one of its subfolders.");
    let existing;
    try { existing = await fs.lstat(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    // A case-only rename can resolve to this very same entry on macOS/Windows.
    const sameEntry = existing && existing.dev === stat.dev && existing.ino === stat.ino &&
      path.dirname(source) === directory &&
      path.basename(source).normalize("NFC").toLowerCase() === name.normalize("NFC").toLowerCase();
    if (existing && !sameEntry) throw new Error("An item with that name already exists in the destination folder.");
    await this.resolve(from);
    await this.resolve(publicPath(toParts.slice(0, -1)));
    await fs.rename(source, target);
    return result;
  }

  async createFolder(destination, name) {
    const workspace = snapshot(this);
    const parts = [...partsFor(destination), entryName(name)];
    if (privateArtifacts(parts)) throw new Error("Saved redaction artifacts cannot be changed.");
    const directory = await workspace.resolve(destination);
    try { await fs.mkdir(path.join(directory, name)); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("An item with that name already exists in this folder.");
      throw error;
    }
    return { from: null, path: publicPath(parts), kind: "directory", changed: true };
  }

  async _importPaths(sourcePaths, destinationRelative, { signal } = {}) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length > ENTRY_LIMIT)
      throw new Error("Choose up to 10,000 files or folders to add.");
    const copied = [];
    const skipped = [];
    if (signal?.aborted) return { copied, skipped, cancelled: true };
    const destination = await this.resolve(destinationRelative);
    if (!(await fs.lstat(destination)).isDirectory())
      throw new Error("Drop files onto a directory.");
    const destinationParts = partsFor(destinationRelative);
    let plannedEntries = 0;

    for (const source of sourcePaths) {
      if (signal?.aborted) return { copied, skipped, cancelled: true };
      const name =
        typeof source === "string" ? path.basename(source) : "Unknown file";
      let created = null;
      let createdStat = null;
      let createdHandle = null;
      try {
        if (
          typeof source !== "string" ||
          !path.isAbsolute(source) ||
          !safeSegment(name)
        )
          throw new Error("Choose a regular file or directory.");
        const sourceStat = await fs.lstat(source);
        if (
          sourceStat.isSymbolicLink() ||
          (!sourceStat.isFile() && !sourceStat.isDirectory())
        ) {
          throw new Error(
            "Symbolic links and special files are not supported.",
          );
        }
        const canonicalSource = await fs.realpath(source);
        if (sourceStat.isDirectory() && inside(canonicalSource, destination))
          throw new Error("A directory cannot be copied into itself.");

        // Inspect before copying so a folder containing links is rejected without a partial import.
        const manifest = [];
        const inspect = async (absolute, relative) => {
          checkCancelled(signal);
          if (++plannedEntries > ENTRY_LIMIT)
            throw new Error(
              "An import can contain up to 10,000 files and folders.",
            );
          const stat = await fs.lstat(absolute);
          checkCancelled(signal);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
            throw new Error(
              "The folder contains a symbolic link or special file.",
            );
          manifest.push({
            relative,
            directory: stat.isDirectory(),
            dev: stat.dev,
            ino: stat.ino,
          });
          if (stat.isDirectory()) {
            const handle = await fs.opendir(absolute);
            for await (const entry of handle) {
              if (!safeSegment(entry.name))
                throw new Error(
                  "The folder contains a filename with unsupported path characters.",
                );
              await inspect(path.join(absolute, entry.name), [
                ...relative,
                entry.name,
              ]);
            }
          }
        };
        await inspect(canonicalSource, []);
        checkCancelled(signal);
        const top = manifest[0];
        let candidate;
        for (let suffix = 1; suffix <= ENTRY_LIMIT; suffix++) {
          checkCancelled(signal);
          const extension = top.directory ? "" : path.extname(name);
          const stem = extension ? name.slice(0, -extension.length) : name;
          const candidateName =
            suffix === 1 ? name : `${stem} (${suffix})${extension}`;
          candidate = path.join(destination, candidateName);
          // Refresh containment immediately before writing to an externally mutable directory.
          await this.resolve(destinationRelative);
          try {
            if (top.directory) await fs.mkdir(candidate);
            else {
              createdHandle = await fs.open(
                candidate,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600,
              );
            }
            created = candidate;
            createdStat = createdHandle
              ? await createdHandle.stat()
              : await fs.lstat(created);
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        if (!created)
          throw new Error("There are too many files with this name.");
        for (const entry of manifest) {
          checkCancelled(signal);
          const from = path.join(canonicalSource, ...entry.relative);
          const toParts = [
            ...destinationParts,
            path.basename(candidate),
            ...entry.relative,
          ];
          const to = path.join(this.root, ...toParts);
          const current = await fs.lstat(from);
          if (
            current.isSymbolicLink() ||
            current.dev !== entry.dev ||
            current.ino !== entry.ino ||
            current.isDirectory() !== entry.directory ||
            (!current.isFile() && !current.isDirectory())
          ) {
            throw new Error(
              "The source changed during import. Try adding it again.",
            );
          }
          if ((await fs.realpath(from)) !== from)
            throw new Error("The source changed during import.");
          await this.resolve(publicPath(toParts.slice(0, -1)));
          if (entry.directory) {
            if (entry.relative.length) await fs.mkdir(to);
          } else {
            // Streams bound memory; O_NOFOLLOW prevents replacing a reserved destination with a link.
            const input = await fs.open(
              from,
              constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
            );
            let output;
            try {
              const opened = await input.stat();
              if (
                !opened.isFile() ||
                opened.ino !== entry.ino ||
                opened.dev !== entry.dev
              )
                throw new Error("The source changed during import.");
              output = entry.relative.length
                ? await fs.open(
                    to,
                    constants.O_WRONLY |
                      (constants.O_NOFOLLOW || 0) |
                      constants.O_CREAT |
                      constants.O_EXCL,
                    0o600,
                  )
                : createdHandle;
              const buffer = Buffer.allocUnsafe(1024 * 1024);
              let position = 0;
              while (position < opened.size) {
                checkCancelled(signal);
                const { bytesRead } = await input.read(
                  buffer,
                  0,
                  Math.min(buffer.length, opened.size - position),
                  position,
                );
                checkCancelled(signal);
                if (!bytesRead)
                  throw new Error(
                    "The source changed during import. Try adding it again.",
                  );
                let written = 0;
                while (written < bytesRead) {
                  checkCancelled(signal);
                  const result = await output.write(
                    buffer,
                    written,
                    bytesRead - written,
                    position + written,
                  );
                  written += result.bytesWritten;
                }
                position += bytesRead;
              }
            } finally {
              await input.close();
              if (output) await output.close();
              if (output === createdHandle) createdHandle = null;
            }
          }
        }
        checkCancelled(signal);
        const completed = await fs.lstat(created);
        checkCancelled(signal);
        if (
          completed.ino !== createdStat.ino ||
          completed.dev !== createdStat.dev
        )
          throw new Error("The destination changed during import.");
        copied.push(
          publicPath([...destinationParts, path.basename(candidate)]),
        );
      } catch (error) {
        if (createdHandle) await createdHandle.close().catch(() => {});
        if (created) {
          // Only remove the new path reserved by this import; originals and preexisting paths stay intact.
          const relative = path.relative(this.root, created);
          try {
            await this.resolve(publicPath(partsFor(relative).slice(0, -1)));
            const current = await fs.lstat(created);
            if (
              current.ino === createdStat?.ino &&
              current.dev === createdStat?.dev
            ) {
              await fs.rm(created, { recursive: true, force: true });
            }
          } catch {
            /* Do not follow a changed destination while cleaning up. */
          }
        }
        if (signal?.aborted) return { copied, skipped, cancelled: true };
        skipped.push({ name, reason: error.message });
      }
    }
    return signal?.aborted
      ? { copied, skipped, cancelled: true }
      : { copied, skipped };
  }

  async preview(relativePath) {
    const absolute = await this.resolve(relativePath);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) throw new Error("Choose a file to preview.");
    const result = {
      name: path.basename(absolute),
      path: publicPath(partsFor(relativePath)),
      kind: "unsupported",
      size: stat.size,
      revision: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`,
    };
    const extension = path.extname(absolute).toLowerCase();
    const imageType = IMAGE_TYPES.get(extension);
    const textFile = TEXT_EXTENSIONS.has(extension) || extension === "";
    const documentKind =
      extension === ".pdf"
        ? "pdf"
        : SPREADSHEET_EXTENSIONS.has(extension)
          ? "spreadsheet"
          : null;
    if (documentKind && stat.size > DOCUMENT_LIMIT)
      throw new Error("Document previews are limited to 40 MiB.");
    if (
      (!documentKind && !imageType && !textFile) ||
      (imageType && stat.size > IMAGE_LIMIT)
    )
      return result;
    const handle = await fs.open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        throw new Error("The file changed. Select it again.");
      const limit = documentKind
        ? DOCUMENT_LIMIT
        : imageType
          ? IMAGE_LIMIT
          : TEXT_LIMIT;
      if (documentKind && opened.size > DOCUMENT_LIMIT)
        throw new Error("Document previews are limited to 40 MiB.");
      const buffer = Buffer.alloc(Math.min(opened.size, limit));
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
      const bytes = buffer.subarray(0, total);
      if (documentKind)
        return { ...result, kind: documentKind, data: new Uint8Array(bytes) };
      if (imageType)
        return {
          ...result,
          kind: "image",
          dataUrl: `data:${imageType};base64,${bytes.toString("base64")}`,
        };
      if (bytes.includes(0)) return result;
      return {
        ...result,
        kind: "text",
        text: bytes.toString("utf8"),
        truncated: opened.size > TEXT_LIMIT,
      };
    } finally {
      await handle.close();
    }
  }
}

module.exports = { Workspace, movablePath };
