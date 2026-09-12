import path from "node:path";
import { readPrivate, writePrivate, fail } from "./storage.mjs";

const statuses = new Set(["working", "waiting", "idle", "interrupted", "error", "closed", "untracked"]);
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const text = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max) : "";
const retention = 7 * 86400000;
const recent = (s, now) => (s.status === "closed" ? s.updatedAt : s.seenAt) > now - retention;

export class Sessions {
  constructor({ dir, now = Date.now }) {
    this.file = path.join(dir, "sessions.json");
    this.now = now;
    this.data = readPrivate(this.file, value => value?.version === 1 && Array.isArray(value.sessions) && value.sessions.length <= 1000) || { version: 1, sessions: [] };
  }
  update(body) {
    if (!validId(body?.machineId) || typeof body.machineName !== "string" || !Array.isArray(body.sessions) || body.sessions.length > 100)
      throw fail(400, "Invalid session snapshot.");
    const ids = new Set();
    const now = this.now();
    // Validate the entire snapshot before changing persistent state.
    const incoming = body.sessions.map(s => {
      if (!validId(s?.id) || ids.has(s.id) || !["claude", "codex"].includes(s.provider) || !statuses.has(s.status) ||
          !Number.isSafeInteger(s.pid) || s.pid < 1 || !Number.isSafeInteger(s.updatedAt) || s.updatedAt < 0 || s.updatedAt > now + 300000)
        throw fail(400, "Invalid session snapshot.");
      ids.add(s.id);
      return {
        id: s.id, machineId: body.machineId, machineName: text(body.machineName, 120),
        provider: s.provider, project: text(s.project, 160), cwd: text(s.cwd, 1024), tty: text(s.tty, 40), pid: s.pid,
        status: s.status, activity: text(s.activity, 160), summary: text(s.summary, 8000), summaryHidden: s.summaryHidden === true,
        summaryAt: Number.isSafeInteger(s.summaryAt) && s.summaryAt >= 0 && s.summaryAt <= s.updatedAt ? s.summaryAt : s.summaryAt == null && s.activity === 'Stop' && s.summary ? s.updatedAt : 0,
        summaryTruncated: s.summaryTruncated === true,
        eventId: text(s.eventId, 128), updatedAt: s.updatedAt, seenAt: now,
      };
    });
    const retained = this.data.sessions.filter(s => recent(s, now));
    const other = retained.filter(s => s.machineId !== body.machineId);
    if (other.length + incoming.length > 1000) throw fail(409, "Session limit reached.");
    const previous = new Map(retained.filter(s => s.machineId === body.machineId).map(s => [s.id, s]));
    const notifications = [];
    for (const s of incoming) {
      const old = previous.get(s.id);
      s.notifiedEvent = old?.notifiedEvent || "";
      s.notifiedAt = old?.notifiedAt || 0;
      if (["idle", "error"].includes(s.status) && s.eventId && s.eventId !== s.notifiedEvent && now - s.notifiedAt >= 60000) {
        s.notifiedEvent = s.eventId;
        s.notifiedAt = now;
        notifications.push({ id: s.id, provider: s.provider, status: s.status });
      }
    }
    const missing = [...previous.values()].filter(s => !ids.has(s.id)).map(s => ({ ...s, status: "closed" }));
    this.data.sessions = [...other, ...incoming, ...missing].filter(s => recent(s, now)).slice(-1000);
    writePrivate(this.file, this.data);
    return notifications;
  }
  list() {
    this.prune();
    const now = this.now();
    return this.data.sessions.map(({ notifiedEvent, notifiedAt, ...s }) => ({
      ...s, online: s.status !== "closed" && s.seenAt > now - 90000,
    })).sort((a, b) => b.updatedAt - a.updatedAt || a.project.localeCompare(b.project));
  }
  prune() {
    const retained = this.data.sessions.filter(s => recent(s, this.now()));
    if (retained.length !== this.data.sessions.length) {
      this.data.sessions = retained;
      writePrivate(this.file, this.data);
    }
  }
}
