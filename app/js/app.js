/* Taher IPTV - home, live TV guide, full-screen player and playlists, driven by the TV remote.

   Screens: 'home', 'live' (guide and full screen), 'playlists', plus screens that other modules
   register through App.register (js/vod.js: 'movies' and 'series'; js/settings.js: 'settings').
   The current screen is on <body data-screen="...">, so each screen's CSS shows its own container.

   Screen contract for App.register(name, screen):
     open(arg)              screen becomes current (arg from App.go)
     close()                screen stops being current
     key(e, k)              a key press; k is already mapped (desktop keys -> remote codes, except while
                            an <input> has focus). Call e.preventDefault() unless an input is typing.
     onState(state, detail) optional: Player state while this screen is current
     tick()                 optional: once a second while current
     onVisibility(hidden)   optional: app hidden/shown while current (default: Player.stop on hide)
     onLoad(data)           optional: a playlist finished loading (called whether current or not) */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    CH_UP: 427, CH_DOWN: 428, PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, STOP: 413, INFO: 457,
    REWIND: 412, FAST_FORWARD: 417,
    IME_DONE: 65376, IME_CANCEL: 65385
  };
  var LIST_ROWS = 14;
  var CAT_ROWS = 17;
  var TRACK = 960;          // scroll track height in px (matches .scroll in CSS)
  var OSD_MS = 5000;
  var NUM_MS = 1600;
  var PRELOAD_AFTER_PLAY_MS = 150;    // the new stream is already playing; start on the next ones at once
  var PRELOAD_FOCUS_MS = 700;         // focus must rest this long before its channel is pre-buffered
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var TILES = [
    { id: 'live', name: 'Live TV',
      icon: '<rect x="2.5" y="4" width="19" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 20.5h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="7" cy="8" r="1.3" fill="currentColor"/>' },
    { id: 'movies', name: 'Movies',
      icon: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 8.3v7.4l6-3.7z" fill="currentColor"/>' },
    { id: 'series', name: 'Series',
      icon: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'playlists', name: 'Playlists',
      icon: '<path d="M4 6.5h11M4 11.5h11M4 16.5h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15.5 14v6.2l4.8-3.1z" fill="currentColor"/>' },
    { id: 'settings', name: 'Settings',
      icon: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' }
  ];

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    screen: 'home',        // see the header comment
    data: null,            // loaded playlist data (see sources.js)
    loadError: '',
    channels: [], cats: [], view: [],
    catIndex: 0, listIndex: 0,
    zone: 'list',          // live guide: 'list' | 'cats' (drawer open) | 'search'
    mode: 'guide',         // live: 'guide' | 'full'
    playing: null,
    state: 'idle', stateDetail: '',
    sort: Store.get('sort', 'num'),
    aspect: Player.setAspect(Store.get('aspect', 'fit')),
    query: '',
    loading: false,
    tile: 0,
    num: '', numTimer: 0, osdTimer: 0, toastTimer: 0, preTimer: 0, zapDir: 1, exitArmed: false
  };

  var screens = {};        // registered by other modules
  var loadListeners = [];

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    var words = String(name).replace(/\(.*?\)|\[.*?\]/g, '').split(/[\s\-_.:]+/).filter(Boolean);
    var s = words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : (words[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }

  function tint(name) {
    var h = 0;
    name = String(name);
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg,hsl(' + h + ',38%,34%),hsl(' + ((h + 40) % 360) + ',42%,24%))';
  }

  // Image with tinted initials behind it; the initials show when there is no image or it fails.
  function logoHtml(ch, cls) {
    var src = ch.logo || ch.poster || '';
    var html = '<span class="' + cls + '"><span class="ini" style="background:' + tint(ch.name) + '">' + esc(initials(ch.name)) + '</span>';
    if (src) {
      html += '<img src="' + esc(src) + '" onload="this.parentNode.className+=\' has-img\'" onerror="this.parentNode.removeChild(this)">';
    }
    return html + '</span>';
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function windowStart(index, count, visible) {
    return clamp(index - Math.floor(visible / 2), 0, Math.max(0, count - visible));
  }

  function pad(n) { return ('0' + n).slice(-2); }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dateStr(d) { return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function dayStr(ms) { var d = new Date(ms); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); }

  function dur(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60);
  }

  function count(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function format(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'HLS';
    if (/\.mpd(\?|$)/i.test(url)) return 'DASH';
    if (/\.mp4(\?|$)/i.test(url)) return 'MP4';
    if (/\.ts(\?|$)/i.test(url)) return 'TS';
    return 'Stream';
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3000);
  }

  function sameCh(a, b) { return !!a && !!b && a.url === b.url; }
  function isLive() { return S.state === 'playing' || S.state === 'buffering'; }
  function isFav(ch) { return !!ch && Library.isFav('live', ch.url); }

  /* ---------- screens ---------- */

  function register(name, screen) { screens[name] = screen; }

  function go(name, arg) {
    if (name !== 'home' && name !== 'live' && name !== 'playlists' && !screens[name]) {
      toast('Coming soon');
      return;
    }
    var prev = S.screen;
    if (prev === name && name !== 'playlists') return;
    leave(prev, name);
    S.screen = name;
    document.body.setAttribute('data-screen', name);
    if (name === 'home') openHome();
    else if (name === 'live') openLive();
    else if (name === 'playlists') openPlaylists(prev);
    else screens[name].open(arg);
  }

  function leave(name, next) {
    if (name === 'live') {
      $('osd').classList.remove('show');
      document.body.classList.remove('full');
      S.mode = 'guide';
      if (next !== 'playlists') stopLive();
    } else if (name === 'playlists') {
      $('playlists').classList.remove('show');
    } else if (screens[name]) {
      screens[name].close();
    }
  }

  function stopLive() {
    clearTimeout(S.preTimer);
    if (S.playing) Player.stop();
    S.playing = null;
    document.body.classList.remove('has-video', 'full');
  }

  /* ---------- data ---------- */

  function favCount() {
    var n = 0;
    S.channels.forEach(function (ch) { if (isFav(ch)) n++; });
    return n;
  }

  function recentChannels() {
    var byUrl = {}, out = [];
    S.channels.forEach(function (ch) { byUrl[ch.url] = ch; });
    Library.history('live').forEach(function (h) { if (byUrl[h.url || h.id]) out.push(byUrl[h.url || h.id]); });
    return out;
  }

  function buildCats() {
    var counts = {}, groups = [], order = S.channels.groupOrder;
    S.channels.forEach(function (ch) {
      if (!counts[ch.group]) { counts[ch.group] = 0; groups.push(ch.group); }
      counts[ch.group]++;
    });
    if (order) groups.sort(function (a, b) { return (order[a] === undefined ? 1e9 : order[a]) - (order[b] === undefined ? 1e9 : order[b]); });
    else groups.sort(function (a, b) { return a.localeCompare(b); });
    S.cats = [{ id: 'all', name: 'All channels', count: S.channels.length },
              { id: 'fav', name: 'Favourites', count: favCount() },
              { id: 'recent', name: 'Recently watched', count: recentChannels().length }]
      .concat(groups.map(function (g) { return { id: 'group', group: g, name: g, count: counts[g] }; }));
  }

  function refreshCounts() {
    if (!S.cats.length) return;
    S.cats[1].count = favCount();
    S.cats[2].count = recentChannels().length;
  }

  // Channels for the current category, filtered by the search text and sorted.
  function buildView(keepFocus) {
    var cat = S.cats[S.catIndex], focused = S.view[S.listIndex];
    var list = !cat ? [] : cat.id === 'all' ? S.channels
      : cat.id === 'fav' ? S.channels.filter(isFav)
      : cat.id === 'recent' ? recentChannels()
      : S.channels.filter(function (ch) { return ch.group === cat.group; });
    var q = S.query.trim().toLowerCase();
    if (q) list = list.filter(function (ch) { return ch.name.toLowerCase().indexOf(q) !== -1 || String(ch.num) === q; });
    if (S.sort === 'name' && cat && cat.id !== 'recent') list = list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    S.view = list;

    var target = keepFocus ? focused : S.playing, at = -1;
    for (var i = 0; target && i < list.length; i++) if (sameCh(list[i], target)) { at = i; break; }
    S.listIndex = Math.max(0, at);
  }

  // Loads a saved playlist and makes it the active one.
  function loadPlaylist(pl) {
    if (!pl) { S.data = null; S.loadError = 'No playlist. Add one in Playlists.'; renderHome(); return Promise.resolve(null); }
    S.loading = true;
    S.loadError = '';
    stopLive();
    renderAll();
    return Playlists.load(pl).then(function (data) {
      Playlists.setActive(pl.id);
      Library.setOwner(pl.id);
      S.data = data;
      S.channels = data.live;
      S.query = '';
      $('search-input').value = '';
      buildCats();
      S.catIndex = 0;
      buildView(false);
      S.zone = 'list';
      S.loading = false;
      renderAll();
      var parts = [count(data.live.length) + ' channels'];
      if (data.movies.length) parts.push(count(data.movies.length) + ' movies');
      if (data.series.length) parts.push(count(data.series.length) + ' series');
      toast('Loaded ' + pl.name + ' · ' + parts.join(' · '));
      for (var name in screens) if (screens.hasOwnProperty(name) && screens[name].onLoad) screens[name].onLoad(data);
      loadListeners.forEach(function (fn) { fn(data); });
      return data;
    }).catch(function (err) {
      S.loading = false;
      S.loadError = 'Could not load ' + pl.name + ': ' + (err.message || err);
      toast(S.loadError);
      renderAll();
      throw err;
    });
  }

  function renderAll() {
    if (S.screen === 'home') renderHome();
    else if (S.screen === 'live') render();
    else if (S.screen === 'playlists') renderPlaylists();
  }

  /* ---------- home ---------- */

  function openHome() {
    stopLive();
    renderHome();
  }

  function tileCount(id) {
    var d = S.data;
    if (S.loading) return 'Loading…';
    if (id === 'playlists') { var n = Playlists.list().length; return n + (n === 1 ? ' playlist' : ' playlists'); }
    if (id === 'settings') return 'Account, history, favourites';
    if (!d) return '';
    if (id === 'live') return count(d.live.length) + ' channels';
    if (id === 'movies') return d.movies.length ? count(d.movies.length) + ' movies' : 'None in this playlist';
    if (id === 'series') return d.series.length ? count(d.series.length) + ' series' : 'None in this playlist';
    return '';
  }

  function renderHome() {
    var pl = Playlists.active(), acc = S.data && S.data.account;
    $('h-playlist').innerHTML = pl ? '<span class="k">Playlist</span>' + esc(pl.name) : '<span class="k">No playlist</span>';
    var a = '';
    if (S.loading) a = '<span class="spin-sm"></span>Loading playlist…';
    else if (S.loadError) a = '<span class="bad">' + esc(S.loadError) + '</span>';
    else if (acc) {
      a = '<span class="k">Status</span><span class="' + (acc.active ? 'ok' : 'bad') + '">' + esc(acc.status) + '</span>' +
        '<span class="sep"></span><span class="k">Expires</span><span class="v">' + (acc.expiry ? dayStr(acc.expiry) : 'Unlimited') + '</span>';
    } else if (S.data) a = '<span class="k">Status</span><span class="ok">Loaded</span><span class="sep"></span><span class="k">M3U playlist</span>';
    $('h-account').innerHTML = a;

    var h = new Date().getHours();
    var hi = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('h-hero').innerHTML = '<div class="hero-hi"><b>' + hi + '</b></div>' +
      '<div class="hero-q">What would you like to watch?</div><div class="hero-row">' + recentForHero() + '</div>';

    var html = '';
    TILES.forEach(function (t, i) {
      html += '<div class="tile tile-' + t.id + (i === S.tile ? ' sel' : '') + '">' +
        '<svg viewBox="0 0 24 24" class="tile-icon">' + t.icon + '</svg>' +
        '<div class="tile-name">' + t.name + '</div><div class="tile-sub">' + esc(tileCount(t.id)) + '</div></div>';
    });
    $('tiles').innerHTML = html;
  }

  // A short "continue" line on the home screen: last live channel and last movie or episode.
  function recentForHero() {
    if (!S.data) return '';
    var out = [], live = Library.history('live')[0], mov = Library.history('movie')[0], ser = Library.history('series')[0];
    if (live) out.push('<span class="hero-item"><span class="k">Last channel</span>' + esc(live.name || '') + '</span>');
    var v = mov && (!ser || mov.at > ser.at) ? mov : ser;
    if (v) {
      var what = v.ep ? v.name + ' · S' + pad(v.ep.season) + 'E' + pad(v.ep.num) : v.name;
      out.push('<span class="hero-item"><span class="k">Continue</span>' + esc(what || '') + '</span>');
    }
    return out.join('');
  }

  function homeKey(e, k) {
    e.preventDefault();
    switch (k) {
      case KEY.LEFT: S.tile = clamp(S.tile - 1, 0, TILES.length - 1); break;
      case KEY.RIGHT: S.tile = clamp(S.tile + 1, 0, TILES.length - 1); break;
      case KEY.ENTER: openTile(TILES[S.tile].id); return;
      case KEY.BLUE: go('playlists'); return;
      case KEY.BACK: armExit(); return;
      default: return;
    }
    renderHome();
  }

  function openTile(id) {
    if (id === 'playlists' || id === 'settings') { go(id); return; }
    if (S.loading) { toast('Playlist is still loading'); return; }
    if (!S.data) { toast(S.loadError || 'Add a playlist first'); go('playlists'); return; }
    if (id === 'movies' && !S.data.movies.length) { toast('This playlist has no movies'); return; }
    if (id === 'series' && !S.data.series.length) { toast('This playlist has no series'); return; }
    if (id === 'live' && !S.data.live.length) { toast('This playlist has no live channels'); return; }
    go(id);
  }

  function armExit() {
    if (S.exitArmed) { exitApp(); return; }
    S.exitArmed = true;
    toast('Press BACK again to exit');
    setTimeout(function () { S.exitArmed = false; }, 2000);
  }

  /* ---------- live: playback ---------- */

  function openLive() {
    S.mode = 'guide';
    S.zone = 'list';
    refreshCounts();
    buildView(false);
    render();
    // Start where the user left off.
    var last = Library.history('live')[0];
    if (!S.playing && last) {
      for (var i = 0; i < S.view.length; i++) {
        if (S.view[i].url === (last.url || last.id)) { S.listIndex = i; play(S.view[i]); return; }
      }
    }
  }

  function play(ch) {
    S.playing = ch;
    Library.record('live', { id: ch.url, url: ch.url, name: ch.name, logo: ch.logo, group: ch.group });
    Player.play(ch.url, ch.ua);
    render();
  }

  Player.onState(function (state, detail) {
    var scr = screens[S.screen];
    if (scr) { if (scr.onState) scr.onState(state, detail); return; }
    if (S.screen !== 'live' && S.screen !== 'playlists') return;
    S.state = state;
    S.stateDetail = detail;
    document.body.classList.toggle('has-video', !!S.playing && isLive());
    renderList();
    renderLive();
    if (state === 'error' && S.mode === 'full') showOsd();
    if (state === 'playing') schedulePreload(PRELOAD_AFTER_PLAY_MS);
  });

  // Channels the user is likely to pick next, most likely first: in full screen two ahead in the
  // zap direction and one behind (CH+/-), in the guide the focused row and the rows around it.
  function preloadTargets() {
    var list = S.view.length ? S.view : S.channels, out = [];
    if (!list.length) return out;
    function at(ch) { for (var j = 0; j < list.length; j++) if (sameCh(list[j], ch)) return j; return -1; }
    if (S.mode === 'full') {
      var i = at(S.playing);
      if (i === -1) return out;
      var d = S.zapDir, n = list.length;
      [d, -d, 2 * d].forEach(function (k) {
        var ch = list[((i + k) % n + n) % n];
        if (!sameCh(ch, S.playing) && out.indexOf(ch) === -1) out.push(ch);
      });
    } else {
      var f = S.view[S.listIndex];
      if (!f) return out;
      if (!sameCh(f, S.playing)) out.push(f);
      [1, -1].forEach(function (k) {
        var ch = S.view[S.listIndex + k];
        if (ch && !sameCh(ch, S.playing)) out.push(ch);
      });
    }
    return out;
  }

  function schedulePreload(ms) {
    clearTimeout(S.preTimer);
    S.preTimer = setTimeout(function () {
      if (S.screen !== 'live' || S.loading) return;
      // Pre-buffering competes with the stream that is still starting, so wait for it.
      if (S.playing && S.state !== 'playing' && S.state !== 'error') return;
      Player.preload(preloadTargets());
    }, ms);
  }

  function goFull() {
    if (!S.playing) return;
    S.mode = 'full';
    document.body.classList.add('full');
    renderLive();
    showOsd();
    schedulePreload(300);
  }

  function goGuide() {
    S.mode = 'guide';
    document.body.classList.remove('full');
    $('osd').classList.remove('show');
    for (var j = 0; j < S.view.length; j++) if (sameCh(S.view[j], S.playing)) { S.listIndex = j; break; }
    render();
    schedulePreload(PRELOAD_FOCUS_MS);
  }

  function zap(step) {
    var list = S.view.length ? S.view : S.channels;
    if (!list.length) return;
    var at = -1;
    for (var j = 0; j < list.length; j++) if (sameCh(list[j], S.playing)) { at = j; break; }
    var next = (at + step + list.length) % list.length;
    S.zapDir = step > 0 ? 1 : -1;
    if (list === S.view) S.listIndex = next;
    play(list[next]);
    showOsd();
  }

  function showOsd() {
    if (!S.playing) return;
    renderOsd();
    $('osd').classList.add('show');
    clearTimeout(S.osdTimer);
    S.osdTimer = setTimeout(function () { $('osd').classList.remove('show'); }, OSD_MS);
  }

  function toggleFav(ch) {
    if (!ch) return;
    var on = Library.toggleFav('live', { id: ch.url, url: ch.url, name: ch.name, logo: ch.logo, group: ch.group });
    refreshCounts();
    if (S.cats[S.catIndex].id === 'fav') {
      var keep = S.listIndex;
      buildView(true);
      S.listIndex = clamp(keep, 0, Math.max(0, S.view.length - 1));
    }
    toast(on ? '♥  Added ' + ch.name + ' to favourites' : 'Removed ' + ch.name + ' from favourites');
    render();
    if (S.mode === 'full') showOsd();
  }

  function toggleSort() {
    S.sort = S.sort === 'num' ? 'name' : 'num';
    Store.set('sort', S.sort);
    buildView(true);
    toast(S.sort === 'name' ? 'Sorted A–Z' : 'Sorted by channel number');
    render();
  }

  function toggleAspect() {
    S.aspect = Player.setAspect(S.aspect === 'fit' ? 'fill' : 'fit');
    Store.set('aspect', S.aspect);
    showOsd();
  }

  /* ---------- number entry ---------- */

  function digit(d) {
    if (S.num.length >= 4) S.num = '';
    S.num += String(d);
    var box = $('numbox');
    box.textContent = S.num;
    box.classList.add('show');
    clearTimeout(S.numTimer);
    S.numTimer = setTimeout(commitNumber, NUM_MS);
  }

  function commitNumber() {
    var n = parseInt(S.num, 10);
    S.num = '';
    $('numbox').classList.remove('show');
    var ch = S.channels[n - 1];
    if (!ch) { toast('No channel ' + n); return; }
    if (S.mode === 'full') { play(ch); showOsd(); return; }
    S.catIndex = 0;
    S.query = '';
    $('search-input').value = '';
    S.zone = 'list';
    play(ch);
    buildView(false);
    render();
  }

  /* ---------- live: rendering ---------- */

  function render() {
    var g = $('guide');
    g.className = 'guide zone-' + S.zone + (S.zone === 'cats' ? ' drawer-open' : '');
    renderCats();
    renderList();
    renderInfo();
    renderLive();
  }

  function renderCats() {
    var start = windowStart(S.catIndex, S.cats.length, CAT_ROWS), html = '';
    for (var i = start; i < Math.min(S.cats.length, start + CAT_ROWS); i++) {
      var c = S.cats[i];
      html += '<div class="cat' + (i === S.catIndex ? (S.zone === 'cats' ? ' sel' : ' current') : '') + '">' +
        '<span class="cat-name">' + esc(c.name) + '</span><span class="cat-count">' + c.count + '</span></div>';
    }
    $('cats').innerHTML = html;
  }

  function renderList() {
    var el = $('list'), cat = S.cats[S.catIndex];
    $('list-title').textContent = S.query ? 'Search · “' + S.query + '”' : (cat ? cat.name : '');
    $('list-meta').innerHTML = S.view.length
      ? '<b>' + (S.listIndex + 1) + '</b> / ' + S.view.length + (S.sort === 'name' ? '  ·  A–Z' : '') : '';

    var thumb = $('scroll-thumb');
    thumb.parentNode.style.visibility = S.view.length > LIST_ROWS ? 'visible' : 'hidden';
    if (S.view.length > LIST_ROWS) {
      var h = Math.max(36, TRACK * LIST_ROWS / S.view.length);
      thumb.style.display = 'block';
      thumb.style.height = h + 'px';
      thumb.style.top = ((TRACK - h) * S.listIndex / (S.view.length - 1)) + 'px';
    } else {
      thumb.style.display = 'none';
    }

    if (S.loading) { el.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto 26px"></div>Loading playlist…</div>'; return; }
    if (!S.view.length) {
      el.innerHTML = '<div class="empty">' + (S.query ? 'No channels match “' + esc(S.query) + '”<small>Press BACK to clear the search</small>'
        : cat && cat.id === 'fav' ? 'No favourites yet<small>Press the red button on a channel to add it</small>'
        : cat && cat.id === 'recent' ? 'Nothing watched yet'
        : 'No channels') + '</div>';
      return;
    }

    var start = windowStart(S.listIndex, S.view.length, LIST_ROWS), html = '';
    for (var i = start; i < Math.min(S.view.length, start + LIST_ROWS); i++) {
      var ch = S.view[i], on = sameCh(ch, S.playing);
      html += '<div class="row' + (i === S.listIndex ? ' sel' : '') + (on ? ' playing' : '') + '">' +
        logoHtml(ch, 'logo') +
        '<span class="num">' + ch.num + '</span><span class="name">' + esc(ch.name) + '</span>' +
        '<div class="tags">' + (isFav(ch) ? '<span class="fav">♥</span>' : '') +
        (on && isLive() ? '<span class="eq"><i></i><i></i><i></i></span>' : '') + '</div></div>';
    }
    el.innerHTML = html;
  }

  // Static part of the info panel: the focused channel.
  function renderInfo() {
    var ch = S.view[S.listIndex];
    if (!ch) {
      $('i-logo').innerHTML = '';
      $('i-name').textContent = S.loading ? 'Loading…' : '';
      $('i-sub').textContent = '';
      return;
    }
    $('i-logo').innerHTML = logoHtml(ch, 'i-logo');
    $('i-name').textContent = ch.name;
    $('i-sub').innerHTML = '<b>' + ch.num + '</b>' + esc(ch.group);
  }

  function stateBadge() {
    switch (S.state) {
      case 'loading': return '<span class="badge"><i class="spin"></i>Connecting</span>';
      case 'buffering': return '<span class="badge"><i class="spin"></i>Buffering</span>';
      case 'error': return '<span class="badge warn">Unavailable</span>';
      case 'ended': return '<span class="badge">Ended</span>';
      case 'playing': return '<span class="badge live">' + (Player.info().duration > 0 ? 'Playing' : 'Live') + '</span>';
      default: return '';
    }
  }

  // Parts that change while a stream plays: badges, progress, now/next. Called every second.
  function renderLive() {
    var ch = S.view[S.listIndex];
    var on = !!ch && sameCh(ch, S.playing);
    var p = on ? Player.info() : null;
    var badges = '', time = '', title = '', pct = 0, next = '';

    if (ch) {
      if (on) {
        badges += stateBadge();
        if (p.width) badges += '<span class="badge res">' + p.width + '×' + p.height + '</span>';
      }
      badges += '<span class="badge">' + format(ch.url) + '</span>';
    }

    if (on && S.state === 'error') {
      title = 'Stream unavailable';
      next = esc(S.stateDetail || 'The channel may be offline or geo-blocked') + ' · OK to retry';
    } else if (on && p.duration > 0) {
      time = dur(p.time) + ' / ' + dur(p.duration);
      title = 'Now playing';
      pct = 100 * p.time / p.duration;
      next = 'Press <b>OK</b> for full screen';
    } else if (on) {
      time = isLive() ? 'Live now' : '';
      title = isLive() ? 'Now playing' : S.state === 'loading' ? 'Connecting…' : S.state === 'buffering' ? 'Buffering…' : '';
      pct = isLive() ? 100 : 0;
      next = 'No programme guide for this channel · <b>OK</b> full screen';
    } else if (ch) {
      title = 'Press OK to watch';
      next = 'No programme guide for this channel';
    }

    $('i-badges').innerHTML = badges;
    $('i-now-time').textContent = time;
    $('i-now').textContent = title;
    $('i-progress').style.width = pct + '%';
    $('i-next').innerHTML = next;
    if (S.mode === 'full') renderOsd();
    renderFullState();
  }

  function renderOsd() {
    var ch = S.playing;
    if (!ch) return;
    var p = Player.info(), now = new Date();
    if ($('o-logo').getAttribute('data-url') !== ch.url) {   // avoid reloading the logo every second
      $('o-logo').innerHTML = logoHtml(ch, 'o-logo');
      $('o-logo').setAttribute('data-url', ch.url);
    }
    $('o-num').textContent = ch.num;
    $('o-name').innerHTML = esc(ch.name) + (isFav(ch) ? ' <span style="color:var(--key-red)">♥</span>' : '');
    $('o-now').innerHTML = '<span class="k">Now</span>' + (p.duration > 0 ? dur(p.time) + ' / ' + dur(p.duration) : isLive() ? 'Live' : esc(S.state));
    $('o-next').innerHTML = '<span class="k">Group</span><span class="v">' + esc(ch.group) + '</span>';
    $('o-time').textContent = hhmm(now);
    $('o-date').textContent = dateStr(now);
    $('o-badges').innerHTML = '<span class="aspect"><i class="dot green"></i>Aspect: ' + (S.aspect === 'fit' ? 'Fit' : 'Fill') + '</span>' +
      (p.width ? '<span class="badge res">' + p.width + '×' + p.height + '</span>' : '') + stateBadge();
  }

  function renderFullState() {
    var el = $('full-state'), html = '';
    if (S.state === 'loading') html = '<div class="spinner"></div>Connecting…';
    else if (S.state === 'buffering') html = '<div class="spinner"></div>Buffering…';
    else if (S.state === 'error') html = 'Stream unavailable<small>' + esc(S.stateDetail || 'The channel may be offline or geo-blocked') + '</small>';
    el.innerHTML = html;
    el.classList.toggle('on', !!html);
  }

  /* ---------- playlists ---------- */

  // view: 'list' (saved playlists and actions) | 'm3u' | 'xtream' (add forms) | 'presets'
  var PL = { view: 'list', index: 0, items: [], from: 'home', confirm: '', busy: false, form: {} };

  function openPlaylists(from) {
    PL.from = from === 'playlists' ? PL.from : from;
    document.body.setAttribute('data-under', PL.from);
    PL.view = 'list';
    PL.confirm = '';
    PL.index = 0;
    var act = Playlists.active();
    Playlists.list().forEach(function (p, i) { if (act && p.id === act.id) PL.index = i; });
    renderPlaylists();
    $('playlists').classList.add('show');
  }

  function closePlaylists() {
    blurInputs();
    go(PL.from === 'live' && S.data ? 'live' : 'home');
  }

  function plItems() {
    if (PL.view === 'list') {
      return Playlists.list().map(function (p) { return { type: 'pl', pl: p }; })
        .concat([{ type: 'nav', to: 'xtream', label: 'Add Xtream Codes login', small: 'server · user · password' },
                 { type: 'nav', to: 'm3u', label: 'Add M3U link', small: 'http(s)://…' },
                 { type: 'nav', to: 'presets', label: 'Add a free playlist', small: presetCount() },
                 { type: 'close', label: 'Close', small: 'BACK' }]);
    }
    if (PL.view === 'presets') {
      return Playlists.PRESETS.map(function (p) { return { type: 'preset', preset: p }; })
        .concat([{ type: 'back', label: 'Back', small: 'BACK' }]);
    }
    var fields = PL.view === 'xtream'
      ? [['name', 'Name (optional)', 'text', 'My provider'], ['server', 'Server URL', 'url', 'http://example.com:8080'],
         ['user', 'Username', 'text', ''], ['pass', 'Password', 'password', '']]
      : [['name', 'Name (optional)', 'text', 'My playlist'], ['url', 'M3U link', 'url', 'https://example.com/playlist.m3u']];
    return fields.map(function (f) { return { type: 'input', key: f[0], label: f[1], input: f[2], ph: f[3] }; })
      .concat([{ type: 'save', label: PL.busy ? 'Checking…' : 'Save and load', small: 'OK' },
               { type: 'back', label: 'Cancel', small: 'BACK' }]);
  }

  function presetCount() { return Playlists.PRESETS.length + ' presets'; }

  function hostOf(url) { var m = /^[a-z]+:\/\/([^\/?#]+)/i.exec(url || ''); return m ? m[1] : url || ''; }

  function renderPlaylists() {
    if (S.screen !== 'playlists') return;
    // Keep what was typed: inputs are rebuilt on every render.
    var typed = {};
    Array.prototype.forEach.call(document.querySelectorAll('#pl-items input'), function (inp) { typed[inp.getAttribute('data-key')] = inp.value; });
    for (var k in typed) if (typed.hasOwnProperty(k)) PL.form[k] = typed[k];

    PL.items = plItems();
    PL.index = clamp(PL.index, 0, PL.items.length - 1);
    var act = Playlists.active(), html = '', title = 'Playlists', sub = '', hint = '';

    if (PL.view === 'list') {
      sub = act ? 'Active: ' + act.name + (S.data ? ' · ' + count(S.channels.length) + ' channels' : '') : 'No playlist yet';
      hint = '<span><kbd>OK</kbd>Load</span><span><i class="dot red"></i>Delete</span><span><kbd>BACK</kbd>Close</span>';
    } else if (PL.view === 'presets') {
      title = 'Free playlists'; sub = 'Public free-to-air channels. OK adds and loads one.';
    } else {
      title = PL.view === 'xtream' ? 'Add Xtream Codes login' : 'Add M3U link';
      sub = PL.view === 'xtream' ? 'The details your IPTV provider sent you.' : 'A link to an .m3u or .m3u8 file.';
      hint = '<span><kbd>OK</kbd>Type</span><span><kbd>▲ ▼</kbd>Move</span><span><kbd>BACK</kbd>Cancel</span>';
    }

    PL.items.forEach(function (it, i) {
      var sel = i === PL.index ? ' sel' : '';
      if (it.type === 'pl') {
        var p = it.pl, on = act && p.id === act.id;
        var kind = p.type === 'xtream' ? 'Xtream · ' + p.user + ' @ ' + hostOf(p.server)
          : p.type === 'demo' ? 'Built-in demo' : (Xtream.fromLink(p.url) ? 'Xtream link · ' : 'M3U · ') + hostOf(p.url);
        var warn = PL.confirm === p.id ? '<small class="warn">Press red again to delete</small>' : '';
        html += '<div class="set-item pl-row' + sel + (on ? ' on' : '') + '"><div class="pl-text"><div class="pl-name">' + esc(p.name) +
          '</div><div class="pl-kind">' + esc(kind) + '</div></div>' + warn +
          (on ? '<svg viewBox="0 0 24 24" class="pl-check"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') +
          '</div>';
      } else if (it.type === 'preset') {
        html += '<div class="set-item' + sel + '">' + esc(it.preset.name) + '</div>';
      } else if (it.type === 'input') {
        html += '<div class="set-label">' + esc(it.label) + '</div>' +
          '<div class="set-item set-input' + sel + '"><input data-key="' + it.key + '" type="' + it.input + '" placeholder="' + esc(it.ph) +
          '" spellcheck="false" autocomplete="off" autocapitalize="off"></div>';
      } else {
        var gap = it.type === 'nav' && PL.items[i - 1] && PL.items[i - 1].type === 'pl' ? ' style="margin-top:22px"' :
          (it.type === 'close' || it.type === 'back' || it.type === 'save') && PL.items[i - 1] && PL.items[i - 1].type !== it.type && it.type !== 'back' ? ' style="margin-top:22px"' : '';
        html += '<div class="set-item' + sel + (it.type === 'nav' ? ' pl-nav' : '') + '"' + gap + '>' + esc(it.label) +
          (it.small ? '<small>' + esc(it.small) + '</small>' : '') + '</div>';
      }
    });

    $('pl-title').textContent = title;
    $('pl-sub').textContent = sub;
    $('pl-items').innerHTML = html;
    $('pl-hint').innerHTML = hint;
    Array.prototype.forEach.call(document.querySelectorAll('#pl-items input'), function (inp) {
      inp.value = PL.form[inp.getAttribute('data-key')] || '';
    });
  }

  function plInput(i) {
    var it = PL.items[i];
    return it && it.type === 'input' ? document.querySelector('#pl-items input[data-key="' + it.key + '"]') : null;
  }

  function blurInputs() {
    var a = document.activeElement;
    if (a && a.tagName === 'INPUT') a.blur();
  }

  function plShow(view) {
    PL.view = view;
    PL.index = 0;
    PL.confirm = '';
    if (view === 'm3u' || view === 'xtream') PL.form = {};
    renderPlaylists();
  }

  function plActivate() {
    var it = PL.items[PL.index];
    if (!it) return;
    switch (it.type) {
      case 'pl':
        App.guard('playlists', function () {
          var pl = it.pl;
          go('home');
          loadPlaylist(pl).catch(function () { /* shown on home */ });
        });
        return;
      case 'nav':
        App.guard('playlists', function () { plShow(it.to); });
        return;
      case 'close': closePlaylists(); return;
      case 'back': plShow('list'); return;
      case 'preset': addAndLoad(copyPreset(it.preset)); return;
      case 'input': var inp = plInput(PL.index); if (inp) inp.focus(); return;
      case 'save': saveForm(); return;
    }
  }

  function copyPreset(p) { var o = {}; for (var k in p) if (p.hasOwnProperty(k)) o[k] = p[k]; return o; }

  function saveForm() {
    if (PL.busy) return;
    renderPlaylists();   // pulls typed values into PL.form
    var f = PL.form, pl;
    if (PL.view === 'xtream') {
      if (!f.server || !f.user || !f.pass) { toast('Fill in server, username and password'); return; }
      pl = { type: 'xtream', name: (f.name || '').trim(), server: Xtream.cleanServer(f.server), user: f.user.trim(), pass: f.pass };
    } else {
      var url = (f.url || '').trim();
      if (!/^https?:\/\//i.test(url)) { toast('Enter a link starting with http:// or https://'); return; }
      pl = { type: 'm3u', name: (f.name || '').trim(), url: url };
    }
    addAndLoad(pl);
  }

  // Checks a new playlist loads before saving it.
  function addAndLoad(pl) {
    PL.busy = true;
    renderPlaylists();
    toast('Checking ' + (pl.name || 'playlist') + '…');
    Playlists.load(pl).then(function () {
      PL.busy = false;
      var saved = Playlists.add(pl);
      go('home');
      return loadPlaylist(saved);
    }).catch(function (err) {
      PL.busy = false;
      renderPlaylists();
      toast('Could not load it: ' + (err.message || err));
    });
  }

  function deleteFocused() {
    var it = PL.items[PL.index];
    if (!it || it.type !== 'pl') return;
    if (PL.confirm !== it.pl.id) { PL.confirm = it.pl.id; renderPlaylists(); return; }
    App.guard('playlists', function () {
      var wasActive = Playlists.active() && Playlists.active().id === it.pl.id;
      Playlists.remove(it.pl.id);
      PL.confirm = '';
      toast('Deleted ' + it.pl.name);
      if (wasActive) {
        S.data = null; S.channels = []; S.cats = []; S.view = [];
        var next = Playlists.active();
        if (next) loadPlaylist(next).catch(function () { /* shown on home */ });
        else { S.loadError = 'No playlist. Add one in Playlists.'; }
      }
      renderPlaylists();
    });
  }

  function playlistsKey(e, k) {
    var input = plInput(PL.index);
    if (input && document.activeElement === input) {
      if (k === KEY.ENTER || k === KEY.IME_DONE || k === KEY.DOWN) {
        input.blur(); PL.index = clamp(PL.index + 1, 0, PL.items.length - 1); renderPlaylists(); e.preventDefault();
      } else if (k === KEY.UP) {
        input.blur(); PL.index = clamp(PL.index - 1, 0, PL.items.length - 1); renderPlaylists(); e.preventDefault();
      } else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === 27) {
        input.blur(); renderPlaylists(); e.preventDefault();
      }
      return; // let the keyboard type
    }
    e.preventDefault();
    if (k !== KEY.RED) PL.confirm = '';
    if (k === KEY.UP) { PL.index = clamp(PL.index - 1, 0, PL.items.length - 1); renderPlaylists(); }
    else if (k === KEY.DOWN) { PL.index = clamp(PL.index + 1, 0, PL.items.length - 1); renderPlaylists(); }
    else if (k === KEY.ENTER) plActivate();
    else if (k === KEY.RED && PL.view === 'list') deleteFocused();
    else if (k === KEY.BACK || k === KEY.BLUE) { if (PL.view === 'list') closePlaylists(); else plShow('list'); }
    else renderPlaylists();
  }

  /* ---------- search ---------- */

  function searchInput() { return $('search-input'); }

  function onSearchTyped() {
    S.query = searchInput().value;
    buildView(false);
    S.listIndex = 0;
    renderList();
    renderInfo();
    renderLive();
  }

  function searchKey(e, k) {
    var input = searchInput();
    if (document.activeElement === input) {
      if (k === KEY.ENTER || k === KEY.IME_DONE || k === KEY.DOWN) {
        input.blur(); S.zone = 'list'; e.preventDefault(); render();
      } else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === 27) {
        input.blur(); e.preventDefault();
      }
      return; // let the keyboard type
    }
    e.preventDefault();
    if (k === KEY.ENTER) { input.focus(); return; }
    if (k === KEY.DOWN || k === KEY.BACK) { S.zone = 'list'; render(); return; }
    if (k === KEY.LEFT) { S.zone = 'cats'; render(); }
  }

  /* ---------- keys ---------- */

  // Desktop keyboard stand-ins so the UI can be tested in a browser.
  function normalize(e) {
    var k = e.keyCode;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return k;
    if (k === 27 || k === 8) return KEY.BACK;        // Esc, Backspace
    if (k === 33) return KEY.CH_UP;                 // PageUp
    if (k === 34) return KEY.CH_DOWN;               // PageDown
    if (k === 82) return KEY.RED;                   // r
    if (k === 71) return KEY.GREEN;                 // g
    if (k === 89) return KEY.YELLOW;                // y
    if (k === 66) return KEY.BLUE;                  // b
    if (k === 73) return KEY.INFO;                  // i
    if (k === 80 || k === 32) return KEY.PLAY;      // p, Space
    if (k === 188) return KEY.REWIND;               // ,
    if (k === 190) return KEY.FAST_FORWARD;         // .
    if (k === 83) return KEY.STOP;                  // s
    if (k >= 96 && k <= 105) return k - 48;         // numpad digits
    return k;
  }

  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { toast('Exit only works on the TV'); }
  }

  function liveBack() {
    if (S.query) { S.query = ''; searchInput().value = ''; buildView(true); render(); return; }
    go('home');
  }

  function catsKey(k) {
    switch (k) {
      case KEY.UP: case KEY.DOWN: case KEY.CH_UP: case KEY.CH_DOWN:
        var step = k === KEY.UP ? -1 : k === KEY.DOWN ? 1 : k === KEY.CH_UP ? -CAT_ROWS : CAT_ROWS;
        S.catIndex = clamp(S.catIndex + step, 0, S.cats.length - 1);
        buildView(false);
        break;
      case KEY.ENTER: case KEY.RIGHT: case KEY.BACK:
        S.zone = 'list';
        break;
      case KEY.BLUE: go('playlists'); return;
      default: return;
    }
    render();
    schedulePreload(PRELOAD_FOCUS_MS);
  }

  function listKey(k) {
    var ch = S.view[S.listIndex], last = Math.max(0, S.view.length - 1);
    switch (k) {
      case KEY.UP:
        if (S.listIndex === 0) S.zone = 'search'; else S.listIndex--;
        break;
      case KEY.DOWN: S.listIndex = clamp(S.listIndex + 1, 0, last); break;
      case KEY.CH_UP: S.listIndex = clamp(S.listIndex - LIST_ROWS, 0, last); break;
      case KEY.CH_DOWN: S.listIndex = clamp(S.listIndex + LIST_ROWS, 0, last); break;
      case KEY.LEFT: S.zone = 'cats'; break;
      case KEY.ENTER:
        if (!ch) return;
        if (sameCh(ch, S.playing) && S.state !== 'error') { goFull(); return; }
        play(ch);
        return;
      case KEY.PLAY: case KEY.PLAY_PAUSE:
        if (!ch) return;
        if (!sameCh(ch, S.playing)) play(ch);
        goFull();
        return;
      case KEY.RED: toggleFav(ch); return;
      case KEY.GREEN: toggleSort(); return;
      case KEY.YELLOW: S.zone = 'search'; render(); searchInput().focus(); return;
      case KEY.BLUE: go('playlists'); return;
      case KEY.STOP: Player.stop(); S.playing = null; document.body.classList.remove('has-video'); break;
      case KEY.BACK: liveBack(); return;
      default: return;
    }
    renderList();
    renderInfo();
    renderLive();
    $('guide').className = 'guide zone-' + S.zone + (S.zone === 'cats' ? ' drawer-open' : '');
    if (S.zone === 'cats') renderCats();
    schedulePreload(PRELOAD_FOCUS_MS);
  }

  function fullKey(k) {
    switch (k) {
      case KEY.UP: case KEY.CH_UP: zap(1); break;
      case KEY.DOWN: case KEY.CH_DOWN: zap(-1); break;
      case KEY.ENTER: case KEY.INFO:
        if ($('osd').classList.contains('show')) $('osd').classList.remove('show'); else showOsd();
        break;
      case KEY.LEFT: case KEY.RIGHT: showOsd(); break;
      case KEY.GREEN: toggleAspect(); break;
      case KEY.RED: toggleFav(S.playing); break;
      case KEY.BLUE: goGuide(); go('playlists'); break;
      case KEY.STOP: Player.stop(); S.playing = null; document.body.classList.remove('has-video'); goGuide(); break;
      case KEY.BACK: goGuide(); break;
      default: break;
    }
  }

  function liveKey(e, k) {
    if (S.mode === 'guide' && S.zone === 'search') { searchKey(e, k); return; }
    if (k >= 48 && k <= 57) { e.preventDefault(); digit(k - 48); return; }
    if (S.loading && k !== KEY.BACK) return;
    e.preventDefault();
    if (S.mode === 'full') fullKey(k);
    else if (S.zone === 'cats') catsKey(k);
    else listKey(k);
  }

  document.addEventListener('keydown', function (e) {
    var k = normalize(e);
    if (S.screen === 'home') homeKey(e, k);
    else if (S.screen === 'live') liveKey(e, k);
    else if (S.screen === 'playlists') playlistsKey(e, k);
    else if (screens[S.screen]) screens[S.screen].key(e, k);
  });

  searchInput().addEventListener('input', onSearchTyped);

  function registerKeys() {
    try {
      var want = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown',
        'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'Info',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
      var have = tizen.tvinputdevice.getSupportedKeys().map(function (key) { return key.name; });
      want.forEach(function (name) { if (have.indexOf(name) !== -1) tizen.tvinputdevice.registerKey(name); });
    } catch (e) { /* not on a TV */ }
  }

  /* ---------- start ---------- */

  document.addEventListener('visibilitychange', function () {
    var scr = screens[S.screen];
    if (scr) {
      if (scr.onVisibility) scr.onVisibility(document.hidden);
      else if (document.hidden) Player.stop();
      return;
    }
    if (document.hidden) { Player.stop(); }
    else if (S.playing) { Player.play(S.playing.url, S.playing.ua); }
  });

  function tick() {
    var now = new Date();
    $('clock-time').textContent = hhmm(now);
    $('clock-date').textContent = dateStr(now);
    $('h-time').textContent = hhmm(now);
    $('h-date').textContent = dateStr(now);
    if (S.screen === 'live' && S.playing) renderLive();
    var scr = screens[S.screen];
    if (scr && scr.tick) scr.tick();
  }

  function start() {
    if (!Player.native) document.documentElement.classList.add('web');
    registerKeys();
    tick();
    setInterval(tick, 1000);
    document.body.setAttribute('data-screen', 'home');
    renderHome();
    loadPlaylist(Playlists.active()).catch(function () { /* shown on home */ });
  }

  /* ---------- shared API for the other screens ---------- */

  window.App = {
    KEY: KEY,
    $: $, esc: esc, clamp: clamp, pad: pad, dur: dur, hhmm: hhmm, dateStr: dateStr, dayStr: dayStr, count: count,
    tint: tint, initials: initials, logoHtml: logoHtml, windowStart: windowStart, toast: toast,
    register: register,
    go: go,                                     // go(screen, arg)
    current: function () { return S.screen; },
    data: function () { return S.data; },       // loaded playlist data, or null
    loading: function () { return S.loading; },
    playlist: function () { return Playlists.active(); },
    reload: function () { return loadPlaylist(Playlists.active()); },
    onLoad: function (fn) { loadListeners.push(fn); },
    // Security hook: run fn if the action is allowed. js/settings.js replaces this to ask for a PIN.
    // Actions: 'playlists' (add, switch, delete), 'clear' (history and favourites).
    guard: function (action, fn) { fn(); },
    // Live favourites/history changed elsewhere (e.g. cleared in Settings): refresh the live counts.
    refreshLive: function () { if (S.cats.length) { refreshCounts(); buildView(true); } },
    armExit: armExit
  };

  // Debug hook for tools/tvdebug.py and tools/webcheck.py.
  window.__tiptv = { S: S, PL: PL, Player: Player, play: play, zap: zap, goFull: goFull, goGuide: goGuide, render: render,
    loadPlaylist: loadPlaylist, go: go, Playlists: Playlists, Library: Library, screens: screens };

  // Start after every script (vod.js, settings.js) has registered its screens.
  document.addEventListener('DOMContentLoaded', start);
})();
