# Agent CI guardrail

AI coding agents push often: 3–5 times per PR in the repos we measured, and each push runs your
full CI. 48–88% of what their PRs cost in CI goes on pushes that a later push replaced.

This Action lets an agent's **work in progress** run only your quick checks, and runs the
**full suite once its PR is ready for review**. People's pushes are never affected.

| Run                                                                          | Gets  |
| ---------------------------------------------------------------------------- | ----- |
| An agent's draft PR, or an agent branch with no PR yet                       | light |
| The agent marks the PR ready for review (Copilot does this when it finishes) | full  |
| A PR with the `ci:full` label                                                | full  |
| Anything from a person, the default branch, merge queues, schedules          | full  |
| Anything the guard can't work out, or any error                              | full  |

Agents are recognised by account (Copilot, `claude[bot]`, Codex, Cursor, Devin, Jules), by the
PR's author, and by default branch names (`copilot/`, `codex/`, `claude/`…).

## Usage

```yaml
on:
  push:
    branches: [main]
  pull_request:
    # ready_for_review is required: it's what runs the full suite when the agent is done.
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: read

jobs:
  lint: # quick checks: always run, and decide for the rest
    runs-on: ubuntu-latest
    outputs:
      full: ${{ steps.guard.outputs.full }}
    steps:
      - id: guard
        uses: laclemen92/agent-ci-guardrail@v0
      - uses: actions/checkout@v5
      - run: npm ci && npm run lint && npm run build

  test:
    needs: lint
    if: needs.lint.outputs.full == 'true'
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm test
```

Put the guard in a job you already run, as above. A separate guard job would add a billed
minute to every run, because GitHub rounds each job up to a whole minute.

**Safety:** skipped jobs count as passing in branch protection. The guard reads its own workflow
file, and if `ready_for_review` isn't among the `pull_request` types it always runs the full
suite (the job summary says why). Draft PRs can't be merged, so a light run is never the last
word on code that merges.

## Inputs

| Input              | Default        |                                                                                                    |
| ------------------ | -------------- | -------------------------------------------------------------------------------------------------- |
| `full-label`       | `ci:full`      | PR label that forces the full suite                                                                |
| `agents`           | `all`          | Agents to guard, comma-separated (`Copilot, Codex`)                                                |
| `include-assisted` | `false`        | Also guard people pushing agent-written commits (co-author markers)                                |
| `token`            | `github.token` | Used for at most three read-only lookups: the workflow file, the branch's open PR, the head commit |

## Outputs

`mode` (`light` or `full`), `full` (`true`/`false`), `agent` (e.g. `Copilot`, empty for
people) and `reason`. The reason also appears in the job summary.

## Development

`pnpm install`, then `pnpm test`. The Action runs from the committed bundle `dist/index.mjs`:
after changing `src/`, run `pnpm build` and commit the bundle. CI fails if it's out of date.
