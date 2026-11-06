// src/guardrail/main.ts
import { appendFileSync, readFileSync } from "node:fs";

// src/guardrail/context.ts
async function guardContext(env, payload, getJson2) {
  const event = env.GITHUB_EVENT_NAME ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  const pr = payload.pull_request;
  const branch = pr?.head?.ref ?? (env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME) ?? null;
  const ctx = {
    event,
    actor: env.GITHUB_ACTOR ?? "",
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR ?? env.GITHUB_ACTOR ?? "",
    branch,
    defaultBranch: payload.repository?.default_branch ?? "main",
    workflowPath: workflowPath(env.GITHUB_WORKFLOW_REF, repo)
  };
  const code = ["push", "pull_request", "pull_request_target"].includes(event);
  const sha = pr?.head?.sha ?? env.GITHUB_SHA;
  if (code && branch && branch !== ctx.defaultBranch && ctx.workflowPath && sha) {
    const file = await getJson2(
      `/repos/${repo}/contents/${ctx.workflowPath}?ref=${sha}`
    );
    if (file?.content && file.encoding === "base64") {
      const yaml = Buffer.from(file.content, "base64").toString("utf8");
      ctx.rerunsWhenReady = runsOnReadyForReview(yaml);
    }
  }
  if (pr) {
    ctx.pullRequest = fromPayload(pr);
    const sha2 = pr.head?.sha;
    if (sha2) {
      const commit = await getJson2(`/repos/${repo}/commits/${sha2}`);
      const message = commit?.commit?.message;
      if (message) ctx.commitMessage = message;
    }
  } else {
    const message = payload.head_commit?.message;
    if (message) ctx.commitMessage = message;
    if (event === "push" && branch && branch !== ctx.defaultBranch) {
      const owner = repo.split("/")[0] ?? "";
      const open = await getJson2(
        `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`
      );
      const first = Array.isArray(open) ? open[0] : void 0;
      if (first) ctx.pullRequest = fromPayload(first);
    }
  }
  return ctx;
}
function fromPayload(pr) {
  return {
    number: pr.number,
    draft: pr.draft ?? false,
    author: pr.user?.login ?? "",
    labels: (pr.labels ?? []).flatMap((l) => l.name ? [l.name] : [])
  };
}
function workflowPath(workflowRef, repo) {
  if (!workflowRef) return "";
  const withoutRef = workflowRef.split("@")[0] ?? "";
  return withoutRef.startsWith(`${repo}/`) ? withoutRef.slice(repo.length + 1) : withoutRef;
}
function runsOnReadyForReview(yaml) {
  return /\bready_for_review\b/.test(yaml.replace(/#.*$/gm, ""));
}

// src/agents.ts
var AGENT_ACCOUNTS = [
  [/^(copilot|copilot-swe-agent)(\[bot\])?$/i, "Copilot"],
  [/^claude(\[bot\])?$/i, "Claude"],
  [/^(chatgpt-codex-connector|codex)(\[bot\])?$/i, "Codex"],
  [/^(cursor|cursoragent)(\[bot\])?$/i, "Cursor"],
  [/^devin-ai-integration(\[bot\])?$/i, "Devin"],
  [/^google-labs-jules(\[bot\])?$/i, "Jules"]
];
var AGENT_BRANCHES = [
  [/^codex[/-]/i, "Codex"],
  [/^claude[/-]/i, "Claude"],
  [/^copilot[/-]/i, "Copilot"],
  [/^cursor[/-]/i, "Cursor"],
  [/^devin[/-]/i, "Devin"],
  [/^jules[/-]/i, "Jules"]
];
var AGENT_COMMITS = [
  [/co-authored-by:\s*claude\b|generated with \[?claude code/i, "Claude"],
  [/co-authored-by:\s*codex\b|generated (with|by) codex\b/i, "Codex"],
  [/co-authored-by:\s*(github )?copilot\b|copilot-swe-agent/i, "Copilot"],
  [/co-authored-by:\s*cursor( agent)?\b|cursoragent@cursor\.com/i, "Cursor"],
  [/co-authored-by:\s*devin\b|devin-ai-integration/i, "Devin"],
  [/^aider: /im, "Aider"]
];
var AUTOMATION_ACCOUNT = /\[bot\]$|^(dependabot|renovate|github-actions)$/i;
var DEPENDENCY_BOT = /^(dependabot|renovate)(\[bot\])?$/i;
var AUTOMATION_EVENTS = /* @__PURE__ */ new Set([
  "schedule",
  "dynamic",
  "repository_dispatch"
]);
var AGENT_WORKFLOWS = [
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
  [/npm (?:install|i)\b[^\n]*@google\/gemini-cli\b/i, "Gemini"]
];
var GH_AW_METADATA = /^# gh-aw-metadata: .*"(?:agent_id|engine_id)":"([^"]+)"/m;
var GH_AW_ENGINES = {
  copilot: "Copilot",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  aider: "Aider"
};
function ghAwAgent(workflowContent) {
  const engine = GH_AW_METADATA.exec(workflowContent)?.[1];
  if (!engine) return void 0;
  return GH_AW_ENGINES[engine.toLowerCase()] ?? "Other agent";
}
var CODE_EVENTS = /* @__PURE__ */ new Set(["push", "pull_request", "merge_group"]);
function attributeRun(run2, workflowContent) {
  for (const account of [run2.actor, run2.triggeringActor]) {
    if (!account) continue;
    for (const [pattern, agent] of AGENT_ACCOUNTS) {
      if (pattern.test(account)) {
        return {
          kind: "agent",
          agent,
          reason: `account ${account}`,
          assisted: false
        };
      }
    }
  }
  const ghAw = workflowContent ? ghAwAgent(workflowContent) : void 0;
  if (ghAw) {
    return {
      kind: "agent",
      agent: ghAw,
      reason: "agent workflow",
      assisted: false
    };
  }
  for (const [pattern, agent] of AGENT_WORKFLOWS) {
    if (pattern.test(run2.path) || workflowContent && pattern.test(workflowContent)) {
      return {
        kind: "agent",
        agent,
        reason: "agent workflow",
        assisted: false
      };
    }
  }
  const bot = !!run2.actor && AUTOMATION_ACCOUNT.test(run2.actor);
  if (CODE_EVENTS.has(run2.event) && !DEPENDENCY_BOT.test(run2.actor ?? "")) {
    for (const [pattern, agent] of AGENT_BRANCHES) {
      if (run2.headBranch && pattern.test(run2.headBranch)) {
        return { kind: "agent", agent, reason: "branch name", assisted: false };
      }
    }
    for (const [pattern, agent] of AGENT_COMMITS) {
      if (run2.commitMessage && pattern.test(run2.commitMessage)) {
        return bot ? { kind: "agent", agent, reason: "commit message", assisted: false } : { kind: "agent", agent, reason: "commit message", assisted: true };
      }
    }
  }
  if (bot) {
    return { kind: "automation", reason: `account ${run2.actor}` };
  }
  if (AUTOMATION_EVENTS.has(run2.event)) {
    return { kind: "automation", reason: `${run2.event} event` };
  }
  return {
    kind: "person",
    reason: run2.actor ? `account ${run2.actor}` : "no agent signal"
  };
}

// src/guardrail/decide.ts
var DEFAULT_OPTIONS = {
  fullLabel: "ci:full",
  agents: "all",
  includeAssisted: false
};
var CODE_EVENTS2 = /* @__PURE__ */ new Set(["push", "pull_request", "pull_request_target"]);
function decide(ctx, options2 = DEFAULT_OPTIONS) {
  if (!CODE_EVENTS2.has(ctx.event)) {
    return { mode: "full", reason: `${ctx.event} event: not PR work` };
  }
  if (!ctx.branch || ctx.branch === ctx.defaultBranch) {
    return { mode: "full", reason: "default branch" };
  }
  const pr = ctx.pullRequest;
  if (pr?.labels.includes(options2.fullLabel)) {
    return {
      mode: "full",
      reason: `PR #${pr.number} has the ${options2.fullLabel} label`
    };
  }
  const agent = agentBehind(ctx, options2);
  if (!agent) return { mode: "full", reason: "pushed by a person" };
  if (pr && !pr.draft) {
    return {
      mode: "full",
      agent,
      reason: `${agent}'s PR #${pr.number} is ready for review`
    };
  }
  if (!ctx.rerunsWhenReady) {
    return {
      mode: "full",
      agent,
      reason: "this workflow doesn't run on ready_for_review, so light runs could let unchecked code merge; add `types: [opened, synchronize, reopened, ready_for_review]` to its pull_request trigger"
    };
  }
  if (!pr) {
    return {
      mode: "light",
      agent,
      reason: `${agent} is still working: branch ${ctx.branch} has no PR yet`
    };
  }
  return {
    mode: "light",
    agent,
    reason: `${agent} is still working: PR #${pr.number} is a draft`
  };
}
function agentBehind(ctx, options2) {
  const event = ctx.event === "pull_request_target" ? "pull_request" : ctx.event;
  const candidates = [
    attributeRun({
      actor: ctx.actor,
      triggeringActor: ctx.triggeringActor,
      headBranch: ctx.branch,
      commitMessage: ctx.commitMessage,
      event,
      path: ctx.workflowPath
    })
  ];
  if (ctx.pullRequest) {
    candidates.push(
      attributeRun({
        actor: ctx.pullRequest.author,
        headBranch: ctx.branch,
        event,
        path: ctx.workflowPath
      })
    );
  }
  for (const a of candidates) {
    if (a.kind !== "agent") continue;
    if (a.assisted && !options2.includeAssisted) continue;
    if (options2.agents !== "all" && !options2.agents.includes(a.agent)) continue;
    return a.agent;
  }
  return void 0;
}

// src/guardrail/main.ts
async function run(env = process.env, fetchFn = fetch) {
  let decision;
  try {
    const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
    const ctx = await guardContext(env, payload, getJson(env, fetchFn));
    decision = decide(ctx, options(env));
  } catch (error) {
    decision = {
      mode: "full",
      reason: `guard error, running everything: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  writeOutputs(env, decision);
  return decision;
}
function options(env) {
  const input = (name) => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
  const agents = input("agents");
  return {
    fullLabel: input("full-label") || DEFAULT_OPTIONS.fullLabel,
    agents: !agents || agents.toLowerCase() === "all" ? "all" : agents.split(",").map((a) => a.trim()).filter(Boolean),
    includeAssisted: input("include-assisted").toLowerCase() === "true"
  };
}
function getJson(env, fetchFn) {
  const token = env["INPUT_TOKEN"] || env.GITHUB_TOKEN;
  const base = env.GITHUB_API_URL ?? "https://api.github.com";
  return async (path) => {
    try {
      const response = await fetchFn(`${base}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "agent-ci-guardrail",
          ...token ? { authorization: `Bearer ${token}` } : {}
        }
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
}
function writeOutputs(env, d) {
  const lines = [
    `mode=${d.mode}`,
    `full=${d.mode === "full"}`,
    `agent=${d.agent ?? ""}`,
    `reason=${d.reason.replace(/\r?\n/g, " ")}`
  ];
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `**CI guardrail: ${d.mode === "light" ? "light checks only" : "full suite"}.** ${d.reason}
`
    );
  }
  console.log(`guardrail: ${d.mode} (${d.reason})`);
}

// src/guardrail/index.ts
await run();
