// Reset a user's password from the command line (e.g. a locked-out admin):
//
//   pnpm reset-password <username> <new-password>
//
// Also re-enables the account and signs the user out everywhere.

import dotenv from "dotenv";
import connectDB, { pool } from "../src/config/db.js";
import { hashPassword, validateNewPassword } from "../src/auth/password.js";

dotenv.config();

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: pnpm reset-password <username> <new-password>");
  process.exit(1);
}

const problem = validateNewPassword(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

await connectDB();

const { rows } = await pool.query(
  `UPDATE users SET password_hash = $2, is_active = TRUE, updated_at = now()
   WHERE lower(username) = lower($1)
   RETURNING _id, username`,
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
