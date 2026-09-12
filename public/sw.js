self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
// No fetch handler: private inbox responses and credentials are never cached offline.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {}
  const expired = Date.parse(payload.expiresAt) <= Date.now();
  const requestId =
    typeof payload.requestId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId)
      ? payload.requestId
      : null;
  const sessionId = payload.type === "session" && typeof payload.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(payload.sessionId) ? payload.sessionId : null;
  const url =
    self.location.origin +
    "/" +
    (sessionId ? "?view=sessions&session=" + encodeURIComponent(sessionId) : requestId && !expired ? "?request=" + encodeURIComponent(requestId) : "");
  const title = expired
    ? (sessionId ? "AgentPulse session update" : "AgentPulse request expired")
    : sessionId ? (payload.title === "Claude Code has an update" ? "Claude Code has an update" : "Codex has an update")
    : payload.title === "Claude Code needs you"
      ? "Claude Code needs you"
      : payload.title === "Codex needs you"
        ? "Codex needs you"
        : "AgentPulse";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: sessionId ? "Open AgentPulse to read the latest response."
        : expired
        ? "Continue on your computer."
        : requestId
          ? "Open AgentPulse to review and respond."
          : "Notifications are connected. You can close the app and still receive alerts.",
      icon: "/icon-192.png",
      badge: "/notification-badge-96.png",
      tag: sessionId ? "session-" + sessionId : requestId || "agentpulse-test",
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL("/", self.location.origin);
  try {
    const candidate = new URL(
      event.notification.data?.url,
      self.location.origin,
    );
    if (candidate.origin === self.location.origin && candidate.pathname === "/")
      url = candidate;
  } catch {}
  event.waitUntil(
    (async () => {
      // Let Chrome route the URL to the installed PWA before choosing a tab.
      // Opening directly also avoids waiting for a stale client to navigate.
      try {
        const opened = await self.clients.openWindow(url.href);
        if (opened) {
          await opened.focus();
          return;
        }
      } catch {}
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        try {
          if (new URL(client.url).origin !== self.location.origin) continue;
          const navigated = await client.navigate(url.href);
          await (navigated || client).focus();
          return;
        } catch {
          // A client may close between enumeration and navigation; try the next.
        }
      }
    })(),
  );
});
