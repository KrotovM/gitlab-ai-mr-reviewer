import type { ChatCompletion, ChatModel } from 'openai/resources/index.mjs'
import type { ChatCompletionMessageParam } from 'openai/resources/index.js'
import OpenAI from 'openai'
import { AI_MODEL_TEMPERATURE } from '../prompt/index.js'
import { GitLabError, OpenAIError, type CommentPayload, type GitLabFetchHeaders } from './types.js'

type GitLabFetchFunction<URLParams extends Record<string, any> = {}, Result = GitLabError> = (fetchParams: {
  gitLabBaseUrl: URL
  headers: GitLabFetchHeaders
} & URLParams, ...rest: any[]) => Promise<Result>

interface FetchPreEditFilesParams {
  changesOldPaths: string[]
  ref: string
}
export interface OldFileVersion { fileName: string, fileContent: string }
type FetchPreEditFilesResult = OldFileVersion[] | GitLabError
export const fetchPreEditFiles: GitLabFetchFunction<FetchPreEditFilesParams, FetchPreEditFilesResult> = async ({
  gitLabBaseUrl,
  headers,
  changesOldPaths,
  ref
}) => {
  const oldFilesRequestUrls = changesOldPaths.map(filePath => {
    const url = new URL(`${gitLabBaseUrl}/repository/files/${encodeURIComponent(filePath)}/raw`)
    url.searchParams.set('ref', ref)
    return url
  })
  let oldFiles: Array<PromiseSettledResult<string>> | Error
  try {
    oldFiles = await Promise.allSettled(
      oldFilesRequestUrls.map(async (url) => {
        const file = await (
          await fetch(url, { headers: { ...headers } })
        ).text()
        return file
      })
    )
  } catch (error: any) {
    oldFiles = error
  }

  if (oldFiles instanceof Error) {
    return new GitLabError({
      name: 'MISSING_OLD_FILES',
      message: 'Failed to fetch old files'
    })
  }

  return oldFiles.reduce<OldFileVersion[]>((acc, file, index) => {
    if (file.status === 'fulfilled') {
      acc.push({
        fileName: changesOldPaths[index]!,
        fileContent: file.value
      })
    }
    return acc
  }, [])
}

export async function generateAICompletion (messages: ChatCompletionMessageParam[], openaiInstance: OpenAI, aiModel: ChatModel): Promise<ChatCompletion | OpenAIError> {
  let completion: ChatCompletion | Error

  try {
    completion = await openaiInstance.chat.completions.create(
      {
        model: aiModel,
        temperature: AI_MODEL_TEMPERATURE,
        stream: false,
        messages
      }
    )
  } catch (error: any) {
    completion = error
  }

  if (completion instanceof Error) {
    return new OpenAIError({
      name: 'MISSING_AI_COMPLETION',
      message: 'Failed to generate AI completion',
      cause: completion
    })
  }

  return completion
}

interface PostMergeRequestNoteParams {
  mergeRequestIid: string | number
}
type PostMergeRequestNoteResult = void | GitLabError
export const postMergeRequestNote: GitLabFetchFunction<PostMergeRequestNoteParams, PostMergeRequestNoteResult> = async ({
  gitLabBaseUrl,
  headers,
  mergeRequestIid
}, commentPayload: CommentPayload): Promise<void | GitLabError> => {
  const commentUrl = new URL(`${gitLabBaseUrl}/merge_requests/${mergeRequestIid}/notes`)
  let aiComment: Response | Error
  try {
    aiComment = await fetch(commentUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commentPayload)
    })
  } catch (error: any) {
    aiComment = error
  }
  if (aiComment instanceof Error || !aiComment.ok) {
    return new GitLabError({
      name: 'FAILED_TO_POST_COMMENT',
      message: 'Failed to post AI comment'
    })
  }
}

export interface MergeRequestChangesDiffRef {
  base_sha?: string
  head_sha?: string
  start_sha?: string
}

export interface MergeRequestChange {
  old_path: string
  new_path: string
  diff: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
}

export interface MergeRequestChangesResponse {
  changes?: MergeRequestChange[]
  diff_refs?: MergeRequestChangesDiffRef
}

interface FetchMergeRequestChangesParams {
  projectId: string | number
  mergeRequestIid: string | number
}
type FetchMergeRequestChangesResult = MergeRequestChangesResponse | GitLabError
export const fetchMergeRequestChanges: GitLabFetchFunction<FetchMergeRequestChangesParams, FetchMergeRequestChangesResult> = async ({
  gitLabBaseUrl,
  headers,
  projectId,
  mergeRequestIid
}) => {
  const url = new URL(`${gitLabBaseUrl}/projects/${projectId}/merge_requests/${mergeRequestIid}/changes`)
  let res: Response | Error

  try {
    res = await fetch(url, { headers: { ...headers } })
  } catch (error: any) {
    res = error
  }

  if (res instanceof Error || !res.ok) {
    return new GitLabError({
      name: 'MISSING_DIFF',
      message: 'Failed to fetch merge request changes'
    })
  }

  return await res.json() as MergeRequestChangesResponse
}

