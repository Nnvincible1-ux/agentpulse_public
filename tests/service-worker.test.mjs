import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
function fixture(clients = {}) {
  const handlers = {},
    shown = [],
    opened = [];
  const self = {
    location: { origin: "https://pulse.example.com" },
    addEventListener: (n, f) => (handlers[n] = f),
    skipWaiting: async () => {},
    registration: {
      showNotification: async (title, options) =>
        shown.push({ title, options }),
      getNotifications: async () => [],
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async (url) => {
        opened.push(url);
        return { focus: async () => {} };
      },
      ...clients,
    },
  };
  vm.runInNewContext(
    fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { self, URL, Date, encodeURIComponent },
  );
  return { handlers, shown, opened };
}
test("push displays a generic alert and stores only a safe app destination", async () => {
  const f = fixture();
  let done;
  assert.equal(typeof f.handlers.push, "function");
  f.handlers.push({
    data: {
      json: () => ({
        title: "Claude Code needs you",
        body: "Open AgentPulse to review and respond.",
        requestId: "x",
        url: "https://evil.example",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    },
    waitUntil: (p) => (done = p),
  });
  await done;
  assert.equal(f.shown.length, 1);
  assert.equal(
    f.shown[0].options.data.url,
    "https://pulse.example.com/?request=x",
  );
  assert.equal(f.shown[0].options.actions, undefined);
});

test("session updates open the terminal overview and never put response text in notifications", async () => {
  const f = fixture();
  let done;
  f.handlers.push({ data: { json: () => ({ type: "session", sessionId: "session-1", title: "Claude Code has an update", body: "private status text", expiresAt: new Date(Date.now() + 60000).toISOString() }) }, waitUntil: p => { done = p; } });
  await done;
  assert.equal(f.shown[0].options.data.url, "https://pulse.example.com/?view=sessions&session=session-1");
  assert.equal(f.shown[0].title, "Claude Code has an update");
  assert.ok(!JSON.stringify(f.shown).includes("private status text"));
});

async function click(f, url = "https://pulse.example.com/?request=blue-green") {
  let done;
  f.handlers.notificationclick({
    notification: { close() {}, data: { url } },
    waitUntil: (promise) => (done = promise),
  });
  await done;
}

test("notification clicks let the browser launch the installed app even when a Chrome tab exists", async () => {
  let focused = false;
  const opened = [];
  const f = fixture({
    matchAll: async () => [{ url: "https://pulse.example.com/", navigate() { throw new Error("must not prefer a browser tab"); } }],
    openWindow: async (url) => { opened.push(url); return { focus: async () => { focused = true; } }; },
  });
  await click(f);
  assert.deepEqual(opened, ["https://pulse.example.com/?request=blue-green"]);
  assert.equal(focused, true);
});

test("failed app launch falls back to a navigated client and focuses the returned handle", async () => {
  let focused = false;
  const f = fixture({
    openWindow: async () => { throw new Error("launch failed"); },
    matchAll: async () => [{
      url: "https://pulse.example.com/",
      navigate: async (url) => {
        assert.equal(url, "https://pulse.example.com/?request=blue-green");
        return { focus: async () => { focused = true; } };
      },
      focus() { throw new Error("stale handle"); },
    }],
  });
  await click(f);
  assert.equal(focused, true);
});

test("a closed client does not stop fallback to another app window", async () => {
  let focused = false;
  const f = fixture({
    openWindow: async () => null,
    matchAll: async () => [
      { url: "https://pulse.example.com/", navigate: async () => { throw new Error("closed"); } },
      { url: "https://pulse.example.com/", navigate: async () => ({ focus: async () => { focused = true; } }) },
    ],
  });
  await click(f);
  assert.equal(focused, true);
});

test("Android notification badge has a transparent background and visible foreground", async () => {
  const f = fixture();
  let done;
  f.handlers.push({ data: { json: () => ({}) }, waitUntil: (promise) => (done = promise) });
  await done;
  const badge = fs.readFileSync(new URL("../public" + f.shown[0].options.badge, import.meta.url));
  assert.equal(badge[25], 6, "badge must be RGBA, not an opaque app icon");
  const width = badge.readUInt32BE(16), height = badge.readUInt32BE(20);
  const chunks = [];
  for (let offset = 8; offset < badge.length;) {
    const length = badge.readUInt32BE(offset);
    if (badge.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(badge.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  let clear = 0, opaque = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    assert.equal(pixels[row], 0);
    for (let x = 0; x < width; x++) {
      const alpha = pixels[row + 1 + x * 4 + 3];
      if (alpha === 0) clear++;
      if (alpha === 255) opaque++;
    }
  }
  assert.ok(clear > width * height * 0.3);
  assert.ok(opaque > width * height * 0.15);
});
test("notification clicks cannot navigate to a foreign origin", async () => {
  const f = fixture();
  let done;
  assert.equal(typeof f.handlers.notificationclick, "function");
  f.handlers.notificationclick({
    notification: { close() {}, data: { url: "https://evil.example" } },
    waitUntil: (p) => (done = p),
  });
  await done;
  assert.equal(f.opened[0], "https://pulse.example.com/");
});
