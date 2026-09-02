// Vercel serverless function — status of the most recent scrape.yml run, for
// the "Run scrape now" button's completion polling.
//
// GET /api/scrape-status
//   -> { state, status, conclusion, runStartedAt, updatedAt, htmlUrl }
//        state: "idle" | "running" | "completed" | "unknown"
//   Always 200 (so the client can poll without treating hiccups as errors);
//   `configured: false` when GITHUB_TOKEN / repo aren't set.
//
// Env: GITHUB_TOKEN, GITHUB_REPO (or Vercel's VERCEL_GIT_REPO_*), SCRAPE_WORKFLOW

import {
  GITHUB_API,
  githubHeaders,
  resolveRepo,
  scrapeWorkflowName,
} from "./_github.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");

  const token = process.env.GITHUB_TOKEN;
  const target = resolveRepo();
  if (!token || !target) {
    return res.status(200).json({ state: "unknown", configured: false });
  }

  const { owner, repo } = target;
  const workflow = scrapeWorkflowName();
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
    workflow,
  )}/runs?per_page=1`;

  try {
    const gh = await fetch(url, { headers: githubHeaders(token) });
    if (!gh.ok) {
      return res
        .status(200)
        .json({ state: "unknown", configured: true, githubStatus: gh.status });
    }
    const data = await gh.json();
    const run = data.workflow_runs?.[0];
    if (!run) return res.status(200).json({ state: "idle", configured: true });

    return res.status(200).json({
      state: run.status === "completed" ? "completed" : "running",
      status: run.status, // queued | in_progress | completed
      conclusion: run.conclusion ?? null, // success | failure | cancelled | ...
      runStartedAt: run.run_started_at ?? run.created_at,
      updatedAt: run.updated_at,
      htmlUrl: run.html_url,
    });
  } catch (err) {
    return res.status(200).json({
      state: "unknown",
      configured: true,
      error: String(err?.message ?? err),
    });
  }
}
