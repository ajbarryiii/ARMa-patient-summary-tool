"use strict";
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function prepareNotifications(electronBinary, {
  platform = process.platform,
  run = execFileSync,
} = {}) {
  if (platform !== "darwin") return;
  const bundle = path.resolve(electronBinary, "../../..");
  try {
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
      stdio: "pipe",
    });
    return;
  } catch {}
  // Electron's downloaded development bundle has only a linker signature.
  // macOS UNNotification needs a signed bundle. Ad-hoc signing is sufficient
  // for local runs and uses no certificates, keychain changes, or paid account.
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], {
    stdio: "pipe",
  });
}

module.exports = { prepareNotifications };
