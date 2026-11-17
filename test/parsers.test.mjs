// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../dist/cli/args.js";
import {
  insertBeforeDisclaimer,
  isEmptyReviewBody,
  parseTriageResponseDetailed,
} from "../dist/prompt/index.js";

const triage = (text) => parseTriageResponseDetailed(text);
const json = { summary: "s", files: [{ path: "a.ts", verdict: "SKIP", reason: " docs only " }] };

test("triage: plain, fenced and prose-wrapped JSON all parse", () => {
  const expected = { summary: "s", files: [{ path: "a.ts", verdict: "SKIP", reason: "docs only" }] };
  for (const text of [
    JSON.stringify(json),
    "```json\n" + JSON.stringify(json) + "\n```",
    `Here is the JSON: ${JSON.stringify(json)} Hope it helps {`,
  ]) {
    assert.deepEqual(triage(text), { result: expected, reason: null, parseError: null }, text);
  }
});

test("triage: failures name a reason; bad file entries are dropped", () => {
  assert.equal(triage("  ").reason, "empty_response");
  assert.equal(triage("not json").reason, "invalid_json");
  assert.equal(triage('{"files": []}').reason, "invalid_schema");
  const { result } = triage(
    JSON.stringify({ summary: "s", files: [{ path: "a.ts", verdict: "MAYBE" }, { verdict: "SKIP" }, { path: "b.ts", verdict: "NEEDS_REVIEW", reason: "" }] }),
  );
  assert.deepEqual(result.files, [{ path: "b.ts", verdict: "NEEDS_REVIEW" }]);
});

test("isEmptyReviewBody: sentinel and synonyms are empty, a severity bullet never is", () => {
  for (const text of ["", "No confirmed bugs or high-value optimizations found.", "No issues were found.", "Nothing to report."]) {
    assert.equal(isEmptyReviewBody(text), true, text);
  }
  assert.equal(isEmptyReviewBody("- [high] Bug\nNo issues found elsewhere."), false);
  assert.equal(isEmptyReviewBody("The cache is never cleared."), false);
});

test("insertBeforeDisclaimer puts the note above the trailing disclaimer", () => {
  assert.equal(insertBeforeDisclaimer("body\n\n---\n_AI_", "note"), "body\n\nnote\n\n---\n_AI_");
  assert.equal(insertBeforeDisclaimer("body", "note"), "body\n\nnote");
});

test("parseCliArgs: defaults, normalized extensions, env concurrency, flag wins", () => {
  const saved = process.env.AI_REVIEW_CONCURRENCY;
  try {
    delete process.env.AI_REVIEW_CONCURRENCY;
    const defaults = parseCliArgs([]);
    assert.equal(defaults.inlineComments, false);
    assert.equal(defaults.maxFindings, 5);
    assert.equal(defaults.reviewConcurrency, 2);

    const opts = parseCliArgs(["--ignore-ext=md, .LOCK", "--ignore-ext", "md", "--inline-comments", "--max-findings=3"]);
    assert.deepEqual(opts.ignoredExtensions, [".md", ".lock"]);
    assert.equal(opts.inlineComments, true);
    assert.equal(opts.maxFindings, 3);

    process.env.AI_REVIEW_CONCURRENCY = "1";
    assert.equal(parseCliArgs([]).reviewConcurrency, 1);
    assert.equal(parseCliArgs(["--max-review-concurrency=4"]).reviewConcurrency, 4);
  } finally {
    if (saved === undefined) delete process.env.AI_REVIEW_CONCURRENCY;
    else process.env.AI_REVIEW_CONCURRENCY = saved;
  }
});

test("parseCliArgs skips unknown or malformed arguments and lists them for a warning", () => {
  const opts = parseCliArgs([
    "--inline-coments",
    "--debug=1",
    "--old-flag=x",
    "-z",
    "stray",
    "--inline-comments",
    "--max-findings=3",
    "--max-diffs",
  ]);
  assert.deepEqual(opts.ignoredArgs, [
    "--inline-coments",
    "--debug=1",
    "--old-flag=x",
    "-z",
    "stray",
    "--max-diffs (no value)",
  ]);
  assert.equal(opts.inlineComments, true);
  assert.equal(opts.debug, false);
  assert.equal(opts.maxFindings, 3);
  assert.equal(opts.promptLimits.maxDiffs, 50);
  assert.deepEqual(parseCliArgs(["--ignore-ext"]).ignoredExtensions, []);
  assert.deepEqual(parseCliArgs(["--debug"]).ignoredArgs, []);
});

test("parseCliArgs still rejects bad numbers", () => {
  assert.throws(() => parseCliArgs(["--max-findings=0"]), /Expected integer >= 1/);
  assert.throws(() => parseCliArgs(["--max-diffs=1.5"]), /Invalid value for --max-diffs/);
  assert.throws(() => parseCliArgs(["--max-findings="]), /Invalid value for --max-findings/);
});
