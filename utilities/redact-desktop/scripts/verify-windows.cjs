"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { verifyApplication, peMachine } = require("./windows-package.cjs");
async function verify(output = path.resolve(__dirname, "../dist")) {
  const app = path.join(output, "win-unpacked");
  const files = await verifyApplication(path.join(app, "resources/app"));
  if (await peMachine(path.join(app, "ARMa.exe")) !== 0x8664) throw new Error("ARMa is not Windows x64.");
  await fs.access(path.join(app, "Windows test guide.txt"));
  if (await fs.stat(path.join(app, "Sign in to Claude.cmd")).then(() => true, () => false))
    throw new Error("Obsolete terminal sign-in helper in package.");
  const { version } = JSON.parse(await fs.readFile(path.join(app, "resources/app/package.json"), "utf8"));
  const installer = `ARMa-${version}-windows-x64-test-setup.exe`;
  await peMachine(path.join(output, installer));
  const bytes = await fs.readFile(path.join(output, installer));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(output, installer + ".sha256"), `${sha256}  ${installer}\n`);
  await fs.writeFile(path.join(output, "windows-package-manifest.json"), JSON.stringify({
    version, platform: "win32", arch: "x64", signed: false,
    installer: { file: installer, bytes: bytes.length, sha256 }, files,
  }, null, 2) + "\n");
  console.log(`Verified ${files.length} runtime files; tests, Codex, build tools and private workspaces excluded.`);
  console.log(`${installer}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB\nSHA-256: ${sha256}`);
}
if (require.main === module) verify().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
