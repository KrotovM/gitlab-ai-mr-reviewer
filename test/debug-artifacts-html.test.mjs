// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDebugArtifactsHtml } from "../dist/cli/debug-artifacts-html.js";

/** Renders one response per label with the given usage; returns the page and
 *  the "Token Usage by Pass" table as rows of cell texts. */
async function render(usageByLabel) {
  const dir = await mkdtemp(join(tmpdir(), "ai-review-report-"));
  const artifactHtmlFile = join(dir, "report.html");
  await renderDebugArtifactsHtml({
    records: Object.entries(usageByLabel).map(([label, usage]) => ({
      kind: "openai_response",
      label,
      response: { usage, choices: [] },
    })),
    artifactHtmlFile,
    cliVersion: "test",
    aiModel: "test",
  });
  const html = await readFile(artifactHtmlFile, "utf8");
  await rm(dir, { recursive: true, force: true });
  const table = html.split("<h2>Token Usage by Pass</h2>")[1].split("</table>")[0];
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1]),
  );
  return { html, rows };
}

const header = ["Pass", "Requests", "Prompt", "Cache read", "Cache write", "Completion", "Total", "Duration"];

test("debug report: Anthropic cache reads and writes per pass and in the totals", async () => {
  // Usage as createAnthropicCompletion returns it: raw fields plus prompt_tokens
  // = input + cache write + cache read.
  const { html, rows } = await render({
    triage_pass: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
      prompt_tokens: 310,
      completion_tokens: 5,
      total_tokens: 315,
    },
    verification_pass_round_1: {
      input_tokens: 20,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 400,
      prompt_tokens: 420,
      completion_tokens: 7,
      total_tokens: 427,
    },
  });
  assert.deepEqual(rows, [
    header,
    ["Triage", "1", "310", "100", "200", "5", "315", "—"],
    ["Verification", "1", "420", "400", "0", "7", "427", "—"],
    ["Total", "2", "730", "500", "200", "12", "742", "—"],
  ]);
  assert.ok(html.includes("cache read 500 • cache write 200"), "Total tokens card");
  assert.ok(
    html.includes("prompt: 310 • cache read: 100 • cache write: 200 • completion: 5 • total: 315"),
    "triage section header",
  );
});

test("debug report: OpenAI cached_tokens count as cache reads; missing fields show 0 or n/a", async () => {
  const { html, rows } = await render({
    triage_pass: {
      prompt_tokens: 300,
      completion_tokens: 10,
      total_tokens: 310,
      prompt_tokens_details: { cached_tokens: 256, audio_tokens: 0 },
    },
    consolidate_pass: undefined,
    verification_pass_round_1: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
  });
  assert.deepEqual(rows, [
    header,
    ["Triage", "1", "300", "256", "0", "10", "310", "—"],
    ["Consolidation", "1", "n/a", "n/a", "n/a", "n/a", "n/a", "—"],
    ["Verification", "1", "100", "0", "0", "5", "105", "—"],
    ["Total", "3", "400", "256", "0", "15", "415", "—"],
  ]);
  assert.ok(html.includes("cache read 256 • cache write 0"), "Total tokens card");
});
