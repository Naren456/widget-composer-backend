import { PrismaClient } from "@prisma/client";

export async function connectDatabase(databaseUrl: string): Promise<PrismaClient> {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  await db.$connect();
  return db;
}
