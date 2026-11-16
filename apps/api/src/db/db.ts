import pg from "pg";

/**
 * The database surface the app uses: parameterised queries and transactions.
 * Production runs on node-postgres; tests run the same SQL on PGlite (Postgres in
 * WebAssembly), so both adapters implement this.
 *
 * JSON columns: pass values through `json()` and cast with `$n::jsonb` — node-postgres
 * would otherwise send a JS array as a Postgres array.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const json = (value: unknown) => JSON.stringify(value);

export function postgresDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const fromClient = (client: pg.PoolClient): Db => ({
    query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)) as unknown as { rows: T[] },
    transaction: (fn) => fn(fromClient(client)),
    close: async () => undefined,
  });
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pool.query(text, params)) as unknown as { rows: T[] },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(fromClient(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
