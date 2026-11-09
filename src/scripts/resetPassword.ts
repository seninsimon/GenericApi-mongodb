// Reset a user's password from the command line (e.g. a locked-out admin):
//
//   pnpm reset-password <username> <new-password>
//   docker compose exec api node dist/scripts/resetPassword.js <username> <new-password>
//
// Also re-enables the account and signs the user out everywhere.
import { hashPassword, validateNewPassword } from "../auth/password.js";
import { migrate } from "../db/migrate.js";
import { pool } from "../db/pool.js";

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: reset-password <username> <new-password>");
  process.exit(1);
}
const problem = validateNewPassword(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

await migrate();
const { rows } = await pool.query<{ _id: string; username: string }>(
  `UPDATE users SET password_hash = $2, is_active = TRUE, updated_at = now()
   WHERE lower(username) = lower($1) RETURNING _id, username`,
  [username, await hashPassword(password)]
);

if (!rows[0]) {
  console.error(`No user named "${username}"`);
  await pool.end();
  process.exit(1);
}
await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0]._id]);
console.log(`Password for "${rows[0].username}" has been reset.`);
await pool.end();
