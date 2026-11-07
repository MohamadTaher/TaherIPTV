# Contributing

A personal project, so the workflow is light: [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

- `main` always works on the TV.
- Work on a short-lived branch named `feat/...`, `fix/...`, `docs/...` or `chore/...`. Merge it into `main` when it
  works, then delete it. A pull request is optional: open one when a record of the testing is useful.
- Commit messages: `type(scope): description`, imperative, at most 72 characters. For example,
  `fix(player): retire players that hang twice`. Types: `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`,
  `chore`.
- Test before merging: browser first, TV when the browser cannot settle it (see [CLAUDE.md](CLAUDE.md)).
- Never commit certificates (`*.p12`, signature files), builds (`*.wgt`) or secrets. The repository is public.
