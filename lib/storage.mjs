import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readPrivate(file, validate) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!validate(value)) throw new Error("invalid_schema");
    fs.chmodSync(file, 0o600);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(
      `Cannot load ${path.basename(file)}; restore a valid backup before starting.`,
    );
  }
}
export function writePrivate(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
export function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
export function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
  );
}
