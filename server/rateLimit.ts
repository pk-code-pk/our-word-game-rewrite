import { db } from "./db.js";

type MaybePromise<T> = T | Promise<T>;

export class RateLimitError extends Error {
  constructor(message = "Too many attempts. Please slow down and try again.") {
    super(message);
    this.name = "RateLimitError";
  }
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function flatMapMaybePromise<T, TResult>(
  value: MaybePromise<T>,
  mapper: (resolved: T) => MaybePromise<TResult>
): MaybePromise<TResult> {
  return isPromiseLike(value) ? value.then(mapper) : mapper(value);
}

// DB-backed sliding-window rate limiter. In-memory counters can't work on Vercel
// serverless because each invocation may run on a fresh, isolated instance; the
// shared Postgres table (SQLite locally) is the only counter every instance sees.
// Mirrors the MaybePromise/flatMapMaybePromise pattern in auth.ts so the same code
// runs synchronously under SQLite and asynchronously under Postgres.
export function enforceRateLimit(
  bucket: string,
  identifier: string,
  max: number,
  windowMs: number
): MaybePromise<void> {
  const now = Date.now();
  const cutoff = now - windowMs;

  return flatMapMaybePromise(
    db
      .prepare(`DELETE FROM rate_limit_hits WHERE bucket = ? AND identifier = ? AND hit_at < ?`)
      .run(bucket, identifier, cutoff),
    () =>
      flatMapMaybePromise(
        db
          .prepare(`SELECT COUNT(*) AS count FROM rate_limit_hits WHERE bucket = ? AND identifier = ?`)
          .get(bucket, identifier) as MaybePromise<{ count: number } | undefined>,
        (row) => {
          const count = Number(row?.count ?? 0);
          if (count >= max) {
            throw new RateLimitError();
          }

          return flatMapMaybePromise(
            db
              .prepare(`INSERT INTO rate_limit_hits (bucket, identifier, hit_at) VALUES (?, ?, ?)`)
              .run(bucket, identifier, now),
            () => undefined
          );
        }
      )
  );
}
