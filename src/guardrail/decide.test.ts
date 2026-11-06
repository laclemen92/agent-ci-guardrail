import { describe, expect, it } from "vitest";
import { decide, DEFAULT_OPTIONS, type GuardContext } from "./decide.js";

const ctx = (extra: Partial<GuardContext> = {}): GuardContext => ({
  event: "pull_request",
  actor: "alice",
  triggeringActor: "alice",
  branch: "feature",
  defaultBranch: "main",
  workflowPath: ".github/workflows/ci.yml",
  rerunsWhenReady: true,
  ...extra,
});

const pr = (extra: Partial<NonNullable<GuardContext["pullRequest"]>> = {}) => ({
  number: 12,
  draft: false,
  author: "alice",
  labels: [],
  ...extra,
});

describe("decide", () => {
  it("runs the full suite for people", () => {
    expect(decide(ctx({ pullRequest: pr({ draft: true }) }))).toMatchObject({
      mode: "full",
      reason: "pushed by a person",
    });
  });

  it("runs light checks on an agent's draft PR", () => {
    expect(
      decide(
        ctx({
          actor: "Copilot",
          triggeringActor: "Copilot",
          branch: "copilot/fix-login",
          pullRequest: pr({ draft: true, author: "Copilot" }),
        }),
      ),
    ).toEqual({
      mode: "light",
      agent: "Copilot",
      reason: "Copilot is still working: PR #12 is a draft",
    });
  });

  it("runs the full suite once the agent's PR is ready for review", () => {
    expect(
      decide(
        ctx({
          actor: "Copilot",
          branch: "copilot/fix-login",
          pullRequest: pr({ author: "Copilot" }),
        }),
      ),
    ).toMatchObject({ mode: "full", agent: "Copilot" });
  });

  it("runs light checks on an agent branch with no PR yet", () => {
    expect(
      decide(ctx({ event: "push", branch: "codex/refactor" })),
    ).toMatchObject({ mode: "light", agent: "Codex" });
  });

  it("recognises an agent's PR by its author when a person triggered the run", () => {
    expect(
      decide(
        ctx({
          branch: "fix-login",
          pullRequest: pr({ draft: true, author: "claude[bot]" }),
        }),
      ),
    ).toMatchObject({ mode: "light", agent: "Claude" });
  });

  it("lets a label force the full suite", () => {
    expect(
      decide(
        ctx({
          branch: "copilot/x",
          pullRequest: pr({ draft: true, labels: ["ci:full"] }),
        }),
      ),
    ).toMatchObject({ mode: "full", reason: "PR #12 has the ci:full label" });
  });

  it("always runs the full suite on the default branch and non-code events", () => {
    expect(
      decide(ctx({ event: "push", branch: "main", actor: "Copilot" })),
    ).toMatchObject({ mode: "full", reason: "default branch" });
    expect(
      decide(ctx({ event: "merge_group", branch: "copilot/x" })),
    ).toMatchObject({ mode: "full" });
  });

  it("guards agent-assisted pushes (local agents push as the person) unless turned off", () => {
    const assisted = ctx({
      event: "push",
      commitMessage: "Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>",
    });
    expect(decide(assisted)).toMatchObject({ mode: "light", agent: "Claude" });
    expect(
      decide(assisted, { ...DEFAULT_OPTIONS, includeAssisted: false }),
    ).toMatchObject({ mode: "full" });
  });

  it("never goes light if the workflow won't re-run when the PR is ready", () => {
    for (const rerunsWhenReady of [false, undefined]) {
      expect(
        decide(
          ctx({
            branch: "copilot/x",
            pullRequest: pr({ draft: true }),
            rerunsWhenReady,
          }),
        ),
      ).toMatchObject({ mode: "full", agent: "Copilot" });
    }
  });

  it("guards only the agents asked for", () => {
    const codex = ctx({ event: "push", branch: "codex/x" });
    expect(
      decide(codex, { ...DEFAULT_OPTIONS, agents: ["Copilot"] }),
    ).toMatchObject({ mode: "full" });
  });
});
