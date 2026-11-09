import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { countUsers, createUser, getAdminRole } from "../repo/userRepo.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.js";

const WEAK_DEFAULTS = new Set(["admin12345", "admin123", "password", "changeme"]);

// On first start (no users yet) create an admin account so someone can log in.
// Without ADMIN_PASSWORD a random password is generated and logged once.
export async function ensureInitialAdmin(): Promise<void> {
  if ((await countUsers()) > 0) return;

  let password = env.adminPassword;
  let generated = false;
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    if (password) logger.warn(`ADMIN_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters, ignoring it`);
    password = randomBytes(9).toString("base64url");
    generated = true;
  }

  const adminRole = await getAdminRole();
  if (!adminRole) throw new Error("Admin role is missing (migrations not applied?)");

  await createUser({
    username: env.adminUsername,
    fullName: "Administrator",
    passwordHash: await hashPassword(password),
    roleId: adminRole._id,
    departmentIds: [],
  });

  logger.warn(
    generated
      ? `Created the first admin account "${env.adminUsername}" with generated password: ${password}`
      : `Created the first admin account "${env.adminUsername}" (password from ADMIN_PASSWORD)`
  );
  if (env.isProduction && WEAK_DEFAULTS.has(password)) {
    logger.warn("The admin password is a well-known default: change it right after logging in");
  }
}
