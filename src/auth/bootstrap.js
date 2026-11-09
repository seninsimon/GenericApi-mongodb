import { randomBytes } from "crypto";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.js";
import { countUsers, createUser, getAdminRole } from "../repo/userRepository.js";

// On first start (no users yet) create an admin account so someone can log in.
// Credentials come from ADMIN_USERNAME / ADMIN_PASSWORD; without a password a
// random one is generated and printed once to the server log.
export const ensureInitialAdmin = async () => {
  if ((await countUsers()) > 0) return;

  const username = process.env.ADMIN_USERNAME || "admin";
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    if (password) {
      console.warn(`ADMIN_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters, ignoring it`);
    }
    password = randomBytes(9).toString("base64url");
    generated = true;
  }

  const adminRole = await getAdminRole();
  await createUser({
    username,
    fullName: "Administrator",
    passwordHash: await hashPassword(password),
    roleId: adminRole._id,
    departmentIds: [],
  });

  console.log("=".repeat(60));
  console.log(`Created the first admin account: username "${username}"`);
  if (generated) console.log(`Generated password: ${password}`);
  console.log("Change this password after logging in (Profile page).");
  console.log("=".repeat(60));
};
