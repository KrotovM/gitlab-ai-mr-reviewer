import { BaseError } from '../errors.js'

export interface GitLabFetchHeaders {
  [header: string]: string
}

type GitLabErrorName =
  | 'MISSING_DIFF'
  | 'EMPTY_DIFF'
  | 'MISSING_OLD_FILES'
  | 'FAILED_TO_POST_COMMENT'
  | 'SEARCH_FAILED'

export class GitLabError extends BaseError<GitLabErrorName> { }

