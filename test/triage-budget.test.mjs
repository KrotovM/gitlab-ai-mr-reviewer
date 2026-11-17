// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewMergeRequestMultiPass } from "../dist/cli/ci-review.js";

/** Fake OpenAI: `triageAnswers` answer the triage calls in order (an Error is
 *  thrown); any other call gets an empty review. */
const fakeLlm = (triageAnswers, triageRequests) => ({
  chat: {
    completions: {
      stream: (request) => ({
        finalChatCompletion: async () => {
          let content = "No confirmed bugs found.";
          if (request.response_format) {
            triageRequests.push(request);
            const next = triageAnswers.shift();
            if (next instanceof Error) throw next;
            content = next;
          }
          return { id: "x", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] };
        },
      }),
    },
  },
});

const run = async ({ changes, triageAnswers, maxTotalPromptChars = 220000, reviewInstructions }) => {
  const triageRequests = [];
  const logs = [];
  await reviewMergeRequestMultiPass({
    llm: fakeLlm(triageAnswers, triageRequests),
    aiModel: "m",
    promptLimits: { maxDiffs: 50, maxDiffChars: 16000, maxTotalPromptChars },
    triageDiffChars: 2000,
    changes,
    refs: { base: "b", head: "h" },
    gitLabProjectApiUrl: new URL("https://gitlab.example.com/api/v4/projects/1"),
    headers: {},
    maxFindings: 5,
    reviewConcurrency: 1,
    forceTools: false,
    allowProfileAutoDemote: true,
    reviewInstructions,
    loggers: { logStep: (m) => logs.push(m), logDebug: () => {} },
  });
  return { triageRequests, logs };
};

const chars = (request) => request.messages.reduce((n, m) => n + m.content.length, 0);
const file = (i) => ({
  old_path: `services/billing/src/handlers/very/deep/module_${i}.ts`,
  new_path: `services/billing/src/handlers/very/deep/module_${i}.ts`,
  diff: `@@ -1 +1 @@\n${"+x\n".repeat(2000)}`,
});

test("the triage prompt of a many-file MR stays within --max-total-prompt-chars, overhead included", async () => {
  const { triageRequests } = await run({
    changes: Array.from({ length: 300 }, (_, i) => file(i)),
    triageAnswers: [new Error("stop after triage")],
    maxTotalPromptChars: 100_000,
    reviewInstructions: "Check money rounding.\n".repeat(200),
  });
  const size = chars(triageRequests[0]);
  assert.ok(size <= 100_000, `triage prompt is ${size} chars`);
  // The budget is used, not just respected: each diff still gets a real slice.
  assert.ok(size > 90_000, `triage prompt is only ${size} chars`);
});

test("when the file list alone is over the cap, triage gets names only and says so", async () => {
  const { triageRequests, logs } = await run({
    changes: Array.from({ length: 300 }, (_, i) => file(i)),
    triageAnswers: [new Error("stop after triage")],
    maxTotalPromptChars: 1000,
  });
  assert.match(logs.join("\n"), /triage_diff_chars=0/);
  assert.match(logs.join("\n"), /triage sees file names and sizes only/);
  assert.doesNotMatch(triageRequests[0].messages.at(-1).content, /\+x/);
});

test("a failed weak-profile retry reports the weak response, not the first one", async () => {
  const { triageRequests, logs } = await run({
    changes: [file(1)],
    triageAnswers: ["not json at all", '{"files": []}'],
  });
  assert.equal(triageRequests.length, 2);
  const failure = logs.find((m) => m.startsWith("Triage parse failed"));
  assert.match(failure, /reason=invalid_schema/);
  assert.match(failure, /Preview: \{"files": \[\]\}/);
});
