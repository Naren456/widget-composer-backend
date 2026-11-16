const SENSITIVE_KEY = /authorization|token|secret|password|cookie|credential|base64|image|prompt/i;

/** Development-only structured logs. Values likely to contain user or auth data are redacted. */
export function devLog(scope: string, event: string, details?: Record<string, unknown>): void {
  // The API config defaults NODE_ENV to development; mirror that when the env
  // variable is omitted so `npm run dev` still emits structured activity logs.
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test") return;
  const suffix = details ? ` ${JSON.stringify(sanitize(details))}` : "";
  console.log(`${new Date().toISOString()} [${scope}] ${event}${suffix}`);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[max depth]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1),
    ]));
  }
  if (typeof value === "string") return value.slice(0, 2_400);
  if (typeof value === "bigint") return value.toString();
  return value;
}
