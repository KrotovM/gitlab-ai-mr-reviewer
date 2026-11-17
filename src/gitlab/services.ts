/** @format */

type GitLabErrorName =
  | "MISSING_DIFF"
  | "FILE_FETCH_FAILED"
  | "FAILED_TO_POST_COMMENT"
  | "SEARCH_FAILED"
  | "INLINE_COMMENTS_FAILED";

export class GitLabError extends Error {
  constructor(
    override name: GitLabErrorName,
    message: string,
    public statusCode: number,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

type GitLabApi = {
  gitLabProjectApiUrl: URL;
  headers: Record<string, string>;
};

type MergeRequestApi = GitLabApi & { mergeRequestIid: string | number };

/** GitLab answers 429 when rate-limited and 502-504 while it restarts or is
 *  overloaded; both clear up within seconds, so those and network errors are
 *  retried, honoring Retry-After. Any other status is final.
 *  ponytail: a retried POST can duplicate a note if GitLab stored it before
 *  failing; rare, and a duplicate beats losing the whole review. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

async function fetchWithRetry(url: URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response | undefined;
    try {
      res = await fetch(url, init);
      if (!RETRY_STATUSES.has(res.status) || attempt === MAX_RETRIES) return res;
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
    }
    const header = res?.headers.get("retry-after");
    const seconds = header == null ? NaN : Number(header);
    const delayMs = Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds, 60) * 1000
      : 500 * 2 ** attempt * (1 + Math.random() / 4);
    res?.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** fetch (with retries) that turns network errors and non-2xx answers into a
 *  GitLabError whose cause carries the URL, status and the start of the body. */
async function gitlabRequest(
  url: URL,
  init: RequestInit,
  name: GitLabErrorName,
  message: string,
): Promise<Response | GitLabError> {
  let res: Response | Error;
  try {
    res = await fetchWithRetry(url, init);
  } catch (error: any) {
    res = error;
  }
  if (!(res instanceof Error) && res.ok) return res;
  const cause =
    res instanceof Error
      ? { url: url.toString(), error: { name: res.name, message: res.message } }
      : {
          url: url.toString(),
          status: res.status,
          statusText: res.statusText,
          body: (await res.text().catch(() => "")).slice(0, 1000),
        };
  return new GitLabError(name, message, res instanceof Error ? 502 : res.status, cause);
}

const postJson = (headers: Record<string, string>, body: unknown): RequestInit => ({
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const mergeRequestUrl = (api: MergeRequestApi, path = ""): URL =>
  new URL(`${api.gitLabProjectApiUrl}/merge_requests/${api.mergeRequestIid}${path}`);

/** GitLab runs quick actions (`/merge`, `/approve`, …) that start a line of a
 *  note, with the token's permissions. Model text must never trigger them, so
 *  indent such lines by a space (renders the same, no longer a command).
 *  Command names start with a letter, so `// comment` lines stay as they are. */
function neutralizeQuickActions(body: string): string {
  return body.replace(/^\/(?=[a-z])/gim, " /");
}

export async function fetchFileAtRef(
  params: GitLabApi & { filePath: string; ref: string },
): Promise<string | GitLabError> {
  const { gitLabProjectApiUrl, headers, filePath, ref } = params;
  const url = new URL(
    `${gitLabProjectApiUrl}/repository/files/${encodeURIComponent(filePath)}/raw`,
  );
  url.searchParams.set("ref", ref);
  const res = await gitlabRequest(
    url,
    { headers },
    "FILE_FETCH_FAILED",
    `Failed to fetch file "${filePath}" at ref "${ref}"`,
  );
  return res instanceof Error ? res : res.text();
}

export async function postMergeRequestNote(
  params: MergeRequestApi & { note: string },
): Promise<void | GitLabError> {
  const res = await gitlabRequest(
    mergeRequestUrl(params, "/notes"),
    postJson(params.headers, { body: neutralizeQuickActions(params.note) }),
    "FAILED_TO_POST_COMMENT",
    "Failed to post AI comment",
  );
  return res instanceof Error ? res : undefined;
}

interface SearchBlobResult {
  path: string;
  data: string;
  startline: number;
  ref: string;
}

export async function searchRepository(
  params: GitLabApi & { query: string; ref: string },
): Promise<SearchBlobResult[] | GitLabError> {
  const { gitLabProjectApiUrl, headers, query, ref } = params;
  const url = new URL(`${gitLabProjectApiUrl}/search`);
  url.searchParams.set("scope", "blobs");
  url.searchParams.set("search", query);
  url.searchParams.set("ref", ref);
  // Name matches come before content matches; the grep tool re-ranks and keeps 10.
  url.searchParams.set("per_page", "50");
  const res = await gitlabRequest(
    url,
    { headers },
    "SEARCH_FAILED",
    `Repository search failed for query "${query}"`,
  );
  return res instanceof Error ? res : ((await res.json()) as SearchBlobResult[]);
}

interface MergeRequestChangesDiffRef {
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
}

export interface MergeRequestChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
}

interface MergeRequestChangesResponse {
  changes?: MergeRequestChange[];
  diff_refs?: MergeRequestChangesDiffRef;
  target_branch?: string;
  /** GitLab hit its diff size limits and returned only part of the changes. */
  overflow?: boolean;
}

export async function fetchMergeRequestChanges(
  params: MergeRequestApi,
): Promise<MergeRequestChangesResponse | GitLabError> {
  const url = mergeRequestUrl(params, "/changes");
  // Ask GitLab for raw diffs to reduce truncation on larger merge requests.
  url.searchParams.set("access_raw_diffs", "true");
  const res = await gitlabRequest(
    url,
    { headers: params.headers },
    "MISSING_DIFF",
    "Failed to fetch merge request changes",
  );
  return res instanceof Error
    ? res
    : ((await res.json()) as MergeRequestChangesResponse);
}

export interface DiffPosition {
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line: number;
  old_line?: number;
}

export interface MergeRequestDiscussion {
  id: string;
  notes: Array<{
    body: string;
    system?: boolean;
    resolved?: boolean;
    position?: Partial<DiffPosition> | null;
  }>;
}

export async function fetchMergeRequestDiffRefs(
  params: MergeRequestApi,
): Promise<MergeRequestChangesDiffRef | GitLabError> {
  const res = await gitlabRequest(
    mergeRequestUrl(params),
    { headers: params.headers },
    "INLINE_COMMENTS_FAILED",
    "Failed to fetch merge request",
  );
  if (res instanceof Error) return res;
  const mr = (await res.json()) as { diff_refs?: MergeRequestChangesDiffRef };
  return mr.diff_refs ?? {};
}

export async function listMergeRequestDiscussions(
  params: MergeRequestApi,
): Promise<MergeRequestDiscussion[] | GitLabError> {
  const discussions: MergeRequestDiscussion[] = [];
  // ponytail: reads at most 50 pages (5000 threads); raise if an MR ever has more.
  for (let page = 1; page <= 50; page += 1) {
    const url = mergeRequestUrl(params, "/discussions");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await gitlabRequest(
      url,
      { headers: params.headers },
      "INLINE_COMMENTS_FAILED",
      "Failed to list merge request threads",
    );
    if (res instanceof Error) return res;
    const batch = (await res.json()) as MergeRequestDiscussion[];
    discussions.push(...batch);
    // A page can be short while more follow (GitLab drops notes the token
    // can't read after paginating), so trust X-Next-Page when it is sent.
    const next = res.headers.get("x-next-page");
    if (next === "" || (next == null && batch.length < 100)) break;
  }
  return discussions;
}

export async function createMergeRequestDiscussion(
  params: MergeRequestApi & { body: string; position: DiffPosition },
): Promise<void | GitLabError> {
  const { position } = params;
  const res = await gitlabRequest(
    mergeRequestUrl(params, "/discussions"),
    postJson(params.headers, { body: neutralizeQuickActions(params.body), position }),
    "INLINE_COMMENTS_FAILED",
    `Failed to create a diff thread at ${position.new_path}:${position.new_line}`,
  );
  return res instanceof Error ? res : undefined;
}

export async function resolveMergeRequestDiscussion(
  params: MergeRequestApi & { discussionId: string },
): Promise<void | GitLabError> {
  const url = mergeRequestUrl(params, `/discussions/${params.discussionId}`);
  url.searchParams.set("resolved", "true");
  const res = await gitlabRequest(
    url,
    { method: "PUT", headers: params.headers },
    "INLINE_COMMENTS_FAILED",
    `Failed to resolve thread ${params.discussionId}`,
  );
  return res instanceof Error ? res : undefined;
}

export async function replyToMergeRequestDiscussion(
  params: MergeRequestApi & { discussionId: string; body: string },
): Promise<void | GitLabError> {
  const res = await gitlabRequest(
    mergeRequestUrl(params, `/discussions/${params.discussionId}/notes`),
    postJson(params.headers, { body: neutralizeQuickActions(params.body) }),
    "INLINE_COMMENTS_FAILED",
    `Failed to reply to thread ${params.discussionId}`,
  );
  return res instanceof Error ? res : undefined;
}

/** Hidden marker that lets later runs find this tool's summary note. */
export const SUMMARY_MARKER = "<!-- gitlab-ai-review:summary -->";

interface MergeRequestNote {
  id: number;
  body: string;
  author?: { id?: number };
}

/** Id of the token user's earlier summary note on this MR, or null. Notes are
 *  listed most recently updated first, and every run updates the summary, so it
 *  is normally on the first page. */
async function findSummaryNote(
  params: MergeRequestApi,
): Promise<number | null | GitLabError> {
  // gitLabProjectApiUrl is <api>/projects/<id>, so ../user is <api>/user.
  const me = await gitlabRequest(
    new URL("../user", params.gitLabProjectApiUrl),
    { headers: params.headers },
    "FAILED_TO_POST_COMMENT",
    "Failed to read the token's user",
  );
  if (me instanceof Error) return me;
  const myId = ((await me.json()) as { id?: number }).id;
  if (myId == null) return null;
  // ponytail: reads at most 20 pages (2000 notes); past that a new note is posted.
  for (let page = 1; page <= 20; page += 1) {
    const url = mergeRequestUrl(params, "/notes");
    url.searchParams.set("order_by", "updated_at");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await gitlabRequest(
      url,
      { headers: params.headers },
      "FAILED_TO_POST_COMMENT",
      "Failed to list merge request notes",
    );
    if (res instanceof Error) return res;
    const batch = (await res.json()) as MergeRequestNote[];
    // Author check: a person quoting the marker must not get their note overwritten.
    const found = batch.find(
      (n) => n.author?.id === myId && n.body.includes(SUMMARY_MARKER),
    );
    if (found != null) return found.id;
    const next = res.headers.get("x-next-page");
    if (next === "" || (next == null && batch.length < 100)) break;
  }
  return null;
}

/** Posts the review as the MR's summary note. Later runs edit their own earlier
 *  note (found by marker and author) instead of stacking a new comment on every
 *  push; when it can't be found or edited, a new note is posted. */
export async function upsertSummaryNote(
  params: MergeRequestApi & { note: string; logStep: (message: string) => void },
): Promise<"updated" | "created" | GitLabError> {
  const { logStep } = params;
  const note = `${params.note}\n\n${SUMMARY_MARKER}`;
  const existing = await findSummaryNote(params);
  if (existing instanceof Error) {
    logStep(
      `Could not find the earlier AI review note (${existing.message}, HTTP ${existing.statusCode}); posting a new one.`,
    );
  } else if (existing != null) {
    const res = await gitlabRequest(
      mergeRequestUrl(params, `/notes/${existing}`),
      { ...postJson(params.headers, { body: neutralizeQuickActions(note) }), method: "PUT" },
      "FAILED_TO_POST_COMMENT",
      "Failed to update AI comment",
    );
    if (!(res instanceof Error)) return "updated";
    logStep(
      `Could not update the earlier AI review note (HTTP ${res.statusCode}); posting a new one.`,
    );
  }
  const res = await postMergeRequestNote({ ...params, note });
  return res instanceof Error ? res : "created";
}
