// Vercel serverless function — dispatch the GitHub Actions `scrape.yml` workflow
// on demand (the app's "Run scrape now" button).
//
// POST /api/trigger-scrape   (no body)
//   -> 200 { ok: true, dispatchedAt, workflow, ref }        workflow queued
//   -> 429 { error, retryAfterSeconds, lastRunAt }          a run started < 5 min ago
//   -> 501 { error }                                        server not configured
//   -> 502 { error, githubStatus, detail }                  GitHub rejected it
//
// Env:
//   GITHUB_TOKEN     (required) PAT with `repo` scope, or fine-grained with
//                    "Actions: read and write" on the repo.
//   GITHUB_REPO      owner/repo. Falls back to Vercel's VERCEL_GIT_REPO_OWNER /
//                    VERCEL_GIT_REPO_SLUG (set automatically on Git-connected
//                    Vercel deploys).
//   SCRAPE_WORKFLOW  workflow file name (default: "scrape.yml")
//   SCRAPE_REF       git ref to run on (default: VERCEL_GIT_COMMIT_REF or "main")

const GITHUB_API = "https://api.github.com";
const COOLDOWN_MS = 5 * 60 * 1000;
const USER_AGENT = "cheap-rent-finder";

function resolveRepo() {
  const explicit = (process.env.GITHUB_REPO || "").trim();
  if (explicit.includes("/")) {
    const [owner, repo] = explicit.split("/");
    if (owner.trim() && repo.trim()) {
      return { owner: owner.trim(), repo: repo.trim() };
    }
  }
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.VERCEL_GIT_REPO_SLUG;
  if (owner && repo) return { owner, repo };
  return null;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res
      .status(501)
      .json({ error: "GITHUB_TOKEN is not configured on the server" });
  }
  const target = resolveRepo();
  if (!target) {
    return res.status(501).json({
      error:
        "Repository not resolved — set GITHUB_REPO=owner/repo (Git-connected Vercel deploys set this automatically)",
    });
  }

  const { owner, repo } = target;
  const workflow = (process.env.SCRAPE_WORKFLOW || "scrape.yml").trim();
  const ref = (
    process.env.SCRAPE_REF ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    "main"
  ).trim();
  const workflowUrl = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
    workflow,
  )}`;

  // --- server-side cooldown: block if the workflow ran in the last 5 min ---
  try {
    const runsRes = await fetch(`${workflowUrl}/runs?per_page=1`, {
      headers: githubHeaders(token),
    });
    if (runsRes.ok) {
      const data = await runsRes.json();
      const last = data.workflow_runs?.[0];
      if (last?.created_at) {
        const age = Date.now() - new Date(last.created_at).getTime();
        if (age >= 0 && age < COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((COOLDOWN_MS - age) / 1000);
          res.setHeader("Retry-After", String(retryAfterSeconds));
          return res.status(429).json({
            error: "A scrape ran recently — try again in a few minutes",
            retryAfterSeconds,
            lastRunAt: last.created_at,
            lastRunStatus: last.status,
          });
        }
      }
    }
    // A non-OK runs query (e.g. 404 for an unknown workflow) is left for the
    // dispatch call below to report with a clearer message.
  } catch {
    // Couldn't check recent runs (network) — fall through and try to dispatch.
  }

  // --- dispatch the workflow ---
  let dispatch;
  try {
    dispatch = await fetch(`${workflowUrl}/dispatches`, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
  } catch (err) {
    return res.status(502).json({
      error: "Could not reach GitHub",
      detail: String(err?.message ?? err),
    });
  }

  if (dispatch.status === 204) {
    return res.status(200).json({
      ok: true,
      dispatchedAt: new Date().toISOString(),
      workflow,
      ref,
    });
  }

  const detail = await dispatch.text().catch(() => "");
  const messages = {
    401: "GitHub rejected the token (401) — check GITHUB_TOKEN",
    403: "GitHub forbade the request (403) — the token needs Actions write access",
    404: `Workflow "${workflow}" not found on ${owner}/${repo} (404) — check the file name and that it has a workflow_dispatch trigger`,
    422: `GitHub could not process the request (422) — check that ref "${ref}" exists`,
  };
  return res.status(502).json({
    error: messages[dispatch.status] || `GitHub returned ${dispatch.status}`,
    githubStatus: dispatch.status,
    detail: detail.slice(0, 500),
  });
}
