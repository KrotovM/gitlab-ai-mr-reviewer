/** @format */

import {
  GitLabError,
  type GitLabFetchHeaders,
} from "./types.js";

type GitLabFetchFunction<
  URLParams extends Record<string, any> = {},
  Result = GitLabError,
> = (
  fetchParams: {
    gitLabProjectApiUrl: URL;
    headers: GitLabFetchHeaders;
  } & URLParams,
  ...rest: any[]
) => Promise<Result>;

interface FetchFileAtRefParams {
  filePath: string;
  ref: string;
}
type FetchFileAtRefResult = string | GitLabError;
export const fetchFileAtRef: GitLabFetchFunction<
  FetchFileAtRefParams,
  FetchFileAtRefResult
> = async ({ gitLabProjectApiUrl, headers, filePath, ref }) => {
  const url = new URL(
    `${gitLabProjectApiUrl}/repository/files/${encodeURIComponent(filePath)}/raw`,
  );
  url.searchParams.set("ref", ref);
  let res: Response | Error;
  try {
    res = await fetch(url, { headers: { ...headers } });
  } catch (error: any) {
    res = error;
  }
  if (res instanceof Error || !res.ok) {
    const responseDetails = await (async () => {
      if (res instanceof Error) {
        return {
          url: url.toString(),
          error: {
            name: res.name,
            message: res.message,
            stack: res.stack,
          },
        };
      }
      const bodyText = await res.text().catch(() => "");
      return {
        url: url.toString(),
        status: res.status,
        statusText: res.statusText,
        body: bodyText.slice(0, 1000),
      };
    })();
    return new GitLabError({
      name: "MISSING_OLD_FILES",
      message: `Failed to fetch file "${filePath}" at ref "${ref}"`,
      statusCode: res instanceof Error ? 502 : res.status,
      cause: responseDetails,
    });
  }
  return await res.text();
};

/** GitLab runs quick actions (`/merge`, `/approve`, …) that start a line of a
 *  note, with the token's permissions. Model text must never trigger them, so
 *  indent such lines by a space (renders the same, no longer a command).
 *  Command names start with a letter, so `// comment` lines stay as they are. */
function neutralizeQuickActions(body: string): string {
  return body.replace(/^\/(?=[a-z])/gim, " /");
}

interface PostMergeRequestNoteParams {
  mergeRequestIid: string | number;
  note: string;
}
type PostMergeRequestNoteResult = void | GitLabError;
export const postMergeRequestNote: GitLabFetchFunction<
  PostMergeRequestNoteParams,
  PostMergeRequestNoteResult
> = async (
  { gitLabProjectApiUrl, headers, mergeRequestIid, note }
): Promise<void | GitLabError> => {
  const commentUrl = new URL(
    `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/notes`,
  );
  let aiComment: Response | Error;
  try {
    aiComment = await fetch(commentUrl, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: neutralizeQuickActions(note) }),
    });
  } catch (error: any) {
    aiComment = error;
  }
  if (aiComment instanceof Error || !aiComment.ok) {
    const responseDetails = await (async () => {
      if (aiComment instanceof Error) {
        return {
          url: commentUrl.toString(),
          error: {
            name: aiComment.name,
            message: aiComment.message,
            stack: aiComment.stack,
          },
        };
      }

      const bodyText = await aiComment.text().catch(() => "");
      return {
        url: commentUrl.toString(),
        status: aiComment.status,
        statusText: aiComment.statusText,
        body: bodyText.slice(0, 4000),
      };
    })();

    return new GitLabError({
      name: "FAILED_TO_POST_COMMENT",
      message: "Failed to post AI comment",
      statusCode: aiComment instanceof Error ? 502 : aiComment.status,
      cause: responseDetails,
    });
  }
};

interface SearchRepositoryParams {
  query: string;
  ref: string;
}
interface SearchBlobResult {
  path: string;
  data: string;
  startline: number;
  ref: string;
}
type SearchRepositoryResult = SearchBlobResult[] | GitLabError;
export const searchRepository: GitLabFetchFunction<
  SearchRepositoryParams,
  SearchRepositoryResult
> = async ({ gitLabProjectApiUrl, headers, query, ref}) => {
  const url = new URL(`${gitLabProjectApiUrl}/search`);
  url.searchParams.set("scope", "blobs");
  url.searchParams.set("search", query);
  url.searchParams.set("ref", ref);
  // Name matches come before content matches; the grep tool re-ranks and keeps 10.
  url.searchParams.set("per_page", "50");
  let res: Response | Error;
  try {
    res = await fetch(url, { headers: { ...headers } });
  } catch (error: any) {
    res = error;
  }
  if (res instanceof Error || !res.ok) {
    const responseDetails = await (async () => {
      if (res instanceof Error) {
        return {
          url: url.toString(),
          error: { name: res.name, message: res.message },
        };
      }
      const bodyText = await res.text().catch(() => "");
      return {
        url: url.toString(),
        status: res.status,
        statusText: res.statusText,
        body: bodyText.slice(0, 1000),
      };
    })();
    return new GitLabError({
      name: "SEARCH_FAILED",
      message: `Repository search failed for query "${query}"`,
      statusCode: res instanceof Error ? 502 : res.status,
      cause: responseDetails,
    });
  }
  return (await res.json()) as SearchBlobResult[];
};

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
  overflow?: boolean;
}

interface FetchMergeRequestChangesParams {
  mergeRequestIid: string | number;
}
type FetchMergeRequestChangesResult = MergeRequestChangesResponse | GitLabError;
export const fetchMergeRequestChanges: GitLabFetchFunction<
  FetchMergeRequestChangesParams,
  FetchMergeRequestChangesResult
> = async ({ gitLabProjectApiUrl, headers, mergeRequestIid }) => {
  const url = new URL(
    `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/changes`,
  );
  // Ask GitLab for raw diffs to reduce truncation on larger merge requests.
  url.searchParams.set("access_raw_diffs", "true");
  let res: Response | Error;

  try {
    res = await fetch(url, { headers: { ...headers } });
  } catch (error: any) {
    res = error;
  }

  if (res instanceof Error || !res.ok) {
    const responseDetails = await (async () => {
      if (res instanceof Error) {
        return {
          url: url.toString(),
          error: {
            name: res.name,
            message: res.message,
            stack: res.stack,
          },
        };
      }
      const bodyText = await res.text().catch(() => "");
      return {
        url: url.toString(),
        status: res.status,
        statusText: res.statusText,
        body: bodyText.slice(0, 4000),
      };
    })();

    return new GitLabError({
      name: "MISSING_DIFF",
      message: "Failed to fetch merge request changes",
      statusCode: res instanceof Error ? 502 : res.status,
      cause: responseDetails,
    });
  }

  return (await res.json()) as MergeRequestChangesResponse;
};

/** fetch with the same error details as above, for the inline-comment calls. */
async function gitlabRequest(
  url: URL,
  init: RequestInit,
  message: string,
): Promise<Response | GitLabError> {
  let res: Response | Error;
  try {
    res = await fetch(url, init);
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
  return new GitLabError({
    name: "INLINE_COMMENTS_FAILED",
    message,
    statusCode: res instanceof Error ? 502 : res.status,
    cause,
  });
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

interface MergeRequestParams {
  mergeRequestIid: string | number;
}

export const fetchMergeRequestDiffRefs: GitLabFetchFunction<
  MergeRequestParams,
  MergeRequestChangesDiffRef | GitLabError
> = async ({ gitLabProjectApiUrl, headers, mergeRequestIid }) => {
  const res = await gitlabRequest(
    new URL(`${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}`),
    { headers: { ...headers } },
    "Failed to fetch merge request",
  );
  if (res instanceof Error) return res;
  const mr = (await res.json()) as { diff_refs?: MergeRequestChangesDiffRef };
  return mr.diff_refs ?? {};
};

export const listMergeRequestDiscussions: GitLabFetchFunction<
  MergeRequestParams,
  MergeRequestDiscussion[] | GitLabError
> = async ({ gitLabProjectApiUrl, headers, mergeRequestIid }) => {
  const discussions: MergeRequestDiscussion[] = [];
  // ponytail: reads at most 50 pages (5000 threads); raise if an MR ever has more.
  for (let page = 1; page <= 50; page += 1) {
    const url = new URL(
      `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/discussions`,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await gitlabRequest(
      url,
      { headers: { ...headers } },
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
};

interface CreateMergeRequestDiscussionParams extends MergeRequestParams {
  body: string;
  position: DiffPosition;
}
export const createMergeRequestDiscussion: GitLabFetchFunction<
  CreateMergeRequestDiscussionParams,
  void | GitLabError
> = async ({ gitLabProjectApiUrl, headers, mergeRequestIid, body, position }) => {
  const res = await gitlabRequest(
    new URL(
      `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/discussions`,
    ),
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: neutralizeQuickActions(body), position }),
    },
    `Failed to create a diff thread at ${position.new_path}:${position.new_line}`,
  );
  return res instanceof Error ? res : undefined;
};

interface ResolveMergeRequestDiscussionParams extends MergeRequestParams {
  discussionId: string;
}
export const resolveMergeRequestDiscussion: GitLabFetchFunction<
  ResolveMergeRequestDiscussionParams,
  void | GitLabError
> = async ({ gitLabProjectApiUrl, headers, mergeRequestIid, discussionId }) => {
  const url = new URL(
    `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/discussions/${discussionId}`,
  );
  url.searchParams.set("resolved", "true");
  const res = await gitlabRequest(
    url,
    { method: "PUT", headers: { ...headers } },
    `Failed to resolve thread ${discussionId}`,
  );
  return res instanceof Error ? res : undefined;
};

interface ReplyToMergeRequestDiscussionParams extends MergeRequestParams {
  discussionId: string;
  body: string;
}
export const replyToMergeRequestDiscussion: GitLabFetchFunction<
  ReplyToMergeRequestDiscussionParams,
  void | GitLabError
> = async ({ gitLabProjectApiUrl, headers, mergeRequestIid, discussionId, body }) => {
  const res = await gitlabRequest(
    new URL(
      `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/discussions/${discussionId}/notes`,
    ),
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: neutralizeQuickActions(body) }),
    },
    `Failed to reply to thread ${discussionId}`,
  );
  return res instanceof Error ? res : undefined;
};

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
async function findSummaryNote({
  gitLabProjectApiUrl,
  headers,
  mergeRequestIid,
}: {
  gitLabProjectApiUrl: URL;
  headers: GitLabFetchHeaders;
  mergeRequestIid: string | number;
}): Promise<number | null | GitLabError> {
  // gitLabProjectApiUrl is <api>/projects/<id>, so ../user is <api>/user.
  const me = await gitlabRequest(
    new URL("../user", gitLabProjectApiUrl),
    { headers: { ...headers } },
    "Failed to read the token's user",
  );
  if (me instanceof Error) return me;
  const myId = ((await me.json()) as { id?: number }).id;
  if (myId == null) return null;
  // ponytail: reads at most 20 pages (2000 notes); past that a new note is posted.
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL(
      `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/notes`,
    );
    url.searchParams.set("order_by", "updated_at");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await gitlabRequest(
      url,
      { headers: { ...headers } },
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
export async function upsertSummaryNote(params: {
  gitLabProjectApiUrl: URL;
  headers: GitLabFetchHeaders;
  mergeRequestIid: string | number;
  note: string;
  logStep: (message: string) => void;
}): Promise<"updated" | "created" | GitLabError> {
  const { gitLabProjectApiUrl, headers, mergeRequestIid, logStep } = params;
  const note = `${params.note}\n\n${SUMMARY_MARKER}`;
  const existing = await findSummaryNote(params);
  if (existing instanceof Error) {
    logStep(
      `Could not find the earlier AI review note (${existing.message}, HTTP ${existing.statusCode}); posting a new one.`,
    );
  } else if (existing != null) {
    const res = await gitlabRequest(
      new URL(
        `${gitLabProjectApiUrl}/merge_requests/${mergeRequestIid}/notes/${existing}`,
      ),
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body: neutralizeQuickActions(note) }),
      },
      "Failed to update AI comment",
    );
    if (!(res instanceof Error)) return "updated";
    logStep(
      `Could not update the earlier AI review note (HTTP ${res.statusCode}); posting a new one.`,
    );
  }
  const res = await postMergeRequestNote({
    gitLabProjectApiUrl,
    headers,
    mergeRequestIid,
    note,
  });
  return res instanceof Error ? res : "created";
}
