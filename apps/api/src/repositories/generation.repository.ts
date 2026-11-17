import { type PrismaClient } from "@prisma/client";

export function createGenerationRun(
  db: PrismaClient,
  data: {
    id: string;
    userId: string;
    model: string;
    status: string;
    errorCode: string | null;
    attempts: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  },
) {
  return db.generationRun.create({ data });
}
