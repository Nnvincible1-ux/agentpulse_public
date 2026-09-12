import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as OTPAuth from "otpauth";

test("session snapshots require a bridge token and are readable only after owner login", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-sessions-api-"));
  const base = `http://127.0.0.1:${31000 + Math.floor(Math.random() * 2000)}`;
  const child = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, NODE_ENV: "test", PORT: new URL(base).port, AGENTPULSE_PUBLIC_ORIGIN: base, AGENTPULSE_DATA_DIR: dir, AGENTPULSE_BRIDGE_TOKEN: "test-bridge", AGENTPULSE_MOBILE_TOKEN: "test-setup" }, stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(r => child.once("exit", r)); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/healthz")).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ready);
  const post = (url, body, headers = {}) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });
  const now=Date.now();
  const snapshot = { machineId: "synthetic-mac", machineName: "Synthetic Mac", sessions: [{ id: "synthetic-session", provider: "claude", project: "sample", cwd: "/tmp/sample", tty: "ttys001", pid: 123, status: "working", activity: "Bash", summary: "Latest synthetic response", eventId: "", turnStartedAt:now-1000, updatedAt: now }] };
  assert.equal((await post("/api/bridge/sessions", snapshot)).status, 401);
  assert.equal((await post("/api/bridge/sessions", snapshot, { authorization: "Bearer test-bridge" })).status, 200);
  assert.equal((await fetch(base + "/api/mobile/sessions", { headers: { authorization: "Bearer test-bridge" } })).status, 401);
  const pending = await (await post("/api/auth/setup", { email: "owner@example.com", password: "synthetic-test-password", token: "test-setup" })).json();
  const confirm = await post("/api/auth/confirm", { enrollment: pending.enrollment, code: OTPAuth.URI.parse(pending.uri).generate() });
  const response = await fetch(base + "/api/mobile/sessions", { headers: { cookie: confirm.headers.get("set-cookie").split(";")[0] } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.sessions[0].project, "sample");
  assert.equal(data.sessions[0].summary, "Latest synthetic response");
  assert.equal(data.sessions[0].online, true);
  assert.equal(data.sessions[0].turnStartedAt,now-1000);
  const invalid=structuredClone(snapshot);invalid.sessions[0].turnStartedAt=now+1;
  assert.equal((await post("/api/bridge/sessions",invalid,{authorization:"Bearer test-bridge"})).status,400);
});
