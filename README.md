# AI Code Reviewer

Gitlab AI Code Review is a CLI tool that leverages OpenAI models to automatically review code changes and output a Markdown review (either to GitLab merge requests via CI, or to your local console).

## Features

- Automatically reviews code changes in GitLab repositories
- Provides feedback on code clarity, simplicity, bugs, and security issues
- Generates Markdown-formatted responses for easy readability in GitLab

## GitLab CI usage (recommended)

This repo now includes a CLI you can run in a dedicated GitLab CI job. It is designed to run in **Merge Request pipelines** and will post a **new comment** on the MR with the AI review.

### Required CI variables

- `OPENAI_API_KEY`
- `AI_MODEL` (optional, default: `gpt-4o-mini`; examples: `gpt-4o`)

GitLab provides these automatically in CI:

- `CI_API_V4_URL`
- `CI_PROJECT_ID`
- `CI_MERGE_REQUEST_IID`
- `CI_JOB_TOKEN`

### Example `.gitlab-ci.yml`

```yaml
stages:
  - review

ai_review:
  stage: review
  image: node:20
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - pnpm build:ts
    - node dist/cli.js
```

## Local usage

You can also run the CLI locally to review diffs and print the review to the console.

### Review uncommitted changes (staged + unstaged)

```bash
OPENAI_API_KEY=... AI_MODEL=gpt-4o node dist/cli.js --worktree
```

### Review last commit (HEAD)

```bash
OPENAI_API_KEY=... AI_MODEL=gpt-4o node dist/cli.js --last-commit
```

## Installation

```bash
pnpm install
pnpm build:ts
```
