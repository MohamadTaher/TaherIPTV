/* Movies and series screens: browse, detail, and the full-screen player.

   Browse: the focused title's backdrop fills the screen behind its title, facts and plot (or its poster on
   a wash of its colours when there is no backdrop). Under them are rows of landscape cards: Continue
   watching, My list, Recently added, Top rated, then the provider's categories. "See all" at the end of a
   row, a category from the side rail, or a search opens the grid: the same hero over a card grid with sort
   and rating chips. The focused row always sits at the same height; the rows above it scroll away.
   Detail: backdrop, poster, facts, buttons and cast; series add seasons and episodes, movies a "More from"
   row. Title info (plot, backdrop, cast, episodes) is fetched once per title and kept.

   Both screens live in <div id="vod">; #vod's class says which of the three views shows (m-browse,
   m-detail, m-player). The player view is transparent so the video plays under the page.
   History and favourites ("My list") go through Library: movies as 'movie', one entry per series as
   'series' ({ ep: last episode, eps: { episodeId: { pos, dur } }, done, hasNext }). */
(function () {
  'use strict';

  var KEY = App.KEY, $ = App.$, esc = App.esc, clamp = App.clamp, pad = App.pad, dur = App.dur;
  var STEP = 290;               // card width (272) + gap, px
  var VIS = 6;                  // cards fully on screen in a row; a 7th peeks in at the edge
  var ROW_H = 236;              // rows: head + card + progress bar
  var GRID_TOP = 58;            // grid: chips line above the cards
  var GRID_H = 192;             // grid rows: card + progress bar + gap
  var ROW_MAX = 40;             // cards in a row before "See all"
  var GRID_COLS = 6;
  var ROW_JUMP = 5;             // CH+/- in the rows
  var HERO_MS = 350;            // fetch the focused title's info once focus rests this long
  var INFO_MAX = 300;           // title infos kept
  var EP_ROWS = 5;
  var SEASONS_SHOWN = 8;
  var CAST_MAX = 8;
  var RAIL_ROWS = 12;           // categories shown in the side rail
  var RAIL_MS = 280;            // the rail's highlighted category shows once the highlight rests this long
  var MORE_MAX = 20;
  var NEW_MS = 14 * 86400000;   // "NEW" badge for titles added in the last two weeks
  var DONE = 0.95;              // watched this much = finished
  var SAVE_MS = 10000;          // save the position this often while playing
  var OSD_MS = 5000;
  var NEXT_MS = 5000;           // "Next episode" countdown
  var SEEK_APPLY_MS = 450;      // seeks wait this long for more key presses
  var SEEK_HOLD_MS = 1500;      // keep showing the target while the TV catches up
  var RECENT_MAX = 100;
  var TOP_MAX = 100;
  var SORTS = [{ id: 'server', name: 'Default' }, { id: 'new', name: 'Newest' }, { id: 'name', name: 'A–Z' }, { id: 'top', name: 'Top rated' }];
  var RATINGS = [0, 6, 7, 8];

  var ICON = {
    play: '<svg viewBox="0 0 24 24" class="ic"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
    again: '<svg viewBox="0 0 24 24" class="ic"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M4 3.5v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    add: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    added: '<svg viewBox="0 0 24 24" class="ic"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    grid: '<svg viewBox="0 0 24 24" class="ic"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="currentColor"/></svg>',
    cont: '<svg viewBox="0 0 24 24" class="ic"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
    fav: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 20.3l-1.3-1.2C5.6 14.5 2.6 11.8 2.6 8.4c0-2.7 2.1-4.8 4.8-4.8 1.6 0 3.2.8 4.6 2.2 1.4-1.4 3-2.2 4.6-2.2 2.7 0 4.8 2.1 4.8 4.8 0 3.4-3 6.1-8.1 10.7z" fill="currentColor"/></svg>',
    recent: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    top: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" fill="currentColor"/></svg>',
    search: '<svg viewBox="0 0 24 24" class="icon"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5l5 5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'
  };

  var built = false;
  var V = { kind: 'movie', view: 'browse' };   // view: 'browse' | 'detail' | 'player'
  var ST = {};                  // browse state per kind
  var cache = {};               // per kind: lookups of the loaded list
  var INFO = { movie: {}, series: {} }, infoKeys = [];
  var D = null;                 // detail state
  var P = null;                 // player state
  var reqSeq = 0;
  var heroBd = null, detailBd = null, heroTimer = 0, heroId = '';

  function noop() {}

  // Runs fn after the next frame is on screen; repeated calls before then run it once.
  var laterFn = null;
  function later(fn) {
    if (!laterFn) requestAnimationFrame(function () { setTimeout(function () { var f = laterFn; laterFn = null; if (f) f(); }, 0); });
    laterFn = fn;
  }

  /* ---------- titles ---------- */

  // Provider names carry extras: "EN - Name (2019) 4K", "|AR| Name". Splits them off for display.
  function clean(it) {
    if (it.cn) return it.cn;
    var s = String(it.name || ''), year = '', q = '', m;
    // "EN - ", "AR| ", "|FR| ", "[DE] ". Not "XX:", which is often part of the title ("CSI: Miami").
    s = s.replace(/^\s*(?:\|[^|]{1,12}\||\[[^\]]{1,12}\]|[A-Z]{2,3}\s*(?:\||\s-\s))\s*/, '');
    for (var n = 0; n < 3; n++) {
      if ((m = QUALITY_RE.exec(s))) { if (!q) q = qualityName(m[1]); s = s.slice(0, m.index); continue; }
      if ((m = /[\s\-]*[(\[]((?:19|20)\d\d)[)\]]\s*$/.exec(s))) { if (!year) year = m[1]; s = s.slice(0, m.index); continue; }
      break;
    }
    s = s.trim() || String(it.name || '');
    it.cn = { title: s, year: year, q: q };
    return it.cn;
  }

  // A trailing quality tag, alone or in brackets: "4K", "[FHD]", "(HDCAM)", "- WEB-DL".
  var QUALITY_RE = /[\s\-|]*[\[(]?\b(4K|UHD|2160P|FHD|1080P|HDR|HD|720P|SD|HDCAM|HDACM|CAM|HDTS|TS|WEB-?DL|WEB-?RIP|BLU-?RAY|HDRIP|DVDRIP)\b[\])]?\s*$/i;

  function qualityName(t) {
    t = t.toUpperCase().replace(/-/g, '');
    if (t === 'UHD' || t === '2160P') return '4K';
    if (t === '1080P') return 'FHD';
    if (t === '720P') return 'HD';
    if (/CAM|ACM|TS$/.test(t)) return 'CAM';      // HDCAM, HDACM (a common typo), CAM, HDTS, TS
    if (/^WEB/.test(t)) return 'WEB';
    if (t === 'BLURAY') return 'BLU-RAY';
    return t;
  }

  function isNew(it) { return it.added > 0 && Date.now() - it.added < NEW_MS; }

  function longDur(ms) {
    var m = Math.round(ms / 60000), h = Math.floor(m / 60);
    return h ? h + 'h ' + pad(m % 60) + 'm' : m + ' min';
  }

  function leftDur(h) { return longDur(Math.max(60000, h.dur - h.pos)) + ' left'; }

  /* ---------- data ---------- */

  function fresh() {
    return { mode: 'rows', zone: 'rows', rows: [], r: 0, pos: {}, grid: null, chip: 0, query: '',
      sort: Store.get('vodSort', 'server'), rating: 0, hist: {} };
  }

  function items(kind) {
    var d = App.data();
    return d ? (kind === 'movie' ? d.movies : d.series) || [] : [];
  }

  // Lookup tables for the loaded list (rebuilt when the list changes).
  function lookups(kind) {
    var src = items(kind), c = cache[kind];
    if (c && c.src === src) return c;
    c = cache[kind] = { src: src, byId: {}, byGroup: {}, groups: [], recent: [], top: [] };
    src.forEach(function (it) {
      c.byId[it.id] = it;
      var g = c.byGroup[it.group];
      if (!g) { g = c.byGroup[it.group] = []; c.groups.push(it.group); }
      g.push(it);
    });
    var order = src.groupOrder;
    if (order) c.groups.sort(function (a, b) { return (order[a] === undefined ? 1e9 : order[a]) - (order[b] === undefined ? 1e9 : order[b]); });
    c.recent = src.filter(function (it) { return it.added > 0; })
      .sort(function (a, b) { return b.added - a.added; }).slice(0, RECENT_MAX);
    c.top = src.filter(function (it) { return it.rating > 0; })
      .sort(function (a, b) { return b.rating - a.rating || b.added - a.added; }).slice(0, TOP_MAX);
    return c;
  }

  function slim(it) { return { id: it.id, name: it.name, poster: it.poster, url: it.url, group: it.group }; }
  function isFav(kind, it) { return Library.isFav(kind, it.id); }
  function inProgress(h) { return !!h && h.pos > 0 && h.dur > 0 && h.pos < h.dur * DONE; }
  function finished(h) { return !!h && h.dur > 0 && h.pos >= h.dur * DONE; }

  // History entries worth resuming: a movie part way through, or a series with an unfinished or a next episode.
  function isCont(kind, h) {
    if (kind === 'movie') return inProgress(h);
    return !!h.ep && (inProgress(h) || (finished(h) && h.hasNext !== false));
  }

  function contItems(kind) {
    var by = lookups(kind).byId, out = [];
    Library.history(kind).forEach(function (h) { if (by[h.id] && isCont(kind, h)) out.push(by[h.id]); });
    return out;
  }

  function favItems(kind) { return items(kind).filter(function (it) { return isFav(kind, it); }); }

  function histMap(kind) {
    var m = {};
    Library.history(kind).forEach(function (h) { m[h.id] = h; });
    return m;
  }

  // Title info (plot, backdrop, cast, episodes): fetched once, the last INFO_MAX kept.
  function infoOf(kind, id) { var e = INFO[kind][id]; return e ? e.info : null; }

  function loadInfo(kind, it) {
    var box = INFO[kind], e = box[it.id];
    if (e) return e.p;
    var d = App.data(), p;
    try { p = kind === 'movie' ? d.movieInfo(it.id) : d.seriesInfo(it.id); } catch (err) { p = Promise.reject(err); }
    e = box[it.id] = { info: null, p: null };
    e.p = Promise.resolve(p).then(function (info) { e.info = info || {}; return e.info; },
      function (err) { if (box[it.id] === e) delete box[it.id]; throw err; });
    infoKeys.push([kind, it.id, e]);
    if (infoKeys.length > INFO_MAX) {
      var old = infoKeys.shift();
      if (INFO[old[0]][old[1]] === old[2]) delete INFO[old[0]][old[1]];
    }
    return e.p;
  }

  // Everything known about a title for the hero and the detail page.
  function facts(kind, it) {
    var c = clean(it), i = infoOf(kind, it.id) || {};
    return {
      title: c.title, year: i.year || it.year || c.year, q: c.q, rating: i.rating || it.rating || 0,
      genre: i.genre || it.genre || '', plot: i.plot || it.plot || '', dur: i.dur || 0,
      backdrop: i.backdrop || it.backdrop || '', poster: i.poster || it.poster || '', group: it.group || '',
      fresh: isNew(it), seasons: i.seasons ? i.seasons.length : 0, cast: i.cast || '', director: i.director || ''
    };
  }

  function genres(g) { return g ? g.split(/\s*[,/|]\s*/).filter(Boolean).slice(0, 3) : []; }

  /* ---------- rows and grid ---------- */

  function buildRows(kind) {
    var K = ST[kind], L = lookups(kind), prev = K.rows[K.r], rows = [];
    var cont = contItems(kind), fav = favItems(kind);
    if (cont.length) rows.push({ id: 'cont', name: 'Continue watching', items: cont });
    if (fav.length) rows.push({ id: 'fav', name: 'My list', items: fav });
    if (L.recent.length) rows.push({ id: 'recent', name: 'Recently added', items: L.recent });
    if (L.top.length >= 5) rows.push({ id: 'top', name: 'Top rated', items: L.top });
    L.groups.forEach(function (g) { rows.push({ id: 'g:' + g, name: g, items: L.byGroup[g] }); });
    K.rows = rows;
    K.hist = histMap(kind);
    K.ver = (K.ver || 0) + 1;
    var at = -1;
    for (var i = 0; prev && i < rows.length; i++) if (rows[i].id === prev.id) { at = i; break; }
    K.r = at >= 0 ? at : clamp(K.r, 0, Math.max(0, rows.length - 1));
    rows.forEach(function (row) { var p = K.pos[row.id]; if (p) fixPos(p, row); });
  }

  function rowLen(row) { return Math.min(row.items.length, ROW_MAX) + 1; }   // + "See all"

  function posOf(K, row) {
    return K.pos[row.id] || (K.pos[row.id] = { i: 0, off: 0 });
  }

  // Keeps the focused poster on screen with the next one showing.
  function fixPos(p, row) {
    p.i = clamp(p.i, 0, rowLen(row) - 1);
    if (p.i > p.off + VIS - 2) p.off = p.i - (VIS - 2);
    if (p.i < p.off + 1) p.off = Math.max(0, p.i - 1);
  }

  function searchList(kind, q) {
    q = q.trim().toLowerCase();
    return items(kind).filter(function (it) { return (it.name || '').toLowerCase().indexOf(q) !== -1; });
  }

  function gridBase(kind, K) {
    var g = K.grid;
    if (g.src === 'search') return searchList(kind, K.query);
    for (var i = 0; i < K.rows.length; i++) if (K.rows[i].id === g.src) return K.rows[i].items;
    return [];
  }

  function openGrid(kind, K, title, src) {
    K.grid = { title: title, src: src, view: [], index: 0 };
    K.mode = 'grid';
    buildGrid(kind, K, null);
  }

  // The grid's items: its row (or the search), rating filter, sort. Keeps the focused title when it can.
  function buildGrid(kind, K, keepId) {
    var g = K.grid, list = gridBase(kind, K), min = K.rating;
    if (min) list = list.filter(function (it) { return it.rating >= min; });
    if (K.sort === 'new') list = list.slice().sort(function (a, b) { return b.added - a.added; });
    else if (K.sort === 'top') list = list.slice().sort(function (a, b) { return b.rating - a.rating || b.added - a.added; });
    else if (K.sort === 'name') list = list.slice().sort(function (a, b) { return clean(a).title.localeCompare(clean(b).title); });
    var was = g.index || 0;
    g.view = list;
    g.index = 0;
    if (!keepId) return;
    g.index = Math.min(was, Math.max(0, list.length - 1));   // the title left the list: stay at its place
    for (var i = 0; i < list.length; i++) if (list[i].id === keepId) { g.index = i; break; }
  }

  function focused(K) {
    if (!K) return null;
    if (K.mode === 'grid') return K.grid.view[K.grid.index] || null;
    var row = K.rows[K.r];
    if (!row) return null;
    return row.items[posOf(K, row).i] && posOf(K, row).i < ROW_MAX ? row.items[posOf(K, row).i] : null;
  }

  /* ---------- view switching ---------- */

  function setMode() {
    var el = $('vod');
    el.classList.remove('m-browse', 'm-detail', 'm-player');
    el.classList.add('m-' + V.view);
  }

  function build() {
    if (built) return;
    built = true;
    $('vod').innerHTML =
      '<div class="v-browse" id="v-browse">' +
        '<div id="vh-bd" class="v-bd"></div><div class="vh-fade"></div>' +
        '<div id="vh-poster" class="vh-poster"></div>' +
        '<div class="v-content"><div id="vh-info" class="vh-info"></div><div id="v-rows" class="v-rows"></div></div>' +
        '<div id="v-rail" class="v-rail"><div class="vrl-sub">Categories<span id="vrl-pos"></span></div><div id="vrl-items"></div>' +
          '<div class="vrl-keys"><span><kbd>OK</kbd>Open</span><span><kbd>BACK</kbd>Home</span></div></div>' +
        '<div class="v-top"><div class="v-kind"><b id="v-kind"></b><span id="v-total"></span></div>' +
          '<div class="v-top-r"><div id="v-legend" class="v-hints"></div>' +
            '<div class="v-search">' + ICON.search + '<input id="v-search-input" type="text" spellcheck="false" autocomplete="off"></div></div></div>' +
      '</div>' +
      '<div class="v-detail" id="v-detail">' +
        '<div id="vd-bd" class="v-bd"></div><div class="vd-fade"></div>' +
        '<div id="vd-scroll" class="vd-scroll">' +
          '<div id="vd-poster"></div>' +
          '<div id="vd-info" class="vd-info"></div>' +
          '<div id="vd-lower" class="vd-lower"></div>' +
        '</div>' +
        '<div class="v-bfade"></div>' +
        '<div id="vd-legend" class="legend"></div>' +
      '</div>' +
      '<div class="v-play">' +
        '<div id="vp-state" class="v-state"></div>' +
        '<div id="vp-next" class="v-next"></div>' +
        '<div id="vp-osd" class="v-osd"></div>' +
      '</div>';
    heroBd = makeBackdrop($('vh-bd'));
    detailBd = makeBackdrop($('vd-bd'));
    $('v-search-input').addEventListener('input', function () {
      if (V.view !== 'browse') return;
      var K = ST[V.kind];
      K.query = this.value;
      if (K.query.trim()) openGrid(V.kind, K, 'Search', 'search');
      else if (K.mode === 'grid' && K.grid.src === 'search') K.mode = 'rows';
      renderBrowse();
    });
  }

  function openKind(kind) {
    build();
    V.kind = kind;
    V.view = 'browse';
    D = null;
    if (!ST[kind]) ST[kind] = fresh();
    var K = ST[kind];
    clearTimeout(railTimer);
    railTimer = 0;
    K.rail = null;
    if (K.zone === 'rail' || K.zone === 'search') K.zone = K.mode === 'grid' ? 'grid' : 'rows';
    refreshBrowse(kind);
    $('v-search-input').value = K.query;
    $('v-search-input').placeholder = kind === 'movie' ? 'Search movies' : 'Search series';
    setMode();
    renderBrowse();
    renderHero(true);
  }

  // Rows and counts change after My list or history do; keep the focused title.
  function refreshBrowse(kind) {
    var K = ST[kind], it = focused(K);
    buildRows(kind);
    if (K.mode === 'grid') buildGrid(kind, K, it && it.id);
  }

  function backToBrowse() {
    D = null;
    V.view = 'browse';
    refreshBrowse(V.kind);
    setMode();
    renderBrowse();
    renderHero(true);
  }

  /* ---------- backdrops ---------- */

  // Two layers that cross-fade. With no backdrop URL, the poster is drawn into a tiny canvas that the page
  // stretches to full size: a soft wash of the poster's colours without a costly CSS blur.
  function makeBackdrop(el) {
    el.innerHTML = '<div class="bd-l"></div><div class="bd-l"></div>';
    var layers = [el.children[0], el.children[1]], front = 0, key = '', seq = 0;

    function show(fill) {
      var back = layers[1 - front];
      fill(back);
      back.classList.add('on');
      layers[front].classList.remove('on');
      front = 1 - front;
    }

    function wash(l, img) {
      l.className = 'bd-l wash';
      l.innerHTML = '<canvas width="64" height="36"></canvas>';
      try {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, sw = w, sh = w * 9 / 16;
        if (sh > h) { sh = h; sw = h * 16 / 9; }
        l.firstChild.getContext('2d').drawImage(img, (w - sw) / 2, (h - sh) * 0.3, sw, sh, 0, 0, 64, 36);
      } catch (e) { /* a broken image leaves the wash dark */ }
    }

    // The image is decoded off the main thread (img.decode) before it shows: some provider backdrops are
    // 3840x2160 and decoding one while painting froze the TV for 300-540 ms (Mohamad TV, 2026-11-18).
    function set(url, poster) {
      var k = url ? 'u' + url : poster ? 'p' + poster : '';
      if (k === key) return;
      key = k;
      var my = ++seq;
      if (!k) { show(function (l) { l.className = 'bd-l'; l.innerHTML = ''; }); el.classList.remove('poster'); return; }
      var img = new Image(), done = false;
      function ready() {
        if (done || my !== seq) return;
        done = true;
        show(function (l) {
          if (url) { l.className = 'bd-l img'; l.innerHTML = ''; img.className = 'bd-img'; l.appendChild(img); }
          else wash(l, img);
        });
        el.classList.toggle('poster', !url);
      }
      function failed() {
        if (done || my !== seq) return;
        done = true;
        key = '';
        set('', url ? poster : '');   // a broken backdrop falls back to the poster wash
      }
      img.decoding = 'async';
      img.onerror = failed;
      img.onload = function () {
        if (img.decode) img.decode().then(ready, ready); else ready();
      };
      img.src = url || poster;
    }

    return { set: set, reset: function () { key = ''; seq++; layers[0].className = layers[1].className = 'bd-l'; el.classList.remove('poster'); } };
  }

  // TMDB serves every image in a few widths; the URL names the width ("/t/p/w1280/", "/t/p/original/").
  // Returns the URL at the given width, or '' when it is not a TMDB image.
  function tmdbSize(url, size) {
    var re = /(image\.tmdb\.org\/t\/p\/)[^\/]+\//;
    return re.test(url || '') ? url.replace(re, '$1' + size + '/') : '';
  }

  /* ---------- browse: rendering ---------- */

  function progressOf(kind, h) {
    if (!h) return 0;
    if (kind === 'series' && !h.ep) return 0;
    return inProgress(h) ? 100 * h.pos / h.dur : 0;
  }

  function barHtml(pct) { return '<div class="v-prog"><i style="width:' + pct.toFixed(1) + '%"></i></div>'; }

  // Landscape card: the title's TMDB backdrop at card size when there is one, else its poster cropped to
  // 16:9, the title written over the bottom either way. A bar under the card shows where you stopped.
  // Big provider-hosted backdrops are not used here: a row would download a dozen 4K images.
  function cardHtml(kind, K, it, i, x, sel, eager) {
    var c = clean(it), h = K.hist[it.id], pct = progressOf(kind, h), info = infoOf(kind, it.id);
    var bd = tmdbSize(it.backdrop || (info && info.backdrop) || '', 'w300'), src = bd || it.poster || '';
    return '<div class="vc' + (sel ? ' sel' : '') + '" data-i="' + i + '" style="left:' + x + 'px">' +
      '<div class="vc-img' + (bd ? '' : ' crop') + '"><span class="ini" style="background:' + App.tint(c.title) + '"></span>' +
        (src ? '<img ' + (eager ? 'src' : 'data-src') + '="' + esc(src) + '" onload="this.parentNode.className+=\' has-img\'" onerror="this.parentNode.removeChild(this)">' : '') +
        '<span class="vc-g"></span><span class="vc-t">' + esc(c.title) + '</span>' +
        (it.rating > 0 ? '<span class="vc-rate">★ ' + it.rating.toFixed(1) + '</span>' : '') +
        (isFav(kind, it) ? '<span class="vc-heart">♥</span>' : isNew(it) && !pct ? '<span class="vc-new">NEW</span>' : '') +
      '</div>' + (pct > 0 ? '<div class="vc-bar">' + barHtml(pct) + '</div>' : '') + '</div>';
  }

  function allHtml(row, x, sel) {
    return '<div class="vc all' + (sel ? ' sel' : '') + '" data-i="' + Math.min(row.items.length, ROW_MAX) + '" style="left:' + x + 'px"><div class="vc-img"><span class="all-in">' +
      '<span class="all-t">See all</span><span class="all-n">' + App.count(row.items.length) + ' titles</span></span></div></div>';
  }

  function near(i, off) { return i >= off - 1 && i <= off + VIS + 1; }

  function translate(el, x, y) {
    var t = 'translate(' + (x || 0) + 'px,' + (y || 0) + 'px)';
    el.style.webkitTransform = t;
    el.style.transform = t;
  }

  // A row holds only the cards around what shows (a 41-card strip was slow to paint on the TV);
  // syncCards adds and drops cards at the edges as the strip slides.
  function rowEl(kind, K, row) {
    var tmp = document.createElement('div');
    tmp.innerHTML = '<div class="vr">' +
      '<div class="vr-head"><span class="vr-name">' + esc(row.name) + '</span><span class="vr-count">' + App.count(row.items.length) + '</span></div>' +
      '<div class="vr-clip"><div class="vr-strip"></div></div></div>';
    var el = tmp.firstChild;
    syncCards(el.querySelector('.vr-strip'), kind, K, row, posOf(K, row));
    return el;
  }

  function syncCards(strip, kind, K, row, p) {
    var n = Math.min(row.items.length, ROW_MAX), lo = Math.max(0, p.off - 2), hi = Math.min(n, p.off + VIS + 2), have = {}, i;
    translate(strip, -p.off * STEP);
    for (i = strip.children.length - 1; i >= 0; i--) {
      var c = strip.children[i], at = +c.getAttribute('data-i');
      if (at < lo || at > hi) strip.removeChild(c); else have[at] = 1;
    }
    var html = '';
    for (i = lo; i <= hi; i++) {
      if (have[i]) continue;
      html += i < n ? cardHtml(kind, K, row.items[i], i, i * STEP, false, true) : allHtml(row, n * STEP, false);
    }
    if (html) strip.insertAdjacentHTML('beforeend', html);
  }

  function markSel(el, i) {
    var old = el.querySelector('.vc.sel'), now = i < 0 ? null : el.querySelector('.vc[data-i="' + i + '"]');
    if (old && old !== now) old.classList.remove('sel');
    if (now) now.classList.add('sel');
  }

  // Rows stay in the page by id between moves (the one below is already painted when focus moves down).
  // They are rebuilt when the rows change (K.ver) or after the grid used the space.
  var rowEls = {}, rowsDrawn = '';

  // focusOnly: draw just the focused row now (a row move on the TV costs one slow paint per new row);
  // the row below follows once that frame is on screen.
  function renderRows(focusOnly) {
    var kind = V.kind, K = ST[kind], box = $('v-rows'), key = kind + ':' + K.ver;
    if (!K.rows.length) {
      rowEls = {};
      rowsDrawn = '';
      var d = App.data(), what = kind === 'movie' ? 'movies' : 'series';
      box.innerHTML = '<div class="v-empty">' + (!d ? 'No playlist loaded<small>Press the blue button to open Playlists</small>'
        : d.vodLoading ? '<div class="spinner" style="margin:0 auto 18px"></div>Loading ' + what + '…'
        : 'No ' + what + ' in this playlist<small>Press the blue button to open Playlists</small>') + '</div>';
      return;
    }
    if (rowsDrawn !== key) { rowEls = {}; rowsDrawn = key; box.innerHTML = ''; }
    var keep = {};
    for (var r = K.r; r <= Math.min(K.rows.length - 1, K.r + 1); r++) {
      var row = K.rows[r], el = rowEls[row.id];
      if (!el && focusOnly && r !== K.r) continue;
      if (!el) { el = rowEls[row.id] = rowEl(kind, K, row); box.appendChild(el); }
      keep[row.id] = 1;
      translate(el, 0, (r - K.r) * ROW_H);
      el.classList.toggle('focus', r === K.r);
      markSel(el, r === K.r && K.zone === 'rows' ? posOf(K, row).i : -1);
    }
    for (var id in rowEls) if (rowEls.hasOwnProperty(id) && !keep[id]) { box.removeChild(rowEls[id]); delete rowEls[id]; }
  }

  // A move along the focused row: slide the strip, move the highlight, bring in the cards at the edge.
  function moveRow(d) {
    var K = ST[V.kind], row = K.rows[K.r];
    if (!row) return;
    var p = posOf(K, row), was = p.i;
    p.i = clamp(p.i + d, 0, rowLen(row) - 1);
    if (p.i === was) return;
    fixPos(p, row);
    var el = rowEls[row.id];
    if (!el) { renderRows(); return; }
    syncCards(el.querySelector('.vr-strip'), V.kind, K, row, p);
    markSel(el, p.i);
  }

  function fillImgs(el) {
    var imgs = el.querySelectorAll('img[data-src]');
    for (var i = 0; i < imgs.length; i++) { imgs[i].src = imgs[i].getAttribute('data-src'); imgs[i].removeAttribute('data-src'); }
  }

  function chipsHtml(K) {
    var html = '<span class="vg-k">Sort</span>', n = 0, inChips = K.zone === 'chips';
    SORTS.forEach(function (s) {
      html += '<span class="chip' + (K.sort === s.id ? ' on' : '') + (inChips && K.chip === n ? ' sel' : '') + '">' + s.name + '</span>';
      n++;
    });
    html += '<span class="vg-k">Rating</span>';
    RATINGS.forEach(function (r) {
      html += '<span class="chip' + (K.rating === r ? ' on' : '') + (inChips && K.chip === n ? ' sel' : '') + '">' + (r ? r + '+' : 'All') + '</span>';
      n++;
    });
    return html;
  }

  function renderGrid() {
    var kind = V.kind, K = ST[kind], g = K.grid, row = Math.floor(g.index / GRID_COLS), html = '';
    rowEls = {};
    rowsDrawn = '';
    var title = g.src === 'search' ? 'Results for “' + esc(K.query.trim()) + '”' : esc(g.title);
    html += '<div class="vg-head"><span class="vr-name">' + title + '</span><span class="vr-count">' + App.count(g.view.length) + '</span>' +
      '<span class="vg-chips">' + chipsHtml(K) + '</span></div>';
    if (!g.view.length) {
      html += '<div class="v-empty small">' + (g.src === 'search' ? 'No match' : 'Nothing here') +
        (K.rating ? '<small>Try a lower rating filter</small>' : g.src === 'search' ? '<small>Press BACK to clear the search</small>' : '') + '</div>';
    }
    for (var r = row; r < row + 2; r++) {
      if (r * GRID_COLS >= g.view.length) break;
      html += '<div class="vg-row" style="top:' + (GRID_TOP + (r - row) * GRID_H) + 'px">';
      for (var i = r * GRID_COLS; i < Math.min(g.view.length, (r + 1) * GRID_COLS); i++) {
        html += cardHtml(kind, K, g.view[i], i, (i % GRID_COLS) * STEP, i === g.index && K.zone === 'grid', true);
      }
      html += '</div>';
    }
    $('v-rows').innerHTML = html;
  }

  function moveGrid(to) {
    var K = ST[V.kind], g = K.grid, was = g.index;
    to = clamp(to, 0, Math.max(0, g.view.length - 1));
    if (to === was) return;
    g.index = to;
    if (Math.floor(to / GRID_COLS) !== Math.floor(was / GRID_COLS)) { renderGrid(); return; }
    var cards = $('v-rows').querySelectorAll('.vg-row')[0].children;
    if (cards[was % GRID_COLS]) cards[was % GRID_COLS].classList.remove('sel');
    if (cards[to % GRID_COLS]) cards[to % GRID_COLS].classList.add('sel');
  }

  function heroMeta(f, kind) {
    var plain = [], badges = '';
    if (f.year) plain.push(esc(f.year));
    if (f.dur > 0) plain.push(longDur(f.dur));
    if (f.seasons) plain.push(f.seasons + (f.seasons === 1 ? ' season' : ' seasons'));
    genres(f.genre).forEach(function (g) { plain.push(esc(g)); });
    if (!plain.length && kind === 'series') plain.push('Series');
    if (f.rating > 0) badges += '<span class="b rate">★ ' + f.rating.toFixed(1) + '</span>';
    if (f.q) badges += '<span class="b q">' + f.q + '</span>';
    if (f.fresh) badges += '<span class="b new">NEW</span>';
    return plain.join('<i class="dot-sep">·</i>') + badges;
  }

  // Where you stopped: a bar and what is left, or the next episode.
  function contLine(kind, K, it) {
    var h = K.hist[it.id];
    if (!h) return '';
    if (kind === 'movie') return inProgress(h) ? barHtml(100 * h.pos / h.dur) + '<span>' + leftDur(h) + '</span>' : '';
    if (!h.ep || !isCont(kind, h)) return '';
    var prog = h.eps && h.eps[h.ep.id], part = inProgress(prog);
    return (part ? barHtml(100 * prog.pos / prog.dur) : '') + '<span>' + code(h.ep) + (part ? ' · ' + leftDur(prog) : ' · Next up') + '</span>';
  }

  // settled: focus has rested (or the screen just opened): also show the backdrop and fetch the info.
  function renderHero(settled) {
    var kind = V.kind, K = ST[kind], it = focused(K);
    clearTimeout(heroTimer);
    if (!it) {
      if (K.mode === 'grid' ? !K.grid.view.length : !K.rows.length) {
        heroId = '';
        $('vh-info').innerHTML = '';
        $('vh-poster').innerHTML = '';
        heroBd.set('', '');
      }
      return;
    }
    var f = facts(kind, it), cont = contLine(kind, K, it);
    $('vh-info').innerHTML =
      (f.group ? '<div class="vh-kicker">' + esc(f.group) + '</div>' : '') +
      '<div class="vh-title">' + esc(f.title) + '</div>' +
      '<div class="vh-meta">' + heroMeta(f, kind) + '</div>' +
      (f.plot ? '<div class="vh-plot">' + esc(f.plot) + '</div>' : '') +
      (cont ? '<div class="vh-cont">' + cont + '</div>' : '');
    // The text follows every move; the backdrop (a big image) and the info request wait until focus rests,
    // so holding a key down does not fetch an image and an info for every title passed.
    if (!settled) {
      heroTimer = setTimeout(function () { if (V.view === 'browse' && V.kind === kind) renderHero(true); }, HERO_MS);
      return;
    }
    if (heroId !== kind + it.id) {
      heroId = kind + it.id;
      $('vh-poster').innerHTML = App.logoHtml({ name: f.title, poster: f.poster }, 'vh-pimg');
    }
    // A TMDB "original" can be 3840 px wide; 1280 is sharp at this size and far cheaper to decode.
    heroBd.set(tmdbSize(f.backdrop, 'w1280') || f.backdrop, f.poster);
    if (!infoOf(kind, it.id) && App.data()) {
      loadInfo(kind, it).then(function () {
        if (V.view === 'browse' && V.kind === kind && focused(ST[kind]) === it) renderHero(true);
      }).catch(noop);
    }
  }

  function searching(K) { return K.zone === 'search' || !!K.query.trim(); }

  function renderBrowse() {
    var kind = V.kind, K = ST[kind];
    $('v-browse').className = 'v-browse z-' + K.zone + ' m-' + K.mode + (K.rail ? ' rail' : '') + (searching(K) ? ' searching' : '');
    $('v-kind').textContent = kind === 'movie' ? 'Movies' : 'Series';
    $('v-total').textContent = App.count(items(kind).length);
    if (K.mode === 'grid') renderGrid(); else renderRows();
    renderHero();
    renderLegend();
    renderRail();
  }

  // Key hints, top right. While searching they make room for the search field.
  function renderLegend() {
    var K = ST[V.kind], html = '';
    if (searching(K)) {
      if (K.zone === 'search') html += '<span><kbd>OK</kbd>Type</span>';
      if (K.query.trim()) html += '<span><kbd>BACK</kbd>Clear</span>';
    } else {
      var sortName = '';
      SORTS.forEach(function (s) { if (s.id === K.sort) sortName = s.name; });
      html = '<span><kbd>◀</kbd>Categories</span><span><i class="dot red"></i>My list</span>' +
        (K.mode === 'grid' ? '<span><i class="dot green"></i>' + sortName + '</span>' : '') +
        '<span><i class="dot yellow"></i>Search</span><span><i class="dot blue"></i>Playlists</span>';
    }
    $('v-legend').innerHTML = html;
  }

  /* ---------- browse: category rail ---------- */

  // LEFT at the start of a row or grid line, or BACK, slides the categories in from the left and pushes the
  // page aside: Home (the rows), the rows' own lists, then the provider's categories. The page shows the
  // highlighted category once the highlight rests; OK or RIGHT goes into it, BACK goes to the home screen.
  var railTimer = 0;

  function railItems(K) {
    var out = [{ id: 'home', name: 'Home', count: -1 }];
    K.rows.forEach(function (row) { out.push({ id: row.id, name: row.name, count: row.items.length }); });
    return out;
  }

  function currentCat(K) { return K.mode === 'grid' && K.grid.src !== 'search' ? K.grid.src : 'home'; }

  // The rows view for 'home', else the grid of that row's titles.
  function showCat(K, id) {
    var row = null;
    if (K.query) clearSearch(K);
    K.rows.forEach(function (r) { if (r.id === id) row = r; });
    if (row) openGrid(V.kind, K, row.name, row.id); else K.mode = 'rows';
  }

  function openRail(K) {
    var list = railItems(K), cur = currentCat(K), at = 0;
    list.forEach(function (c, i) { if (c.id === cur) at = i; });
    K.rail = { i: at, list: list };
    K.zone = 'rail';
    renderBrowse();
  }

  function closeRail(K) {
    var dr = K.rail;
    if (railTimer) { clearTimeout(railTimer); railTimer = 0; showCat(K, dr.list[dr.i].id); }
    K.rail = null;
    K.zone = K.mode === 'grid' ? 'grid' : 'rows';
    renderBrowse();
    renderHero(true);
  }

  function renderRail() {
    var K = ST[V.kind], dr = K.rail;
    if (!dr) return;
    var cur = currentCat(K), n = dr.list.length, start = App.windowStart(dr.i, n, RAIL_ROWS), html = '', firstGroup = true;
    $('vrl-pos').textContent = (dr.i + 1) + ' / ' + n;
    for (var i = start; i < Math.min(n, start + RAIL_ROWS); i++) {
      var c = dr.list[i], grp = c.id.indexOf('g:') === 0;
      var icon = c.id === 'home' ? ICON.grid : ICON[c.id] || '<span class="ic"></span>';
      html += '<div class="vrl-item' + (i === dr.i ? ' sel' : '') + (c.id === cur ? ' cur' : '') + (grp && firstGroup && i > start ? ' grp' : '') + '">' +
        icon + '<span class="n">' + esc(c.name) + '</span>' + (c.count >= 0 ? '<span class="c">' + App.count(c.count) + '</span>' : '') + '</div>';
      if (grp) firstGroup = false;
    }
    $('vrl-items').innerHTML = html;
  }

  function railKey(k, K) {
    var dr = K.rail, n = dr.list.length, was = dr.i;
    switch (k) {
      case KEY.UP: dr.i = clamp(dr.i - 1, 0, n - 1); break;
      case KEY.DOWN: dr.i = clamp(dr.i + 1, 0, n - 1); break;
      case KEY.CH_UP: dr.i = clamp(dr.i - RAIL_ROWS, 0, n - 1); break;
      case KEY.CH_DOWN: dr.i = clamp(dr.i + RAIL_ROWS, 0, n - 1); break;
      case KEY.ENTER: case KEY.RIGHT: closeRail(K); return;
      case KEY.BACK:
        clearTimeout(railTimer);
        railTimer = 0;
        K.rail = null;
        K.zone = K.mode === 'grid' ? 'grid' : 'rows';
        App.go('home');
        return;
      case KEY.YELLOW: closeRail(K); focusSearch(K); return;
      case KEY.BLUE: App.go('playlists'); return;
      default: return;
    }
    if (dr.i === was) return;
    renderRail();
    clearTimeout(railTimer);
    railTimer = setTimeout(function () {
      railTimer = 0;
      if (V.view !== 'browse' || ST[V.kind] !== K || K.rail !== dr) return;
      showCat(K, dr.list[dr.i].id);
      renderBrowse();
    }, RAIL_MS);
  }

  /* ---------- browse: keys ---------- */

  function toggleFavItem(kind, it) {
    if (!it) return false;
    var on = Library.toggleFav(kind, slim(it));
    App.toast(on ? '♥  Added ' + clean(it).title + ' to My list' : 'Removed ' + clean(it).title + ' from My list');
    return on;
  }

  function browseFav(K) {
    var it = focused(K);
    if (!it) return;
    toggleFavItem(V.kind, it);
    refreshBrowse(V.kind);
    renderBrowse();
  }

  function cycleSort(K) {
    var i = 0;
    SORTS.forEach(function (s, n) { if (s.id === K.sort) i = n; });
    setSort(K, SORTS[(i + 1) % SORTS.length].id);
    App.toast('Sort: ' + SORTS[(i + 1) % SORTS.length].name);
  }

  // A new sort or filter starts the grid from its first title.
  function setSort(K, id) {
    K.sort = id;
    Store.set('vodSort', id);
    buildGrid(V.kind, K, null);
    renderBrowse();
  }

  function setRating(K, r) {
    K.rating = r;
    buildGrid(V.kind, K, null);
    renderBrowse();
  }

  function focusSearch(K) {
    K.zone = 'search';
    renderBrowse();
    $('v-search-input').focus();
  }

  function clearSearch(K) {
    K.query = '';
    $('v-search-input').value = '';
    if (K.mode === 'grid' && K.grid.src === 'search') K.mode = 'rows';
  }

  // BACK clears a search first; otherwise it opens the categories (BACK there goes home).
  function browseBack(K) {
    if (K.mode === 'grid' && K.grid.src === 'search') {
      clearSearch(K);
      K.zone = 'rows';
      renderBrowse();
      renderHero(true);
      return;
    }
    openRail(K);
  }

  function searchKey(e, k, K) {
    var input = $('v-search-input');
    if (document.activeElement === input) {
      if (k === KEY.ENTER || k === KEY.IME_DONE || k === KEY.DOWN) {
        input.blur(); K.zone = K.mode === 'grid' ? 'grid' : 'rows'; e.preventDefault(); renderBrowse(); renderHero(true);
      } else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === 27) {
        input.blur(); e.preventDefault(); renderLegend();
      }
      return; // let the keyboard type
    }
    e.preventDefault();
    if (k === KEY.ENTER || k === KEY.YELLOW) input.focus();
    else if (k === KEY.DOWN) { K.zone = K.mode === 'grid' ? 'chips' : 'rows'; renderBrowse(); }
    else if (k === KEY.BACK) {
      if (K.query) clearSearch(K);
      K.zone = K.mode === 'grid' ? 'grid' : 'rows';
      renderBrowse();
      renderHero(true);
    } else if (k === KEY.BLUE) App.go('playlists');
  }

  function rowsKey(k, K) {
    var row = K.rows[K.r];
    switch (k) {
      case KEY.LEFT:
        if (!row || posOf(K, row).i === 0) { openRail(K); return; }
        moveRow(-1); renderHero(); return;
      case KEY.RIGHT: moveRow(1); renderHero(); return;
      case KEY.UP: case KEY.DOWN: case KEY.CH_UP: case KEY.CH_DOWN:
        var step = k === KEY.UP ? -1 : k === KEY.DOWN ? 1 : k === KEY.CH_UP ? -ROW_JUMP : ROW_JUMP;
        if (k === KEY.UP && K.r === 0) { K.zone = 'search'; break; }
        var to = clamp(K.r + step, 0, Math.max(0, K.rows.length - 1));
        if (to === K.r) return;
        K.r = to;
        // The rows move in this frame; the hero text and the row below are drawn in the next one.
        renderRows(true);
        later(function () { if (V.view === 'browse' && K.mode === 'rows') { renderRows(); renderHero(); } });
        return;
      case KEY.ENTER:
        if (!row) return;
        var p = posOf(K, row);
        if (p.i >= Math.min(row.items.length, ROW_MAX)) { openGrid(V.kind, K, row.name, row.id); K.zone = 'grid'; break; }
        openDetail(row.items[p.i]);
        return;
      case KEY.RED: browseFav(K); return;
      case KEY.YELLOW: focusSearch(K); return;
      case KEY.BLUE: App.go('playlists'); return;
      case KEY.BACK: browseBack(K); return;
      default: return;
    }
    renderBrowse();
  }

  function chipsKey(k, K) {
    var n = SORTS.length + RATINGS.length;
    switch (k) {
      case KEY.LEFT: if (K.chip === 0) { openRail(K); return; } K.chip--; break;
      case KEY.RIGHT: K.chip = clamp(K.chip + 1, 0, n - 1); break;
      case KEY.UP: K.zone = 'search'; break;
      case KEY.DOWN: K.zone = 'grid'; break;
      case KEY.ENTER:
        if (K.chip < SORTS.length) setSort(K, SORTS[K.chip].id); else setRating(K, RATINGS[K.chip - SORTS.length]);
        return;
      case KEY.GREEN: cycleSort(K); return;
      case KEY.YELLOW: focusSearch(K); return;
      case KEY.BLUE: App.go('playlists'); return;
      case KEY.BACK: browseBack(K); return;
      default: return;
    }
    renderBrowse();
  }

  function gridKey(k, K) {
    var g = K.grid, col = g.index % GRID_COLS;
    switch (k) {
      case KEY.LEFT:
        if (col === 0) { openRail(K); return; }
        moveGrid(g.index - 1); renderHero(); return;
      case KEY.RIGHT: if (col < GRID_COLS - 1) moveGrid(g.index + 1); renderHero(); return;
      case KEY.UP:
        if (g.index < GRID_COLS) { K.zone = 'chips'; break; }
        moveGrid(g.index - GRID_COLS); renderHero(); return;
      case KEY.DOWN:
        if (Math.floor(g.index / GRID_COLS) < Math.floor((g.view.length - 1) / GRID_COLS)) moveGrid(Math.min(g.view.length - 1, g.index + GRID_COLS));
        renderHero(); return;
      case KEY.CH_UP: moveGrid(Math.max(col, g.index - 2 * GRID_COLS)); renderHero(); return;
      case KEY.CH_DOWN: moveGrid(g.index + 2 * GRID_COLS); renderHero(); return;
      case KEY.ENTER: if (g.view[g.index]) openDetail(g.view[g.index]); return;
      case KEY.RED: browseFav(K); return;
      case KEY.GREEN: cycleSort(K); return;
      case KEY.YELLOW: focusSearch(K); return;
      case KEY.BLUE: App.go('playlists'); return;
      case KEY.BACK: browseBack(K); return;
      default: return;
    }
    renderBrowse();
  }

  function browseKey(e, k) {
    var K = ST[V.kind];
    if (K.zone === 'search') { searchKey(e, k, K); return; }
    e.preventDefault();
    if (k >= 48 && k <= 57) return;     // digits do nothing here
    if (K.rail) railKey(k, K);
    else if (K.zone === 'chips') chipsKey(k, K);
    else if (K.zone === 'grid') gridKey(k, K);
    else rowsKey(k, K);
  }

  /* ---------- detail ---------- */

  function code(ep) { return 'S' + pad(ep.season) + 'E' + pad(ep.num); }

  function flatEps() {
    var out = [];
    if (!D || D.kind !== 'series' || !D.info || !D.info.seasons) return out;
    D.info.seasons.forEach(function (s, si) {
      s.episodes.forEach(function (ep, ei) { out.push({ ep: ep, si: si, ei: ei }); });
    });
    return out;
  }

  function epProg(ep) {
    var h = Library.entry('series', D.item.id);
    return h && h.eps ? h.eps[ep.id] : null;
  }

  // Other titles from the same category, for the "More from" row under a movie.
  function moreLike(kind, it) {
    var list = lookups(kind).byGroup[it.group] || [], out = [];
    for (var i = 0; i < list.length && out.length < MORE_MAX; i++) if (list[i] !== it) out.push(list[i]);
    return out;
  }

  // from: 'home' (BACK returns home), 'more' (BACK returns to the title it was opened from).
  function openDetail(it, from) {
    clearTimeout(heroTimer);
    var kind = V.kind, req = ++reqSeq, prev = from === 'more' ? D : null, info = infoOf(kind, it.id);
    D = { kind: kind, item: it, info: info, loading: !info, err: '', zone: 'btn', btn: 0, si: 0, ei: 0, etop: 0,
      req: req, more: kind === 'movie' ? moreLike(kind, it) : [], mi: 0, moff: 0, plotOpen: false, canOpen: false,
      prev: prev, from: prev ? prev.from : from || '' };
    V.view = 'detail';
    setMode();
    if (info && kind === 'series') pickEpisode();
    renderDetail(true);
    if (info) return;
    loadInfo(kind, it).then(function (got) {
      if (!D || D.req !== req) return;
      D.info = got;
      D.loading = false;
      if (kind === 'series') pickEpisode();
      renderDetail(true);
    }).catch(function (err) {
      if (!D || D.req !== req) return;
      D.loading = false;
      if (kind === 'series') D.err = 'Could not load episodes: ' + (err && err.message || err);
      renderDetail(true);
    });
  }

  // Start with the episode to watch next, else the first one.
  function pickEpisode() {
    var r = seriesResume(), flat = flatEps(), at = null;
    for (var i = 0; r && i < flat.length; i++) if (flat[i].ep.id === r.ep.id) { at = flat[i]; break; }
    D.si = at ? at.si : 0;
    D.ei = at ? at.ei : 0;
    scrollEps();
  }

  function scrollEps() {
    var n = curEps().length;
    D.etop = clamp(D.ei - 1, 0, Math.max(0, n - EP_ROWS));
  }

  function curEps() {
    var s = D && D.kind === 'series' && D.info && D.info.seasons && D.info.seasons[D.si];
    return s ? s.episodes : [];
  }

  // The episode "Resume" or "Play next" leads to, from the series history entry.
  function seriesResume() {
    var h = Library.entry('series', D.item.id);
    if (!h || !h.ep || !D.info) return null;
    var flat = flatEps(), i = -1;
    for (var j = 0; j < flat.length; j++) if (flat[j].ep.id === h.ep.id) { i = j; break; }
    if (i < 0) return null;
    var cur = flat[i].ep, prog = (h.eps && h.eps[cur.id]) || { pos: h.pos, dur: h.dur };
    if (inProgress(prog)) return { ep: cur, pos: prog.pos, label: 'Resume', sub: code(cur) + ' · ' + leftDur(prog) };
    if (flat[i + 1]) return { ep: flat[i + 1].ep, pos: 0, label: 'Play next', sub: code(flat[i + 1].ep) };
    return null;
  }

  function buttons() {
    var out = [], fav = isFav(D.kind, D.item);
    if (D.kind === 'movie') {
      var h = Library.entry('movie', D.item.id), len = D.info && D.info.dur;
      if (inProgress(h)) {
        out.push({ act: 'resume', icon: ICON.play, label: 'Continue', sub: leftDur(h), pos: h.pos });
        out.push({ act: 'play', icon: ICON.again, label: 'From start' });
      } else {
        out.push({ act: 'play', icon: ICON.play, label: 'Play', sub: len > 0 ? longDur(len) : '' });
      }
    } else {
      var r = seriesResume(), first = flatEps()[0];
      if (r) out.push({ act: 'resume', icon: ICON.play, label: r.label, sub: r.sub, ep: r.ep, pos: r.pos });
      else if (first) out.push({ act: 'play', icon: ICON.play, label: 'Play', sub: code(first.ep), ep: first.ep });
    }
    out.push({ act: 'fav', icon: fav ? ICON.added : ICON.add, label: fav ? 'In My list' : 'My list' });
    return out;
  }

  function renderDetail(head) {
    if (!D) return;
    $('v-detail').className = 'v-detail z-' + D.zone + (D.kind === 'series' ? ' series' : '');
    if (head) renderDetailHead();
    var plot = $('vd-plot');
    if (plot) plot.className = 'vd-plot' + (D.plotOpen ? ' open' : '') + (D.zone === 'plot' ? ' sel' : '');
    renderBtns();
    renderLower(head);   // after the plot's size is set: the lower part goes under it
    scrollDetail();
    var leg = D.kind === 'series'
      ? '<span><kbd>▲ ▼ ◀ ▶</kbd>Move</span><span><kbd>OK</kbd>Play</span><span><i class="dot green"></i>From start</span>'
      : '<span><kbd>▲ ▼ ◀ ▶</kbd>Move</span><span><kbd>OK</kbd>Select</span>';
    if (D.zone === 'plot') leg = '<span><kbd>OK</kbd>' + (D.plotOpen ? 'Less' : 'Full description') + '</span>';
    $('vd-legend').innerHTML = leg + '<span><i class="dot red"></i>My list</span><span><kbd>BACK</kbd>Back</span>';
  }

  function chip(t, cls) { return '<span class="chip' + (cls ? ' ' + cls : '') + '">' + t + '</span>'; }

  function renderDetailHead() {
    var it = D.item, f = facts(D.kind, it), series = D.kind === 'series', chips = '';
    detailBd.set(f.backdrop, f.poster);
    $('vd-poster').innerHTML = App.logoHtml({ name: f.title, poster: f.poster }, 'vd-poster');
    if (f.year) chips += chip(esc(f.year));
    if (f.dur > 0) chips += chip(longDur(f.dur));
    if (f.seasons) chips += chip(f.seasons + (f.seasons === 1 ? ' season' : ' seasons'));
    genres(f.genre).forEach(function (g) { chips += chip(esc(g)); });
    if (f.rating > 0) chips += chip('★ ' + f.rating.toFixed(1), 'rate');
    if (f.q) chips += chip(f.q, 'q');
    if (f.fresh) chips += chip('NEW', 'new');
    var h = series ? null : Library.entry('movie', it.id), prog = '';
    if (h && inProgress(h)) {
      prog = '<div class="vd-prog"><div class="v-prog"><i style="width:' + (100 * h.pos / h.dur).toFixed(1) + '%"></i></div>' +
        '<span>' + leftDur(h) + '</span></div>';
    }
    var cast = f.cast ? f.cast.split(/\s*,\s*/).filter(Boolean) : [], rows = '';
    if (cast.length) rows += '<div><span class="k">Starring</span><span class="v">' + esc(cast.slice(0, 3).join(', ')) + (cast.length > 3 ? '<i> and more</i>' : '') + '</span></div>';
    if (f.director) rows += '<div><span class="k">Director</span><span class="v">' + esc(f.director) + '</span></div>';
    $('vd-info').innerHTML =
      '<div class="vh-kicker">' + (series ? 'Series' : 'Movie') + (f.group ? '<i class="dot-sep">·</i>' + esc(f.group) : '') + '</div>' +
      '<div class="vd-title">' + esc(f.title) + '</div>' +
      (chips ? '<div class="vd-chips">' + chips + '</div>' : '') +
      (D.loading && !f.plot ? '<div class="vd-plot dim"><span class="spin-sm"></span>Loading…</div>'
        : '<div id="vd-plot" class="vd-plot">' + (f.plot ? esc(f.plot) : '<span class="dim">No description.</span>') + '</div>') +
      prog + '<div id="vd-btns" class="vd-btns"></div>' +
      (rows ? '<div class="vd-facts">' + rows + '</div>' : '');
    var plot = $('vd-plot');
    D.canOpen = !!plot && (D.plotOpen || plot.scrollHeight > plot.clientHeight + 2);
  }

  function renderBtns() {
    var btns = buttons(), html = '';
    D.btn = clamp(D.btn, 0, btns.length - 1);
    btns.forEach(function (b, i) {
      html += '<div class="vd-btn' + (i === 0 && b.act !== 'fav' ? ' primary' : '') + (D.zone === 'btn' && i === D.btn ? ' sel' : '') + '">' + b.icon +
        '<span class="l"><b>' + esc(b.label) + '</b>' + (b.sub ? '<small>' + esc(b.sub) + '</small>' : '') + '</span></div>';
    });
    $('vd-btns').innerHTML = html;
  }

  // Under the facts: seasons and episodes for a series; cast and "More from" for a movie.
  function renderLower(full) {
    var el = $('vd-lower'), info = $('vd-info');
    if (full) el.style.top = Math.max(720, info.offsetTop + info.offsetHeight + 44) + 'px';
    if (D.kind === 'series') { el.innerHTML = seasonsHtml() + episodesHtml(); return; }
    if (full) { el.innerHTML = castHtml() + moreHtml(); return; }
    var strip = el.querySelector('.vr-strip');
    if (!strip) return;
    translate(strip, -D.moff * STEP);
    var cards = strip.children;
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('sel', D.zone === 'more' && i === D.mi);
      if (near(i, D.moff)) fillImgs(cards[i]);
    }
  }

  function castHtml() {
    var f = facts(D.kind, D.item), people = [];
    if (f.director) people.push({ name: f.director, role: 'Director' });
    (f.cast ? f.cast.split(/\s*,\s*/) : []).forEach(function (n) { if (n) people.push({ name: n, role: '' }); });
    if (!people.length) return '';
    var html = '<div class="vd-sec"><span class="t">Cast &amp; crew</span><span class="c">' + people.length + '</span></div><div class="vd-cast">';
    people.slice(0, CAST_MAX).forEach(function (p) {
      html += '<div class="pp"><span class="av" style="background:' + App.tint(p.name) + '">' + esc(App.initials(p.name)) + '</span>' +
        '<span class="nm">' + esc(p.name) + '</span>' + (p.role ? '<span class="rl">' + p.role + '</span>' : '') + '</div>';
    });
    return html + '</div>';
  }

  function moreHtml() {
    if (!D.more.length) return '';
    var K = { hist: histMap(D.kind) }, html = '';
    D.more.forEach(function (it, i) { html += cardHtml(D.kind, K, it, i, i * STEP, D.zone === 'more' && i === D.mi, near(i, D.moff)); });
    return '<div class="vd-more"><div class="vd-sec"><span class="t">More from ' + esc(D.item.group || 'this category') + '</span></div>' +
      '<div class="vr-clip"><div class="vr-strip" style="-webkit-transform:translateX(' + (-D.moff * STEP) + 'px);transform:translateX(' + (-D.moff * STEP) + 'px)">' +
      html + '</div></div></div>';
  }

  function seasonsHtml() {
    var ss = D.info && D.info.seasons || [], eps = curEps(), html = '<div class="vd-sec eps"><span class="t">Episodes</span>';
    var start = App.windowStart(D.si, ss.length, SEASONS_SHOWN);
    for (var i = start; i < Math.min(ss.length, start + SEASONS_SHOWN); i++) {
      html += '<span class="chip' + (i === D.si ? (D.zone === 'season' ? ' sel' : ' on') : '') + '">' +
        (ss[i].num ? 'Season ' + ss[i].num : 'Specials') + '</span>';
    }
    if (eps.length) html += '<span class="c">' + eps.length + (eps.length === 1 ? ' episode' : ' episodes') + '</span>';
    return html + '</div>';
  }

  function episodesHtml() {
    if (D.err) return '<div class="v-empty small">' + esc(D.err) + '</div>';
    if (D.loading) return '<div class="v-empty small"><div class="spinner" style="margin:0 auto 18px"></div>Loading episodes…</div>';
    var eps = curEps(), f = facts(D.kind, D.item), html = '<div class="vd-eps">';
    if (!eps.length) return '<div class="v-empty small">No episodes</div>';
    for (var i = D.etop; i < Math.min(eps.length, D.etop + EP_ROWS); i++) {
      var ep = eps[i], pr = epProg(ep), done = finished(pr), pct = inProgress(pr) ? 100 * pr.pos / pr.dur : 0;
      var img = ep.poster && ep.poster !== f.poster ? ep.poster : f.backdrop;
      html += '<div class="vd-ep' + (D.zone === 'eps' && i === D.ei ? ' sel' : (i === D.ei ? ' cur' : '')) + '">' +
        '<span class="n">' + ep.num + '</span>' +
        '<span class="th" style="background:' + App.tint(f.title + ep.num) + '">' +
          (img ? '<img src="' + esc(img) + '" onerror="this.parentNode.removeChild(this)">' : '<b>E' + ep.num + '</b>') +
          (done ? '<span class="wt">✓</span>' : '') +
          (pct > 0 ? '<div class="v-prog"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : '') + '</span>' +
        '<div class="tx"><div class="tt"><span class="nm">' + esc(ep.title) + '</span>' +
          '<small>' + (ep.dur > 0 ? longDur(ep.dur) : '') + (done ? (ep.dur > 0 ? ' · ' : '') + 'Watched' : pct > 0 ? (ep.dur > 0 ? ' · ' : '') + leftDur(pr) : '') + '</small></div>' +
          (ep.plot ? '<div class="pl">' + esc(ep.plot) + '</div>' : '') + '</div></div>';
    }
    return html + '</div>';
  }

  // The page slides up to bring the episodes or the "More from" row into view.
  function scrollDetail() {
    var lower = $('vd-lower'), y = 0;
    if (D.zone === 'season' || D.zone === 'eps') y = -(lower.offsetTop - 110);
    else if (D.zone === 'more') {
      var more = lower.querySelector('.vd-more');
      if (more) y = -(lower.offsetTop + more.offsetTop - 560);
    }
    translate($('vd-scroll'), 0, Math.min(0, y));
  }

  function detailAct(b) {
    if (!b) return;
    if (b.act === 'fav') {
      toggleFavItem(D.kind, D.item);
      renderDetail(false);
    } else if (D.kind === 'movie') {
      startPlay(D.item, null, b.act === 'resume' ? b.pos : 0);
    } else {
      startPlay(D.item, b.ep, b.pos || 0);
    }
  }

  function detailBack() {
    if (D.prev) {
      D = D.prev;
      D.zone = 'more';
      renderDetail(true);
      return;
    }
    if (D.from === 'home') App.go('home'); else backToBrowse();
  }

  function detailKey(e, k) {
    e.preventDefault();
    var series = D.kind === 'series', btns = buttons(), eps = curEps();
    if (k === KEY.BACK) { detailBack(); return; }
    if (k === KEY.RED) { toggleFavItem(D.kind, D.item); renderDetail(false); return; }
    if (k === KEY.BLUE) { App.go('playlists'); return; }
    var ready = series ? !D.loading && !D.err && D.info && D.info.seasons && D.info.seasons.length > 0 : D.more.length > 0;
    switch (D.zone) {
      case 'plot':
        if (k === KEY.ENTER) { D.plotOpen = !D.plotOpen; renderDetail(true); return; }
        if (k === KEY.DOWN) { D.zone = 'btn'; if (D.plotOpen) { D.plotOpen = false; renderDetail(true); return; } }
        break;
      case 'btn':
        if (k === KEY.LEFT) D.btn = clamp(D.btn - 1, 0, btns.length - 1);
        else if (k === KEY.RIGHT) D.btn = clamp(D.btn + 1, 0, btns.length - 1);
        else if (k === KEY.UP && D.canOpen) D.zone = 'plot';
        else if (k === KEY.DOWN && ready) D.zone = series ? (D.info.seasons.length > 1 ? 'season' : 'eps') : 'more';
        else if (k === KEY.ENTER) { detailAct(btns[D.btn]); return; }
        else if (k === KEY.PLAY || k === KEY.PLAY_PAUSE) { detailAct(btns[0]); return; }
        break;
      case 'more':
        if (k === KEY.LEFT || k === KEY.RIGHT) {
          D.mi = clamp(D.mi + (k === KEY.LEFT ? -1 : 1), 0, D.more.length - 1);
          if (D.mi > D.moff + VIS - 2) D.moff = D.mi - (VIS - 2);
          if (D.mi < D.moff + 1) D.moff = Math.max(0, D.mi - 1);
        } else if (k === KEY.UP) D.zone = 'btn';
        else if (k === KEY.ENTER && D.more[D.mi]) { openDetail(D.more[D.mi], 'more'); return; }
        break;
      case 'season':
        if (k === KEY.LEFT || k === KEY.RIGHT) {
          var ns = clamp(D.si + (k === KEY.LEFT ? -1 : 1), 0, D.info.seasons.length - 1);
          if (ns !== D.si) { D.si = ns; D.ei = 0; D.etop = 0; }
        } else if (k === KEY.UP) D.zone = 'btn';
        else if (k === KEY.DOWN || k === KEY.ENTER) D.zone = 'eps';
        break;
      case 'eps':
        if (k === KEY.UP) { if (D.ei === 0) D.zone = D.info.seasons.length > 1 ? 'season' : 'btn'; else D.ei--; }
        else if (k === KEY.DOWN) D.ei = clamp(D.ei + 1, 0, eps.length - 1);
        else if (k === KEY.CH_UP) D.ei = clamp(D.ei - EP_ROWS, 0, eps.length - 1);
        else if (k === KEY.CH_DOWN) D.ei = clamp(D.ei + EP_ROWS, 0, eps.length - 1);
        else if (k === KEY.LEFT || k === KEY.RIGHT) {
          var n2 = clamp(D.si + (k === KEY.LEFT ? -1 : 1), 0, D.info.seasons.length - 1);
          if (n2 !== D.si) { D.si = n2; D.ei = 0; }
        } else if ((k === KEY.ENTER || k === KEY.GREEN || k === KEY.PLAY || k === KEY.PLAY_PAUSE) && eps[D.ei]) {
          var ep = eps[D.ei], pr = epProg(ep);
          // OK resumes a part-watched episode; GREEN starts it over.
          startPlay(D.item, ep, k !== KEY.GREEN && inProgress(pr) ? pr.pos : 0);
          return;
        }
        if (D.ei >= D.etop + EP_ROWS - 1 || D.ei < D.etop + 1) scrollEps();
        break;
    }
    renderDetail(false);
  }

  /* ---------- player ---------- */

  function nextEp() {
    return P && P.flat && P.idx + 1 < P.flat.length ? P.flat[P.idx + 1] : null;
  }

  function startPlay(item, ep, startMs) {
    var flat = null, idx = -1;
    if (ep) {
      flat = flatEps();
      for (var i = 0; i < flat.length; i++) if (flat[i].ep.id === ep.id) { idx = i; break; }
      if (idx >= 0) { D.si = flat[idx].si; D.ei = flat[idx].ei; scrollEps(); }
    }
    clearTimers();
    P = { kind: D.kind, item: item, ep: ep, flat: flat, idx: idx, url: ep ? ep.url : item.url,
      dur: ep ? ep.dur : (D.info && D.info.dur) || 0, startMs: startMs, state: 'loading', detail: '',
      started: false, suspended: false, lastSave: Date.now(), target: null, holdUntil: 0,
      seekTimer: 0, streak: 0, lastKey: 0, lastDir: 0, osdTimer: 0, nextTimer: 0, resumeAt: 0 };
    V.view = 'player';
    setMode();
    renderPlayer();
    Player.play(P.url, '', startMs, { aspect: 'auto' });
  }

  function clearTimers() {
    if (!P) return;
    clearTimeout(P.seekTimer);
    clearTimeout(P.osdTimer);
    clearTimeout(P.nextTimer);
  }

  function nowPos() {
    var p = Player.info();
    return { pos: p.time, dur: p.duration || (P && P.dur) || 0 };
  }

  // Saves the position to the history. ended = true records the stream as watched to the end.
  function saveProgress(ended) {
    if (!P || !P.started) return;
    var n = nowPos(), pos = ended ? n.dur : n.pos;
    if (!(n.dur > 0)) return;
    P.dur = n.dur;
    P.lastSave = Date.now();
    var it = P.item;
    if (P.kind === 'movie') {
      Library.record('movie', slim(it), pos, n.dur);
      return;
    }
    var prev = Library.entry('series', it.id), eps = {};
    if (prev && prev.eps) for (var id in prev.eps) if (prev.eps.hasOwnProperty(id)) eps[id] = prev.eps[id];
    eps[P.ep.id] = { pos: pos, dur: n.dur };
    Library.record('series', slim(it), pos, n.dur, {
      ep: { id: P.ep.id, title: P.ep.title, season: P.ep.season, num: P.ep.num, url: P.ep.url },
      eps: eps, done: pos >= n.dur * DONE, hasNext: !!nextEp()
    });
  }

  // Stops playback and returns to the detail view.
  function leavePlayer() {
    if (!P) return;
    clearTimers();
    saveProgress(false);
    Player.stop();
    P = null;
    V.view = 'detail';
    setMode();
    if (D && D.kind === 'series') D.zone = 'eps'; else if (D) D.zone = 'btn';
    if (D) D.btn = 0;
    renderDetail(true);   // the head too: progress bar and button labels change after watching
  }

  function onEnded() {
    saveProgress(true);
    var next = nextEp();
    if (!next) { leavePlayer(); return; }
    P.state = 'ended';
    renderState();
    $('vp-next').innerHTML = '<div class="k">Next episode</div><div class="t">' + code(next.ep) + ' · ' + esc(next.ep.title) +
      '</div><div class="h">OK play now · BACK stop</div>';
    $('vp-next').classList.add('on');
    P.nextTimer = setTimeout(playNext, NEXT_MS);
  }

  function playNext() {
    var next = nextEp();
    if (!P || !next) return;
    startPlay(P.item, next.ep, 0);
  }

  function showOsd() {
    if (!P) return;
    renderOsd();
    $('vp-osd').classList.add('show');
    clearTimeout(P.osdTimer);
    P.osdTimer = setTimeout(function () {
      if (P && !Player.paused()) $('vp-osd').classList.remove('show');
    }, OSD_MS);
  }

  function renderPlayer() {
    $('vp-next').classList.remove('on');
    $('vp-osd').classList.remove('show');
    renderState();
    renderOsd();
  }

  function renderState() {
    var el = $('vp-state'), html = '';
    if (P.state === 'loading') html = '<div class="spinner"></div>Loading…';
    else if (P.state === 'buffering') html = '<div class="spinner"></div>Buffering…';
    else if (P.state === 'error') html = 'Playback failed<small>' + esc(P.detail || 'The stream could not be played') + '</small><small>OK to retry · BACK to return</small>';
    el.innerHTML = html;
    el.classList.toggle('on', !!html);
  }

  function renderOsd() {
    if (!P) return;
    var n = nowPos(), paused = P.started && Player.paused();
    if (P.target !== null && !P.seekTimer && Date.now() > P.holdUntil) P.target = null;
    var pos = P.target !== null ? P.target : n.pos, pct = n.dur > 0 ? clamp(100 * pos / n.dur, 0, 100) : 0;
    var sub = P.ep ? code(P.ep) + ' · ' + esc(P.ep.title) : '';
    var icon = paused ? '<svg viewBox="0 0 24 24" class="ic"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" class="ic"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';
    $('vp-osd').innerHTML = '<div class="v-osd-title">' + esc(clean(P.item).title) + '</div>' +
      (sub ? '<div class="v-osd-sub">' + sub + '</div>' : '') +
      '<div class="v-bar"><i style="width:' + pct.toFixed(2) + '%"></i><b style="left:' + pct.toFixed(2) + '%"></b></div>' +
      '<div class="v-osd-row">' + icon + '<span class="tm">' + dur(pos) + (n.dur > 0 ? ' / ' + dur(n.dur) : '') + '</span>' +
      '<span class="hint"><kbd>◀ ▶</kbd>Seek 10 s<kbd>OK</kbd>' + (paused ? 'Play' : 'Pause') + '<kbd>BACK</kbd>Stop</span></div>';
  }

  // Each press moves 10 s; presses in quick succession move further. The jump happens when the keys pause.
  function seekBy(dir, big) {
    var now = Date.now();
    P.streak = now - P.lastKey < 700 && P.lastDir === dir ? P.streak + 1 : 0;
    P.lastKey = now;
    P.lastDir = dir;
    var step = big ? 30000 : P.streak < 3 ? 10000 : P.streak < 8 ? 30000 : 60000, n = nowPos();
    var base = P.target !== null ? P.target : n.pos;
    P.target = clamp(base + dir * step, 0, Math.max(0, (n.dur || 1e12) - 500));
    clearTimeout(P.seekTimer);
    P.seekTimer = setTimeout(function () {
      if (!P) return;
      P.seekTimer = 0;
      P.holdUntil = Date.now() + SEEK_HOLD_MS;
      Player.seek(P.target);
      renderOsd();
    }, SEEK_APPLY_MS);
    showOsd();
  }

  function togglePause() {
    if (!P || !P.started) return;
    if (Player.paused()) Player.resume();
    else { Player.pause(); saveProgress(false); }
    showOsd();
  }

  function playerKey(e, k) {
    e.preventDefault();
    if (P.nextTimer && P.state === 'ended') {      // "Next episode" countdown
      if (k === KEY.ENTER || k === KEY.PLAY || k === KEY.PLAY_PAUSE || k === KEY.FAST_FORWARD) playNext();
      else if (k === KEY.BACK || k === KEY.STOP) leavePlayer();
      return;
    }
    switch (k) {
      case KEY.BACK: case KEY.STOP: leavePlayer(); return;
      case KEY.ENTER:
        if (P.state === 'error') { startPlay(P.item, P.ep, nowPos().pos || P.startMs); return; }
        togglePause();
        return;
      case KEY.PLAY_PAUSE: togglePause(); return;
      case KEY.PLAY: if (P.started && Player.paused()) togglePause(); else showOsd(); return;
      case KEY.PAUSE: if (P.started && !Player.paused()) togglePause(); else showOsd(); return;
      case KEY.LEFT: seekBy(-1, false); return;
      case KEY.RIGHT: seekBy(1, false); return;
      case KEY.REWIND: seekBy(-1, true); return;
      case KEY.FAST_FORWARD: seekBy(1, true); return;
      default: showOsd();
    }
  }

  /* ---------- screens ---------- */

  // A different playlist loaded: forget this kind's browse state (and whatever is open if it is this kind).
  function resetKind(kind) {
    delete ST[kind];
    delete cache[kind];
    INFO[kind] = {};
    infoKeys = infoKeys.filter(function (k) { return k[0] !== kind; });
    heroId = '';
    if (V.kind !== kind) return;
    if (P) { clearTimers(); Player.stop(); P = null; }
    D = null;
    V.view = 'browse';
  }

  function makeScreen(kind, name) {
    return {
      open: function () { openKind(kind); },
      close: function () {
        if (P) { clearTimers(); saveProgress(false); Player.stop(); P = null; }
        D = null;
        V.view = 'browse';
        if (built) { var input = $('v-search-input'); if (document.activeElement === input) input.blur(); }
      },
      key: function (e, k) {
        if (V.view === 'player' && P) playerKey(e, k);
        else if (V.view === 'detail' && D) detailKey(e, k);
        else browseKey(e, k);
      },
      onState: function (state, detail) {
        if (V.view !== 'player' || !P || P.suspended || state === 'idle') return;
        P.state = state;
        P.detail = detail || '';
        if (state === 'ended') { onEnded(); return; }
        if (state === 'playing' && !P.started) { P.started = true; P.lastSave = Date.now(); showOsd(); }
        renderState();
      },
      tick: function () {
        if (V.view !== 'player' || !P || P.suspended) return;
        if (P.started && P.state === 'playing' && !Player.paused() && Date.now() - P.lastSave >= SAVE_MS) saveProgress(false);
        if ($('vp-osd').classList.contains('show')) renderOsd();
      },
      onVisibility: function (hidden) {
        if (V.view === 'player' && P) {
          if (hidden && !P.suspended) {
            P.resumeAt = nowPos().pos || P.startMs;
            saveProgress(false);
            P.suspended = true;
            P.started = false;
            Player.stop();
          } else if (!hidden && P.suspended) {
            P.suspended = false;
            P.state = 'loading';
            renderState();
            Player.play(P.url, '', P.resumeAt, { aspect: 'auto' });
          }
        } else if (hidden) {
          Player.stop();
        }
      },
      onLoad: function () {
        var wasHere = App.current() === name;
        resetKind(kind);
        if (wasHere) openKind(kind);
      }
    };
  }

  // For the home screen: movies and series to resume, most recent first, as { kind, it, h }.
  App.vodContinue = function () {
    if (!App.data()) return [];
    var out = [];
    ['movie', 'series'].forEach(function (kind) {
      var by = lookups(kind).byId;
      Library.history(kind).forEach(function (h) { if (by[h.id] && isCont(kind, h)) out.push({ kind: kind, it: by[h.id], h: h }); });
    });
    out.sort(function (a, b) { return (b.h.at || 0) - (a.h.at || 0); });
    return out.slice(0, 30);
  };

  // Opens a title's detail page from the home screen; BACK there returns home.
  App.openTitle = function (kind, it) {
    var name = kind === 'movie' ? 'movies' : 'series';
    App.go(name);
    if (App.current() !== name) return;
    openDetail(it, 'home');
  };

  App.register('movies', makeScreen('movie', 'movies'));
  App.register('series', makeScreen('series', 'series'));
})();
