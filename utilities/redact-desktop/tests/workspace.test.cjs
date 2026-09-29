"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { constants } = require("node:fs");
const { Workspace } = require("../workspace.cjs");

async function fixture(t) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "arma-workspace-test-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const parent = await fs.realpath(temporary);
  const workspace = new Workspace();
  return { parent, workspace };
}

test("renames and moves files and folders without changing their contents", async t => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  await workspace.createFolder("redacted", "Reports");
  await workspace.createFolder("redacted", "Archive");
  await fs.writeFile(path.join(workspace.root, "redacted/Reports/claim.csv"), "id,amount\n0001,-123.45\n");
  assert.deepEqual(await workspace.rename("redacted/Reports/claim.csv", "Claim.csv"), {
    from: "redacted/Reports/claim.csv", path: "redacted/Reports/Claim.csv", kind: "file", changed: true,
  });
  await workspace.move("redacted/Reports", "redacted/Archive");
  assert.equal(await fs.readFile(path.join(workspace.root, "redacted/Archive/Reports/Claim.csv"), "utf8"), "id,amount\n0001,-123.45\n");
  await assert.rejects(fs.stat(path.join(workspace.root, "redacted/Reports")), { code: "ENOENT" });
  assert.equal((await workspace.move("redacted/Archive", "redacted")).changed, false);
});

test("file edits reject collisions, invalid portable names, traversal, and folder cycles", async t => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  await fs.writeFile(path.join(workspace.root, "redacted/source.txt"), "source");
  await fs.writeFile(path.join(workspace.root, "redacted/existing.txt"), "existing");
  await assert.rejects(workspace.rename("redacted/source.txt", "existing.txt"), /already exists/);
  await workspace.createFolder("redacted", "Archive");
  await fs.writeFile(path.join(workspace.root, "redacted/Archive/source.txt"), "destination");
  await assert.rejects(workspace.move("redacted/source.txt", "redacted/Archive"), /already exists/);
  await assert.rejects(workspace.createFolder("redacted", "Archive"), /already exists/);
  await workspace.createFolder("redacted/Archive", "Nested");
  await assert.rejects(workspace.move("redacted/Archive", "redacted/Archive/Nested"), /itself/);
  for (const name of ["", "..", "../oops", "x/y", "x\\y", "NUL", "COM1.txt", "bad:", "bad.", "bad ", "bad?"]) {
    await assert.rejects(workspace.rename("redacted/source.txt", name), /valid filename/);
    await assert.rejects(workspace.createFolder("redacted", name), /valid filename/);
  }
  await assert.rejects(workspace.move("redacted/source.txt", "../outside"), /cannot leave/);
  assert.equal(await fs.readFile(path.join(workspace.root, "redacted/source.txt"), "utf8"), "source");
  assert.equal(await fs.readFile(path.join(workspace.root, "redacted/existing.txt"), "utf8"), "existing");
  assert.equal(await fs.readFile(path.join(workspace.root, "redacted/Archive/source.txt"), "utf8"), "destination");
});

test("manual moves into redacted preserve file contents and immutable redaction artifacts", async t => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  await fs.mkdir(path.join(workspace.root, "unredacted/redaction-runs/run"), { recursive: true });
  await fs.writeFile(path.join(workspace.root, "unredacted/redaction-runs/run/mapping.csv"), "private mapping");
  await fs.writeFile(path.join(workspace.root, "unredacted/source.csv"), "private original");
  for (const source of ["", "redacted", "unredacted", "unredacted/redaction-runs", "unredacted/redaction-runs/run/mapping.csv"]) {
    await assert.rejects(workspace.rename(source, "renamed"), /cannot be moved/);
    await assert.rejects(workspace.move(source, "redacted"), /cannot be moved/);
  }
  await assert.rejects(workspace.move("unredacted/source.csv", ""), /Move originals to redacted/);
  await assert.rejects(workspace.move("unredacted/source.csv", "unredacted/redaction-runs/run"), /cannot be changed/);
  await assert.rejects(workspace.createFolder("unredacted/redaction-runs", "new"), /cannot be changed/);
  await workspace.createFolder("unredacted", "Archive");
  await workspace.move("unredacted/source.csv", "unredacted/Archive");
  await workspace.rename("unredacted/Archive/source.csv", "renamed.csv");
  assert.equal(await fs.readFile(path.join(workspace.root, "unredacted/Archive/renamed.csv"), "utf8"), "private original");
  await workspace.move("unredacted/Archive/renamed.csv", "redacted");
  assert.equal(await fs.readFile(path.join(workspace.root, "redacted/renamed.csv"), "utf8"), "private original");
  await assert.rejects(fs.stat(path.join(workspace.root, "unredacted/Archive/renamed.csv")), { code: "ENOENT" });
  await workspace.move("redacted/renamed.csv", "unredacted/Archive");
  await workspace.createFolder("redacted", "Reviewed");
  await workspace.move("unredacted/Archive", "redacted/Reviewed");
  assert.equal(await fs.readFile(path.join(workspace.root, "redacted/Reviewed/Archive/renamed.csv"), "utf8"), "private original");
  await assert.rejects(fs.stat(path.join(workspace.root, "unredacted/Archive")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(workspace.root, "unredacted/redaction-runs/run/mapping.csv"), "utf8"), "private mapping");
});

test("filesystem edits reject symbolic links and multiply linked files", async t => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  await fs.writeFile(path.join(parent, "outside.txt"), "outside");
  await fs.symlink(parent, path.join(workspace.root, "redacted/linked"), "dir");
  await fs.writeFile(path.join(workspace.root, "redacted/source.txt"), "source");
  await assert.rejects(workspace.move("redacted/source.txt", "redacted/linked"), /Symbolic links/);
  await assert.rejects(workspace.rename("redacted/linked", "renamed"), /Symbolic links/);
  await fs.link(path.join(parent, "outside.txt"), path.join(workspace.root, "redacted/hardlink.txt"));
  await assert.rejects(workspace.rename("redacted/hardlink.txt", "renamed.txt"), /Linked files/);
  assert.equal(await fs.readFile(path.join(parent, "outside.txt"), "utf8"), "outside");
});

test("creating and reopening a workspace preserves existing files and creates both standard directories", async (t) => {
  const { parent, workspace } = await fixture(t);
  const result = await workspace.create(parent, "Synthetic claim");
  assert.deepEqual(result, {
    path: path.join(parent, "Synthetic claim"),
    name: "Synthetic claim",
  });
  await fs.writeFile(
    path.join(result.path, "unredacted", "original.txt"),
    "Synthetic patient",
  );
  assert.deepEqual(
    (await workspace.list()).map((item) => [item.name, item.kind]),
    [
      ["redacted", "directory"],
      ["unredacted", "directory"],
    ],
  );
  const reopened = new Workspace();
  assert.deepEqual(await reopened.open(result.path), result);
  assert.equal(
    await fs.readFile(
      path.join(result.path, "unredacted", "original.txt"),
      "utf8",
    ),
    "Synthetic patient",
  );
  await assert.rejects(workspace.create(parent, "Synthetic claim"), {
    code: "EEXIST",
  });
});

test("opening an existing directory initializes missing folders without replacing conflicting files", async (t) => {
  const { parent, workspace } = await fixture(t);
  const existing = path.join(parent, "existing");
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, "redacted"), "Keep this file");
  await assert.rejects(workspace.open(existing), /regular directory/);
  await assert.rejects(fs.stat(path.join(existing, "unredacted")), {
    code: "ENOENT",
  });
  assert.equal(workspace.root, null);
  assert.equal(
    await fs.readFile(path.join(existing, "redacted"), "utf8"),
    "Keep this file",
  );
});

test("unredacted folders and descendants cannot become workspace roots, including normalized names", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "selected-workspace");
  const selectedRoot = workspace.root;
  const names = [
    "unredacted",
    "UnReDaCtEd",
    "ｕｎｒｅｄａｃｔｅｄ",
    "ＵＮＲＥＤＡＣＴＥＤ",
  ];
  for (const [index, name] of names.entries()) {
    const reserved = path.join(parent, `claims-${index}`, name);
    const nested = path.join(reserved, "nested");
    await fs.mkdir(nested, { recursive: true });
    for (const root of [reserved, nested]) {
      await assert.rejects(workspace.open(root), /above unredacted/);
      assert.equal(workspace.root, selectedRoot);
      await assert.rejects(fs.stat(path.join(root, "redacted")), {
        code: "ENOENT",
      });
    }
  }
});

test("creating a workspace rejects unredacted ancestry before creating any directory", async (t) => {
  const { parent, workspace } = await fixture(t);
  for (const name of [
    "unredacted",
    "UnReDaCtEd",
    "ｕｎｒｅｄａｃｔｅｄ",
    "ＵＮＲＥＤＡＣＴＥＤ",
  ]) {
    await assert.rejects(workspace.create(parent, name), /above unredacted/);
    await assert.rejects(fs.stat(path.join(parent, name)), { code: "ENOENT" });
  }
  const reserved = path.join(parent, "unredacted");
  const nested = path.join(reserved, "nested");
  await fs.mkdir(nested, { recursive: true });
  for (const directory of [reserved, nested]) {
    await assert.rejects(
      workspace.create(directory, "new-workspace"),
      /above unredacted/,
    );
    await assert.rejects(fs.stat(path.join(directory, "new-workspace")), {
      code: "ENOENT",
    });
  }
  assert.equal(workspace.root, null);
});

test("canonical unredacted ancestry is rejected when reached through a symlink alias", async (t) => {
  const { parent, workspace } = await fixture(t);
  const reserved = path.join(parent, "claims", "unredacted");
  const nested = path.join(reserved, "nested");
  await fs.mkdir(nested, { recursive: true });
  const alias = path.join(parent, "alias");
  await fs.symlink(reserved, alias, "dir");
  // The selected directory itself is regular; only its ancestor is a symlink.
  const aliasedNested = path.join(alias, "nested");
  await assert.rejects(workspace.open(aliasedNested), /above unredacted/);
  await assert.rejects(
    workspace.create(aliasedNested, "new-workspace"),
    /above unredacted/,
  );
  await assert.rejects(fs.stat(path.join(nested, "redacted")), {
    code: "ENOENT",
  });
  await assert.rejects(fs.stat(path.join(nested, "new-workspace")), {
    code: "ENOENT",
  });
  assert.equal(workspace.root, null);
});

test("rejects traversal, absolute paths, and invalid new workspace names", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  for (const relative of [
    "../outside",
    "unredacted/../../outside",
    "..\\outside",
    "/tmp",
    "C:\\outside",
    "bad\0name",
  ]) {
    await assert.rejects(workspace.resolve(relative));
  }
  for (const name of [
    "",
    ".",
    "..",
    "../outside",
    "bad/name",
    "bad\\name",
    " padded ",
  ]) {
    await assert.rejects(workspace.create(parent, name));
  }
  assert.equal(
    await workspace.resolve("unredacted/."),
    path.join(workspace.root, "unredacted"),
  );
});

test("never browses or previews symbolic links, and refuses a symlinked reserved folder", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const outside = path.join(parent, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "Outside workspace");
  await fs.symlink(outside, path.join(workspace.root, "linked"), "dir");
  await fs.symlink(
    path.join(outside, "secret.txt"),
    path.join(workspace.root, "secret.txt"),
  );
  assert.deepEqual(
    (await workspace.list()).map((item) => item.name),
    ["redacted", "unredacted"],
  );
  await assert.rejects(
    workspace.resolve("linked/secret.txt"),
    /Symbolic links/,
  );
  await assert.rejects(workspace.preview("secret.txt"), /Symbolic links/);
  await fs.rmdir(path.join(workspace.root, "redacted"));
  await fs.symlink(outside, path.join(workspace.root, "redacted"), "dir");
  await assert.rejects(
    new Workspace().open(workspace.root),
    /regular directory/,
  );
  await assert.rejects(
    workspace.importPaths([path.join(outside, "secret.txt")], "redacted"),
    /Symbolic links/,
  );
});

test("imports files and directories without moving originals or overwriting collisions", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const source = path.join(parent, "synthetic.csv");
  await fs.writeFile(source, "patient,amount\nExample,123.45\n");
  await fs.writeFile(
    path.join(workspace.root, "unredacted", "synthetic.csv"),
    "Existing",
  );
  const folder = path.join(parent, "Attachments");
  await fs.mkdir(path.join(folder, "nested"), { recursive: true });
  await fs.writeFile(path.join(folder, "nested", "note.txt"), "Synthetic note");
  const result = await workspace.importPaths([source, folder]);
  assert.deepEqual(result, {
    copied: ["unredacted/synthetic (2).csv", "unredacted/Attachments"],
    skipped: [],
  });
  assert.equal(
    await fs.readFile(
      path.join(workspace.root, "unredacted", "synthetic.csv"),
      "utf8",
    ),
    "Existing",
  );
  assert.equal(
    await fs.readFile(
      path.join(workspace.root, "unredacted", "synthetic (2).csv"),
      "utf8",
    ),
    await fs.readFile(source, "utf8"),
  );
  assert.equal(
    await fs.readFile(
      path.join(
        workspace.root,
        "unredacted",
        "Attachments",
        "nested",
        "note.txt",
      ),
      "utf8",
    ),
    "Synthetic note",
  );
  assert.equal(
    await fs.readFile(path.join(folder, "nested", "note.txt"), "utf8"),
    "Synthetic note",
  );
  assert.deepEqual((await workspace.importPaths([folder], "redacted")).copied, [
    "redacted/Attachments",
  ]);
  assert.deepEqual((await workspace.importPaths([folder], "redacted")).copied, [
    "redacted/Attachments (2)",
  ]);
});

test("failed individual imports are skipped while valid imports continue", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const source = path.join(parent, "note.txt");
  await fs.writeFile(source, "A synthetic note");
  const link = path.join(parent, "link.txt");
  await fs.symlink(source, link);
  const result = await workspace.importPaths([
    link,
    path.join(parent, "missing"),
    source,
  ]);
  assert.deepEqual(result.copied, ["unredacted/note.txt"]);
  assert.deepEqual(
    result.skipped.map((item) => item.name),
    ["link.txt", "missing"],
  );
  assert.match(result.skipped[0].reason, /Symbolic links/);
});

test("rejects a folder containing links as a whole, including links within the source", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const source = path.join(parent, "folder");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "note.txt"), "Synthetic");
  await fs.symlink("note.txt", path.join(source, "link.txt"));
  const result = await workspace.importPaths([source]);
  assert.deepEqual(result.copied, []);
  assert.match(result.skipped[0].reason, /symbolic link/);
  assert.deepEqual((await workspace.list("unredacted")).map(e => e.name), ["Mapping CSV columns.md"]);
});

test("rejects importing a directory into itself and invalid destinations", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const result = await workspace.importPaths([parent, workspace.root]);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((item) => /itself/.test(item.reason)));
  assert.deepEqual(result.copied, []);
  await fs.writeFile(path.join(workspace.root, "note.txt"), "Synthetic");
  await assert.rejects(workspace.importPaths([], "note.txt"), /directory/);
  await assert.rejects(workspace.importPaths([], "../outside"), /cannot leave/);
});

test("browsing nested directories returns relative paths and file sizes", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  await fs.writeFile(
    path.join(workspace.root, "redacted", "note.txt"),
    "hello",
  );
  await fs.mkdir(path.join(workspace.root, "redacted", "z-folder"));
  assert.deepEqual(await workspace.list("redacted"), [
    { name: "z-folder", path: "redacted/z-folder", kind: "directory", size: 0 },
    { name: "note.txt", path: "redacted/note.txt", kind: "file", size: 5 },
  ]);
});

test("text previews stay bounded and document bytes remain local preview data", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  await fs.writeFile(path.join(workspace.root, "note.txt"), "Synthetic note");
  const { revision, ...note } = await workspace.preview("note.txt");
  assert.equal(typeof revision, "string");
  assert.deepEqual(note, {
    name: "note.txt",
    path: "note.txt",
    kind: "text",
    size: 14,
    text: "Synthetic note",
    truncated: false,
  });
  await fs.writeFile(
    path.join(workspace.root, "large.txt"),
    "a".repeat(300 * 1024),
  );
  const large = await workspace.preview("large.txt");
  assert.equal(large.text.length, 256 * 1024);
  assert.equal(large.truncated, true);
  await fs.writeFile(
    path.join(workspace.root, "binary.txt"),
    Buffer.from([1, 0, 2]),
  );
  await fs.writeFile(
    path.join(workspace.root, "claims.xlsx"),
    "Synthetic unsupported document",
  );
  assert.equal((await workspace.preview("binary.txt")).kind, "unsupported");
  const workbook = await workspace.preview("claims.xlsx");
  assert.equal(workbook.kind, "spreadsheet");
  assert.equal(
    Buffer.from(workbook.data).toString(),
    "Synthetic unsupported document",
  );
  await assert.rejects(workspace.preview("unredacted"), /file to preview/);
});

test("image previews use local data URLs and reject oversized images and SVG content", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG3sAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(path.join(workspace.root, "pixel.png"), png);
  const preview = await workspace.preview("pixel.png");
  assert.equal(preview.kind, "image");
  assert.equal(
    preview.dataUrl,
    `data:image/png;base64,${png.toString("base64")}`,
  );
  const big = await fs.open(path.join(workspace.root, "large.png"), "w");
  await big.truncate(12 * 1024 * 1024 + 1);
  await big.close();
  await fs.writeFile(
    path.join(workspace.root, "drawing.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" />',
  );
  assert.equal((await workspace.preview("large.png")).kind, "unsupported");
  assert.equal((await workspace.preview("drawing.svg")).kind, "unsupported");
});

test("replacing an opened workspace with a symlink invalidates later reads and writes", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const root = workspace.root;
  const outside = path.join(parent, "outside");
  await fs.mkdir(outside);
  await fs.rename(root, `${root}-old`);
  await fs.symlink(outside, root, "dir");
  await assert.rejects(workspace.list(), /working directory has changed/);
  await assert.rejects(
    workspace.importPaths([]),
    /working directory has changed/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("a replaced import destination never truncates or cleans up an unrelated original", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const source = path.join(parent, "source.txt");
  const original = path.join(parent, "original.txt");
  const destination = path.join(workspace.root, "unredacted", "source.txt");
  await fs.writeFile(source, "Synthetic new content");
  await fs.writeFile(original, "Preserve original");
  const realOpen = fs.open;
  let replaced = false;
  fs.open = async (filename, flags, ...rest) => {
    if (
      !replaced &&
      filename === source &&
      flags === (constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    ) {
      replaced = true;
      await fs.unlink(destination);
      await fs.link(original, destination);
    }
    return realOpen(filename, flags, ...rest);
  };
  let result;
  try {
    result = await workspace.importPaths([source]);
  } finally {
    fs.open = realOpen;
  }
  assert.equal(replaced, true);
  assert.deepEqual(result.copied, []);
  assert.match(result.skipped[0].reason, /destination changed/);
  assert.equal(await fs.readFile(original, "utf8"), "Preserve original");
  assert.equal(await fs.readFile(destination, "utf8"), "Preserve original");
});

test("an import remains in its original workspace when the selected workspace changes", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "first");
  const firstRoot = workspace.root;
  const other = new Workspace();
  await other.create(parent, "second");
  const source = path.join(parent, "source.txt");
  await fs.writeFile(source, "Synthetic content");
  const realOpen = fs.open;
  let switched = false;
  fs.open = async (filename, flags, ...rest) => {
    if (
      !switched &&
      filename === source &&
      flags === (constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    ) {
      switched = true;
      await workspace.open(other.root);
    }
    return realOpen(filename, flags, ...rest);
  };
  let result;
  try {
    result = await workspace.importPaths([source]);
  } finally {
    fs.open = realOpen;
  }
  assert.equal(switched, true);
  assert.deepEqual(result, { copied: ["unredacted/source.txt"], skipped: [] });
  assert.equal(
    await fs.readFile(path.join(firstRoot, "unredacted", "source.txt"), "utf8"),
    "Synthetic content",
  );
  assert.deepEqual((await other.list("unredacted")).map(e => e.name), ["Mapping CSV columns.md"]);
});

test("cancelling during a file copy keeps completed imports and originals and removes the partial copy", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const first = path.join(parent, "first.txt");
  const large = path.join(parent, "large.txt");
  const last = path.join(parent, "last.txt");
  await fs.writeFile(first, "Completed synthetic file");
  const largeContent = Buffer.alloc(3 * 1024 * 1024, "x");
  await fs.writeFile(large, largeContent);
  await fs.writeFile(last, "Must not be imported");
  const partial = path.join(workspace.root, "unredacted", "large.txt");
  const controller = new AbortController();
  const realOpen = fs.open;
  let bytesWritten = 0;
  fs.open = async (filename, ...args) => {
    const handle = await realOpen(filename, ...args);
    if (filename === partial) {
      const realWrite = handle.write.bind(handle);
      handle.write = async (...writeArgs) => {
        const result = await realWrite(...writeArgs);
        bytesWritten += result.bytesWritten;
        controller.abort();
        return result;
      };
    }
    return handle;
  };
  let result;
  try {
    result = await workspace.importPaths([first, large, last], "unredacted", {
      signal: controller.signal,
    });
  } finally {
    fs.open = realOpen;
  }
  assert.ok(bytesWritten > 0 && bytesWritten < largeContent.length);
  assert.deepEqual(result, {
    copied: ["unredacted/first.txt"],
    skipped: [],
    cancelled: true,
  });
  assert.deepEqual(
    (await workspace.list("unredacted")).map((entry) => entry.name),
    ["first.txt", "Mapping CSV columns.md"],
  );
  assert.equal(
    await fs.readFile(
      path.join(workspace.root, "unredacted", "first.txt"),
      "utf8",
    ),
    "Completed synthetic file",
  );
  assert.deepEqual(await fs.readFile(large), largeContent);
  assert.equal(await fs.readFile(last, "utf8"), "Must not be imported");
});

test("cancelling during recursive preflight stops before copying that folder or later sources", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const first = path.join(parent, "first.txt");
  const folder = path.join(parent, "folder");
  const nested = path.join(folder, "nested");
  const last = path.join(parent, "last.txt");
  await fs.writeFile(first, "Completed synthetic file");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(
    path.join(nested, "original.txt"),
    "Preserve nested original",
  );
  await fs.writeFile(last, "Must not be imported");
  const controller = new AbortController();
  const realLstat = fs.lstat;
  let reachedNested = false;
  fs.lstat = async (filename, ...args) => {
    const result = await realLstat(filename, ...args);
    if (filename === nested) {
      reachedNested = true;
      controller.abort();
    }
    return result;
  };
  let result;
  try {
    result = await workspace.importPaths([first, folder, last], "unredacted", {
      signal: controller.signal,
    });
  } finally {
    fs.lstat = realLstat;
  }
  assert.equal(reachedNested, true);
  assert.deepEqual(result, {
    copied: ["unredacted/first.txt"],
    skipped: [],
    cancelled: true,
  });
  assert.deepEqual(
    (await workspace.list("unredacted")).map((entry) => entry.name),
    ["first.txt", "Mapping CSV columns.md"],
  );
  assert.equal(
    await fs.readFile(path.join(nested, "original.txt"), "utf8"),
    "Preserve nested original",
  );
  assert.equal(await fs.readFile(last, "utf8"), "Must not be imported");
});

test("an already cancelled import does no filesystem work", async (t) => {
  const { parent, workspace } = await fixture(t);
  await workspace.create(parent, "workspace");
  const source = path.join(parent, "source.txt");
  await fs.writeFile(source, "Synthetic original");
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await workspace.importPaths([source], "unredacted", {
      signal: controller.signal,
    }),
    {
      copied: [],
      skipped: [],
      cancelled: true,
    },
  );
  assert.deepEqual((await workspace.list("unredacted")).map(e => e.name), ["Mapping CSV columns.md"]);
  assert.equal(await fs.readFile(source, "utf8"), "Synthetic original");
});
