// Verify (issue → PR pipeline): reference parsing in every accepted form, the
// prompts the dream and its one retry receive, the PR body that closes the
// issue, and the branch/label naming the floor shows.
import {
  parseIssueRef, issueTaskPrompt, issueBranchName, issueLabel,
  retryPrompt, prTitle, prBody, formatIssueJob, runTests,
} from "../dist/issue.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const FALLBACK = { owner: "DOMCHURCH", repo: "Gnosis" };

// --- reference parsing ----------------------------------------------------------
const url = parseIssueRef("https://github.com/DOMCHURCH/Gnosis/issues/241");
ok("a full issue URL parses", url && url.number === 241);
ok("...with the owner", url.owner === "DOMCHURCH");
ok("...and the repo", url.repo === "Gnosis");
ok("http and trailing text are tolerated", parseIssueRef("see http://github.com/a/b/issues/7 please").number === 7);
ok("owner/repo#n parses", parseIssueRef("DOMCHURCH/Gnosis#12").number === 12);
ok("a bare #n uses the current repo", parseIssueRef("#5", FALLBACK).number === 5);
ok("...taking the fallback owner", parseIssueRef("#5", FALLBACK).owner === "DOMCHURCH");
ok("a bare number uses the current repo", parseIssueRef("5", FALLBACK).number === 5);
ok("a bare number without a fallback is refused", parseIssueRef("5") === null);
ok("nonsense is refused", parseIssueRef("not an issue") === null);
ok("empty input is refused", parseIssueRef("") === null);
ok("a PR url is not read as an issue", parseIssueRef("https://github.com/a/b/pull/9") === null);

// --- naming the floor shows -----------------------------------------------------
ok("the branch name is issue-<n>", issueBranchName(241) === "issue-241");
ok("the floor label leads with the issue number", issueLabel({ number: 241, title: "implement rate limiting" }) === "#241 implement rate limiting");
ok("a very long title is trimmed for the floor", issueLabel({ number: 1, title: "x".repeat(200) }).length <= 60);

// --- the dream's prompt ----------------------------------------------------------
const issue = { owner: "o", repo: "r", number: 241, title: "implement rate limiting", body: "We need a token bucket.", url: "u" };
const task = issueTaskPrompt(issue);
ok("the prompt states the job", /implement this github issue/i.test(task));
ok("...asks for tests", /write tests/i.test(task));
ok("...carries the issue number and title", task.includes("#241") && task.includes("implement rate limiting"));
ok("...and the body", task.includes("token bucket"));
ok("an empty body is handled", issueTaskPrompt({ ...issue, body: "" }).includes("(no description)"));

// --- the single retry -------------------------------------------------------------
const retry = retryPrompt(issue, "FAIL x\n".repeat(200) + "LAST LINE");
ok("the retry names the failure", /test suite failed/i.test(retry));
ok("...includes the tail of the output", retry.includes("LAST LINE"));
ok("...but not the whole log", retry.split("\n").length < 80);
ok("...and forbids deleting tests to get green", /do not disable or delete tests/i.test(retry));

// --- the PR ------------------------------------------------------------------------
ok("the PR title carries the issue number", prTitle(issue) === "implement rate limiting (#241)");
const body = prBody(issue, "Added a token bucket limiter.", { ok: true, output: "" });
ok("the PR body closes the issue", body.startsWith("Closes #241"));
ok("...includes the summary", body.includes("Added a token bucket limiter."));
ok("...records the test result", /Tests: passing/.test(body));
ok("...and says what opened it", /\/issue/.test(body));
ok("a failing suite is stated plainly in the body", /Tests: FAILING/.test(prBody(issue, "s", { ok: false, output: "" })));
ok("an empty summary still yields a usable body", prBody(issue, "", { ok: true, output: "" }).includes("Gnosis dream"));

// --- status line ------------------------------------------------------------------
const line = formatIssueJob({ ref: { owner: "o", repo: "r", number: 241 }, title: "t", dreamId: "d3", branch: "gnosis/issue-241", stage: "testing", worktree: "/w" });
ok("the status line shows the issue, stage and branch", /#241/.test(line) && /testing/.test(line) && /gnosis\/issue-241/.test(line));
ok("...and the dream running it", /d3/.test(line));
ok("a finished job shows its PR url", /http/.test(formatIssueJob({ ref: { owner: "o", repo: "r", number: 1 }, title: "t", dreamId: "d1", branch: "b", stage: "done", worktree: "/w", prUrl: "https://x/pr/1" })));

// --- a repo with no test script must not block the PR -------------------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosis-notest-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }), "utf8");
  const res = await runTests(dir);
  ok("a repo with no test script counts as passing", res.ok === true);
  ok("...and says so rather than pretending it ran", /no test script/i.test(res.output));
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
