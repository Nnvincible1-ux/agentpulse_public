import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../lib/sessions.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-sessions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1800000000000;
  return { dir, store: new Sessions({ dir, now: () => now }), advance: ms => { now += ms; } };
}
const session = { id: "session-1", provider: "claude", project: "example", cwd: "/Users/test/example", tty: "ttys001", pid: 123, status: "working", activity: "Bash", summary: "", eventId: "e1", updatedAt: 1800000000000 };
const snapshot = sessions => ({ machineId: "test-mac", machineName: "Test Mac", sessions });

test("sessions keep independent project status and mark missing heartbeats as offline", t => {
  const f = fixture(t);
  f.store.update(snapshot([session, { ...session, id: "session-2", provider: "codex", status: "waiting" }]));
  assert.equal(f.store.list().length, 2);
  assert.equal(f.store.list()[0].online, true);
  f.advance(91000);
  assert.equal(f.store.list()[0].online, false);
  assert.equal(f.store.list()[0].status, "working");
  f.store.update(snapshot([]));
  assert.equal(f.store.list()[0].status, "closed");
});

test("only new completed responses notify; snapshots do not repeat notifications after restart", t => {
  const f = fixture(t);
  assert.equal(f.store.update(snapshot([session])).length, 0);
  const idle = { ...session, status: "idle", summary: "Implemented A. Remaining: B and C.", eventId: "e2" };
  assert.equal(f.store.update(snapshot([idle])).length, 1);
  assert.equal(f.store.update(snapshot([idle])).length, 0);
  const restarted = new Sessions({ dir: f.dir, now: () => 1800000000000 });
  assert.equal(restarted.update(snapshot([idle])).length, 0);
  assert.equal(restarted.list()[0].summary, idle.summary);
  assert.equal(fs.statSync(path.join(f.dir, "sessions.json")).mode & 0o777, 0o600);
});

test("untracked processes never pretend to have a task status; old data expires", t => {
  const f = fixture(t);
  f.store.update(snapshot([{ ...session, status: "untracked", summary: "" }]));
  assert.equal(f.store.list()[0].status, "untracked");
  f.advance(8 * 86400000);
  assert.deepEqual(f.store.list(), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "sessions.json"), "utf8")).sessions.length, 0);
});

test("invalid snapshots cannot overwrite existing sessions or inject prototype keys", t => {
  const f = fixture(t);
  f.store.update(snapshot([session]));
  for (const body of [snapshot([{ ...session, status: "invented" }]), snapshot([{ ...session, id: "__proto__" }]), snapshot(Array(101).fill(session)), { ...snapshot([session]), machineId: "../other" }]) {
    assert.throws(() => f.store.update(body), { status: 400 });
    assert.equal(f.store.list().length, 1);
  }
});

test("repeated closed snapshots cannot retain old response text indefinitely", t => {
  const f = fixture(t);
  const closed = { ...session, status: "closed", summary: "Old response" };
  f.store.update(snapshot([closed]));
  f.advance(8 * 86400000);
  f.store.update(snapshot([closed]));
  assert.deepEqual(f.store.list(), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "sessions.json"), "utf8")).sessions.length, 0);
});

test('closed sessions are never online even when the Mac still sends heartbeats',t=>{
 const f=fixture(t);f.store.update(snapshot([{...session,status:'closed'}]));
 assert.equal(f.store.list()[0].online,false);
 f.store.update(snapshot([{...session,status:'idle',summary:'Actual reply',summaryAt:1799999999000,summaryTruncated:true}]));
 assert.equal(f.store.list()[0].summaryAt,1799999999000);
 assert.equal(f.store.list()[0].summaryTruncated,true);
});

test("the retention cap drops old closed records before live sessions", t => {
  const f = fixture(t);
  for (let batch = 0; batch < 10; batch++)
    f.store.update(snapshot(Array.from({ length: 100 }, (_, i) => ({ ...session, id: "old-" + (batch * 100 + i), tty: "??", updatedAt: 1800000000000 - (batch * 100 + i) }))));
  f.store.update(snapshot([]));
  assert.equal(f.store.list().filter(s => s.status === "closed").length, 1000);
  f.advance(1000);
  const live = { ...session, id: "live-1", updatedAt: 1800000001000 };
  f.store.update(snapshot([live]));
  const rows = f.store.list();
  assert.equal(rows.length, 1000);
  assert.equal(rows[0].id, "live-1");
  assert.equal(rows[0].online, true);
  assert.equal(rows.filter(s => s.status === "closed").length, 999);
  assert.equal(rows.some(s => s.id === "old-999"), false);
});
