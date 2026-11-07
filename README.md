# Taher IPTV

An IPTV player for Samsung Tizen TVs, built as a Tizen web app (1920x1080, remote-only).

- Home screen with Live TV, Movies, Series, Playlists and Settings.
- Channel guide with categories, search, favourites, recently watched and sorting.
- Full-screen player on Samsung AVPlay, with near-instant channel switching through pre-buffering.
- Saved playlists: M3U links and Xtream Codes logins (account status and expiry shown on the home screen);
  includes presets for public free-to-air playlists and a verified test playlist.

## Layout

| Path | What |
|---|---|
| `app/` | The packaged app: `config.xml`, `index.html`, `css/`, `js/` (see [CLAUDE.md](CLAUDE.md) for each file) |
| `app/playlists/test.m3u` | Test channels probed from the home network |
| `deploy.ps1` | Packages, signs, installs and launches on the TV |
| `tools/` | `webcheck.py` (headless Chrome at TV size), `tvdebug.py` (drives the app on the TV), `mock_xtream.py` (fake Xtream server, login demo / demo) |

## Run

- Browser: serve `app/` (`python -m http.server 8765 --directory app`) and open http://localhost:8765. The keyboard stands
  in for the remote: arrows, Enter = OK, Esc = Back, PageUp/PageDown = CH+/-, r/g/y/b = colour keys.
- TV: needs Tizen Studio with a Samsung certificate profile and the TV in Developer Mode, then `pwsh -File deploy.ps1`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branches, commits and pull requests.

Playlists link to publicly available streams from [iptv-org](https://github.com/iptv-org/iptv) and
[Free-TV](https://github.com/Free-TV/IPTV). This project hosts no video.
