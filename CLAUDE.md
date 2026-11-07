# Taher IPTV

IPTV player for the Samsung TV "Mohamad TV" (Tizen 9, 1920x1080), built as a Tizen web app.
Repo: github.com/MohamadTaher/TaherIPTV.

## Layout

- `app/` is the packaged app: `config.xml`, `index.html`, `css/`, and in `js/`:
  `m3u.js` (playlist parser), `player.js` (AVPlay on the TV, `<video>` in a browser), `store.js` (storage,
  favourites and watch history per playlist), `xtream.js` (Xtream Codes API), `sources.js` (saved playlists,
  loading M3U or Xtream into live/movies/series), `app.js` (home, live guide, playlists, remote keys, and the
  `App` API other screens register with), `vod.js` (movies and series), `settings.js` (settings tabs).
- `deploy.ps1` packages, signs (profile `TaherTV`), installs and launches on the TV: `pwsh -File deploy.ps1`.
- `tools/tvdebug.py` drives the app on the TV over the DevTools protocol.
- `app/playlists/test.m3u` is the verified test playlist (preset "Test channels"); use it for real testing.
- `tools/mock_xtream.py` is a fake Xtream server (`mock-xtream` in `.claude/launch.json`, port 8766, login
  demo / demo) with live, movies, series and account data, for testing Xtream features in the browser.
- App id `TaherIPTV0.TaherIPTV`. Do not rename it.

## Git workflow

Follow [CONTRIBUTING.md](CONTRIBUTING.md): a light GitHub Flow for a personal project. Short branches
(`feat/`, `fix/`, `docs/`, `chore/`) merged into `main`, Conventional Commit messages. Keep it simple.
Push and merge only when the user asks.

## Testing: browser first, TV only when needed

1. **Default: a browser.** Start the `app` server from `.claude/launch.json` (serves `app/` on :8765).
   - `python -I tools/webcheck.py start + keys left down + shot out.png` runs headless Chrome at a true
     1920x1080 viewport with the same commands as tvdebug (`keys`, `type`, `eval`, `shot`, `logs`, `stop`).
     Prefer it for screenshots: the browser pane renders at 3x pixel density and its screenshots crop.
   - In a browser the keyboard stands in for the remote: arrows, Enter = OK, Esc/Backspace = Back,
     PageUp/PageDown = CH+/-, r/g/y/b = colour keys, 0-9 = numbers.
   - Check `logs` for errors. Layout, navigation, playlists, search and favourites are verified here.
2. **TV debug environment only when the browser cannot settle it**: AVPlay playback (a stream plays in the
   browser but maybe not on the TV, or the reverse), TV remote keys or the on-screen keyboard (IME), TV-only
   APIs (`webapis`, `tizen`), performance on the TV, or a bug that only shows on the TV.
   - `python -I tools/tvdebug.py start` relaunches the app in debug mode and forwards port 9222.
   - Then `eval "<js>"`, `keys down ok`, `logs 10`, `shot out.png`; chain with `+`.
   - `window.__tiptv` exposes state; `__tiptv.Player.info()` returns AVPlay state, time and tracks.
   - Screenshots do not show video (AVPlay draws on a plane under the page). Confirm video by
     `Player.info()` (time advancing, video track present) and ask the user to look at the TV.
3. Deploy with `deploy.ps1` only after the browser check passes.

## Rules for the code

- Target `required_version` 6.0 (Chromium 76): no `?.`, `??`, CSS `inset`, flexbox `gap` or `aspect-ratio`.
- The video plays under the page. Nothing opaque may cover it: the page background stays transparent on
  the TV, and `#html-player` is shown only in a browser (`html.web`).
- Fixed 1920x1080 layout in px. Every screen must work with only the remote: arrows, OK, Back, colour keys,
  CH+/-, numbers.

## Design

Layout follows SetIPTV (the user's reference app): channel list on the left with logo, number and name, a
category drawer that slides in from the left, an info panel on the right (search, now/next, progress), a
colour-key legend at the bottom, and a full-screen info bar. Improve on it in colour and detail;
do not copy its logo or name. Accent is amber (`--accent`), on a dark charcoal background.
