import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Random URL-safe token, e.g. for refresh tokens. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Lookup hash for tokens stored server-side; the raw token is never persisted. */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** HMAC-SHA256 signature, base64url. */
export const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
