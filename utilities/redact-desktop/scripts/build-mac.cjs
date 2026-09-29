"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { build, Platform, Arch } = require("electron-builder");
const { APPLICATION_FILES, CLAUDE_BINARY, prune, keepPackageFiles, verifyApplication } = require("./windows-package.cjs");
const project = path.resolve(__dirname, "..");
const output = path.join(project, "dist");
// Build contract: --x64 selects Intel; the default is Apple Silicon.
// Each target has independent staging, artifact, and verification outputs.
const arch = process.argv.includes("--x64") ? "x64" : "arm64";
const stage = path.join(output, `mac-${arch}-stage`);
async function main() {
  if (process.platform !== "darwin") throw new Error("Build the Mac DMG on macOS.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Build with Node.js 22.13 or newer.");
  const source = JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8"));
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  for (const name of [...APPLICATION_FILES, "package.json", "package-lock.json"]) {
    await fs.mkdir(path.dirname(path.join(stage, name)), { recursive: true });
    await fs.copyFile(path.join(project, name), path.join(stage, name));
  }
  await fs.copyFile(path.resolve(project, "../../LICENSE"), path.join(stage, "LICENSE"));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run npm run build:mac so the pinned npm environment is available.");
  console.log("Installing locked macOS production dependencies into the isolated staging folder…");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--os=darwin", `--cpu=${arch}`, "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Staging npm ci exited ${code}`)));
  });
  // npm postinstall would select the build host's binary. Place the locked
  // macOS binary explicitly, then remove the duplicate platform package.
  await fs.copyFile(path.join(stage, `node_modules/@anthropic-ai/claude-code-darwin-${arch}/claude`), path.join(stage, CLAUDE_BINARY));
  await fs.chmod(path.join(stage, CLAUDE_BINARY), 0o755);
  const claudeDir = path.join(stage, "node_modules/@anthropic-ai");
  for (const name of await fs.readdir(claudeDir)) if (name !== "claude-code") await fs.rm(path.join(claudeDir, name), { recursive: true, force: true });
  await fs.rm(path.join(stage, "node_modules/@napi-rs"), { recursive: true, force: true });
  for (const name of ["@anthropic-ai/claude-code", "pdfjs-dist"]) {
    const filename = path.join(stage, "node_modules", name, "package.json");
    const pkg = JSON.parse(await fs.readFile(filename, "utf8"));
    delete pkg.optionalDependencies; delete pkg.scripts;
    await fs.writeFile(filename, JSON.stringify(pkg, null, 2) + "\n");
  }
  await prune(path.join(stage, "node_modules"));
  await keepPackageFiles(stage, "@anthropic-ai/claude-code", ["package.json", "bin/claude.exe"]);
  await keepPackageFiles(stage, "pdfjs-dist", ["package.json", "build/pdf.mjs", "build/pdf.worker.mjs", "cmaps/", "wasm/", "standard_fonts/"]);
  await keepPackageFiles(stage, "exceljs", ["package.json", "excel.js", "lib/"]);
  await keepPackageFiles(stage, "sql.js", ["package.json", "dist/sql-wasm.js", "dist/sql-wasm.wasm"]);
  await keepPackageFiles(stage, "xlsx", ["package.json", "xlsx.js", "dist/cpexcel.js"]);
  await keepPackageFiles(stage, "jszip", ["package.json", "lib/"]);
  const shipped = { name: source.name, version: source.version, description: "ARMa local claims workspace", private: true, license: source.license, author: "ajbarryiii", main: source.main, dependencies: source.dependencies };
  await fs.writeFile(path.join(stage, "package.json"), JSON.stringify(shipped, null, 2) + "\n");
  await fs.unlink(path.join(stage, "package-lock.json"));
  console.log(`Verified ${(await verifyApplication(stage, { platform: "darwin", arch })).length} staged runtime files. Building macOS ${arch} disk image…`);
  await build({
    projectDir: project, targets: Platform.MAC.createTarget(["dmg"], Arch[arch]), publish: "never",
    config: {
      appId: "com.arma.workspace", productName: "ARMa",
      electronVersion: source.devDependencies.electron,
      directories: { app: stage, output, buildResources: path.join(project, "build") },
      // Workers and the stdio adapters execute real paths using Electron's Node mode.
      asar: false, npmRebuild: false,
      files: ["**/*", "!**/*.{map,ts,tsbuildinfo}"],
      disableDefaultIgnoredFiles: true,
      electronLanguages: ["en-US"],
      artifactName: "ARMa-${version}-mac-${arch}-test.${ext}",
      mac: { target: ["dmg"], identity: "-", hardenedRuntime: false,
        notarize: false, category: "public.app-category.productivity",
        signIgnore: ["node_modules/@anthropic-ai/claude-code/bin/claude\\.exe$"] },
      dmg: { sign: false },
      afterPack: async context => {
        // Claude's wrapper names its Mach-O binary .exe; the Mac packager
        // filters that suffix even with default ignored files disabled.
        const native = path.join(context.appOutDir, "ARMa.app/Contents/Resources/app", CLAUDE_BINARY);
        await fs.mkdir(path.dirname(native), { recursive: true });
        await fs.copyFile(path.join(stage, CLAUDE_BINARY), native);
        await fs.chmod(native, 0o755);
        await verifyApplication(path.join(context.appOutDir, "ARMa.app/Contents/Resources/app"), { platform: "darwin", arch });
      },
    },
  });
  await require("./verify-mac.cjs").verify(output, arch);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
