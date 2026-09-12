import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as OTPAuth from "otpauth";
import { Auth } from "../lib/auth.mjs";

const oldPassword = "old-synthetic-test-password";
const newPassword = "new-synthetic-test-password";
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reset-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1800000000000;
  const options = { dir, origin: "https://pulse.example.com", bootstrapToken: "bootstrap-test", now: () => now };
  const auth = new Auth(options);
  const enrollment = await auth.beginSetup({ token: "bootstrap-test", email: "owner@example.com", password: oldPassword });
  const code = () => OTPAuth.URI.parse(enrollment.uri).generate({ timestamp: now });
  const account = auth.confirmSetup({ enrollment: enrollment.enrollment, code: code() });
  now += 30000;
  return { dir, auth, account, code, options, advance: ms => { now += ms; }, body: { email: "owner@example.com", password: newPassword, confirmPassword: newPassword } };
}

test("password reset requires both an unused recovery code and fresh TOTP", async t => {
  const f = await fixture(t);
  assert.equal(typeof f.auth.resetPassword, "function");
  for (const proof of [{}, { recoveryCode: f.account.recoveryCodes[0] }, { code: f.code() }, { recoveryCode: f.account.recoveryCodes[0], code: "invalid" }]) {
    await assert.rejects(f.auth.resetPassword({ ...f.body, ...proof }), { status: 401 });
  }
  const cookie = { headers: { cookie: f.account.cookie.split(";")[0] } };
  const secret = f.auth.owner.secret;
  const result = await f.auth.resetPassword({ ...f.body, recoveryCode: f.account.recoveryCodes[0], code: f.code() });
  assert.deepEqual(result, { ok: true });
  assert.equal(f.auth.session(cookie), null);
  assert.equal(new Auth(f.options).session(cookie), null, "revocation must survive restart");
  assert.equal(f.auth.owner.secret, secret);
  assert.equal(f.auth.owner.recoveryHashes.length, 7);
  await assert.rejects(f.auth.login({ email: f.body.email, password: oldPassword, code: f.account.recoveryCodes[1] }), { status: 401 });
  await assert.rejects(f.auth.login({ email: f.body.email, password: newPassword, code: f.code() }), { status: 401 });
  f.advance(30000);
  await f.auth.login({ email: f.body.email, password: newPassword, code: f.code() });
  f.advance(30000);
  await assert.rejects(f.auth.resetPassword({ ...f.body, recoveryCode: f.account.recoveryCodes[0], code: f.code() }), { status: 401 });
});

test("administrator reset codes are hashed, expire, replace older codes and work once across restart", async t => {
  const f = await fixture(t);
  assert.equal(typeof f.auth.issuePasswordReset, "function");
  const first = f.auth.issuePasswordReset();
  const second = f.auth.issuePasswordReset();
  assert.ok(!fs.readFileSync(path.join(f.dir, "password-reset.json"), "utf8").includes(second.token));
  assert.equal(fs.statSync(path.join(f.dir, "password-reset.json")).mode & 0o777, 0o600);
  await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: first.token }), { status: 401 });
  await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: second.token, email: "someone@example.com" }), { status: 401 });
  f.advance(16 * 60 * 1000);
  await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: second.token }), { status: 401 });
  const fresh = f.auth.issuePasswordReset();
  const restarted = new Auth(f.options);
  await restarted.resetPassword({ ...f.body, resetToken: fresh.token });
  await assert.rejects(new Auth(f.options).resetPassword({ ...f.body, resetToken: fresh.token }), { status: 401 });
  await restarted.login({ email: f.body.email, password: newPassword, code: f.code() });
});

test("bad passwords do not consume reset proof; concurrent resets cannot reuse it", async t => {
  const f = await fixture(t);
  assert.equal(typeof f.auth.issuePasswordReset, "function");
  const { token } = f.auth.issuePasswordReset();
  for (const change of [{ password: "short", confirmPassword: "short" }, { confirmPassword: "different" }]) {
    await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: token, ...change }), { status: 400 });
  }
  const results = await Promise.allSettled([
    f.auth.resetPassword({ ...f.body, resetToken: token }),
    f.auth.resetPassword({ ...f.body, resetToken: token }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && r.reason.status === 401).length, 1);
});

test("reset attempts are rate limited and bootstrap/bridge credentials cannot reset a password", async t => {
  const f = await fixture(t);
  assert.equal(typeof f.auth.resetPassword, "function");
  await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: "bootstrap-test" }), { status: 401 });
  f.advance(6 * 60 * 1000);
  for (let i = 0; i < 20; i++) await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: "invalid" }), { status: 401 });
  await assert.rejects(f.auth.resetPassword({ ...f.body, resetToken: "invalid" }), { status: 429 });
});
