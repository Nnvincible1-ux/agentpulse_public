import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { readPrivate, writePrivate, fail, hash, equal } from "./storage.mjs";

const scrypt = promisify(crypto.scrypt);
const sessionMs = 30 * 24 * 60 * 60 * 1000;
const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const hex = (s, length) =>
  typeof s === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(s);
function validOwner(o) {
  return (
    o?.version === 1 &&
    typeof o.email === "string" &&
    hex(o.salt, 32) &&
    hex(o.passwordHash, 128) &&
    typeof o.secret === "string" &&
    /^[A-Z2-7]{32}$/.test(o.secret) &&
    Number.isSafeInteger(o.lastCounter) &&
    Array.isArray(o.recoveryHashes) &&
    o.recoveryHashes.every((h) => hex(h, 64))
  );
}
function validSessionStore(value) {
  if (
    value?.version !== 1 ||
    !hex(value.ownerHash, 64) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 100
  ) return false;
  const ids = new Set();
  return value.sessions.every(session => {
    const valid =
      session &&
      hex(session.id, 64) &&
      !ids.has(session.id) &&
      typeof session.csrf === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(session.csrf) &&
      Number.isSafeInteger(session.expires) &&
      (session.pushEndpoint === "" ||
        (typeof session.pushEndpoint === "string" && session.pushEndpoint.length <= 4096));
    if (valid) ids.add(session.id);
    return valid;
  });
}

export class Auth {
  constructor({ dir, origin, bootstrapToken, now = Date.now }) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    ) {
      throw new Error("AGENTPULSE_PUBLIC_ORIGIN must be your HTTPS origin.");
    }
    this.origin = origin;
    this.bootstrapToken = bootstrapToken;
    this.now = now;
    this.cookieName =
      url.protocol === "https:" ? "__Host-agentpulse" : "agentpulse_dev";
    this.secure = url.protocol === "https:";
    this.file = path.join(dir, "owner.json");
    this.resetFile = path.join(dir, "password-reset.json");
    this.sessionFile = path.join(dir, "auth-sessions.json");
    this.owner = readPrivate(this.file, validOwner);
    const storedSessions = readPrivate(this.sessionFile, validSessionStore);
    const currentOwner = this.ownerMarker();
    const remembered = storedSessions && equal(storedSessions.ownerHash, currentOwner)
      ? storedSessions.sessions.filter(session => session.expires > this.now())
      : [];
    this.pending = new Map();
    this.sessions = new Map(remembered.map(session => [session.id, {
      csrf: session.csrf,
      expires: session.expires,
      ...(session.pushEndpoint ? { pushEndpoint: session.pushEndpoint } : {}),
    }]));
    this.attempts = [];
    this.hashing = 0;
    this.dummySalt = crypto.randomBytes(16).toString("hex");
    if (storedSessions && (remembered.length !== storedSessions.sessions.length ||
        !equal(storedSessions.ownerHash, currentOwner))) this.persistSessions();
  }
  get configured() {
    return Boolean(this.owner);
  }
  ownerMarker() {
    return hash(this.owner ? this.owner.email + this.owner.passwordHash : "unconfigured");
  }
  persistSessions() {
    writePrivate(this.sessionFile, {
      version: 1,
      ownerHash: this.ownerMarker(),
      sessions: [...this.sessions].map(([id, session]) => ({
        id,
        csrf: session.csrf,
        expires: session.expires,
        pushEndpoint: typeof session.pushEndpoint === "string" ? session.pushEndpoint : "",
      })),
    });
  }
  throttle() {
    const now = this.now();
    this.attempts = this.attempts.filter((t) => t > now - 5 * 60 * 1000);
    if (this.attempts.length >= 20 || this.hashing >= 2)
      throw fail(429, "Too many attempts. Wait five minutes and try again.");
    this.attempts.push(now);
    for (const [id, p] of this.pending)
      if (p.expires <= now) this.pending.delete(id);
    let sessionsChanged = false;
    for (const [id, s] of this.sessions) {
      if (s.expires <= now) {
        this.sessions.delete(id);
        sessionsChanged = true;
      }
    }
    if (sessionsChanged) this.persistSessions();
  }
  async derive(password, salt) {
    if (typeof password !== "string" || password.length > 256)
      throw fail(401, "Sign-in details were not accepted.");
    this.hashing++;
    try {
      return (
        await scrypt(password, salt, 64, {
          N: 65536,
          r: 8,
          p: 2,
          maxmem: 128 * 1024 * 1024,
        })
      ).toString("hex");
    } finally {
      this.hashing--;
    }
  }
  async beginSetup(body) {
    this.throttle();
    if (this.configured)
      throw fail(409, "An owner account already exists. Sign in instead.");
    if (!this.bootstrapToken || !equal(body?.token, this.bootstrapToken))
      throw fail(401, "Ownership token was not accepted.");
    const email = normalizeEmail(body.email);
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof body.password !== "string" ||
      body.password.length < 15 ||
      body.password.length > 256
    ) {
      throw fail(
        400,
        "Use a valid email and a password of 15 to 256 characters.",
      );
    }
    if (this.pending.size >= 3)
      throw fail(
        429,
        "Setup is already in progress. Wait ten minutes before trying again.",
      );
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await this.derive(body.password, salt);
    const otp = new OTPAuth.TOTP({
      issuer: "AgentPulse",
      label: email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: new OTPAuth.Secret({ size: 20 }),
    });
    const uri = otp.toString();
    const qr = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
    });
    if (this.configured)
      throw fail(409, "An owner account already exists. Sign in instead.");
    const enrollment = crypto.randomBytes(32).toString("base64url");
    this.pending.set(hash(enrollment), {
      email,
      salt,
      passwordHash,
      secret: otp.secret.base32,
      expires: this.now() + 10 * 60 * 1000,
    });
    return { enrollment, qr, uri };
  }
  counter(secret, code, lastCounter = -1) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
    const otp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const timestamp = this.now();
    const delta = otp.validate({ token: code, timestamp, window: 1 });
    if (delta === null) return null;
    const counter = Math.floor(timestamp / 30000) + delta;
    return counter > lastCounter ? counter : null;
  }
  confirmSetup(body) {
    this.throttle();
    if (this.configured) throw fail(409, "An owner account already exists.");
    const p = this.pending.get(hash(body?.enrollment));
    const counter =
      p && p.expires > this.now() ? this.counter(p.secret, body?.code) : null;
    if (counter === null)
      throw fail(401, "Code was not accepted or setup expired.");
    const recoveryCodes = Array.from({ length: 8 }, () =>
      crypto.randomBytes(12).toString("hex").match(/.{6}/g).join("-"),
    );
    const owner = {
      version: 1,
      email: p.email,
      salt: p.salt,
      passwordHash: p.passwordHash,
      secret: p.secret,
      lastCounter: counter,
      recoveryHashes: recoveryCodes.map(hash),
    };
    writePrivate(this.file, owner);
    this.owner = owner;
    this.pending.clear();
    return { ...this.newSession(), recoveryCodes };
  }
  async login(body) {
    this.throttle();
    const candidate = await this.derive(
      body?.password,
      this.owner?.salt || this.dummySalt,
    );
    const o = this.owner;
    if (
      !o ||
      !equal(normalizeEmail(body?.email), o.email) ||
      !equal(candidate, o.passwordHash)
    )
      throw fail(401, "Sign-in details were not accepted.");
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const counter = this.counter(o.secret, code, o.lastCounter);
    const recoveryIndex = o.recoveryHashes.findIndex((h) =>
      equal(h, hash(code.toLowerCase())),
    );
    if (counter === null && recoveryIndex < 0)
      throw fail(
        401,
        "Sign-in details were not accepted. Use a fresh authenticator code or an unused recovery code.",
      );
    const updated = { ...o, recoveryHashes: [...o.recoveryHashes] };
    if (counter !== null) updated.lastCounter = counter;
    else updated.recoveryHashes.splice(recoveryIndex, 1);
    writePrivate(this.file, updated);
    this.owner = updated;
    return {
      ...this.newSession(),
      recoveryUsed: counter === null,
      recoveryRemaining: updated.recoveryHashes.length,
    };
  }
  // Called only by the administrator's local CLI, never by a public route.
  issuePasswordReset() {
    if (!this.owner) throw fail(409, "Set up an owner account first.");
    const token = crypto.randomBytes(32).toString("base64url");
    const expires = this.now() + 15 * 60 * 1000;
    writePrivate(this.resetFile, {
      version: 1,
      ownerHash: hash(this.owner.email + this.owner.passwordHash),
      tokenHash: hash(token),
      expires,
    });
    return { token, expires };
  }
  resetProof(body) {
    const o = this.owner;
    const rejected = () => fail(401, "Recovery details were not accepted. Use an unused recovery code and a fresh authenticator code, or a valid administrator reset code.");
    if (!o || !equal(normalizeEmail(body?.email), o.email)) throw rejected();
    if (typeof body?.resetToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.resetToken)) {
      const reset = readPrivate(this.resetFile, (r) =>
        r?.version === 1 && hex(r.ownerHash, 64) && hex(r.tokenHash, 64) && Number.isSafeInteger(r.expires),
      );
      if (reset && reset.expires > this.now() &&
        equal(reset.ownerHash, hash(o.email + o.passwordHash)) &&
        equal(reset.tokenHash, hash(body.resetToken))) return { recoveryIndex: -1, counter: null };
      throw rejected();
    }
    const recoveryCode = typeof body?.recoveryCode === "string" ? body.recoveryCode.trim().toLowerCase() : "";
    const recoveryIndex = o.recoveryHashes.findIndex((h) => equal(h, hash(recoveryCode)));
    const counter = this.counter(o.secret, body?.code, o.lastCounter);
    if (recoveryIndex < 0 || counter === null) throw rejected();
    return { recoveryIndex, counter };
  }
  async resetPassword(body) {
    this.throttle();
    if (typeof body?.password !== "string" || body.password.length < 15 || body.password.length > 256)
      throw fail(400, "Use a password of 15 to 256 characters.");
    if (body.confirmPassword !== body.password)
      throw fail(400, "The new passwords do not match.");
    this.resetProof(body);
    const previousHash = this.owner.passwordHash;
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await this.derive(body.password, salt);
    // Recheck after scrypt: another request may have consumed the proof.
    if (this.owner.passwordHash !== previousHash)
      throw fail(401, "Recovery details were not accepted. Start again.");
    const proof = this.resetProof(body);
    const updated = { ...this.owner, salt, passwordHash, recoveryHashes: [...this.owner.recoveryHashes] };
    if (proof.recoveryIndex >= 0) {
      updated.recoveryHashes.splice(proof.recoveryIndex, 1);
      updated.lastCounter = proof.counter;
    }
    writePrivate(this.file, updated);
    this.owner = updated;
    // The administrator code is bound to the previous password hash, so it
    // also becomes unusable across restarts without a second file write.
    this.sessions.clear();
    this.pending.clear();
    this.persistSessions();
    return { ok: true };
  }
  newSession() {
    if (this.sessions.size >= 100)
      this.sessions.delete(this.sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString("base64url");
    const session = {
      csrf: crypto.randomBytes(32).toString("base64url"),
      expires: this.now() + sessionMs,
    };
    this.sessions.set(hash(token), session);
    this.persistSessions();
    return {
      cookie: this.cookie(token, sessionMs / 1000),
      csrf: session.csrf,
      email: this.owner.email,
    };
  }
  cookie(token, maxAge) {
    return `${this.cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.secure ? "; Secure" : ""}`;
  }
  sessionKey(req) {
    const cookies = String(req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim());
    return hash(
      cookies
        .find((s) => s.startsWith(`${this.cookieName}=`))
        ?.slice(this.cookieName.length + 1) || "",
    );
  }
  session(req) {
    const key = this.sessionKey(req),
      s = this.sessions.get(key);
    if (!s || s.expires <= this.now()) {
      if (this.sessions.delete(key)) this.persistSessions();
      return null;
    }
    return s;
  }
  attachPushEndpoint(session, endpoint) {
    if (
      typeof endpoint !== "string" ||
      !endpoint ||
      endpoint.length > 4096 ||
      ![...this.sessions.values()].includes(session)
    ) throw fail(401, "Session was not accepted.");
    session.pushEndpoint = endpoint;
    this.persistSessions();
  }
  checkMutation(req, session = null) {
    if (
      req.headers.origin !== this.origin ||
      (session && !equal(req.headers["x-csrf-token"], session.csrf))
    )
      throw fail(403, "Reload AgentPulse and try again.");
  }
  logout(req) {
    this.sessions.delete(this.sessionKey(req));
    this.persistSessions();
    return this.cookie("", 0);
  }
}
