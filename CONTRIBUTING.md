# Contributing

Bug reports and pull requests are welcome. For anything bigger than a fix, open an issue first so we can agree on the approach.

## Setup

Node.js 20 or newer and [pnpm](https://pnpm.io):

```bash
pnpm install   # also builds dist/ (the prepare script runs tsc)
pnpm test      # type-check, then node --test on test/*.test.mjs
```

## Trying a change on a real merge request

Push your branch to your fork and, in the review job from the [README](README.md#gitlab-cicd), run it instead of the npm package:

```yaml
  script:
    - npx -y github:<you>/gitlab-ai-mr-reviewer#<branch> --include-artifacts --debug
```

Keep `ai-review-report.html` as a job artifact: it breaks the run down per pass (tokens, triage decisions, per-file findings, errors). For prompt changes, attach before/after reports or job logs from the same MR to the pull request.

## Pull requests

- One change per pull request.
- Add or update a test in `test/` when behavior changes.
- Update `README.md` when you add or change a flag or an environment variable.
- Don't bump the version in `package.json`: releases are cut by the maintainer.

Security issues: see [SECURITY.md](SECURITY.md), don't open a public issue.
