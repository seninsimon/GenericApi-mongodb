// Small input helpers shared by controllers.

export const cleanText = (value, maxLength = 200) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

export const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,50}$/;

export const toIdList = (value) =>
  Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === "string" && v))] : [];

// Wrap an async handler so a thrown error becomes a JSON 500 (or the error's status).
export const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
