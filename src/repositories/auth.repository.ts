import { type Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export function createUser(db: Db, id: string) {
  return db.user.create({ data: { id } });
}

export function createRefreshToken(db: Db, data: { tokenHash: string; userId: string; expiresAt: Date }) {
  return db.refreshToken.create({ data });
}

export function findRefreshToken(db: Db, tokenHash: string) {
  return db.refreshToken.findUnique({ where: { tokenHash } });
}

export function revokeRefreshToken(db: Db, tokenHash: string, revokedAt: Date) {
  return db.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt },
  });
}

export function revokeUserRefreshTokens(db: Db, userId: string, revokedAt: Date) {
  return db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt },
  });
}
