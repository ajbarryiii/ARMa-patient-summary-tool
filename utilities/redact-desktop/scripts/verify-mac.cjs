"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { verifyApplication, verifyNativeBinary } = require("./windows-package.cjs");
async function verify(output = path.resolve(__dirname, "../dist"), arch = "arm64") {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported Mac architecture.");
  const app = path.join(output, arch === "arm64" ? "mac-arm64/ARMa.app" : "mac/ARMa.app");
  const target = { platform: "darwin", arch };
  const files = await verifyApplication(path.join(app, "Contents/Resources/app"), target);
  await verifyNativeBinary(path.join(app, "Contents/MacOS/ARMa"), target);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {stdio:"pipe"});
  const { version } = JSON.parse(await fs.readFile(path.join(app, "Contents/Resources/app/package.json"), "utf8"));
  const installer = `ARMa-${version}-mac-${arch}-test.dmg`;
  execFileSync("/usr/bin/hdiutil", ["verify", path.join(output, installer)], {stdio:"pipe"});
  const bytes = await fs.readFile(path.join(output, installer));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(output, installer + ".sha256"), `${sha256}  ${installer}\n`);
  await fs.writeFile(path.join(output, `mac-${arch}-package-manifest.json`), JSON.stringify({
    version, ...target, signing: "ad-hoc", notarized: false,
    installer: { file: installer, bytes: bytes.length, sha256 }, files,
  }, null, 2) + "\n");
  console.log(`Verified ${files.length} runtime files and ad-hoc signature. ${installer}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB\nSHA-256: ${sha256}`);
}
if (require.main === module) verify(undefined, process.argv.includes("--x64") ? "x64" : "arm64").catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
