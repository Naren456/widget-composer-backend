import { randomUUID } from "node:crypto";
import { type NextFunction, type Request, type Response } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  createRefreshToken,
  createUser,
  findRefreshToken,
  revokeRefreshToken,
  revokeUserRefreshTokens,
} from "../../repositories/auth.repository.js";
import { randomToken, safeEqual, sha256, sign } from "../../lib/crypto.js";
import { HttpError } from "../../lib/errors.js";

/**
 * Anonymous device accounts. There is no sign-in provider yet, so a first launch
 * creates a user and returns:
 *   - an access token: `v1.<userId>.<expiry>.<hmac>`, valid one hour, sent as a Bearer;
 *   - a refresh token: opaque, stored only as a hash, rotated on every use.
 * Presenting an already-used refresh token revokes all of that user's sessions, since
 * it means a copy of the token is in someone else's hands.
 *
 * A sign-in provider later attaches to the same `users` row; every ownership check
 * already keys on `user_id`.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Session = { accessToken: string; expiresIn: number; refreshToken: string; userId: string };

export function issueAccessToken(secret: Buffer, userId: string, now = Date.now()): string {
  const payload = `v1.${userId}.${Math.floor(now / 1000) + ACCESS_TTL_S}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** The user id in a valid, unexpired token, or null. */
export function verifyAccessToken(secret: Buffer, token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !UUID.test(parts[1])) return null;
  const payload = parts.slice(0, 3).join(".");
  if (!safeEqual(sign(secret, payload), parts[3])) return null;
  if (Number(parts[2]) * 1000 <= now) return null;
  return parts[1];
}

async function newSession(db: PrismaClient | Prisma.TransactionClient, secret: Buffer, userId: string): Promise<Session> {
  const refreshToken = randomToken();
  await createRefreshToken(db, {
    tokenHash: sha256(refreshToken),
    userId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return { accessToken: issueAccessToken(secret, userId), expiresIn: ACCESS_TTL_S, refreshToken, userId };
}

export async function createDeviceUser(db: PrismaClient, secret: Buffer): Promise<Session> {
  const userId = randomUUID();
  await createUser(db, userId);
  return newSession(db, secret, userId);
}

export async function refreshSession(db: PrismaClient, secret: Buffer, refreshToken: string): Promise<Session> {
  const hash = sha256(refreshToken);
  const result = await db.$transaction(async (tx) => {
    const row = await findRefreshToken(tx, hash);
    if (!row) return null;
    if (row.revokedAt) {
      await revokeUserRefreshTokens(tx, row.userId, new Date());
      return { reused: true as const };
    }
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const revoked = await revokeRefreshToken(tx, hash, new Date());
    if (revoked.count === 0) {
      await revokeUserRefreshTokens(tx, row.userId, new Date());
      return { reused: true as const };
    }
    return { userId: row.userId };
  });

  if (!result) throw new HttpError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
  if ("reused" in result) {
    throw new HttpError(401, "REFRESH_TOKEN_REUSED", "This refresh token was already used; all sessions were signed out.");
  }
  return newSession(db, secret, result.userId);
}

/** Rejects the request unless it carries a valid access token; exposes the user id. */
export function requireUser(secret: Buffer) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const userId = token ? verifyAccessToken(secret, token) : null;
    if (!userId) return next(new HttpError(401, "UNAUTHENTICATED", "A valid access token is required."));
    res.locals.userId = userId;
    next();
  };
}

export const currentUser = (res: Response): string => res.locals.userId as string;
