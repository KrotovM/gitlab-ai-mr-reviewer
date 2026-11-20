# Security policy

## Supported versions

Fixes go into the latest release only. Pin a version in CI if you need reproducible runs, and update to get fixes.

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/KrotovM/gitlab-ai-mr-reviewer/security/advisories/new), not in a public issue. Include the version (the job log prints `gitlab-ai-review vX.Y.Z`), the provider, and the steps or MR content that trigger it.

This is a one-maintainer project, so reports are handled on a best-effort basis.

## What counts

The reviewer runs in CI with a GitLab token (`api` scope) and an LLM API key, and treats the merge request as untrusted input. In scope:

- leaking `PROJECT_ACCESS_TOKEN`, `GITLAB_TOKEN` or an LLM API key: job log, MR comments, debug artifact;
- code in the MR (including a `REVIEW.md` it changes) making the reviewer do more than post a review: read files outside the repository, call other GitLab APIs, run quick actions.

Out of scope: a wrong, missing or noisy finding. That's review quality, open a regular issue.

The `--include-artifacts` report contains model outputs about your code. In public projects, restrict who can download job artifacts.
