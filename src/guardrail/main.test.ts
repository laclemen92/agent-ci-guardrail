import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardContext, runsOnReadyForReview } from "./context.js";
import { options, run } from "./main.js";

function files(payload: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-"));
  const event = join(dir, "event.json");
  writeFileSync(event, JSON.stringify(payload));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  return { event, output, summary };
}

/** A fetch that answers from a path → JSON map and records what was asked. */
function fakeFetch(responses: Record<string, unknown>) {
  const asked: string[] = [];
  const fn = ((url: string) => {
    const path = url.replace("https://api.github.com", "");
    asked.push(path);
    const body = responses[path];
    return Promise.resolve(
      new Response(JSON.stringify(body ?? {}), {
        status: body === undefined ? 404 : 200,
      }),
    );
  }) as typeof fetch;
  return { fn, asked };
}

const repository = { default_branch: "main" };

const WORKFLOW = `on:
  push:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
`;
const contents = (yaml: string) => ({
  content: Buffer.from(yaml).toString("base64"),
  encoding: "base64",
});

describe("guardContext", () => {
  it("reads a PR event and looks up the head commit's message", async () => {
    const { fn, asked } = fakeFetch({
      "/repos/acme/app/commits/abc": { commit: { message: "WIP" } },
      "/repos/acme/app/contents/.github/workflows/ci.yml?ref=abc":
        contents(WORKFLOW),
    });
    const getJson = async (path: string) => {
      const r = await fn(`https://api.github.com${path}`);
      return r.ok ? r.json() : null;
    };
    const ctx = await guardContext(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_ACTOR: "Copilot",
        GITHUB_REPOSITORY: "acme/app",
        GITHUB_WORKFLOW_REF:
          "acme/app/.github/workflows/ci.yml@refs/pull/3/merge",
      },
      {
        repository,
        pull_request: {
          number: 3,
          draft: true,
          user: { login: "Copilot" },
          labels: [{ name: "bug" }],
          head: { ref: "copilot/fix", sha: "abc" },
        },
      },
      getJson,
    );
    expect(asked).toEqual([
      "/repos/acme/app/contents/.github/workflows/ci.yml?ref=abc",
      "/repos/acme/app/commits/abc",
    ]);
    expect(ctx).toMatchObject({
      branch: "copilot/fix",
      commitMessage: "WIP",
      rerunsWhenReady: true,
      workflowPath: ".github/workflows/ci.yml",
      pullRequest: {
        number: 3,
        draft: true,
        author: "Copilot",
        labels: ["bug"],
      },
    });
  });
});

describe("run", () => {
  it("finds the open PR for a pushed agent branch and writes outputs", async () => {
    const f = files({
      repository,
      head_commit: { message: "Add tests" },
    });
    const { fn, asked } = fakeFetch({
      "/repos/acme/app/pulls?state=open&head=acme%3Acodex%2Ftests": [
        { number: 9, draft: true, user: { login: "alice" }, labels: [] },
      ],
      "/repos/acme/app/contents/.github/workflows/ci.yml?ref=def":
        contents(WORKFLOW),
    });
    const decision = await run(
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: f.event,
        GITHUB_ACTOR: "alice",
        GITHUB_REF_NAME: "codex/tests",
        GITHUB_SHA: "def",
        GITHUB_WORKFLOW_REF:
          "acme/app/.github/workflows/ci.yml@refs/heads/codex/tests",
        GITHUB_REPOSITORY: "acme/app",
        GITHUB_OUTPUT: f.output,
        GITHUB_STEP_SUMMARY: f.summary,
      },
      fn,
    );
    expect(asked).toHaveLength(2);
    expect(decision).toMatchObject({ mode: "light", agent: "Codex" });
    expect(readFileSync(f.output, "utf8")).toBe(
      "mode=light\nfull=false\nagent=Codex\nreason=Codex is still working: PR #9 is a draft\n",
    );
    expect(readFileSync(f.summary, "utf8")).toContain("light checks only");
  });

  it("fails open: any error means the full suite", async () => {
    const f = files({});
    const decision = await run(
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: join(f.event, "missing"),
        GITHUB_OUTPUT: f.output,
      },
      fakeFetch({}).fn,
    );
    expect(decision.mode).toBe("full");
    expect(decision.reason).toMatch(/^guard error/);
    expect(readFileSync(f.output, "utf8")).toContain("full=true");
  });
});

describe("options", () => {
  it("reads the inputs", () => {
    expect(
      options({
        "INPUT_FULL-LABEL": "run-all",
        INPUT_AGENTS: "Copilot, Codex",
        "INPUT_INCLUDE-ASSISTED": "true",
      }),
    ).toEqual({
      fullLabel: "run-all",
      agents: ["Copilot", "Codex"],
      includeAssisted: true,
    });
  });
});

describe("runsOnReadyForReview", () => {
  it("needs ready_for_review in the triggers, not in a comment", () => {
    expect(runsOnReadyForReview(WORKFLOW)).toBe(true);
    expect(runsOnReadyForReview("on:\n  pull_request:\n")).toBe(false);
    expect(
      runsOnReadyForReview("on:\n  pull_request: # add ready_for_review\n"),
    ).toBe(false);
  });
});
