import { describe, expect, it } from "vitest";

import { attributeRun, attributionLabel } from "./agents.js";

type RunFields = Parameters<typeof attributeRun>[0];

const run = (extra: Partial<RunFields> = {}, workflowContent?: string) =>
  attributeRun(
    {
      actor: "alice",
      triggeringActor: "alice",
      headBranch: "feature",
      commitMessage: "Fix the thing",
      event: "pull_request",
      path: ".github/workflows/ci.yml",
      ...extra,
    },
    workflowContent,
  );

describe("attributeRun", () => {
  it.each([
    ["Copilot", "Copilot"],
    ["copilot-swe-agent[bot]", "Copilot"],
    ["claude[bot]", "Claude"],
    ["devin-ai-integration[bot]", "Devin"],
    ["cursor[bot]", "Cursor"],
    ["chatgpt-codex-connector[bot]", "Codex"],
    ["google-labs-jules[bot]", "Jules"],
  ])("attributes runs triggered by %s to %s", (actor, agent) => {
    expect(run({ actor })).toEqual({
      kind: "agent",
      agent,
      reason: `account ${actor}`,
      assisted: false,
    });
  });

  it("finds agents that push as the user by their branch name (Codex)", () => {
    expect(run({ headBranch: "codex/streaming-nested-models" })).toEqual({
      kind: "agent",
      agent: "Codex",
      reason: "branch name",
      assisted: false,
    });
  });

  it.each([
    ["Fix bug\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "Claude"],
    [
      "Add tests\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "Claude",
    ],
    [
      "Refactor\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "Cursor",
    ],
    [
      "Update\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>",
      "Copilot",
    ],
    ["aider: fix typo in README", "Aider"],
  ])("finds agents from commit markers: %j", (commitMessage, agent) => {
    expect(run({ commitMessage })).toMatchObject({
      kind: "agent",
      agent,
      reason: "commit message",
      assisted: true,
    });
  });

  it("prefers the account over the branch, and the branch over the commit", () => {
    expect(
      run({
        actor: "claude[bot]",
        headBranch: "codex/x",
        commitMessage: "aider: y",
      }),
    ).toMatchObject({ agent: "Claude" });
    expect(
      run({ headBranch: "codex/x", commitMessage: "aider: y" }),
    ).toMatchObject({
      agent: "Codex",
    });
  });

  it("treats other bots and scheduled runs as automation", () => {
    expect(run({ actor: "dependabot[bot]" })).toMatchObject({
      kind: "automation",
    });
    expect(run({ actor: "renovate[bot]" })).toMatchObject({
      kind: "automation",
    });
    expect(run({ event: "schedule" })).toMatchObject({
      kind: "automation",
      reason: "schedule event",
    });
  });

  it("defaults to a person, without false positives on similar words", () => {
    expect(run()).toMatchObject({ kind: "person" });
    expect(
      run({
        headBranch: "fix/codex-parser",
        commitMessage: "Mention Claude in docs",
      }),
    ).toMatchObject({ kind: "person" });
  });
});

describe("attributeRun: events and agent workflows", () => {
  it("credits workflows that run an agent, even when a person triggered them", () => {
    expect(
      run(
        { event: "issue_comment", path: ".github/workflows/claude.yml" },
        "jobs:\n  claude:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n",
      ),
    ).toEqual({
      kind: "agent",
      agent: "Claude",
      reason: "agent workflow",
      assisted: false,
    });
    expect(
      run({ event: "dynamic", path: "dynamic/copilot-swe-agent/copilot" }),
    ).toMatchObject({ kind: "agent", agent: "Copilot" });
    expect(
      run({
        event: "dynamic",
        path: "dynamic/agents/copilot-pull-request-reviewer",
      }),
    ).toMatchObject({
      kind: "agent",
      agent: "Copilot",
      reason: "agent workflow",
    });
  });

  it("ignores branch and commit signals for events that don't test pushed code", () => {
    // On comment/review/issue events the head commit is just the latest on main.
    const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";
    for (const event of [
      "issue_comment",
      "issues",
      "pull_request_review",
      "pull_request_target",
    ]) {
      expect(run({ event, commitMessage: trailer })).toMatchObject({
        kind: "person",
      });
    }
    expect(run({ event: "push", commitMessage: trailer })).toMatchObject({
      kind: "agent",
      agent: "Claude",
    });
  });

  it("treats GitHub-managed workflows that aren't agents as automation", () => {
    expect(
      run({
        event: "dynamic",
        path: "dynamic/github-code-scanning/codeql",
        commitMessage: "Co-Authored-By: Claude",
      }),
    ).toMatchObject({ kind: "automation" });
  });
});

describe("attributeRun: agents in Actions", () => {
  const lockFile = (engine: string) =>
    `# gh-aw-metadata: {"schema_version":"v4","agent_id":"${engine}","engine_versions":{}}\nname: PR Sous Chef\n`;

  it.each([
    ["copilot", "Copilot"],
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["gemini", "Gemini"],
    ["goose", "Other agent"],
  ])("reads the engine of a gh-aw workflow (%s → %s)", (engine, agent) => {
    expect(
      run(
        { event: "schedule", actor: "github-actions[bot]" },
        lockFile(engine),
      ),
    ).toMatchObject({ kind: "agent", agent, reason: "agent workflow" });
  });

  it("finds agent CLIs installed in a workflow", () => {
    expect(
      run({}, "steps:\n  - run: npm install -g @anthropic-ai/claude-code@2\n"),
    ).toMatchObject({ kind: "agent", agent: "Claude" });
    expect(run({}, "# we don't use @openai/codex here\n")).toMatchObject({
      kind: "person",
    });
  });

  it("credits CI on an agent's branch to the agent even when a bot pushed", () => {
    expect(
      run({ actor: "github-actions[bot]", headBranch: "copilot/fix-tests" }),
    ).toMatchObject({ kind: "agent", agent: "Copilot", reason: "branch name" });
    expect(
      run({
        actor: "github-actions[bot]",
        commitMessage: "Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      }),
    ).toMatchObject({ kind: "agent", agent: "Claude", assisted: false });
  });

  it("keeps dependency bots as automation", () => {
    expect(
      run({
        actor: "dependabot[bot]",
        headBranch: "dependabot/npm/foo",
        commitMessage: "Bump foo\n\nCo-authored-by: Copilot <x>",
      }),
    ).toMatchObject({ kind: "automation" });
  });
});

describe("attributionLabel", () => {
  it("names groups for reports", () => {
    expect(attributionLabel(run({ actor: "Copilot" }))).toBe("Copilot");
    expect(attributionLabel(run())).toBe("People");
    expect(attributionLabel(run({ event: "schedule" }))).toBe("Automation");
  });
});
