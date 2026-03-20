# AI Code Reviewer

Gitlab AI Code Review is a CLI tool that leverages OpenAI models to automatically review code changes and output a Markdown review (either to GitLab merge requests via CI, or to your local console).

## Features

- Automatically reviews code changes in GitLab repositories
- Provides feedback on code clarity, simplicity, bugs, and security issues
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
```

## Env variables

Set these in your project/group CI settings (or locally in your shell):

- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (optional, for OpenAI-compatible providers/proxies)
- `AI_MODEL` (optional, default: `gpt-4o-mini`; example: `gpt-4o`)
- `PROJECT_ACCESS_TOKEN` (optional but recommended for private projects; token with `api` scope)

GitLab provides these automatically in Merge Request pipelines:

- `CI_API_V4_URL`
- `CI_PROJECT_ID`
- `CI_MERGE_REQUEST_IID`
- `CI_JOB_TOKEN` (used only when `PROJECT_ACCESS_TOKEN` is not provided)

## Flags

- `--ci` - Run in GitLab MR pipeline mode and post a new MR note.
- `--worktree` - Review local uncommitted changes (staged + unstaged).
- `--last-commit` - Review the last commit (`HEAD`).
- `--ignore-ext=md,lock` - Exclude file extensions from review (comma-separated only).
- `--max-old-files=30` - Max number of pre-change files included in the prompt.
- `--max-old-file-chars=12000` - Max chars per pre-change file content.
- `--max-diffs=50` - Max number of diffs included in the prompt.
- `--max-diff-chars=16000` - Max chars per diff chunk.
- `--max-total-prompt-chars=220000` - Final hard cap for prompt size.
- `--debug` - Print full error details (stack and API error fields).
- `--help` - Show help output.
