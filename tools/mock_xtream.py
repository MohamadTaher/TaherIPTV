"""Fake Xtream Codes server for testing the app in a browser (no real provider account needed).

  python -I tools/mock_xtream.py            serves http://127.0.0.1:8766  (login demo / demo)

In the app: Playlists > Add Xtream Codes login > server http://127.0.0.1:8766, user demo, password demo.
Or Add M3U link > http://127.0.0.1:8766/get.php?username=demo&password=demo&type=m3u_plus

Implements player_api.php (account, live/vod/series categories and lists, get_series_info, get_vod_info),
get.php (M3U with /live/, /movie/ and /series/ entries), SVG posters, and stream URLs that redirect to
public test videos. Login 'expired' / 'demo' answers with an expired account; any other login is rejected.
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
NOW = int(time.time())

LIVE_URLS = [
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
]
MP4 = [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
]

LIVE_CATS = [('1', 'News'), ('2', 'Sports'), ('3', 'Kids')]
VOD_CATS = [('10', 'English Movies - 2026'), ('11', 'Arabic Movies - 2026'), ('12', 'Box Office 2025'), ('13', 'Classics')]
SER_CATS = [('20', 'Drama'), ('21', 'Comedy'), ('22', 'Documentary')]

WORDS = ['Silent', 'Golden', 'Last', 'Hidden', 'Broken', 'Midnight', 'Desert', 'Iron', 'Crimson', 'Lost',
         'River', 'Empire', 'Shadow', 'Harbor', 'Falcon', 'Winter', 'Signal', 'Atlas', 'Echo', 'Orbit']

LIVE = [{'num': i + 1, 'name': f'{c[1]} {i + 1}', 'stream_id': 100 + i, 'stream_icon': '',
         'category_id': c[0], 'epg_channel_id': '', 'added': str(NOW - i * 3600)}
        for i, c in enumerate(LIVE_CATS * 4)]

VOD = []
for i in range(48):
    cat = VOD_CATS[i % len(VOD_CATS)]
    name = f'{WORDS[i % 20]} {WORDS[(i * 7 + 3) % 20]}' + (f' ({2020 + i % 7})' if i % 3 else '')
    VOD.append({'num': i + 1, 'name': name, 'stream_id': 1000 + i, 'stream_icon': f'/poster/m{1000 + i}.svg',
                'rating': str(round(5 + (i * 37 % 50) / 10, 1)), 'added': str(NOW - i * 86400),
                'category_id': cat[0], 'container_extension': 'mp4'})

SERIES = []
for i in range(14):
    cat = SER_CATS[i % len(SER_CATS)]
    SERIES.append({'num': i + 1, 'name': f'The {WORDS[(i * 3) % 20]} {WORDS[(i * 11 + 5) % 20]}', 'series_id': 500 + i,
                   'cover': f'/poster/s{500 + i}.svg', 'plot': 'A family of characters tests the app across seasons.',
                   'rating': str(round(6 + (i * 13 % 40) / 10, 1)), 'last_modified': str(NOW - i * 43200),
                   'category_id': cat[0], 'genre': cat[1], 'releaseDate': f'{2015 + i % 10}-03-01'})


def episodes(sid):
    out = {}
    seasons = 1 + sid % 3
    for s in range(1, seasons + 1):
        out[str(s)] = [{'id': str(sid * 100 + s * 10 + e), 'episode_num': e, 'title': f'Episode {e}',
                        'container_extension': 'mp4',
                        'info': {'duration_secs': 600 + e * 60, 'plot': f'Season {s}, episode {e}.', 'movie_image': ''}}
                       for e in range(1, 7)]
    return out


def poster(key):
    h = sum(ord(c) * 31 for c in key) % 360
    title = key
    for v in VOD:
        if f'm{v["stream_id"]}' == key:
            title = v['name']
    for s in SERIES:
        if f's{s["series_id"]}' == key:
            title = s['name']
    words = title.split(' ')
    lines = ''.join(f'<text x="150" y="{300 + i * 46}" font-size="40" font-weight="700" fill="#fff" '
                    f'text-anchor="middle" font-family="Arial">{w}</text>' for i, w in enumerate(words[:3]))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl({h},55%,42%)"/>'
            f'<stop offset="1" stop-color="hsl({(h + 50) % 360},60%,16%)"/></linearGradient></defs>'
            f'<rect width="300" height="450" fill="url(#g)"/><circle cx="150" cy="150" r="70" fill="rgba(255,255,255,.12)"/>'
            f'{lines}</svg>').encode()


class H(BaseHTTPRequestHandler):
    def send(self, code, body, ctype='application/json', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write('mock_xtream: ' + fmt % args + '\n')

    def base(self):
        return f'http://{self.headers.get("Host", f"127.0.0.1:{PORT}")}'

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path
        if path.startswith('/poster/'):
            return self.send(200, poster(path[8:].rsplit('.', 1)[0]), 'image/svg+xml')
        parts = path.strip('/').split('/')
        if len(parts) == 4 and parts[0] in ('live', 'movie', 'series'):
            sid = int(parts[3].split('.')[0])
            target = LIVE_URLS[sid % len(LIVE_URLS)] if parts[0] == 'live' else MP4[sid % len(MP4)]
            return self.send(302, b'', 'text/plain', {'Location': target})
        user, pw = q.get('username'), q.get('password')
        if path == '/get.php':
            if (user, pw) != ('demo', 'demo'):
                return self.send(401, b'', 'text/plain')
            return self.send(200, self.m3u(user, pw).encode(), 'audio/x-mpegurl')
        if path != '/player_api.php':
            return self.send(404, b'{}')
        if (user, pw) not in (('demo', 'demo'), ('expired', 'demo')):
            return self.send(200, json.dumps({'user_info': {'auth': 0}}).encode())
        action = q.get('action', '')
        cat = lambda cats: [{'category_id': c, 'category_name': n, 'parent_id': 0} for c, n in cats]
        if action == '':
            expired = user == 'expired'
            body = {'user_info': {'username': user, 'password': pw, 'auth': 1,
                                  'status': 'Expired' if expired else 'Active',
                                  'exp_date': str(NOW - 86400 if expired else 1851984000),  # 2028-09-07
                                  'is_trial': '0', 'active_cons': '0', 'created_at': str(NOW - 400 * 86400),
                                  'max_connections': '1', 'allowed_output_formats': ['m3u8', 'ts']},
                    'server_info': {'url': '127.0.0.1', 'port': str(PORT), 'timezone': 'UTC'}}
        elif action == 'get_live_categories': body = cat(LIVE_CATS)
        elif action == 'get_live_streams': body = LIVE
        elif action == 'get_vod_categories': body = cat(VOD_CATS)
        elif action == 'get_vod_streams':
            body = [dict(v, stream_icon=self.base() + v['stream_icon']) for v in VOD]
        elif action == 'get_series_categories': body = cat(SER_CATS)
        elif action == 'get_series':
            body = [dict(s, cover=self.base() + s['cover']) for s in SERIES]
        elif action == 'get_series_info':
            sid = int(q.get('series_id', 0))
            s = next((x for x in SERIES if x['series_id'] == sid), None)
            body = {'info': dict(s, cover=self.base() + s['cover'], backdrop_path=[]) if s else {},
                    'episodes': episodes(sid) if s else {}, 'seasons': []}
        elif action == 'get_vod_info':
            vid = int(q.get('vod_id', 0))
            v = next((x for x in VOD if x['stream_id'] == vid), None)
            body = {'info': {'plot': f'{v["name"]} is a test movie served by the mock server.', 'genre': 'Drama, Action',
                             'releasedate': '2024-05-01', 'cast': 'A. Actor, B. Actor', 'director': 'C. Director',
                             'duration_secs': 596, 'movie_image': self.base() + v['stream_icon'], 'rating': v['rating']}
                    if v else {}, 'movie_data': {}}
        else:
            body = []
        self.send(200, json.dumps(body).encode())

    def m3u(self, user, pw):
        b, out = self.base(), ['#EXTM3U']
        names = dict(LIVE_CATS)
        for s in LIVE:
            out += [f'#EXTINF:-1 tvg-logo="" group-title="{names[s["category_id"]]}",{s["name"]}',
                    f'{b}/live/{user}/{pw}/{s["stream_id"]}.m3u8']
        names = dict(VOD_CATS)
        for v in VOD[:12]:
            out += [f'#EXTINF:-1 tvg-logo="{b}{v["stream_icon"]}" group-title="{names[v["category_id"]]}",{v["name"]}',
                    f'{b}/movie/{user}/{pw}/{v["stream_id"]}.mp4']
        names = dict(SER_CATS)
        for s in SERIES[:3]:
            for sn, eps in episodes(s['series_id']).items():
                for e in eps:
                    out += [f'#EXTINF:-1 tvg-logo="{b}{s["cover"]}" group-title="{names[s["category_id"]]}",'
                            f'{s["name"]} S{int(sn):02d} E{e["episode_num"]:02d}',
                            f'{b}/series/{user}/{pw}/{e["id"]}.mp4']
        return '\n'.join(out) + '\n'


if __name__ == '__main__':
    print(f'mock Xtream server on http://127.0.0.1:{PORT}  (login demo / demo)')
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
