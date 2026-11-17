// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerificationPrompt, NO_FINDINGS_SENTENCE } from "../dist/prompt/index.js";

test("the verification evidence pool leaves out files that had no findings", () => {
  const [, user] = buildVerificationPrompt({
    perFileFindings: [
      { path: "clean.ts", findings: NO_FINDINGS_SENTENCE },
      { path: "bug.ts", findings: "- [high] Bug\n  File: bug.ts\n  Line: 3\n  Why: crash." },
    ],
    summary: "s",
    consolidatedFindings: "- [high] Bug",
    maxFindings: 5,
    refs: { base: "b", head: "h" },
  });
  assert.match(user.content, /### bug\.ts/);
  assert.doesNotMatch(user.content, /clean\.ts/);
});
