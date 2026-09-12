import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";
import { readPrivate, writePrivate, fail } from "./storage.mjs";

function keyBytes(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value))
    throw fail(400, "Invalid notification subscription.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length)
    throw fail(400, "Invalid notification subscription.");
  return bytes;
}
export function validateSubscription(input) {
  try {
    if (typeof input?.endpoint !== "string" || input.endpoint.length > 2048)
      throw new Error();
    const url = new URL(input.endpoint);
    const allowed =
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "web.push.apple.com" ||
      url.hostname === "updates.push.services.mozilla.com" ||
      url.hostname.endsWith(".updates.push.services.mozilla.com");
    if (
      !allowed ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    const p256dh = keyBytes(input.keys?.p256dh, 65),
      auth = keyBytes(input.keys?.auth, 16);
    if (p256dh[0] !== 4) throw new Error();
    crypto.ECDH.convertKey(p256dh, "prime256v1");
    return {
      endpoint: url.href,
      keys: {
        p256dh: p256dh.toString("base64url"),
        auth: auth.toString("base64url"),
      },
    };
  } catch {
    throw fail(
      400,
      "Invalid or unsupported notification subscription. Use Chrome on Android, Firefox, or Safari.",
    );
  }
}
function validData(value) {
  try {
    if (
      value?.version !== 1 ||
      !Array.isArray(value.subscriptions) ||
      value.subscriptions.length > 20
    )
      return false;
    const ec = crypto.createECDH("prime256v1");
    ec.setPrivateKey(keyBytes(value.keys?.privateKey, 32));
    if (!ec.getPublicKey().equals(keyBytes(value.keys?.publicKey, 65)))
      return false;
    value.subscriptions.forEach(validateSubscription);
    return true;
  } catch {
    return false;
  }
}
export class Push {
  constructor({
    dir,
    origin,
    send = (...args) => webpush.sendNotification(...args),
  }) {
    this.file = path.join(dir, "push.json");
    this.origin = origin;
    this.send = send;
    this.data = readPrivate(this.file, validData);
    if (!this.data) {
      this.data = {
        version: 1,
        keys: webpush.generateVAPIDKeys(),
        subscriptions: [],
      };
      this.save();
    }
    this.lastTest = new Map();
  }
  get publicKey() {
    return this.data.keys.publicKey;
  }
  save() {
    writePrivate(this.file, this.data);
  }
  has(endpoint) {
    return this.data.subscriptions.some((s) => s.endpoint === endpoint);
  }
  subscribe(input) {
    const sub = validateSubscription(input);
    const next = this.data.subscriptions.filter(
      (s) => s.endpoint !== sub.endpoint,
    );
    if (next.length >= 20)
      throw fail(
        409,
        "Device limit reached. Disable notifications on an unused device first.",
      );
    this.data.subscriptions = [...next, sub];
    this.save();
  }
  unsubscribe(endpoint) {
    this.data.subscriptions = this.data.subscriptions.filter(
      (s) => s.endpoint !== endpoint,
    );
    this.save();
    this.lastTest.delete(endpoint);
  }
  async publish(subscriptions, payload, ttl) {
    let sent = 0,
      failed = 0;
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await this.send(sub, JSON.stringify(payload), {
            vapidDetails: { subject: this.origin, ...this.data.keys },
            TTL: ttl,
            urgency: "high",
            timeout: 8000,
          });
          sent++;
        } catch (error) {
          failed++;
          if ([404, 410].includes(error.statusCode))
            this.unsubscribe(sub.endpoint);
          // Push errors contain private subscription URLs; never log their raw text.
        }
      }),
    );
    return { sent, failed };
  }
  async notify(item) {
    const ttl = item.continuous ? 300 : Math.min(
      300,
      Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 1000),
    );
    if (!Number.isFinite(ttl) || ttl <= 0) return { sent: 0, failed: 0 };
    return this.publish(
      [...this.data.subscriptions],
      {
        title: `${item.provider === "claude" ? "Claude Code" : "Codex"} needs you`,
        body: "Open AgentPulse to review and respond.",
        requestId: item.id,
        expiresAt: item.expiresAt,
      },
      ttl,
    );
  }
  async notifySession(session) {
    return this.publish([...this.data.subscriptions], {
      type: "session", sessionId: session.id,
      title: `${session.provider === "claude" ? "Claude Code" : "Codex"} has an update`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }, 3600);
  }
  async test(endpoint) {
    const sub = this.data.subscriptions.find((s) => s.endpoint === endpoint);
    if (!sub) throw fail(404, "Enable notifications on this device first.");
    if (Date.now() - (this.lastTest.get(endpoint) || 0) < 15000)
      throw fail(429, "Wait a few seconds before sending another test.");
    this.lastTest.set(endpoint, Date.now());
    return this.publish(
      [sub],
      {
        title: "AgentPulse notifications are connected",
        body: "You can close the app and still receive alerts.",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      60,
    );
  }
}
