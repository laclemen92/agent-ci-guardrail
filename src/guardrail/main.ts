/**
 * Entry point of the guardrail Action. Decides "light" or "full" CI for this
 * run and writes the outputs. Fails open: on any error the run gets the full
 * suite, so the guard can never block or weaken CI by mistake.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { AgentName } from "../agents.js";
import { guardContext, type GetJson, type Payload } from "./context.js";
import {
  decide,
  DEFAULT_OPTIONS,
  type GuardDecision,
  type GuardOptions,
} from "./decide.js";

export async function run(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<GuardDecision> {
  let decision: GuardDecision;
  try {
    const payload: Payload = env.GITHUB_EVENT_PATH
      ? (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as Payload)
      : {};
    const ctx = await guardContext(env, payload, getJson(env, fetchFn));
    decision = decide(ctx, options(env));
  } catch (error) {
    decision = {
      mode: "full",
      reason: `guard error, running everything: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  writeOutputs(env, decision);
  return decision;
}

/** Action inputs arrive as INPUT_<NAME> (upper case, dashes kept). */
export function options(env: NodeJS.ProcessEnv): GuardOptions {
  const input = (name: string) =>
    env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
  const agents = input("agents");
  return {
    fullLabel: input("full-label") || DEFAULT_OPTIONS.fullLabel,
    agents:
      !agents || agents.toLowerCase() === "all"
        ? "all"
        : (agents
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean) as AgentName[]),
    includeAssisted: input("include-assisted").toLowerCase() !== "false",
  };
}

function getJson(env: NodeJS.ProcessEnv, fetchFn: typeof fetch): GetJson {
  const token = env["INPUT_TOKEN"] || env.GITHUB_TOKEN;
  const base = env.GITHUB_API_URL ?? "https://api.github.com";
  return async (path) => {
    try {
      const response = await fetchFn(`${base}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "agent-ci-guardrail",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
}

function writeOutputs(env: NodeJS.ProcessEnv, d: GuardDecision): void {
  const lines = [
    `mode=${d.mode}`,
    `full=${d.mode === "full"}`,
    `agent=${d.agent ?? ""}`,
    `reason=${d.reason.replace(/\r?\n/g, " ")}`,
  ];
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `**CI guardrail: ${d.mode === "light" ? "light checks only" : "full suite"}.** ${d.reason}\n`,
    );
  }
  console.log(`guardrail: ${d.mode} (${d.reason})`);
}
