import { BaseError } from '../errors.js'

export interface GitLabFetchHeaders {
  [header: string]: string
}

export type CommentPayload = { body: string } | { note: string }

type GitLabErrorName =
  | 'MISSING_DIFF'
  | 'EMPTY_DIFF'
  | 'MISSING_OLD_FILES'
  | 'FAILED_TO_POST_COMMENT'
  | 'SEARCH_FAILED'

type OpenAIErrorName =
  | 'MISSING_AI_COMPLETION'

export class GitLabError extends BaseError<GitLabErrorName> { }
export class OpenAIError extends BaseError<OpenAIErrorName> { }

