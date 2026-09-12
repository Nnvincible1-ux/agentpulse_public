import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as OTPAuth from "otpauth";

const exec = promisify(execFile);
test("administrator reset works through the API, retains MFA, and revokes the old session", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reset-api-"));
  const base = `http://127.0.0.1:${23000 + Math.floor(Math.random() * 3000)}`;
  const env = { ...process.env, NODE_ENV: "test", PORT: new URL(base).port, AGENTPULSE_PUBLIC_ORIGIN: base, AGENTPULSE_DATA_DIR: dir, AGENTPULSE_BRIDGE_TOKEN: "test-bridge", AGENTPULSE_MOBILE_TOKEN: "test-setup" };
  const child = spawn(process.execPath, ["server.mjs"], { env, stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/healthz")).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, "isolated server started");
  const post = (route, body, origin = base) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body) });
  const start = await post("/api/auth/setup", { token: "test-setup", email: "owner@example.com", password: "old-synthetic-password" });
  const enrollment = await start.json();
  const confirm = await post("/api/auth/confirm", { enrollment: enrollment.enrollment, code: OTPAuth.URI.parse(enrollment.uri).generate() });
  const cookie = confirm.headers.get("set-cookie").split(";")[0];
  const account = await confirm.json();
  const generated = await exec(process.execPath, ["scripts/create-password-reset.mjs"], { env });
  const token = generated.stdout.trim().split("\n").at(-1);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const body = { email: "owner@example.com", resetToken: token, password: "new-synthetic-password", confirmPassword: "new-synthetic-password" };
  assert.equal((await post("/api/auth/reset-password", body, "https://foreign.example")).status, 403);
  const response = await post("/api/auth/reset-password", body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await fetch(base + "/api/mobile/requests", { headers: { cookie } })).status, 401);
  assert.equal((await post("/api/auth/reset-password", body)).status, 401);
  assert.equal((await post("/api/auth/login", { email: body.email, password: body.password })).status, 401);
  assert.equal((await post("/api/auth/login", { email: body.email, password: body.password, code: account.recoveryCodes[0] })).status, 200);
});
