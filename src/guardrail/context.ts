import type { GuardContext } from "./decide.js";

/** The parts of the Actions environment the guard reads. */
export interface ActionsEnv {
  GITHUB_EVENT_NAME?: string;
  GITHUB_EVENT_PATH?: string;
  GITHUB_ACTOR?: string;
  GITHUB_TRIGGERING_ACTOR?: string;
  GITHUB_REF_NAME?: string;
  GITHUB_HEAD_REF?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_WORKFLOW_REF?: string;
  GITHUB_API_URL?: string;
  GITHUB_SHA?: string;
}

/** A minimal GitHub REST GET: returns parsed JSON, or null on any failure. */
export type GetJson = (path: string) => Promise<unknown>;

export interface Payload {
  repository?: { default_branch?: string };
  head_commit?: { message?: string } | null;
  pull_request?: PullRequestPayload;
}

interface PullRequestPayload {
  number: number;
  draft?: boolean;
  user?: { login?: string };
  labels?: { name?: string }[];
  head?: { ref?: string; sha?: string };
}

/**
 * Builds the guard's view of this run from the event payload, plus at most
 * one API call: the open PR for a pushed branch, or the head commit's
 * message for a PR event (the payload doesn't carry it).
 */
export async function guardContext(
  env: ActionsEnv,
  payload: Payload,
  getJson: GetJson,
): Promise<GuardContext> {
  const event = env.GITHUB_EVENT_NAME ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  const pr = payload.pull_request;
  const branch =
    pr?.head?.ref ?? (env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME) ?? null;

  const ctx: GuardContext = {
    event,
    actor: env.GITHUB_ACTOR ?? "",
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR ?? env.GITHUB_ACTOR ?? "",
    branch,
    defaultBranch: payload.repository?.default_branch ?? "main",
    workflowPath: workflowPath(env.GITHUB_WORKFLOW_REF, repo),
  };

  const code = ["push", "pull_request", "pull_request_target"].includes(event);
  const sha = pr?.head?.sha ?? env.GITHUB_SHA;
  if (
    code &&
    branch &&
    branch !== ctx.defaultBranch &&
    ctx.workflowPath &&
    sha
  ) {
    const file = (await getJson(
      `/repos/${repo}/contents/${ctx.workflowPath}?ref=${sha}`,
    )) as { content?: string; encoding?: string } | null;
    if (file?.content && file.encoding === "base64") {
      const yaml = Buffer.from(file.content, "base64").toString("utf8");
      ctx.rerunsWhenReady = runsOnReadyForReview(yaml);
    }
  }

  if (pr) {
    ctx.pullRequest = fromPayload(pr);
    const sha = pr.head?.sha;
    if (sha) {
      const commit = (await getJson(`/repos/${repo}/commits/${sha}`)) as {
        commit?: { message?: string };
      } | null;
      const message = commit?.commit?.message;
      if (message) ctx.commitMessage = message;
    }
  } else {
    const message = payload.head_commit?.message;
    if (message) ctx.commitMessage = message;
    if (event === "push" && branch && branch !== ctx.defaultBranch) {
      const owner = repo.split("/")[0] ?? "";
      const open = (await getJson(
        `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      )) as PullRequestPayload[] | null;
      const first = Array.isArray(open) ? open[0] : undefined;
      if (first) ctx.pullRequest = fromPayload(first);
    }
  }
  return ctx;
}

function fromPayload(
  pr: PullRequestPayload,
): NonNullable<GuardContext["pullRequest"]> {
  return {
    number: pr.number,
    draft: pr.draft ?? false,
    author: pr.user?.login ?? "",
    labels: (pr.labels ?? []).flatMap((l) => (l.name ? [l.name] : [])),
  };
}

/** `owner/repo/.github/workflows/ci.yml@refs/heads/main` → `.github/workflows/ci.yml`. */
function workflowPath(workflowRef: string | undefined, repo: string): string {
  if (!workflowRef) return "";
  const withoutRef = workflowRef.split("@")[0] ?? "";
  return withoutRef.startsWith(`${repo}/`)
    ? withoutRef.slice(repo.length + 1)
    : withoutRef;
}

/**
 * True if the workflow's pull_request trigger includes ready_for_review.
 * A bare `pull_request:` (default types) doesn't. Text check: good enough
 * to fail safe, since anything unclear means the full suite.
 */
export function runsOnReadyForReview(yaml: string): boolean {
  return /\bready_for_review\b/.test(yaml.replace(/#.*$/gm, ""));
}
