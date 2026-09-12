import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as OTPAuth from "otpauth";
import { Auth } from "../lib/auth.mjs";

const password = "synthetic-password-for-tests-only";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1800000000000;
  const auth = new Auth({
    dir,
    origin: "https://pulse.example.com",
    bootstrapToken: "test-owner-token",
    now: () => now,
  });
  return {
    dir,
    auth,
    now: () => now,
    advance(ms) {
      now += ms;
    },
    otp(secret) {
      return OTPAuth.URI.parse(secret).generate({ timestamp: now });
    },
  };
}
async function enroll(f) {
  const pending = await f.auth.beginSetup({
    token: "test-owner-token",
    email: "Owner@example.com",
    password,
  });
  assert.match(pending.qr, /^data:image\/png;base64,/);
  const result = f.auth.confirmSetup({
    enrollment: pending.enrollment,
    code: f.otp(pending.uri),
  });
  return { ...result, uri: pending.uri };
}
test("only bootstrap owner can enroll and only after TOTP proof", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.auth.beginSetup({ token: "bad", email: "owner@example.com", password }),
    { status: 401 },
  );
  const p = await f.auth.beginSetup({
    token: "test-owner-token",
    email: "owner@example.com",
    password,
  });
  assert.equal(f.auth.configured, false);
  assert.throws(
    () => f.auth.confirmSetup({ enrollment: p.enrollment, code: "invalid" }),
    { status: 401 },
  );
  const result = f.auth.confirmSetup({
    enrollment: p.enrollment,
    code: f.otp(p.uri),
  });
  assert.equal(f.auth.configured, true);
  assert.equal(result.recoveryCodes.length, 8);
  await assert.rejects(
    f.auth.beginSetup({
      token: "test-owner-token",
      email: "x@example.com",
      password,
    }),
    { status: 409 },
  );
  assert.equal(fs.statSync(path.join(f.dir, "owner.json")).mode & 0o777, 0o600);
  const disk = fs.readFileSync(path.join(f.dir, "owner.json"), "utf8");
  assert.ok(!disk.includes(password));
  assert.ok(!disk.includes(result.recoveryCodes[0]));
});
test("password plus fresh TOTP required; codes cannot replay", async (t) => {
  const f = fixture(t),
    owner = await enroll(f);
  await assert.rejects(
    f.auth.login({
      email: "owner@example.com",
      password,
      code: f.otp(owner.uri),
    }),
    { status: 401 },
  );
  f.advance(30000);
  await assert.rejects(
    f.auth.login({
      email: "owner@example.com",
      password: "wrong",
      code: f.otp(owner.uri),
    }),
    { status: 401 },
  );
  await assert.rejects(
    f.auth.login({
      email: "other@example.com",
      password,
      code: f.otp(owner.uri),
    }),
    { status: 401 },
  );
  const login = await f.auth.login({
    email: "OWNER@example.com",
    password,
    code: f.otp(owner.uri),
  });
  assert.match(login.cookie, /__Host-agentpulse=/);
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /Secure/);
  assert.match(login.cookie, /SameSite=Strict/);
  assert.match(login.cookie, /Max-Age=2592000/);
  const req = { headers: { cookie: login.cookie.split(";")[0] } };
  assert.ok(f.auth.session(req));
  await assert.rejects(
    f.auth.login({
      email: "owner@example.com",
      password,
      code: f.otp(owner.uri),
    }),
    { status: 401 },
  );
  f.advance(31 * 24 * 60 * 60 * 1000);
  assert.equal(f.auth.session(req), null);
});
test("a remembered mobile session survives restart and expires after 30 days", async (t) => {
  const f = fixture(t), owner = await enroll(f);
  const cookie = owner.cookie.split(";")[0];
  const token = cookie.split("=")[1];
  const req = { headers: { cookie } };
  const original = f.auth.session(req);
  f.auth.attachPushEndpoint(original, "https://fcm.googleapis.com/fcm/send/synthetic");

  f.advance(29 * 24 * 60 * 60 * 1000);
  const restarted = new Auth({
    dir: f.dir,
    origin: "https://pulse.example.com",
    bootstrapToken: "test-owner-token",
    now: f.now,
  });
  const restored = restarted.session(req);
  assert.ok(restored);
  assert.equal(restored.csrf, owner.csrf);
  assert.equal(restored.pushEndpoint, "https://fcm.googleapis.com/fcm/send/synthetic");
  const disk = fs.readFileSync(path.join(f.dir, "auth-sessions.json"), "utf8");
  assert.equal(disk.includes(token), false, "raw bearer cookie must never be stored");
  assert.equal(fs.statSync(path.join(f.dir, "auth-sessions.json")).mode & 0o777, 0o600);

  f.advance(2 * 24 * 60 * 60 * 1000);
  assert.equal(restarted.session(req), null);
});
test("logout revocation survives restart", async (t) => {
  const f = fixture(t), owner = await enroll(f);
  const req = { headers: { cookie: owner.cookie.split(";")[0] } };
  const restarted = new Auth({
    dir: f.dir,
    origin: "https://pulse.example.com",
    bootstrapToken: "test-owner-token",
    now: f.now,
  });
  assert.ok(restarted.session(req));
  restarted.logout(req);
  const afterLogout = new Auth({
    dir: f.dir,
    origin: "https://pulse.example.com",
    bootstrapToken: "test-owner-token",
    now: f.now,
  });
  assert.equal(afterLogout.session(req), null);
});
test("recovery code requires password, works once and survives restart", async (t) => {
  const f = fixture(t),
    owner = await enroll(f);
  const code = owner.recoveryCodes[0];
  await assert.rejects(
    f.auth.login({ email: "owner@example.com", password: "wrong", code }),
    { status: 401 },
  );
  await f.auth.login({ email: "owner@example.com", password, code });
  const restarted = new Auth({
    dir: f.dir,
    origin: "https://pulse.example.com",
    bootstrapToken: "test-owner-token",
  });
  await assert.rejects(
    restarted.login({ email: "owner@example.com", password, code }),
    { status: 401 },
  );
  await restarted.login({
    email: "owner@example.com",
    password,
    code: owner.recoveryCodes[1],
  });
});
test("session mutation needs matching origin and csrf; logout revokes session", async (t) => {
  const f = fixture(t),
    owner = await enroll(f);
  const req = {
    headers: {
      cookie: owner.cookie.split(";")[0],
      origin: "https://pulse.example.com",
      "x-csrf-token": owner.csrf,
    },
  };
  const session = f.auth.session(req);
  assert.doesNotThrow(() => f.auth.checkMutation(req, session));
  assert.throws(
    () =>
      f.auth.checkMutation(
        { headers: { ...req.headers, origin: "https://evil.example" } },
        session,
      ),
    { status: 403 },
  );
  assert.throws(
    () =>
      f.auth.checkMutation(
        { headers: { ...req.headers, "x-csrf-token": "bad" } },
        session,
      ),
    { status: 403 },
  );
  f.auth.logout(req);
  assert.equal(f.auth.session(req), null);
});
test("enrollment expires and authentication attempts are bounded", async (t) => {
  const f = fixture(t);
  const pending = await f.auth.beginSetup({
    token: "test-owner-token",
    email: "owner@example.com",
    password,
  });
  f.advance(11 * 60 * 1000);
  assert.throws(
    () =>
      f.auth.confirmSetup({
        enrollment: pending.enrollment,
        code: f.otp(pending.uri),
      }),
    { status: 401 },
  );
  for (let i = 0; i < 20; i++)
    await f.auth
      .login({ email: "x", password: "wrong", code: "bad" })
      .catch(() => {});
  await assert.rejects(
    f.auth.login({ email: "x", password: "wrong", code: "bad" }),
    { status: 429 },
  );
});
test("corrupt owner data fails closed instead of opening enrollment", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "owner.json"), "{bad");
  assert.throws(
    () =>
      new Auth({
        dir: f.dir,
        origin: "https://pulse.example.com",
        bootstrapToken: "test-owner-token",
      }),
  );
});
