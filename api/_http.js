// Shared request-parsing helpers for the serverless functions.
// The `_` prefix means Vercel does NOT deploy this file as a Serverless
// Function — it's import-only.

/** Parse a POST body as JSON, tolerating Vercel's already-parsed req.body,
 * a raw string body, or a stream — `{}` on anything malformed. */
export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  let raw = "";
  try {
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
