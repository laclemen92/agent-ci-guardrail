import { attributeRun, type AgentName } from "../agents.js";

/** What the guard knows about the run it's deciding for. */
export interface GuardContext {
  /** GitHub event name, e.g. "pull_request" or "push". */
  event: string;
  actor: string;
  triggeringActor: string;
  /** Branch being tested (the PR's head branch for pull_request events). */
  branch: string | null;
  defaultBranch: string;
  /** Head commit message, if known. */
  commitMessage?: string;
  /** Workflow file path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /**
   * Whether this workflow re-runs when a PR is marked ready for review.
   * Without that, the skipped checks of the last light run would be what
   * branch protection sees, so the guard never goes light.
   */
  rerunsWhenReady?: boolean;
  /** The open PR for this branch, if any. */
  pullRequest?: {
    number: number;
    draft: boolean;
    author: string;
    labels: string[];
  };
}

export interface GuardOptions {
  /** Label that forces the full suite on a PR. */
  fullLabel: string;
  /** Agents to guard, or "all". */
  agents: AgentName[] | "all";
  /**
   * Also guard agent-assisted pushes: a person pushing agent-written
   * commits (co-author markers). On by default, since local agents (Claude
   * Code, Codex CLI, Cursor) push as the person; turn off to treat those
   * pushes as the person's.
   */
  includeAssisted: boolean;
}

export const DEFAULT_OPTIONS: GuardOptions = {
  fullLabel: "ci:full",
  agents: "all",
  includeAssisted: true,
};

export interface GuardDecision {
  /** "light": run the quick checks only. "full": run everything. */
  mode: "light" | "full";
  /** The agent behind the run, if any. */
  agent?: AgentName;
  /** One line on why, for the job summary. */
  reason: string;
}

/** Events that test pushed code; anything else gets the full suite. */
const CODE_EVENTS = new Set(["push", "pull_request", "pull_request_target"]);

/**
 * Decides how much CI a run gets. Agents' work in progress (a draft PR, or
 * an agent branch with no PR yet) gets the light suite; everything else,
 * including any doubt, gets the full suite. The guard never blocks CI.
 */
export function decide(
  ctx: GuardContext,
  options: GuardOptions = DEFAULT_OPTIONS,
): GuardDecision {
  if (!CODE_EVENTS.has(ctx.event)) {
    return { mode: "full", reason: `${ctx.event} event: not PR work` };
  }
  if (!ctx.branch || ctx.branch === ctx.defaultBranch) {
    return { mode: "full", reason: "default branch" };
  }
  const pr = ctx.pullRequest;
  if (pr?.labels.includes(options.fullLabel)) {
    return {
      mode: "full",
      reason: `PR #${pr.number} has the ${options.fullLabel} label`,
    };
  }

  const agent = agentBehind(ctx, options);
  if (!agent) return { mode: "full", reason: "pushed by a person" };

  if (pr && !pr.draft) {
    return {
      mode: "full",
      agent,
      reason: `${agent}'s PR #${pr.number} is ready for review`,
    };
  }
  if (!ctx.rerunsWhenReady) {
    return {
      mode: "full",
      agent,
      reason:
        "this workflow doesn't run on ready_for_review, so light runs could let unchecked code merge; add `types: [opened, synchronize, reopened, ready_for_review]` to its pull_request trigger",
    };
  }
  if (!pr) {
    return {
      mode: "light",
      agent,
      reason: `${agent} is still working: branch ${ctx.branch} has no PR yet`,
    };
  }
  return {
    mode: "light",
    agent,
    reason: `${agent} is still working: PR #${pr.number} is a draft`,
  };
}

/** The guarded agent behind the run, from the run itself or the PR's author. */
function agentBehind(
  ctx: GuardContext,
  options: GuardOptions,
): AgentName | undefined {
  const event =
    ctx.event === "pull_request_target" ? "pull_request" : ctx.event;
  const candidates = [
    attributeRun({
      actor: ctx.actor,
      triggeringActor: ctx.triggeringActor,
      headBranch: ctx.branch,
      commitMessage: ctx.commitMessage,
      event,
      path: ctx.workflowPath,
    }),
  ];
  if (ctx.pullRequest) {
    candidates.push(
      attributeRun({
        actor: ctx.pullRequest.author,
        headBranch: ctx.branch,
        event,
        path: ctx.workflowPath,
      }),
    );
  }
  for (const a of candidates) {
    if (a.kind !== "agent") continue;
    if (a.assisted && !options.includeAssisted) continue;
    if (options.agents !== "all" && !options.agents.includes(a.agent)) continue;
    return a.agent;
  }
  return undefined;
}
