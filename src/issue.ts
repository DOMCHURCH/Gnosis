// GitHub issue → PR pipeline. `/issue <url>` reads an issue, implements it as a
// dream in an isolated worktree, runs the tests, and opens a PR that closes it.
//
// The isolation is the point. A dream that edits the working tree you are also
// using would collide with your own turns, so the work happens on its own branch
// in its own directory, and the only thing that reaches the shared repo is a PR
// you review.
//
// Everything here that can be tested without a network is a pure function: URL
// parsing, prompt construction, PR body, and the retry decision. The `gh` calls
// are thin wrappers around those.

import { execa } from "execa";

/** A parsed reference to a GitHub issue. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface IssueDetail extends IssueRef {
  title: string;
  body: string;
  url: string;
}

/**
 * Parse an issue reference. Accepts a full URL, `owner/repo#123`, or a bare
 * `#123` / `123` when a fallback repo is known (the session's own remote).
 */
export function parseIssueRef(input: string, fallback?: { owner: string; repo: string }): IssueRef | null {
  const text = (input ?? "").trim();
  if (!text) return null;

  const url = /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i.exec(text);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };

  const qualified = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/.exec(text);
  if (qualified) return { owner: qualified[1]!, repo: qualified[2]!, number: Number(qualified[3]) };

  const bare = /^#?(\d+)$/.exec(text);
  if (bare && fallback) return { owner: fallback.owner, repo: fallback.repo, number: Number(bare[1]) };

  return null;
}

/** `owner/repo` for the git remote of `cwd`, via gh. Null when unavailable. */
export async function currentRepo(cwd: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const r = await execa("gh", ["repo", "view", "--json", "owner,name"], { cwd, reject: false, timeout: 20000 });
    if (r.exitCode !== 0) return null;
    const j = JSON.parse(r.stdout);
    const owner = j?.owner?.login;
    const repo = j?.name;
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

/** Fetch an issue's title and body. Returns an error string rather than throwing. */
export async function fetchIssue(ref: IssueRef, cwd: string): Promise<{ ok: true; issue: IssueDetail } | { ok: false; error: string }> {
  try {
    const r = await execa(
      "gh",
      ["api", `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, "--jq", "{title:.title,body:.body,url:.html_url,pull:.pull_request}"],
      { cwd, reject: false, timeout: 30000 },
    );
    if (r.exitCode !== 0) return { ok: false, error: (r.stderr || r.stdout || "gh api failed").trim().split(/\r?\n/)[0]! };
    const j = JSON.parse(r.stdout || "{}");
    // The issues endpoint also returns PRs; implementing one as an issue is
    // almost certainly a mistake worth naming.
    if (j.pull) return { ok: false, error: `#${ref.number} is a pull request, not an issue` };
    return { ok: true, issue: { ...ref, title: String(j.title ?? ""), body: String(j.body ?? ""), url: String(j.url ?? "") } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The dream's task prompt: the issue itself, plus what "done" means here. */
export function issueTaskPrompt(issue: IssueDetail): string {
  return [
    `Implement this GitHub issue, write tests, and open a PR when done.`,
    ``,
    `ISSUE #${issue.number}: ${issue.title}`,
    ``,
    issue.body.trim() || "(no description)",
    ``,
    `Work only within this repository. Add or update tests that would fail without your change.`,
    `Do not commit secrets. When you are finished, summarise what you changed in one line.`,
  ].join("\n");
}

/** Branch/worktree name for an issue — `gnosis/issue-<n>` once prefixed. */
export function issueBranchName(number: number): string {
  return `issue-${number}`;
}

/** The floor label for a dream spawned from an issue: "#241 implement rate limiting". */
export function issueLabel(issue: { number: number; title: string }): string {
  return `#${issue.number} ${issue.title}`.slice(0, 60);
}

export interface TestOutcome {
  ok: boolean;
  output: string;
}

/**
 * Run the repo's test suite in the worktree. `npm test` is the contract; a repo
 * without one is treated as passing rather than blocking the PR on a script that
 * was never going to exist.
 */
export async function runTests(cwd: string, command = "npm test"): Promise<TestOutcome> {
  try {
    const [bin, ...args] = command.split(/\s+/);
    const r = await execa(bin!, args, { cwd, reject: false, timeout: 15 * 60 * 1000, windowsHide: true });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    if (r.exitCode === 0) return { ok: true, output };
    // "Missing script: test" is not a failing test suite.
    if (/missing script|no test specified/i.test(output)) return { ok: true, output: "(no test script — skipped)" };
    return { ok: false, output };
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
}

/** The follow-up task after a failed test run — one retry, with the evidence. */
export function retryPrompt(issue: IssueDetail, failure: string): string {
  return [
    `The test suite failed after your change to issue #${issue.number}. Fix it.`,
    ``,
    `FAILURE OUTPUT (tail):`,
    failure.split(/\r?\n/).slice(-60).join("\n"),
    ``,
    `Change only what is needed to make the suite pass. Do not disable or delete tests to get green.`,
  ].join("\n");
}

/** PR title and body. The body closes the issue, which is the whole point. */
export function prTitle(issue: IssueDetail): string {
  return `${issue.title} (#${issue.number})`;
}

export function prBody(issue: IssueDetail, summary: string, tests: TestOutcome): string {
  return [
    `Closes #${issue.number}`,
    ``,
    summary.trim() || "Implemented by a Gnosis dream.",
    ``,
    `---`,
    `Tests: ${tests.ok ? "passing" : "FAILING"}`,
    `Opened by \`/issue\` — a Gnosis dream working in an isolated worktree.`,
  ].join("\n");
}

/** Open the PR. Draft by default: a machine-authored PR should be reviewed. */
export async function openPr(
  cwd: string,
  opts: { title: string; body: string; branch: string; base?: string; draft?: boolean },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const args = ["pr", "create", "--title", opts.title, "--body", opts.body, "--head", opts.branch];
    if (opts.base) args.push("--base", opts.base);
    if (opts.draft !== false) args.push("--draft");
    const r = await execa("gh", args, { cwd, reject: false, timeout: 60000 });
    if (r.exitCode !== 0) return { ok: false, error: (r.stderr || r.stdout || "gh pr create failed").trim().split(/\r?\n/).slice(-1)[0]! };
    const url = (r.stdout || "").trim().split(/\r?\n/).pop() ?? "";
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Push the worktree branch so a PR can reference it. */
export async function pushBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const r = await execa("git", ["push", "-u", "origin", branch], { cwd, reject: false, timeout: 120000 });
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-1)[0] };
}

/** Live state for one issue being worked. Kept in memory; `/issue status` reads it. */
export interface IssueJob {
  ref: IssueRef;
  title: string;
  dreamId: string;
  branch: string;
  worktree: string;
  stage: "implementing" | "testing" | "retrying" | "opening-pr" | "done" | "failed";
  prUrl?: string;
  note?: string;
}

/** One line for `/issue status`. */
export function formatIssueJob(j: IssueJob): string {
  const pr = j.prUrl ? ` → ${j.prUrl}` : "";
  const note = j.note ? ` — ${j.note}` : "";
  return `#${j.ref.number} [${j.stage}] ${j.branch} (dream ${j.dreamId})${pr}${note}`;
}

// --- orchestration -----------------------------------------------------------

/** What the pipeline needs from the host to do its work. */
export interface IssueDeps {
  /** Start a dream on `task` inside `cwd`; returns its id. */
  startDream: (task: string, cwd: string) => string;
  /** Register a callback for when a specific dream finishes. */
  onDreamFinish: (id: string, cb: (summary: string, status: string) => void) => void;
  /** Give the dream a floor label. */
  label: (dreamId: string, label: string) => void;
  /** Report progress to the user. */
  say: (line: string) => void;
  /** Test command; defaults to `npm test`. */
  testCommand?: string;
  /** Open the PR as a draft (default true). */
  draft?: boolean;
}

/**
 * Drive one issue from fetch to PR. The dream does the implementing; this
 * function owns everything around it — worktree, tests, the single retry, and
 * the PR — because those are deterministic steps that should not depend on the
 * model remembering to do them.
 */
export async function runIssuePipeline(
  issue: IssueDetail,
  worktreePath: string,
  branch: string,
  deps: IssueDeps,
  job: IssueJob,
): Promise<void> {
  const finish = (stage: IssueJob["stage"], note?: string) => {
    job.stage = stage;
    if (note) job.note = note;
  };

  const dreamId = deps.startDream(issueTaskPrompt(issue), worktreePath);
  job.dreamId = dreamId;
  deps.label(dreamId, issueLabel(issue));
  deps.say(`#${issue.number}: dreaming ${dreamId} in ${branch}`);

  let attempt = 0;
  const afterDream = async (summary: string, status: string): Promise<void> => {
    if (status !== "done") {
      finish("failed", `dream ${status}`);
      deps.say(`#${issue.number}: dream ${status} — no PR opened`);
      return;
    }
    finish("testing");
    deps.say(`#${issue.number}: running the test suite…`);
    const tests = await runTests(worktreePath, deps.testCommand);

    if (!tests.ok && attempt === 0) {
      // Exactly one retry, with the failure as evidence. A second failure means
      // the change needs a human, not another loop.
      attempt++;
      finish("retrying", "tests failed — retrying once");
      deps.say(`#${issue.number}: tests failed — one retry with the output`);
      const retryId = deps.startDream(retryPrompt(issue, tests.output), worktreePath);
      job.dreamId = retryId;
      deps.label(retryId, issueLabel(issue));
      deps.onDreamFinish(retryId, (s, st) => void afterDream(s, st));
      return;
    }
    if (!tests.ok) {
      finish("failed", "tests still failing after one retry");
      deps.say(`#${issue.number}: tests still failing after the retry — no PR opened`);
      return;
    }

    finish("opening-pr");
    const pushed = await pushBranch(worktreePath, branch);
    if (!pushed.ok) {
      finish("failed", `push failed: ${pushed.error ?? ""}`);
      deps.say(`#${issue.number}: could not push ${branch} — ${pushed.error ?? ""}`);
      return;
    }
    const pr = await openPr(worktreePath, {
      title: prTitle(issue),
      body: prBody(issue, summary, tests),
      branch,
      draft: deps.draft !== false,
    });
    if (!pr.ok) {
      finish("failed", `pr failed: ${pr.error}`);
      deps.say(`#${issue.number}: PR could not be opened — ${pr.error}`);
      return;
    }
    job.prUrl = pr.url;
    finish("done");
    deps.say(`#${issue.number}: PR opened — ${pr.url}`);
  };

  deps.onDreamFinish(dreamId, (s, st) => void afterDream(s, st));
}
