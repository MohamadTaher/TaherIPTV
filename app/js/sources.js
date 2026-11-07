/* Saved playlists and loading them.

   A playlist is { id, name, type: 'm3u' | 'xtream' | 'demo', url?, server?, user?, pass? }.
   An M3U link that is really an Xtream get.php link is loaded through the Xtream API, which gives
   account details, posters and series episodes.

   Playlists.load(pl) resolves to the loaded data:
     { playlist, live: [channel], movies: [movie], series: [series], account: account|null,
       seriesInfo(id) -> Promise, movieInfo(id) -> Promise }
   Shapes are documented in xtream.js. Plain M3U files are split by URL: '/movie/' entries are movies,
   '/series/' entries are episodes grouped into series by their 'S01E02' names, the rest is live. */
var Playlists = (function () {
  'use strict';

  var PRESETS = [
    // Channel counts checked 2026-11-06.
    { name: 'Demo test streams', type: 'demo' },
    { name: 'Test channels · verified (184)', type: 'm3u', url: 'playlists/test.m3u' },   // checked 2026-11-07, see the file header
    { name: 'Free-TV · free-to-air, curated (2,000)', type: 'm3u', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8' },
    { name: 'iptv-org · World by country (13,000)', type: 'm3u', url: 'https://iptv-org.github.io/iptv/index.country.m3u' },
    { name: 'iptv-org · World by category (12,000)', type: 'm3u', url: 'https://iptv-org.github.io/iptv/index.category.m3u' },
    { name: 'iptv-org · News (1,000)', type: 'm3u', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
    { name: 'iptv-org · Sports (480)', type: 'm3u', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' }
  ];

  // Public test streams, checked reachable on 2026-11-06.
  var DEMO = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="Movies",Big Buck Bunny',
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    '#EXTINF:-1 group-title="Movies",Tears of Steel',
    'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
    '#EXTINF:-1 group-title="Movies",Tears of Steel (DASH)',
    'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.mpd',
    '#EXTINF:-1 group-title="Movies",Big Buck Bunny (DASH)',
    'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
    '#EXTINF:-1 group-title="Live tests",Unified Streaming Live',
    'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
    '#EXTINF:-1 group-title="Test patterns",Apple BipBop',
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    '#EXTINF:-1 group-title="Test patterns",Apple BipBop fMP4',
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8'
  ].join('\n');

  /* ---------- saved list ---------- */

  function newId() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

  function migrate() {
    // Before saved playlists the app kept one 'source' and live favourites as { url: true }.
    var old = Store.get('source', null), pl;
    if (old && old.url) pl = { id: newId(), name: old.name, type: 'm3u', url: old.url };
    else if (old && old.demo) pl = { id: newId(), name: old.name, type: 'demo' };
    else pl = { id: newId(), name: PRESETS[1].name, type: 'm3u', url: PRESETS[1].url };
    var favs = Store.get('favs', null);
    if (favs) {
      Library.setOwner(pl.id);
      for (var url in favs) if (favs.hasOwnProperty(url)) Library.toggleFav('live', { id: url, name: '' });
      Store.del('favs');
    }
    Store.del('source');
    return { list: [pl], active: pl.id };
  }

  var saved = Store.get('playlists', null) || migrate();
  persist();

  function persist() { Store.set('playlists', saved); }
  function list() { return saved.list.slice(); }
  function get(id) {
    for (var i = 0; i < saved.list.length; i++) if (saved.list[i].id === id) return saved.list[i];
    return null;
  }
  function active() { return get(saved.active) || saved.list[0] || null; }
  function setActive(id) { saved.active = id; persist(); }

  function add(pl) {
    pl = copy(pl);
    pl.id = newId();
    if (!pl.name) pl.name = pl.type === 'xtream' ? pl.user + ' @ ' + host(pl.server) : host(pl.url) || 'Playlist';
    saved.list.push(pl);
    persist();
    return pl;
  }

  function update(id, fields) {
    var pl = get(id);
    if (!pl) return null;
    for (var k in fields) if (fields.hasOwnProperty(k) && k !== 'id') pl[k] = fields[k];
    persist();
    return pl;
  }

  function remove(id) {
    saved.list = saved.list.filter(function (p) { return p.id !== id; });
    if (saved.active === id) saved.active = saved.list.length ? saved.list[0].id : '';
    persist();
    Library.KINDS.forEach(function (kind) {
      Store.del('fav.' + id + '.' + kind);
      Store.del('hist.' + id + '.' + kind);
    });
  }

  function copy(o) { var out = {}; for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k]; return out; }
  function host(url) { var m = /^[a-z]+:\/\/([^\/?#:]+)/i.exec(url || ''); return m ? m[1] : ''; }

  /* ---------- loading ---------- */

  function fetchText(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.timeout = 45000;
      xhr.onload = function () {
        // Files packaged with the app load with status 0 on the TV.
        var ok = (xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText);
        if (ok) resolve(xhr.responseText); else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () { reject(new Error('network error')); };
      xhr.ontimeout = function () { reject(new Error('timed out')); };
      xhr.send();
    });
  }

  function loginOf(pl) {
    if (pl.type === 'xtream') return { server: pl.server, user: pl.user, pass: pl.pass };
    if (pl.type === 'm3u') return Xtream.fromLink(pl.url);
    return null;
  }

  function load(pl) {
    var login = loginOf(pl);
    return login ? loadXtream(pl, login) : loadM3u(pl);
  }

  function loadXtream(pl, login) {
    var x = Xtream.client(login);
    // The account call also picks the live stream format, so it goes first.
    return x.account().then(function (account) {
      // Movies and series are optional: some accounts are live-only.
      function soft(p) { return p.catch(function () { return []; }); }
      return Promise.all([x.live(), soft(x.movies()), soft(x.series())]).then(function (r) {
        return { playlist: pl, live: r[0], movies: r[1], series: r[2], account: account,
          seriesInfo: x.seriesInfo, movieInfo: x.movieInfo };
      });
    });
  }

  var EP_RE = /^(.*?)[\s._\-|]*S(\d{1,2})[\s._\-]*E(\d{1,3})\b(.*)$/i;

  function loadM3u(pl) {
    var got = pl.type === 'demo' ? Promise.resolve(DEMO) : fetchText(pl.url);
    return got.then(function (text) {
      var all = M3U.parse(text), live = [], movies = [], byName = {}, series = [];
      all.forEach(function (e) {
        if (/\/movie\//i.test(e.url)) {
          movies.push({ kind: 'movie', id: e.url, name: e.name, poster: e.logo, group: e.group, added: 0, rating: 0, url: e.url });
        } else if (/\/series\//i.test(e.url)) {
          var m = EP_RE.exec(e.name), name = m ? m[1].trim() || e.name : e.name;
          var s = byName[name];
          if (!s) {
            s = byName[name] = { kind: 'series', id: 'm3u:' + name, name: name, poster: e.logo, group: e.group,
              added: 0, rating: 0, plot: '', genre: '', year: '', seasons: {} };
            series.push(s);
          }
          var sn = m ? parseInt(m[2], 10) : 1, en = m ? parseInt(m[3], 10) : 0;
          (s.seasons[sn] = s.seasons[sn] || []).push({ kind: 'episode', id: e.url, num: en, season: sn,
            title: m && m[4].replace(/^[\s\-:.]+/, '') || e.name, dur: 0, poster: e.logo, plot: '', url: e.url });
        } else {
          e.num = live.length + 1;
          live.push(e);
        }
      });
      if (!all.length) throw new Error('no channels found');

      function seriesInfo(id) {
        var s = null;
        for (var i = 0; i < series.length; i++) if (series[i].id === id) { s = series[i]; break; }
        if (!s) return Promise.reject(new Error('series not found'));
        var seasons = Object.keys(s.seasons).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
          var eps = s.seasons[n].slice().sort(function (a, b) { return a.num - b.num; });
          eps.forEach(function (ep, i) { if (!ep.num) ep.num = i + 1; });
          return { num: n, episodes: eps };
        });
        return Promise.resolve({ plot: '', genre: '', year: '', poster: s.poster, backdrop: '', seasons: seasons });
      }
      function movieInfo() { return Promise.resolve(null); }

      return { playlist: pl, live: live, movies: movies, series: series, account: null,
        seriesInfo: seriesInfo, movieInfo: movieInfo };
    });
  }

  return { PRESETS: PRESETS, list: list, get: get, active: active, setActive: setActive,
    add: add, update: update, remove: remove, load: load, loginOf: loginOf };
})();
