<!-- @format -->

# AI Code Reviewer

Gitlab AI Code Review is a CLI tool that leverages OpenAI models to automatically review code changes and output a Markdown review (either to GitLab merge requests via CI, or to your local console).

## Features

- Automatically reviews code changes in GitLab repositories
- Provides feedback on bugs and optimization opportunities
- Generates Markdown-formatted responses for easy readability in GitLab

## Usage

### GitLab CI/CD

Run the tool in Merge Request pipelines to post a new AI review comment to the MR.

Minimal MR review job:

```yaml
stages: [review]

ai_review:
  stage: review
  image: node:20
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    - npx -y @krotovm/gitlab-ai-review --ci
```

### Local CLI

Run locally to review diffs and print the review to stdout.

```bash
# review local uncommitted changes
OPENAI_API_KEY=... npx -y @krotovm/gitlab-ai-review --worktree

# review last commit and ignore docs/lock changes by extension
OPENAI_API_KEY=... npx -y @krotovm/gitlab-ai-review --last-commit --ignore-ext=md,lock

# review a prepared git diff from file
OPENAI_API_KEY=... npx -y @krotovm/gitlab-ai-review --diff-file=./changes.diff

# use a custom OpenAI-compatible endpoint
OPENAI_API_KEY=... OPENAI_BASE_URL="https://api.openai.com/v1" npx -y @krotovm/gitlab-ai-review --worktree
```

## Env variables

Set these in your project/group CI settings (or locally in your shell):

- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (optional, for OpenAI-compatible providers/proxies)
- `AI_MODEL` (optional, default: `gpt-4o-mini`; example: `gpt-4o`)
- `PROJECT_ACCESS_TOKEN` (optional but recommended for private projects; token with `api` scope)

`OPENAI_BASE_URL` is passed through to the `openai` SDK client, so you can use any OpenAI-compatible gateway/provider endpoint.

GitLab provides these automatically in Merge Request pipelines:

- `CI_API_V4_URL`
- `CI_PROJECT_ID`
- `CI_MERGE_REQUEST_IID`
- `CI_JOB_TOKEN` (used only when `PROJECT_ACCESS_TOKEN` is not provided)

## Flags

- `--ci` - Run in GitLab MR pipeline mode and post a new MR note.
- `--worktree` - Review local uncommitted changes (staged + unstaged).
- `--last-commit` - Review the last commit (`HEAD`).
- `--diff-file=./changes.diff` - Review git-diff content from a file and print to stdout.
- `--ignore-ext=md,lock` - Exclude file extensions from review (comma-separated only).
- `--max-diffs=50` - Max number of diffs included in the prompt.
- `--max-diff-chars=16000` - Max chars per diff chunk.
- `--max-total-prompt-chars=220000` - Final hard cap for prompt size.
- `--debug` - Print full error details (stack and API error fields).
- `--help` - Show help output.

In CI MR mode, the reviewer now fetches additional file context on-demand via tool calls instead of eagerly loading all pre-edit files up front. This reduces large-payload timeouts on big diffs.
