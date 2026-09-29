"use strict";

// Main-process only: never put prompts, responses, paths, or provider errors in
// an OS notification, where they may be visible on the lock screen.
class QueryNotifications {
  constructor({ Notification, getWindow }) {
    this.Notification = Notification;
    this.getWindow = getWindow;
    this.latest = null;
  }

  forQuery(provider) {
    let finished = false;
    return (event) => {
      if (finished || event.type !== "done") return;
      finished = true;
      if (event.cancelled) return;
      const name = provider === "codex" ? "Codex" : "Claude";
      this.show(event.failed
        ? `${name} query failed. Open ARMa for details.`
        : `${name} query complete. Your response is ready.`);
    };
  }

  show(body) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      if (!this.Notification.isSupported()) return;
      this.clear();
      const notification = new this.Notification({ title: "ARMa", body });
      // Keep the latest notification alive for clicks from Notification Center
      // or Action Center, including after Windows times out its banner.
      this.latest = notification;
      notification.once("click", () => {
        const target = this.getWindow();
        if (!target || target.isDestroyed()) return;
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      });
      notification.once("failed", () => {
        if (this.latest === notification) this.latest = null;
      });
      notification.show();
    } catch {
      // Notification support/permissions must never interrupt query completion.
      this.clear();
    }
  }

  clear() {
    const notification = this.latest;
    this.latest = null;
    try {
      notification?.close();
    } catch {}
  }
}

function configureNotifications(app, platform = process.platform) {
  if (platform !== "win32") return;
  // Electron 44 registers the per-user Start Menu shortcut and toast activator.
  // Set an application identity before the first notification is created.
  app.setAppUserModelId("com.arma.workspace");
  app.setToastActivatorCLSID("{A1720939-0AA6-4B17-8B52-DC4B62712D53}");
}

module.exports = { QueryNotifications, configureNotifications };
