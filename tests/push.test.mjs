import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Push, validateSubscription } from "../lib/push.mjs";
function subscription(host = "fcm.googleapis.com") {
  const ec = crypto.createECDH("prime256v1");
  ec.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/test-device`,
    keys: {
      p256dh: ec.getPublicKey().toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url"),
    },
  };
}
function fixture(t, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-push-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return {
    dir,
    push: new Push({ dir, origin: "https://pulse.example.com", send }),
  };
}
test("only valid subscriptions on known HTTPS browser push services are accepted", () => {
  assert.ok(validateSubscription(subscription()));
  for (const host of [
    "127.0.0.1",
    "169.254.169.254",
    "evil.example",
    "fcm.googleapis.com.evil.example",
  ])
    assert.throws(() => validateSubscription(subscription(host)), {
      status: 400,
    });
  for (const endpoint of [
    "http://fcm.googleapis.com/send/test",
    "https://user@fcm.googleapis.com/test",
    "https://fcm.googleapis.com:8443/test",
  ])
    assert.throws(() => validateSubscription({ ...subscription(), endpoint }), {
      status: 400,
    });
  assert.throws(
    () =>
      validateSubscription({
        ...subscription(),
        keys: { p256dh: "bad", auth: "bad" },
      }),
    { status: 400 },
  );
});
test("VAPID keys and devices persist; notifications contain no private request content", async (t) => {
  const sent = [];
  const f = fixture(t, async (sub, payload, options) => {
    sent.push({ sub, payload: JSON.parse(payload), options });
  });
  const sub = subscription();
  f.push.subscribe(sub);
  const result = await f.push.notify({
    id: "req-123",
    provider: "claude",
    title: "SECRET COMMAND",
    detail: "SECRET PATH",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0].payload).includes("SECRET"));
  assert.equal(sent[0].payload.requestId, "req-123");
  assert.ok(sent[0].options.TTL <= 60);
  assert.equal(sent[0].options.urgency, "high");
  const restarted = new Push({
    dir: f.dir,
    origin: "https://pulse.example.com",
  });
  assert.equal(restarted.publicKey, f.push.publicKey);
  assert.equal(restarted.has(sub.endpoint), true);
  assert.equal(fs.statSync(path.join(f.dir, "push.json")).mode & 0o777, 0o600);
});
test("expired subscriptions are removed; delivery failures are reported without throwing", async (t) => {
  const f = fixture(t, async () => {
    throw Object.assign(new Error("private endpoint must not leak"), {
      statusCode: 410,
    });
  });
  const sub = subscription();
  f.push.subscribe(sub);
  const result = await f.push.notify({
    id: "x",
    provider: "codex",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.equal(f.push.has(sub.endpoint), false);
});
test("tests target one subscribed device and disabling removes it", async (t) => {
  let sends = 0;
  const f = fixture(t, async () => {
    sends++;
  });
  const sub = subscription();
  await assert.rejects(f.push.test(sub.endpoint), { status: 404 });
  f.push.subscribe(sub);
  await f.push.test(sub.endpoint);
  assert.equal(sends, 1);
  f.push.unsubscribe(sub.endpoint);
  assert.equal(f.push.has(sub.endpoint), false);
});
test("expired requests do not trigger notifications", async (t) => {
  let sends = 0;
  const f = fixture(t, async () => {
    sends++;
  });
  f.push.subscribe(subscription());
  await f.push.notify({
    id: "x",
    provider: "claude",
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal(sends, 0);
});
