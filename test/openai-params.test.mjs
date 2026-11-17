// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewMergeRequestMultiPass } from "../dist/cli/ci-review.js";

test("a model that rejects temperature (OpenAI reasoning models) is retried without it for the rest of the run", async () => {
  const sent = [];
  let rejections = 0;
  const llm = {
    chat: {
      completions: {
        stream: (request) => ({
          finalChatCompletion: async () => {
            if ("temperature" in request) {
              rejections += 1;
              throw Object.assign(
                new Error("400 Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported."),
                { status: 400 },
              );
            }
            sent.push(request);
            const content = request.response_format
              ? JSON.stringify({ summary: "s", files: [{ path: "a.ts", verdict: "NEEDS_REVIEW" }] })
              : "No confirmed bugs found.";
            return { id: "x", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] };
          },
        }),
      },
    },
  };
  const answer = await reviewMergeRequestMultiPass({
    llm,
    aiModel: "m",
    promptLimits: { maxDiffs: 50, maxDiffChars: 16000, maxTotalPromptChars: 220000 },
    triageDiffChars: 2000,
    changes: [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }],
    refs: { base: "b", head: "h" },
    gitLabProjectApiUrl: new URL("https://gitlab.example.com/api/v4/projects/1"),
    headers: {},
    maxFindings: 5,
    reviewConcurrency: 1,
    forceTools: false,
    loggers: { logStep: () => {}, logDebug: () => {} },
  });
  assert.equal(rejections, 1);
  // Triage, then the per-file review; consolidation is skipped with no findings.
  assert.equal(sent.length, 2);
  assert.ok(sent.every((r) => r.stream_options != null), "usage is still requested");
  assert.match(answer, /No confirmed bugs/);
});
