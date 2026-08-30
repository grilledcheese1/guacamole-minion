// Shared-password gate for the whole Vercel deployment.
//
// Blocks the app AND /api/* for anyone without a valid cookie, so the public URL
// can't be crawled by bots that would burn Google Maps + Turso quota. No user
// accounts — one shared password in the SITE_PASSWORD env var. A correct submit
// sets a signed, httpOnly cookie (HMAC-SHA256 of the password) for 30 days.
//
// If SITE_PASSWORD is unset the gate is disabled (handy for local dev).
//
// Runs as a Vercel Edge Middleware (root-level middleware.js, Web-standard
// Request/Response, no framework deps). No `config` export => runs on every
// request; returning nothing lets the request continue to the origin.

const COOKIE_NAME = "site_gate";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const TOKEN_CONTEXT = "site-gate:v1";
const AUTH_PATH = "/__auth";

export default async function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return; // gate disabled

  const url = new URL(request.url);
  const expectedToken = await hmacHex(password, TOKEN_CONTEXT);

  // 1. Login form submission.
  if (request.method === "POST" && url.pathname === AUTH_PATH) {
    let submitted = "";
    let next = "/";
    try {
      const form = await request.formData();
      submitted = String(form.get("password") ?? "");
      next = sanitizeNext(form.get("next"));
    } catch {
      /* malformed body -> treat as a failed attempt */
    }
    const ok = constantTimeEqual(
      await sha256Hex(submitted),
      await sha256Hex(password),
    );
    if (ok) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: next,
          "Set-Cookie":
            `${COOKIE_NAME}=${expectedToken}; Path=/; HttpOnly; Secure; ` +
            `SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
          "Cache-Control": "no-store",
        },
      });
    }
    return htmlResponse(loginPage({ error: true, next }), 401);
  }

  // 2. Logout.
  if (request.method === "GET" && url.pathname === `${AUTH_PATH}/logout`) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        "Cache-Control": "no-store",
      },
    });
  }

  // 3. Already authenticated? Let it through.
  const token = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (token && constantTimeEqual(token, expectedToken)) return;

  // 4. Blocked.
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }
  return htmlResponse(
    loginPage({ error: false, next: url.pathname + url.search }),
    401,
  );
}

// --- helpers -------------------------------------------------------------

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function sanitizeNext(value) {
  const s = typeof value === "string" ? value : "";
  // Same-origin absolute paths only — block protocol-relative + schemes + loops.
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  if (s === AUTH_PATH || s.startsWith(`${AUTH_PATH}/`)) return "/";
  return s;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const ENCODER = new TextEncoder();

async function hmacHex(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, ENCODER.encode(data));
  return toHex(sig);
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(data));
  return toHex(digest);
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// Self-contained login page. Inline CSS transcribes public/DESIGN.md's
// `text-input` and `button-primary` component specs.
function loginPage({ error, next }) {
  const safeNext = escapeHtml(next || "/");
  const errorBlock = error
    ? '<p class="error">Incorrect password. Try again.</p>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Cheap Rent Finder — private</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: 24px; background: #f9fbfa; color: #001e2b;
    font-family: "Euclid Circular A","Manrope",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 380px; background: #fff;
    border: 1px solid #e1e5e8; border-radius: 12px; padding: 32px;
    box-shadow: rgba(0,30,43,.08) 0 4px 12px 0;
  }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .dot { width: 12px; height: 12px; border-radius: 9999px; background: #00ed64; box-shadow: 0 0 0 4px rgba(0,237,100,.18); }
  p.sub { margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #5c6c7a; }
  label { display: block; margin-bottom: 8px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #7c8c9a; }
  /* DESIGN.md: text-input */
  input[type=password] {
    width: 100%; height: 44px; padding: 12px 16px;
    font-family: inherit; font-size: 16px; color: #001e2b;
    background: #fff; border: 1px solid #c1ccd6; border-radius: 8px; outline: none;
  }
  input[type=password]:focus { border: 2px solid #00684a; padding: 11px 15px; }
  /* DESIGN.md: button-primary */
  button {
    margin-top: 16px; width: 100%; min-height: 44px;
    font-family: inherit; font-size: 14px; font-weight: 600;
    color: #001e2b; background: #00ed64;
    border: 0; border-radius: 9999px; padding: 10px 22px; cursor: pointer;
  }
  button:hover { background: #00a35c; }
  button:active { background: #008c34; }
  .error { margin: 12px 0 0; font-size: 13px; font-weight: 600; color: #fa6e39; }
</style>
</head>
<body>
  <form class="card" method="POST" action="${AUTH_PATH}">
    <h1><span class="dot" aria-hidden="true"></span>Cheap Rent Finder</h1>
    <p class="sub">This site is private. Enter the shared password to continue.</p>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <input type="hidden" name="next" value="${safeNext}" />
    <button type="submit">Enter</button>
    ${errorBlock}
  </form>
</body>
</html>`;
}
