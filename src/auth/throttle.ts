import { query } from "../db/pool.js";

// Failed-login throttling stored in Postgres, so it works across several API
// instances: 10 failures per IP + username within 15 minutes.
const MAX_FAILURES = 10;
const WINDOW = "15 minutes";

export const throttleKey = (ip: string | undefined, username: string) =>
  `${ip ?? "?"}|${username.toLowerCase()}`;

export async function isThrottled(key: string): Promise<boolean> {
  const { rows } = await query<{ failures: number }>(
    `SELECT failures FROM login_attempts
     WHERE key = $1 AND first_failure_at > now() - $2::interval`,
    [key, WINDOW]
  );
  return (rows[0]?.failures ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(key: string): Promise<void> {
  await query(
    `INSERT INTO login_attempts (key, failures, first_failure_at) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN login_attempts.first_failure_at < now() - $2::interval
                       THEN 1 ELSE login_attempts.failures + 1 END,
       first_failure_at = CASE WHEN login_attempts.first_failure_at < now() - $2::interval
                               THEN now() ELSE login_attempts.first_failure_at END`,
    [key, WINDOW]
  );
}

export const clearFailures = (key: string) => query(`DELETE FROM login_attempts WHERE key = $1`, [key]);

// housekeeping (run by the worker)
export const pruneLoginAttempts = () =>
  query(`DELETE FROM login_attempts WHERE first_failure_at < now() - $1::interval`, [WINDOW]);
