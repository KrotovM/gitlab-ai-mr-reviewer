<!-- @format -->

# AI Code Reviewer

Gitlab AI Code Review is a CLI tool that leverages OpenAI models to automatically review code changes and post a Markdown review to GitLab merge requests from CI.

## Features

- Automatically reviews code changes in GitLab repositories
- Provides feedback on bugs and optimization opportunities
- Generates Markdown-formatted responses for easy readability in GitLab as merge request comment

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
    - npx -y @krotovm/gitlab-ai-review
```

## Env variables

Set these in your project/group CI settings:

- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (optional, for OpenAI-compatible providers/proxies)
- `AI_MODEL` (optional, default: `gpt-4o-mini`; example: `gpt-4o`)
- `PROJECT_ACCESS_TOKEN` (optional for public projects, but required for most private projects; token with `api` scope)
- `GITLAB_TOKEN` (optional alias for `PROJECT_ACCESS_TOKEN`)

`OPENAI_BASE_URL` is passed through to the `openai` SDK client, so you can use any OpenAI-compatible gateway/provider endpoint.

GitLab provides these automatically in Merge Request pipelines:

- `CI_API_V4_URL`
- `CI_PROJECT_ID`
- `CI_MERGE_REQUEST_IID`
- `CI_JOB_TOKEN` (used only when `PROJECT_ACCESS_TOKEN` is not provided)

## Flags

- `--ignore-ext=md,lock` - Exclude file extensions from review (comma-separated only).
- `--max-diffs=50` - Max number of diffs included in the prompt.
- `--max-diff-chars=16000` - Max chars per diff chunk (single-pass fallback only).
- `--max-total-prompt-chars=220000` - Final hard cap for prompt size (single-pass fallback only).
- `--max-findings=5` - Max findings in the final review (CI multi-pass only).
- `--max-review-concurrency=5` - Parallel per-file review API calls (CI multi-pass only).
- `--debug` - Print full error details (stack and API error fields).
- `--help` - Show help output.

## Architecture

The reviewer uses a three-pass pipeline optimised for large merge requests:

1. **Triage** — a fast LLM call classifies each changed file as `NEEDS_REVIEW` or `SKIP` (cosmetic-only changes, docs, config) and produces a short MR summary.
2. **Per-file review** — only `NEEDS_REVIEW` files are reviewed, each in a dedicated LLM call running in parallel (with tool access to fetch full files or grep the repository). Each file gets full model attention instead of competing for it across a single giant prompt.
3. **Consolidate** — all per-file findings are merged, deduplicated, ranked by severity, and trimmed to the top N (default 5).

If the triage pass fails (API error, unparseable response), the pipeline falls back to the original single-pass approach automatically.

The CI pipeline falls back to a simpler single-pass review automatically when triage cannot be used.
