// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_MARKER, upsertSummaryNote } from "../dist/gitlab/services.js";

const api = new URL("https://gitlab.example.com/api/v4/projects/1");
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fake GitLab: the token user is #7; `notes` is what the notes list returns
 *  (or a Response for an error); `put` answers the edit. */
const run = async ({ notes = [], put = () => json({}) } = {}) => {
  const calls = [];
  const logs = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname, query: u.search, body: init.body && JSON.parse(init.body).body });
    if (u.pathname === "/api/v4/user") return json({ id: 7 });
    if (method === "GET" && u.pathname.endsWith("/notes")) return notes instanceof Response ? notes : json(notes);
    if (method === "PUT") return put();
    if (method === "POST") return json({ id: 99 }, 201);
    throw new Error(`unexpected ${method} ${u.pathname}`);
  };
  const result = await upsertSummaryNote({
    gitLabProjectApiUrl: api,
    headers: {},
    mergeRequestIid: 5,
    note: "Review\n/approve",
    logStep: (m) => logs.push(m),
  });
  return { result, calls, logs, writes: calls.filter((c) => c.method !== "GET") };
};

const ours = { id: 3, body: `old review\n\n${SUMMARY_MARKER}`, author: { id: 7 } };

test("first run posts a new note carrying the hidden marker, with quick actions neutralized", async () => {
  const { result, writes } = await run();
  assert.equal(result, "created");
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ["POST /api/v4/projects/1/merge_requests/5/notes"]);
  assert.equal(writes[0].body, `Review\n /approve\n\n${SUMMARY_MARKER}`);
});

test("later runs edit their own earlier note instead of adding another", async () => {
  const { result, calls, writes } = await run({ notes: [{ id: 1, body: "human", author: { id: 2 } }, ours] });
  assert.equal(result, "updated");
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ["PUT /api/v4/projects/1/merge_requests/5/notes/3"]);
  assert.equal(writes[0].body, `Review\n /approve\n\n${SUMMARY_MARKER}`);
  // Most recently updated first, so the note is found on the first page.
  assert.match(calls.find((c) => c.path.endsWith("/notes")).query, /order_by=updated_at&sort=desc/);
});

test("a note quoting the marker but written by someone else is left alone", async () => {
  const { result, writes } = await run({ notes: [{ ...ours, author: { id: 2 } }] });
  assert.equal(result, "created");
  assert.deepEqual(writes.map((w) => w.method), ["POST"]);
});

test("when the old note can't be listed or edited, a new note is posted and the reason logged", async () => {
  const listFails = await run({ notes: new Response("boom", { status: 500 }) });
  assert.equal(listFails.result, "created");
  assert.deepEqual(listFails.writes.map((w) => w.method), ["POST"]);
  assert.match(listFails.logs[0], /Could not find the earlier AI review note.*500/);

  const editFails = await run({ notes: [ours], put: () => new Response("forbidden", { status: 403 }) });
  assert.equal(editFails.result, "created");
  assert.deepEqual(editFails.writes.map((w) => w.method), ["PUT", "POST"]);
  assert.match(editFails.logs[0], /Could not update the earlier AI review note.*403/);
});
