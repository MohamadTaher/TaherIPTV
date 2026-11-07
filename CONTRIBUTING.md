# Contributing

Git workflow for Taher IPTV. It follows [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow),
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) and
[Semantic Versioning 2.0.0](https://semver.org/).

## Branches

- `main` is the only long-lived branch. It always works on the TV and is what gets deployed.
- Nothing is committed to `main` directly. Every change goes through a short-lived branch and a pull request.
- Branch from the latest `main` and name the branch `<type>/<short-description>` in kebab-case, using the
  commit types below:

  | Example | For |
  |---|---|
  | `feat/epg-guide` | a new feature |
  | `fix/avplay-timeout` | a bug fix |
  | `perf/faster-zapping` | a speed improvement |
  | `docs/deploy-steps` | documentation only |
  | `refactor/player-pool` | code change with no behaviour change |
  | `test/zap-benchmark` | tests or test tools |
  | `build/sign-profile` | packaging and deploy |
  | `chore/update-playlist` | maintenance |

- One topic per branch. Keep it small enough to review in one sitting, and delete it after merging.
- Before opening a pull request, rebase on `main` (`git pull --rebase origin main`) so history stays linear.

## Commits

Format: `<type>(<optional scope>): <description>`

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- Scopes used here: `app`, `player`, `playlist`, `ui`, `tools`, `deploy`.
- Imperative mood, lower case, no full stop, 72 characters at most: `fix(player): retire players that hang twice`.
- A breaking change adds `!` after the type (`feat(player)!: ...`).
- One logical change per commit. Commits are not squashed on merge, so each one should make sense on its own.

## Pull requests

- Title in the same Conventional Commits format as a commit.
- Fill in the template: what changed, why, and how it was tested.
- Testing follows [CLAUDE.md](CLAUDE.md#testing-browser-first-tv-only-when-needed): browser check first, TV only when the
  browser cannot settle it (AVPlay playback, remote keys, IME, TV-only APIs, performance). Say which you ran,
  with numbers for anything timed.
- Merge with **Rebase and merge** (linear history, each commit kept), then delete the branch.

## Protection for `main`

Settings for the `main` branch ruleset on GitHub:

- Require a pull request before merging.
- Require linear history.
- Block force pushes.
- Restrict deletions.

## Releases

- Tag releases on `main` as `vMAJOR.MINOR.PATCH` (SemVer). `version` in `app/config.xml` must match the tag.
- MAJOR: breaking change for users (lost settings, removed feature). MINOR: new feature. PATCH: fixes.

## Never commit

- Signing certificates and profiles (`*.p12`, `author-signature.xml`, `signature*.xml`, `.sign/`).
- Build output (`.build/`, `*.wgt`) and caches (`__pycache__/`).
- Passwords, tokens or paid IPTV account links. The repository is public.
