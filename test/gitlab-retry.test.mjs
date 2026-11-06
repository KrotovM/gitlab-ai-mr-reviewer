// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFileAtRef, postMergeRequestNote } from "../dist/gitlab/services.js";

const api = new URL("https://gitlab.example.com/api/v4/projects/1");

/** Fake GitLab answering from `responses` in order (a function throws a network error). */
const serve = (responses) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(init.method ?? "GET");
    const next = responses.shift();
    if (typeof next === "function") next();
    return next;
  };
  return calls;
};
const busy = (status) => new Response("busy", { status, headers: { "retry-after": "0" } });
const getFile = () => fetchFileAtRef({ gitLabProjectApiUrl: api, headers: {}, filePath: "a.ts", ref: "h" });

test("rate limits and gateway errors are retried, honoring Retry-After", async () => {
  const calls = serve([busy(429), busy(502), new Response("code")]);
  assert.equal(await getFile(), "code");
  assert.equal(calls.length, 3);
});

test("a network error is retried too, and a note POST is retried like a GET", async () => {
  const calls = serve([() => { throw new TypeError("fetch failed"); }, new Response("{}", { status: 201 })]);
  const res = await postMergeRequestNote({ gitLabProjectApiUrl: api, headers: {}, mergeRequestIid: 5, note: "x" });
  assert.equal(res, undefined);
  assert.deepEqual(calls, ["POST", "POST"]);
});

test("retries stop after 3 and return the last error", async () => {
  const calls = serve([busy(503), busy(503), busy(503), busy(503), new Response("never")]);
  const res = await getFile();
  assert.equal(res.statusCode, 503);
  assert.equal(calls.length, 4);
});

test("other statuses are final: a missing file or a server bug is not retried", async () => {
  for (const status of [404, 500]) {
    const calls = serve([new Response("no", { status }), new Response("never")]);
    assert.equal((await getFile()).statusCode, status);
    assert.equal(calls.length, 1);
  }
});
