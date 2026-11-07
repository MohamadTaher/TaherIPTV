/* Taher IPTV - channel guide, full-screen player and playlists, driven by the TV remote. */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    CH_UP: 427, CH_DOWN: 428, PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, STOP: 413, INFO: 457,
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

  var PRESETS = [
    // Channel counts checked 2026-11-06.
    { name: 'Demo test streams', demo: true },
    { name: 'Test channels · verified (184)', url: 'playlists/test.m3u' },   // checked 2026-11-07, see the file header
    { name: 'Free-TV · free-to-air, curated (2,000)', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8' },
    { name: 'iptv-org · World by country (13,000)', url: 'https://iptv-org.github.io/iptv/index.country.m3u' },
    { name: 'iptv-org · World by category (12,000)', url: 'https://iptv-org.github.io/iptv/index.category.m3u' },
    { name: 'iptv-org · News (1,000)', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
    { name: 'iptv-org · Sports (480)', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' }
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

  var $ = function (id) { return document.getElementById(id); };

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('tiptv.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('tiptv.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
    }
  };

  var S = {
    channels: [], cats: [], view: [],
    catIndex: 0, listIndex: 0,
    zone: 'list',          // 'list' | 'cats' (drawer open) | 'search'
    mode: 'guide',         // 'guide' | 'full' | 'settings'
    playing: null,
    state: 'idle', stateDetail: '',
    favs: store.get('favs', {}),
    source: store.get('source', PRESETS[0]),
    sort: store.get('sort', 'num'),
    aspect: Player.setAspect(store.get('aspect', 'fit')),
    query: '',
    loading: false,
    setIndex: 0, setItems: [],
    num: '', numTimer: 0, osdTimer: 0, toastTimer: 0, preTimer: 0, zapDir: 1, exitArmed: false
  };

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    var words = name.replace(/\(.*?\)|\[.*?\]/g, '').split(/[\s\-_.:]+/).filter(Boolean);
    var s = words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : (words[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }

  function tint(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg,hsl(' + h + ',38%,34%),hsl(' + ((h + 40) % 360) + ',42%,24%))';
  }

  function logoHtml(ch, cls) {
    var html = '<span class="' + cls + '"><span class="ini" style="background:' + tint(ch.name) + '">' + esc(initials(ch.name)) + '</span>';
    if (ch.logo) {
      html += '<img src="' + esc(ch.logo) + '" onload="this.parentNode.className+=\' has-img\'" onerror="this.parentNode.removeChild(this)">';
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

  function dur(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60);
  }

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

  /* ---------- data ---------- */

  function favCount() {
    var n = 0;
    S.channels.forEach(function (ch) { if (S.favs[ch.url]) n++; });
    return n;
  }

  function buildCats() {
    var counts = {}, groups = [];
    S.channels.forEach(function (ch) {
      if (!counts[ch.group]) { counts[ch.group] = 0; groups.push(ch.group); }
      counts[ch.group]++;
    });
    groups.sort(function (a, b) { return a.localeCompare(b); });
    S.cats = [{ id: 'all', name: 'All channels', count: S.channels.length },
              { id: 'fav', name: 'Favourites', count: favCount() }]
      .concat(groups.map(function (g) { return { id: 'group', group: g, name: g, count: counts[g] }; }));
  }

  // Channels for the current category, filtered by the search text and sorted.
  function buildView(keepFocus) {
    var cat = S.cats[S.catIndex], focused = S.view[S.listIndex];
    var list = !cat ? [] : cat.id === 'all' ? S.channels
      : cat.id === 'fav' ? S.channels.filter(function (ch) { return S.favs[ch.url]; })
      : S.channels.filter(function (ch) { return ch.group === cat.group; });
    var q = S.query.trim().toLowerCase();
    if (q) list = list.filter(function (ch) { return ch.name.toLowerCase().indexOf(q) !== -1 || String(ch.num) === q; });
    if (S.sort === 'name') list = list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    S.view = list;

    var target = keepFocus ? focused : S.playing, at = -1;
    for (var i = 0; target && i < list.length; i++) if (sameCh(list[i], target)) { at = i; break; }
    S.listIndex = Math.max(0, at);
  }

  function loadSource(src) {
    S.loading = true;
    render();
    var got = src.demo ? Promise.resolve(DEMO) : fetchText(src.url);
    return got.then(function (text) {
      var list = M3U.parse(text);
      if (!list.length) throw new Error('no channels found');
      S.channels = list;
      S.source = src;
      store.set('source', src);
      S.query = '';
      $('search-input').value = '';
      buildCats();
      S.catIndex = 0;
      buildView(false);
      S.zone = 'list';
      S.loading = false;
      render();
      toast('Loaded ' + list.length + ' channels · ' + src.name);
    }).catch(function (err) {
      S.loading = false;
      toast('Could not load ' + src.name + ': ' + (err.message || err));
      if (!S.channels.length && !src.demo) return loadSource(PRESETS[0]);
      render();
    });
  }

  function fetchText(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.timeout = 30000;
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

  /* ---------- playback ---------- */

  function play(ch) {
    S.playing = ch;
    store.set('last', ch.url);
    Player.play(ch.url, ch.ua);
    render();
  }

  Player.onState(function (state, detail) {
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
      if (S.mode === 'settings' || S.loading) return;
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
    if (S.favs[ch.url]) delete S.favs[ch.url]; else S.favs[ch.url] = true;
    store.set('favs', S.favs);
    S.cats[1].count = favCount();
    if (S.cats[S.catIndex].id === 'fav') {
      var keep = S.listIndex;
      buildView(true);
      S.listIndex = clamp(keep, 0, Math.max(0, S.view.length - 1));
    }
    toast(S.favs[ch.url] ? '♥  Added ' + ch.name + ' to favourites' : 'Removed ' + ch.name + ' from favourites');
    render();
    if (S.mode === 'full') showOsd();
  }

  function toggleSort() {
    S.sort = S.sort === 'num' ? 'name' : 'num';
    store.set('sort', S.sort);
    buildView(true);
    toast(S.sort === 'name' ? 'Sorted A–Z' : 'Sorted by channel number');
    render();
  }

  function toggleAspect() {
    S.aspect = Player.setAspect(S.aspect === 'fit' ? 'fill' : 'fit');
    store.set('aspect', S.aspect);
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

  /* ---------- rendering ---------- */

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
        : 'No channels') + '</div>';
      return;
    }

    var start = windowStart(S.listIndex, S.view.length, LIST_ROWS), html = '';
    for (var i = start; i < Math.min(S.view.length, start + LIST_ROWS); i++) {
      var ch = S.view[i], on = sameCh(ch, S.playing);
      html += '<div class="row' + (i === S.listIndex ? ' sel' : '') + (on ? ' playing' : '') + '">' +
        logoHtml(ch, 'logo') +
        '<span class="num">' + ch.num + '</span><span class="name">' + esc(ch.name) + '</span>' +
        '<div class="tags">' + (S.favs[ch.url] ? '<span class="fav">♥</span>' : '') +
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
    $('o-name').innerHTML = esc(ch.name) + (S.favs[ch.url] ? ' <span style="color:var(--key-red)">♥</span>' : '');
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

  /* ---------- playlists (settings) ---------- */

  function openSettings() {
    S.mode = 'settings';
    S.setItems = [{ type: 'input' }, { type: 'load' }]
      .concat(PRESETS.map(function (p) { return { type: 'preset', preset: p }; }))
      .concat([{ type: 'close' }]);
    S.setIndex = 0;
    var first = !$('set-url');
    renderSettings();
    if (first && !S.source.demo) $('set-url').value = S.source.url || '';
    $('settings').classList.add('show');
  }

  function closeSettings() {
    var input = $('set-url');
    if (input) input.blur();
    $('settings').classList.remove('show');
    S.mode = 'guide';
    render();
  }

  function renderSettings() {
    var keep = $('set-url') ? $('set-url').value : '';
    $('set-current').textContent = 'Current: ' + S.source.name + ' · ' + S.channels.length + ' channels';
    var html = '';
    S.setItems.forEach(function (it, i) {
      var sel = i === S.setIndex ? ' sel' : '';
      if (it.type === 'input') {
        html += '<div class="set-label">Your M3U playlist link</div>' +
          '<div class="set-item set-input' + sel + '"><input id="set-url" type="url" placeholder="https://example.com/playlist.m3u" spellcheck="false"></div>';
      } else if (it.type === 'load') {
        html += '<div class="set-item' + sel + '">Load this link<small>OK</small></div><div class="set-label">Presets</div>';
      } else if (it.type === 'preset') {
        html += '<div class="set-item' + sel + '">' + esc(it.preset.name) + (S.source.name === it.preset.name ? '<small>current</small>' : '') + '</div>';
      } else {
        html += '<div class="set-item' + sel + '" style="margin-top:26px">Close<small>BACK</small></div>';
      }
    });
    $('set-items').innerHTML = html;
    $('set-url').value = keep;
  }

  function activateSetting() {
    var it = S.setItems[S.setIndex];
    if (it.type === 'input') { $('set-url').focus(); return; }
    if (it.type === 'close') { closeSettings(); return; }
    var src;
    if (it.type === 'load') {
      var url = $('set-url').value.trim();
      if (!/^https?:\/\//i.test(url)) { toast('Enter a link starting with http:// or https://'); S.setIndex = 0; renderSettings(); return; }
      src = { name: url.replace(/^https?:\/\//i, '').split('/')[0], url: url };
    } else {
      src = it.preset;
    }
    closeSettings();
    loadSource(src);
  }

  function settingsKey(e, k) {
    var input = $('set-url');
    if (document.activeElement === input) {
      if (k === KEY.ENTER || k === KEY.IME_DONE) { input.blur(); S.setIndex = 1; renderSettings(); e.preventDefault(); }
      else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === 27) { input.blur(); e.preventDefault(); }
      return; // let the keyboard type
    }
    e.preventDefault();
    if (k === KEY.UP) { S.setIndex = clamp(S.setIndex - 1, 0, S.setItems.length - 1); renderSettings(); }
    else if (k === KEY.DOWN) { S.setIndex = clamp(S.setIndex + 1, 0, S.setItems.length - 1); renderSettings(); }
    else if (k === KEY.ENTER) activateSetting();
    else if (k === KEY.BACK || k === KEY.BLUE) closeSettings();
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
    if (k >= 96 && k <= 105) return k - 48;         // numpad digits
    return k;
  }

  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { toast('Exit only works on the TV'); }
  }

  function back() {
    if (S.query) { S.query = ''; searchInput().value = ''; buildView(true); render(); return; }
    if (S.exitArmed) { exitApp(); return; }
    S.exitArmed = true;
    toast('Press BACK again to exit');
    setTimeout(function () { S.exitArmed = false; }, 2000);
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
      case KEY.BLUE: openSettings(); return;
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
      case KEY.BLUE: openSettings(); return;
      case KEY.STOP: Player.stop(); S.playing = null; document.body.classList.remove('has-video'); break;
      case KEY.BACK: back(); return;
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
      case KEY.BLUE: goGuide(); openSettings(); break;
      case KEY.STOP: Player.stop(); S.playing = null; document.body.classList.remove('has-video'); goGuide(); break;
      case KEY.BACK: goGuide(); break;
      default: break;
    }
  }

  document.addEventListener('keydown', function (e) {
    var k = normalize(e);
    if (S.mode === 'settings') { settingsKey(e, k); return; }
    if (S.mode === 'guide' && S.zone === 'search') { searchKey(e, k); return; }
    if (k >= 48 && k <= 57) { e.preventDefault(); digit(k - 48); return; }
    if (S.loading && k !== KEY.BACK) return;
    e.preventDefault();
    if (S.mode === 'full') fullKey(k);
    else if (S.zone === 'cats') catsKey(k);
    else listKey(k);
  });

  searchInput().addEventListener('input', onSearchTyped);

  function registerKeys() {
    try {
      var want = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown',
        'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'Info',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
      var have = tizen.tvinputdevice.getSupportedKeys().map(function (key) { return key.name; });
      want.forEach(function (name) { if (have.indexOf(name) !== -1) tizen.tvinputdevice.registerKey(name); });
    } catch (e) { /* not on a TV */ }
  }

  /* ---------- start ---------- */

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { Player.stop(); }
    else if (S.playing) { Player.play(S.playing.url, S.playing.ua); }
  });

  function tick() {
    var now = new Date();
    $('clock-time').textContent = hhmm(now);
    $('clock-date').textContent = dateStr(now);
    if (S.playing && S.mode !== 'settings') renderLive();
  }

  function start() {
    if (!Player.native) document.documentElement.classList.add('web');
    registerKeys();
    tick();
    setInterval(tick, 1000);
    loadSource(S.source).then(function () {
      var last = store.get('last', '');
      for (var i = 0; i < S.view.length; i++) {
        if (S.view[i].url === last) { S.listIndex = i; play(S.view[i]); return; }
      }
      render();
    });
  }

  // Debug hook for tools/tvdebug.py.
  window.__tiptv = { S: S, Player: Player, play: play, zap: zap, goFull: goFull, goGuide: goGuide, render: render,
    loadSource: loadSource, presets: PRESETS };

  start();
})();
