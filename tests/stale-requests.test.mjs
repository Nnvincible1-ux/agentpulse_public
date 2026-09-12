import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as OTPAuth from "otpauth";

test("orphaned terminal requests are discarded and cannot reconnect", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-stale-request-"));
  const port = 25000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  const bridge = "synthetic-bridge-token";
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    AGENTPULSE_PUBLIC_ORIGIN: base,
    AGENTPULSE_DATA_DIR: dir,
    AGENTPULSE_BRIDGE_TOKEN: bridge,
    AGENTPULSE_MOBILE_TOKEN: "synthetic-owner-token",
  };
  let child;
  async function start() {
    child = spawn(process.execPath, ["server.mjs"], { env, stdio: "ignore" });
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        if ((await fetch(base + "/healthz")).ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("isolated server did not start");
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await start();
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const setup = await post("/api/auth/setup", {
    token: "synthetic-owner-token",
    email: "owner@example.com",
    password: "synthetic-owner-password",
  });
  const enrollment = await setup.json();
  const confirm = await post("/api/auth/confirm", {
    enrollment: enrollment.enrollment,
    code: OTPAuth.URI.parse(enrollment.uri).generate(),
  });
  const cookie = confirm.headers.get("set-cookie").split(";")[0];
  const created = await post("/api/bridge/requests", {
    requestId: "orphaned-bash",
    provider: "claude",
    kind: "permission",
    project: "chunk-retry",
    title: "Bash",
    detail: "git status",
    canApprove: true,
    lease: true,
    continuous: true,
    sessionId: "native-session",
    machineId: "synthetic-mac",
  }, { authorization: `Bearer ${bridge}` });
  assert.equal(created.status, 201);

  await stop();
  await start();
  const mobileHeaders = { cookie };
  let listed = await (await fetch(base + "/api/mobile/requests", { headers: mobileHeaders })).json();
  assert.equal(listed.requests.some(request => request.id === "orphaned-bash"), false);

  const reconnected = await fetch(base + "/api/bridge/requests/orphaned-bash/verdict", {
    headers: { authorization: `Bearer ${bridge}` },
  });
  assert.equal(reconnected.status, 404);
  listed = await (await fetch(base + "/api/mobile/requests", { headers: mobileHeaders })).json();
  assert.equal(listed.requests.some(request => request.id === "orphaned-bash"), false);
});
