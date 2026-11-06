import type { WorkflowRun } from "./model.js";

/** Who a run is attributed to: a person, an AI coding agent, or other automation. */
export type Attribution =
  | { kind: "person"; reason: string }
  | {
      kind: "agent";
      agent: AgentName;
      reason: string;
      /**
       * True when a person pushed changes the agent wrote (found by a
       * commit marker), rather than the agent triggering the run itself.
       */
      assisted: boolean;
    }
  | { kind: "automation"; reason: string };

export type AgentName =
  | "Codex"
  | "Claude"
  | "Copilot"
  | "Cursor"
  | "Devin"
  | "Jules"
  | "Aider"
  | "Gemini"
  /** Agents we don't name separately (e.g. gh-aw's opencode, goose, pi engines). */
  | "Other agent";

/** GitHub accounts that agents act as (apps show up with a [bot] suffix). */
const AGENT_ACCOUNTS: [RegExp, AgentName][] = [
  [/^(copilot|copilot-swe-agent)(\[bot\])?$/i, "Copilot"],
  [/^claude(\[bot\])?$/i, "Claude"],
  [/^(chatgpt-codex-connector|codex)(\[bot\])?$/i, "Codex"],
  [/^(cursor|cursoragent)(\[bot\])?$/i, "Cursor"],
  [/^devin-ai-integration(\[bot\])?$/i, "Devin"],
  [/^google-labs-jules(\[bot\])?$/i, "Jules"],
];

/** Branch names agents create by default. */
const AGENT_BRANCHES: [RegExp, AgentName][] = [
  [/^codex[/-]/i, "Codex"],
  [/^claude[/-]/i, "Claude"],
  [/^copilot[/-]/i, "Copilot"],
  [/^cursor[/-]/i, "Cursor"],
  [/^devin[/-]/i, "Devin"],
  [/^jules[/-]/i, "Jules"],
];

/** Trailers and markers agents leave in commit messages. */
const AGENT_COMMITS: [RegExp, AgentName][] = [
  [/co-authored-by:\s*claude\b|generated with \[?claude code/i, "Claude"],
  [/co-authored-by:\s*codex\b|generated (with|by) codex\b/i, "Codex"],
  [/co-authored-by:\s*(github )?copilot\b|copilot-swe-agent/i, "Copilot"],
  [/co-authored-by:\s*cursor( agent)?\b|cursoragent@cursor\.com/i, "Cursor"],
  [/co-authored-by:\s*devin\b|devin-ai-integration/i, "Devin"],
  [/^aider: /im, "Aider"],
];

/** Bots that aren't coding agents: dependency updates, release tooling and the like. */
const AUTOMATION_ACCOUNT = /\[bot\]$|^(dependabot|renovate|github-actions)$/i;
const DEPENDENCY_BOT = /^(dependabot|renovate)(\[bot\])?$/i;
const AUTOMATION_EVENTS = new Set([
  "schedule",
  "dynamic",
  "repository_dispatch",
]);

/** Workflows that run an agent itself inside GitHub Actions. */
const AGENT_WORKFLOWS: [RegExp, AgentName][] = [
  [/anthropics\/claude-code-action/i, "Claude"],
  [/openai\/codex-action/i, "Codex"],
  [/^dynamic\/copilot-swe-agent\//i, "Copilot"],
  // Copilot code review and Copilot's agent sessions run as GitHub-managed
  // workflows under dynamic/agents/ (e.g. "Running Copilot Code Review").
  [/^dynamic\/agents\//i, "Copilot"],
  // Agent CLIs installed in a workflow step.
  [/npm (?:install|i)\b[^\n]*@anthropic-ai\/claude-code\b/i, "Claude"],
  [/npm (?:install|i)\b[^\n]*@openai\/codex\b/i, "Codex"],
  [/npm (?:install|i)\b[^\n]*@github\/copilot\b/i, "Copilot"],
  [/npm (?:install|i)\b[^\n]*@google\/gemini-cli\b/i, "Gemini"],
];

/**
 * GitHub Agentic Workflows (gh-aw) compile each workflow to a `.lock.yml`
 * whose header names the agent engine, e.g.
 * `# gh-aw-metadata: {..., "agent_id":"copilot", ...}`.
 */
const GH_AW_METADATA =
  /^# gh-aw-metadata: .*"(?:agent_id|engine_id)":"([^"]+)"/m;
const GH_AW_ENGINES: Record<string, AgentName> = {
  copilot: "Copilot",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  aider: "Aider",
};

/** The agent a gh-aw workflow runs, if the YAML is a compiled gh-aw workflow. */
function ghAwAgent(workflowContent: string): AgentName | undefined {
  const engine = GH_AW_METADATA.exec(workflowContent)?.[1];
  if (!engine) return undefined;
  return GH_AW_ENGINES[engine.toLowerCase()] ?? "Other agent";
}

/** Events where the run tests code someone pushed; only these use branch and commit signals. */
const CODE_EVENTS = new Set(["push", "pull_request", "merge_group"]);

/**
 * Attributes a run, strongest signal first:
 *
 * 1. the account that triggered it (agent apps act as their own account);
 * 2. the workflow itself running an agent (e.g. Claude Code via
 *    `@claude` comments, Copilot's coding agent);
 * 3. for runs that test pushed code only: the agent's branch name, then
 *    markers the agent leaves in the commit message. Codex and other local
 *    agents push as the user, and agents in Actions push as
 *    github-actions[bot], so these matter. For comment, review or issue
 *    events the "head commit" is just the latest on the default branch, so
 *    they don't count there;
 * 4. automation (bots, schedules, GitHub-managed workflows).
 */
export function attributeRun(
  run: Pick<
    WorkflowRun,
    | "actor"
    | "triggeringActor"
    | "headBranch"
    | "commitMessage"
    | "event"
    | "path"
  >,
  workflowContent?: string | null,
): Attribution {
  for (const account of [run.actor, run.triggeringActor]) {
    if (!account) continue;
    for (const [pattern, agent] of AGENT_ACCOUNTS) {
      if (pattern.test(account)) {
        return {
          kind: "agent",
          agent,
          reason: `account ${account}`,
          assisted: false,
        };
      }
    }
  }
  const ghAw = workflowContent ? ghAwAgent(workflowContent) : undefined;
  if (ghAw) {
    return {
      kind: "agent",
      agent: ghAw,
      reason: "agent workflow",
      assisted: false,
    };
  }
  for (const [pattern, agent] of AGENT_WORKFLOWS) {
    if (
      pattern.test(run.path) ||
      (workflowContent && pattern.test(workflowContent))
    ) {
      return {
        kind: "agent",
        agent,
        reason: "agent workflow",
        assisted: false,
      };
    }
  }
  const bot = !!run.actor && AUTOMATION_ACCOUNT.test(run.actor);
  // Code an agent wrote counts as the agent's even when a bot account pushed
  // it or triggered its CI (agents and CI-trigger workflows often push with
  // the workflow token, as github-actions[bot]). Dependency bots never do.
  if (CODE_EVENTS.has(run.event) && !DEPENDENCY_BOT.test(run.actor ?? "")) {
    for (const [pattern, agent] of AGENT_BRANCHES) {
      if (run.headBranch && pattern.test(run.headBranch)) {
        return { kind: "agent", agent, reason: "branch name", assisted: false };
      }
    }
    for (const [pattern, agent] of AGENT_COMMITS) {
      if (run.commitMessage && pattern.test(run.commitMessage)) {
        return bot
          ? { kind: "agent", agent, reason: "commit message", assisted: false }
          : { kind: "agent", agent, reason: "commit message", assisted: true };
      }
    }
  }
  if (bot) {
    return { kind: "automation", reason: `account ${run.actor}` };
  }
  if (AUTOMATION_EVENTS.has(run.event)) {
    return { kind: "automation", reason: `${run.event} event` };
  }
  return {
    kind: "person",
    reason: run.actor ? `account ${run.actor}` : "no agent signal",
  };
}

/** The group a run's cost is reported under: "People", "Automation", or the agent's name. */
export function attributionLabel(attribution: Attribution): string {
  if (attribution.kind === "agent") return attribution.agent;
  return attribution.kind === "person" ? "People" : "Automation";
}
