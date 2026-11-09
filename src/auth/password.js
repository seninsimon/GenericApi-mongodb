import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCb);

// scrypt parameters (N=2^15, r=8, p=1), ~32 MB memory per hash
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;

// Stored format: scrypt$N$r$p$<salt b64>$<hash b64>
export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
};

export const verifyPassword = async (password, stored) => {
  const [algo, n, r, p, saltB64, hashB64] = String(stored).split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEM,
  });
  return timingSafeEqual(actual, expected);
};

// Used when a login names an unknown user, so the response takes as long as a real check.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
export const verifyDummyPassword = (password) => verifyPassword(password, DUMMY_HASH);

export const validateNewPassword = (password) => {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) return "Password is too long";
  return null;
};
