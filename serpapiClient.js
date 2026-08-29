// SerpAPI library initialization (Node).
//
// Loads SERPAPI_KEY from .env.local and exposes a configured client.
//
//   import { getJson, SERPAPI_KEY } from "./serpapiClient.js";
//   const results = await getJson({ engine: "google", q: "apartments for rent" });

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
import { getJson } from "serpapi";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const envLocal = join(projectRoot, ".env.local");
if (existsSync(envLocal)) dotenv.config({ path: envLocal });
dotenv.config({ path: join(projectRoot, ".env"), override: false });

export const SERPAPI_KEY = process.env.SERPAPI_KEY;

if (!SERPAPI_KEY || SERPAPI_KEY === "replace_with_your_serpapi_key") {
  console.warn(
    "[serpapiClient] SERPAPI_KEY is not set. Copy .env.local.example to .env.local " +
      "and add your key from https://serpapi.com/manage-api-key",
  );
}

// Thin wrapper that injects the API key into every request.
export function search(params) {
  return getJson({ ...params, api_key: SERPAPI_KEY });
}

export { getJson };
