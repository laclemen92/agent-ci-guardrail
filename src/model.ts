/** Normalized GitHub Actions data. Everything the rules need, nothing more. */

/** A repository we can analyse. */
export interface RepoRef {
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  /** Display name of the workflow (`name:` in the YAML, or the file path). */
  name: string;
  /** Workflow file path, e.g. `.github/workflows/ci.yml`. */
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  /** Git tree of the head commit: identical trees mean identical files. */
  treeId?: string;
  headBranch: string | null;
  /** Who caused the run (the pusher, or the app that opened the PR). */
  actor?: string;
  /** Who started this attempt (differs from actor on re-runs). */
  triggeringActor?: string;
  /** Head commit message, trimmed; carries agent trailers like Co-Authored-By. */
  commitMessage?: string;
  /** PRs in this repo associated with the run (empty for PRs from forks). */
  pullRequests: number[];
  /** Latest attempt number. Jobs from every attempt are kept. */
  runAttempt: number;
  createdAt: string;
  /** When the latest attempt started running (after any concurrency wait). */
  runStartedAt?: string;
  updatedAt: string;
  url: string;
}

export interface JobStep {
  number: number;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Job {
  id: number;
  runId: number;
  runAttempt: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The `runs-on` labels the job requested. */
  labels: string[];
  runnerName: string | null;
  /** "GitHub Actions" for standard GitHub-hosted runners. */
  runnerGroupName: string | null;
  steps: JobStep[];
  url: string;
}

export interface WorkflowFile {
  id: number;
  name: string;
  path: string;
  state: string;
  /** YAML at the default branch, or null if it couldn't be read. */
  content: string | null;
}

/** Everything ingested for one repository. */
export interface RepoData {
  repo: RepoRef;
  /** Completed runs created in the analysis window. */
  runs: WorkflowRun[];
  /**
   * Jobs (all attempts), keyed by run id. Only for runs whose jobs were
   * fetched: a sample plus the runs rules asked for, or all with --full.
   */
  jobsByRun: Map<number, Job[]>;
  workflows: WorkflowFile[];
  /**
   * Per run id, the attempts that were "Re-run failed jobs" (GitHub copied the
   * passed jobs into them). Copies themselves are left out of jobsByRun.
   */
  rerunFailedAttempts?: Map<number, Set<number>>;
  /**
   * Files each run's path filters would see (the PR's diff, or the pushed
   * commit's), keyed by run id. Only for PR runs and default-branch pushes
   * of code workflows whose changes could be looked up.
   */
  changedFiles?: Map<number, string[]>;
  /** Runs in the window that were still queued or in progress, so left out. */
  incompleteRuns: number;
  /** True if Actions data wasn't accessible (Actions disabled or no permission). */
  inaccessible: boolean;
  /** True if some time slice had more runs than the API can return. */
  truncated: boolean;
  /** Requests that failed on GitHub's side even after retries; those runs were estimated. */
  failedRequests?: number;
}
