// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGetFileTool } from "../dist/cli/ci-review.js";

const api = new URL("https://gitlab.example.com/api/v4/projects/1");

const read = async (fileText, args) => {
  globalThis.fetch = async () => new Response(fileText);
  return JSON.parse(
    await handleGetFileTool(JSON.stringify({ path: "a.ts", ref: "h", ...args }), api, {}, () => {}),
  );
};

test("get_file_at_ref numbers lines and reports the file length", async () => {
  const r = await read("a\nb\nc\n");
  assert.equal(r.content, "1\ta\n2\tb\n3\tc");
  assert.deepEqual([r.start_line, r.end_line, r.total_lines, r.truncated], [1, 3, 3, false]);
});

test("get_file_at_ref returns only the requested lines", async () => {
  const r = await read("a\nb\nc\nd\ne", { start_line: 2, end_line: 3 });
  assert.equal(r.content, "2\tb\n3\tc");
  assert.deepEqual([r.start_line, r.end_line, r.total_lines, r.truncated], [2, 3, 5, false]);
});

test("a large file is cut at a line boundary and says where to continue", async () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
  const first = await read(text);
  assert.equal(first.truncated, true);
  assert.ok(first.content.length <= 12_000);
  assert.ok(first.content.endsWith(`${first.end_line}\tline ${first.end_line}`));
  assert.equal(first.next_start_line, first.end_line + 1);

  // The tail of the file is reachable, which it wasn't before.
  const tail = await read(text, { start_line: 2990 });
  assert.equal(tail.content.split("\n")[0], "2990\tline 2990");
  assert.deepEqual([tail.end_line, tail.truncated], [3000, false]);
});

test("a range past the end of the file is an error the model can act on", async () => {
  const r = await read("a\nb", { start_line: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /start_line 5 is past the end of the file \(2 lines\)/);
});
