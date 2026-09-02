// Shared GitHub REST helpers for the scrape endpoints.
// The `_` prefix means Vercel does NOT deploy this file as a Serverless
// Function — it's import-only.

export const GITHUB_API = "https://api.github.com";
export const USER_AGENT = "cheap-rent-finder";

/** owner/repo from GITHUB_REPO, falling back to Vercel's git env vars. */
export function resolveRepo() {
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

export function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

export function scrapeWorkflowName() {
  return (process.env.SCRAPE_WORKFLOW || "scrape.yml").trim();
}
