const { spawn } = require("node:child_process");
const path = require("node:path");
const { prepareNotifications } = require("./prepare-notifications.cjs");
const electronBinary = require("electron");
try {
  prepareNotifications(electronBinary);
} catch {
  console.warn("Desktop notifications need a signed Electron bundle. Check macOS codesign availability and reinstall dependencies if needed.");
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronBinary,
  [path.join(__dirname, ".."), ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
