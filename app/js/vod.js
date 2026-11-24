/* Movies and series screens: browse, detail, and the full-screen player.

   Browse opens with the category rail out (from the home screen) and refreshes the list in the background.
   Browse: the focused title's backdrop fills the screen behind its title, facts and plot (or its poster on
   a wash of its colours when there is no backdrop). Under them are rows of poster cards: Continue
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
  // Two rows of 2:3 posters (226x339) show. A row shows 7 whole cards, 5 with the category rail open (the
  // rail pushes the page 500 px = 2 cards); nothing is cut at the edge.
  var STEP = 250;               // poster card width (226) + gap, px
  var VIS = 7;                  // cards on screen in a row
  var ROW_H = 400;              // rows: head + card + progress bar + gap
  var ROWS_KEPT = [1, 3];       // rows kept drawn above and below the focused one, so moves never wait for images
  var GRID_H = 384;             // grid rows: card + progress bar + gap
  var ROW_MAX = 40;             // cards in a row before "See all"
  var GRID_COLS = 7;
  var ROW_JUMP = 5;             // CH+/- in the rows
  var HERO_MS = 350;            // fetch the focused title's info once focus rests this long
  var INFO_MAX = 300;           // title infos kept
  var EP_ROWS = 5;
  var SEASONS_SHOWN = 8;
  var CAST_MAX = 8;
  var RAIL_ROWS = 12;           // categories shown in the side rail
  var RAIL_MS = 280;            // the rail's highlighted category shows once the highlight rests this long
  var MORE_MAX = 20;
  var SHOT_STEP = 424;          // screenshot thumb width (400) + gap
  var SHOT_VIS = 4;
  var YOUTUBE_APP = '111299001912';   // the YouTube app on Samsung TVs
  var NEW_MS = 14 * 86400000;   // "NEW" badge for titles added in the last two weeks
  var DONE = 0.95;              // watched this much = finished
  var SAVE_MS = 10000;          // save the position this often while playing
  var OSD_MS = 5000;
  var NEXT_MS = 5000;           // "Next episode" countdown
  var SEEK_APPLY_MS = 450;      // seeks wait this long for more key presses
  var SEEK_HOLD_MS = 1500;      // keep showing the target while the TV catches up
  var RECENT_MAX = 100;
  var TOP_MAX = 100;
  var SORTS = [{ id: 'new', name: 'Newest' }, { id: 'server', name: 'Default' }, { id: 'name', name: 'A–Z' }, { id: 'top', name: 'Top rated' }];
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
    trailer: '<svg viewBox="0 0 24 24" class="ic"><rect x="2.5" y="5" width="19" height="14" rx="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M10 9v6l5-3z" fill="currentColor"/></svg>',
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
      sort: Store.get('vodSort2', 'new'), rating: 0, hist: {} };
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
        '<div id="vd-view" class="vd-view"></div>' +
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

  // From the home screen the categories are out (arg.title: a title opens straight away instead).
  function openKind(kind, arg) {
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
    if (!(arg && arg.title) && K.rows.length) openRail(K); else renderBrowse();
    renderHero(true);
    refreshList(kind);
  }

  // The list was loaded with the playlist, maybe days ago: fetch it again in the background and show
  // titles added since (data.refreshVod skips a fetch made in the last few minutes). Shown at once while
  // browsing; the detail page and the player pick the new list up on their way back (backToBrowse).
  function refreshList(kind) {
    var d = App.data();
    if (!d || !d.refreshVod) return;
    d.refreshVod().then(function (changed) {
      if (!changed || App.data() !== d || !ST[kind] || V.kind !== kind || V.view !== 'browse') return;
      if (App.current() !== (kind === 'movie' ? 'movies' : 'series')) return;
      updateList(kind);
    }).catch(noop);
  }

  // New lists are in: rebuild the rows (and the rail's list) keeping what is focused.
  function updateList(kind) {
    var K = ST[kind];
    refreshBrowse(kind);
    if (K.rail) {
      var id = K.rail.list[K.rail.i] && K.rail.list[K.rail.i].id, list = railItems(K), at = 0;
      list.forEach(function (c, i) { if (c.id === id) at = i; });
      K.rail = { i: at, list: list };
    }
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

  // Poster card (2:3): the whole poster, never cropped (a poster of another shape is letterboxed). Without
  // a poster the title is written over a tint. A bar under the card shows where you stopped.
  function cardHtml(kind, K, it, i, x, sel, eager) {
    var c = clean(it), h = K.hist[it.id], pct = progressOf(kind, h);
    var src = tmdbSize(it.poster, 'w342') || it.poster || '';
    return '<div class="vc' + (sel ? ' sel' : '') + '" data-i="' + i + '" style="left:' + x + 'px">' +
      '<div class="vc-img"><span class="ini" style="background:' + App.tint(c.title) + '"></span>' +
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

  // Rows from one above to three below the focused one stay drawn (their posters load ahead), and slide
  // into place. focusOnly: only add a missing row that shows now; the others follow once that frame is on screen.
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
    for (var r = Math.max(0, K.r - ROWS_KEPT[0]); r <= Math.min(K.rows.length - 1, K.r + ROWS_KEPT[1]); r++) {
      var row = K.rows[r], el = rowEls[row.id];
      if (!el && focusOnly && (r < K.r || r > K.r + 1)) continue;
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

  // The grid keeps the rows around the focused one drawn (one above, two below), like the rows view, and
  // redraws them only when its list changes (another category, sort, filter or search).
  var gridEls = {}, gridDrawn = null, gridVer = '';

  function renderGrid() {
    var kind = V.kind, K = ST[kind], g = K.grid, row = Math.floor(g.index / GRID_COLS), box = $('v-rows');
    rowEls = {};
    rowsDrawn = '';
    if (gridDrawn !== g.view || gridVer !== kind + K.ver || !$('vg-body')) {
      box.innerHTML = '<div class="vg-head" id="vg-head"></div><div class="vg-body" id="vg-body"></div>';
      gridEls = {};
      gridDrawn = g.view;
      gridVer = kind + K.ver;
    }
    var title = g.src === 'search' ? 'Results for “' + esc(K.query.trim()) + '”' : esc(g.title);
    $('vg-head').innerHTML = '<span class="vr-name">' + title + '</span><span class="vr-count">' + App.count(g.view.length) + '</span>' +
      '<span class="vg-chips">' + chipsHtml(K) + '</span>';
    var body = $('vg-body');
    if (!g.view.length) {
      body.innerHTML = '<div class="v-empty small">' + (g.src === 'search' ? 'No match' : 'Nothing here') +
        (K.rating ? '<small>Try a lower rating filter</small>' : g.src === 'search' ? '<small>Press BACK to clear the search</small>' : '') + '</div>';
      return;
    }
    var keep = {}, last = Math.floor((g.view.length - 1) / GRID_COLS);
    for (var r = Math.max(0, row - 1); r <= Math.min(last, row + 2); r++) {
      var el = gridEls[r];
      if (!el) {
        var html = '';
        for (var i = r * GRID_COLS; i < Math.min(g.view.length, (r + 1) * GRID_COLS); i++) {
          html += cardHtml(kind, K, g.view[i], i, 16 + (i % GRID_COLS) * STEP, false, true);
        }
        el = gridEls[r] = document.createElement('div');
        el.className = 'vg-row';
        el.innerHTML = html;
        translate(el, 0, (r - row) * GRID_H);
        body.appendChild(el);
      }
      translate(el, 0, (r - row) * GRID_H);
      keep[r] = 1;
    }
    for (var k in gridEls) if (gridEls.hasOwnProperty(k) && !keep[k]) { body.removeChild(gridEls[k]); delete gridEls[k]; }
    markSel(body, K.zone === 'grid' ? g.index : -1);
  }

  function moveGrid(to) {
    var K = ST[V.kind], g = K.grid, was = g.index;
    to = clamp(to, 0, Math.max(0, g.view.length - 1));
    if (to === was) return;
    g.index = to;
    if (Math.floor(to / GRID_COLS) !== Math.floor(was / GRID_COLS)) { renderGrid(); return; }
    markSel($('vg-body'), to);
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
      (cont ? '<div class="vh-cont">' + cont + '</div>' : f.plot ? '<div class="vh-plot">' + esc(f.plot) + '</div>' : '');
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
    Store.set('vodSort2', id);
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
      shi: 0, shoff: 0, view: -1,
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
    if (inProgress(prog)) return { ep: cur, pos: prog.pos, label: 'Resume', sub: code(cur) + ' · ' + leftDur(prog), pct: 100 * prog.pos / prog.dur };
    if (flat[i + 1]) return { ep: flat[i + 1].ep, pos: 0, label: 'Play next', sub: code(flat[i + 1].ep) };
    return null;
  }

  function buttons() {
    var out = [], fav = isFav(D.kind, D.item);
    if (D.kind === 'movie') {
      var h = Library.entry('movie', D.item.id), len = D.info && D.info.dur;
      if (inProgress(h)) {
        out.push({ act: 'resume', icon: ICON.play, label: 'Continue', sub: leftDur(h), pos: h.pos, pct: 100 * h.pos / h.dur });
        out.push({ act: 'play', icon: ICON.again, label: 'From start' });
      } else {
        out.push({ act: 'play', icon: ICON.play, label: 'Play', sub: len > 0 ? longDur(len) : '' });
      }
    } else {
      var r = seriesResume(), first = flatEps()[0];
      if (r) out.push({ act: 'resume', icon: ICON.play, label: r.label, sub: r.sub, ep: r.ep, pos: r.pos, pct: r.pct });
      else if (first) out.push({ act: 'play', icon: ICON.play, label: 'Play', sub: code(first.ep), ep: first.ep });
    }
    if (D.kind === 'series' && D.info && D.info.trailer) out.push({ act: 'trailer', icon: ICON.trailer, label: 'Trailer' });
    out.push({ act: 'fav', icon: fav ? ICON.added : ICON.add, label: fav ? 'In My list' : 'My list' });
    return out;
  }

  // A movie's "Trailer & screenshots" row, as Netflix shows it: the trailer first, then the provider's
  // backdrops (most list 2-5; one alone is the page's own backdrop, so it is left out).
  // Items: { trailer: youtube id } or { shot: url }.
  function shots() {
    if (!D || D.kind !== 'movie' || !D.info) return [];
    var out = [], list = D.info.shots || [];
    if (D.info.trailer) out.push({ trailer: D.info.trailer });
    if (list.length > 1) list.forEach(function (u) { out.push({ shot: u }); });
    return out;
  }

  function firstShot(list) { return list.length && list[0].trailer ? 1 : 0; }

  // Opens the trailer in the TV's YouTube app (a browser opens YouTube in a new tab).
  function openTrailer(id) {
    var url = 'https://www.youtube.com/watch?v=' + id;
    if (!(window.tizen && tizen.application && tizen.ApplicationControl)) { window.open(url, '_blank'); return; }
    function fail(err) { App.toast('Could not open YouTube' + (err && err.message ? ': ' + err.message : '')); }
    try {
      var data = [new tizen.ApplicationControlData('PAYLOAD', [JSON.stringify({ values: 'v=' + id })])];
      var ctl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', null, null, null, data);
      tizen.application.launchAppControl(ctl, YOUTUBE_APP, noop, fail);
      App.toast('Opening the trailer in YouTube…');
    } catch (err) { fail(err); }
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
    if (D.zone === 'shots') leg = '<span><kbd>◀ ▶</kbd>Move</span><span><kbd>OK</kbd>' + (shots()[D.shi] && shots()[D.shi].trailer ? 'Play trailer' : 'View') + '</span>';
    renderView();
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
    var cast = f.cast ? f.cast.split(/\s*,\s*/).filter(Boolean) : [], rows = '';
    if (cast.length) rows += '<div><span class="k">Starring</span><span class="v">' + esc(cast.slice(0, 3).join(', ')) + (cast.length > 3 ? '<i> and more</i>' : '') + '</span></div>';
    if (f.director) rows += '<div><span class="k">Director</span><span class="v">' + esc(f.director) + '</span></div>';
    $('vd-info').innerHTML =
      '<div class="vh-kicker">' + (series ? 'Series' : 'Movie') + (f.group ? '<i class="dot-sep">·</i>' + esc(f.group) : '') + '</div>' +
      '<div class="vd-title">' + esc(f.title) + '</div>' +
      (chips ? '<div class="vd-chips">' + chips + '</div>' : '') +
      (D.loading && !f.plot ? '<div class="vd-plot dim"><span class="spin-sm"></span>Loading…</div>'
        : '<div id="vd-plot" class="vd-plot">' + (f.plot ? esc(f.plot) : '<span class="dim">No description.</span>') + '</div>') +
      '<div id="vd-btns" class="vd-btns"></div>' +
      (rows ? '<div class="vd-facts">' + rows + '</div>' : '');
    var plot = $('vd-plot');
    D.canOpen = !!plot && (D.plotOpen || plot.scrollHeight > plot.clientHeight + 2);
  }

  function renderBtns() {
    var btns = buttons(), html = '';
    D.btn = clamp(D.btn, 0, btns.length - 1);
    // The first button (Play, Continue, Resume) is the big one: a round play icon, its label and what it
    // plays, and how far you got as a bar along its bottom.
    btns.forEach(function (b, i) {
      var main = i === 0 && b.act !== 'fav';
      html += '<div class="vd-btn' + (main ? ' primary' : '') + (D.zone === 'btn' && i === D.btn ? ' sel' : '') + '">' +
        (main ? '<span class="pi">' + b.icon + '</span>' : b.icon) +
        '<span class="l"><b>' + esc(b.label) + '</b>' + (b.sub ? '<small>' + esc(b.sub) + '</small>' : '') +
        (main && b.pct > 0 ? '<span class="pb"><i style="width:' + b.pct.toFixed(1) + '%"></i></span>' : '') + '</span></div>';
    });
    $('vd-btns').innerHTML = html;
  }

  // Under the facts: seasons and episodes for a series; cast and "More from" for a movie.
  function renderLower(full) {
    var el = $('vd-lower'), info = $('vd-info');
    if (full) el.style.top = Math.max(720, info.offsetTop + info.offsetHeight + 44) + 'px';
    if (D.kind === 'series') { el.innerHTML = seasonsHtml() + episodesHtml(); return; }
    if (full) { el.innerHTML = shotsHtml() + moreHtml() + castHtml(); return; }
    var ss = el.querySelector('.vs-strip');
    if (ss) {
      translate(ss, -D.shoff * SHOT_STEP);
      for (var j = 0; j < ss.children.length; j++) ss.children[j].classList.toggle('sel', D.zone === 'shots' && j === D.shi);
    }
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

  function shotsHtml() {
    var list = shots(), html = '', n = list.length - firstShot(list);
    if (!list.length) return '';
    list.forEach(function (m, i) {
      var sel = D.zone === 'shots' && i === D.shi ? ' sel' : '';
      if (m.trailer) {
        // YouTube's 4:3 thumbnail has the 16:9 frame between black bars; the tile crops them off.
        var bd = facts(D.kind, D.item).backdrop;
        html += '<div class="vs trailer' + sel + '" style="left:0">' +
          (bd ? '<img decoding="async" src="' + esc(bd) + '" class="bd">' : '') +
          '<img decoding="async" src="https://i.ytimg.com/vi/' + esc(m.trailer) + '/hqdefault.jpg" onerror="this.parentNode.removeChild(this)">' +
          '<span class="vs-shade"></span><span class="vs-play">' + ICON.play + '</span><span class="vs-l">Trailer</span></div>';
        return;
      }
      html += '<div class="vs' + sel + '" style="left:' + (i * SHOT_STEP) + 'px">' +
        '<img decoding="async" src="' + esc(m.shot) + '" onerror="this.parentNode.className+=\' bad\'"></div>';
    });
    var title = list[0].trailer ? (n ? 'Trailer &amp; screenshots' : 'Trailer') : 'Screenshots';
    return '<div class="vd-shots"><div class="vd-sec"><span class="t">' + title + '</span>' + (n ? '<span class="c">' + n + '</span>' : '') + '</div>' +
      '<div class="vs-clip"><div class="vs-strip" style="-webkit-transform:translateX(' + (-D.shoff * SHOT_STEP) + 'px);transform:translateX(' + (-D.shoff * SHOT_STEP) + 'px)">' +
      html + '</div></div></div>';
  }

  // A screenshot full screen (D.view = its index): LEFT/RIGHT for the others, OK or BACK closes.
  function renderView() {
    var el = $('vd-view'), list = shots(), f0 = firstShot(list);
    if (!D || D.view < 0 || !list[D.view] || !list[D.view].shot) { el.className = 'vd-view'; el.innerHTML = ''; return; }
    el.className = 'vd-view on';
    el.innerHTML = '<div class="spinner"></div><img decoding="async" src="' + esc(list[D.view].shot) + '" onload="this.className=\'ok\'">' +
      '<div class="vv-bar"><span class="vv-n">' + (D.view - f0 + 1) + ' / ' + (list.length - f0) + '</span>' +
      '<span class="vv-k"><kbd>◀ ▶</kbd>Previous / next<kbd>BACK</kbd>Close</span></div>';
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
    else if (D.zone === 'shots' || D.zone === 'more') {
      // The focused row sits low on the screen; the last one rises to show what is under it (cast).
      var row = lower.querySelector(D.zone === 'shots' ? '.vd-shots' : '.vd-more');
      var last = D.zone === 'more' || !lower.querySelector('.vd-more');
      if (row) {
        var top = lower.offsetTop + row.offsetTop;
        y = -(top - 630);
        if (last) y = Math.max(-(top - 120), Math.min(y, -(lower.offsetTop + lower.offsetHeight - 1000)));
      }
    }
    translate($('vd-scroll'), 0, Math.min(0, y));
  }

  function detailAct(b) {
    if (!b) return;
    if (b.act === 'fav') {
      toggleFavItem(D.kind, D.item);
      renderDetail(false);
    } else if (b.act === 'trailer') {
      openTrailer(D.info.trailer);
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
    var series = D.kind === 'series', btns = buttons(), eps = curEps(), sh = shots();
    if (D.view >= 0) {
      if (k === KEY.LEFT || k === KEY.RIGHT) { D.view = clamp(D.view + (k === KEY.LEFT ? -1 : 1), firstShot(sh), sh.length - 1); D.shi = D.view; }
      else if (k === KEY.BACK || k === KEY.ENTER) D.view = -1;
      if (D.shi > D.shoff + SHOT_VIS - 1) D.shoff = D.shi - (SHOT_VIS - 1);
      if (D.shi < D.shoff) D.shoff = D.shi;
      renderDetail(false);
      return;
    }
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
        else if (k === KEY.DOWN && !series && sh.length) D.zone = 'shots';
        else if (k === KEY.DOWN && ready) D.zone = series ? (D.info.seasons.length > 1 ? 'season' : 'eps') : 'more';
        else if (k === KEY.ENTER) { detailAct(btns[D.btn]); return; }
        else if (k === KEY.PLAY || k === KEY.PLAY_PAUSE) { detailAct(btns[0]); return; }
        break;
      case 'more':
        if (k === KEY.LEFT || k === KEY.RIGHT) {
          D.mi = clamp(D.mi + (k === KEY.LEFT ? -1 : 1), 0, D.more.length - 1);
          if (D.mi > D.moff + VIS - 2) D.moff = D.mi - (VIS - 2);
          if (D.mi < D.moff + 1) D.moff = Math.max(0, D.mi - 1);
        } else if (k === KEY.UP) D.zone = sh.length ? 'shots' : 'btn';
        else if (k === KEY.ENTER && D.more[D.mi]) { openDetail(D.more[D.mi], 'more'); return; }
        break;
      case 'shots':
        if (k === KEY.LEFT || k === KEY.RIGHT) {
          D.shi = clamp(D.shi + (k === KEY.LEFT ? -1 : 1), 0, sh.length - 1);
          if (D.shi > D.shoff + SHOT_VIS - 1) D.shoff = D.shi - (SHOT_VIS - 1);
          if (D.shi < D.shoff) D.shoff = D.shi;
        } else if (k === KEY.UP) D.zone = 'btn';
        else if (k === KEY.DOWN && D.more.length) D.zone = 'more';
        else if (k === KEY.ENTER && sh[D.shi] && sh[D.shi].trailer) { openTrailer(sh[D.shi].trailer); return; }
        else if (k === KEY.ENTER) D.view = D.shi;
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
      seekTimer: 0, seekFrom: 0, streak: 0, zone: 'btns', btn: 'play', aspect: Store.get('vodAspect', 'auto'), lastKey: 0, lastDir: 0, osdTimer: 0, nextTimer: 0, resumeAt: 0 };
    V.view = 'player';
    setMode();
    renderPlayer();
    Player.play(P.url, '', startMs, { aspect: P.aspect });
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
      if (!P || Player.paused() || P.seekTimer) return;
      $('vp-osd').classList.remove('show');
      P.zone = 'btns';
      P.btn = 'play';
    }, OSD_MS);
  }

  function renderPlayer() {
    $('vp-next').classList.remove('on');
    $('vp-osd').classList.remove('show');
    renderState();
    renderOsd();
  }

  function renderState() {
    var el = $('vp-state'), html = '', name = '<small>' + esc(clean(P.item).title) + (P.ep ? ' · ' + code(P.ep) : '') + '</small>';
    if (P.state === 'loading') html = '<div class="spinner"></div>Loading' + name;
    else if (P.state === 'buffering') html = '<div class="spinner"></div>Buffering…';
    else if (P.state === 'error') html = 'Playback failed<small>' + esc(P.detail || 'The stream could not be played') + '</small><small>OK to retry · BACK to return</small>';
    el.innerHTML = html;
    el.classList.toggle('on', !!html);
  }

  var PICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M12 5a7.5 7.5 0 1 1-7.1 5.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 2v6L8 5z" fill="currentColor"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M12 5a7.5 7.5 0 1 0 7.1 5.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 2v6l4-3z" fill="currentColor"/></svg>',
    aspect: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 12V9h3M18 12v3h-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M5 5v14l10-7z" fill="currentColor"/><path d="M17 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };
  var VOD_ASPECTS = [{ id: 'auto', name: 'Original' }, { id: 'fill', name: 'Fill screen' }];

  function clock(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // "+30 s", "−1:30": how far a seek goes.
  function delta(ms) {
    var a = Math.abs(ms), s = Math.round(a / 1000);
    return (ms < 0 ? '−' : '+') + (s < 60 ? s + ' s' : Math.floor(s / 60) + ':' + pad(s % 60));
  }

  // The buttons under the bar, in focus order: back 10 s, play/pause, forward 10 s, picture size, next episode.
  function pButtons() {
    var b = ['back', 'play', 'fwd', 'aspect'];
    if (nextEp()) b.push('next');
    return b;
  }

  // What the focused round button does, shown under it.
  function btnLabel(id, paused) {
    return id === 'back' ? 'Back 10 s' : id === 'fwd' ? 'Forward 10 s' : id === 'play' ? (paused ? 'Play' : 'Pause') : '';
  }

  // Paused: what you are watching, on the left over the dimmed picture (as the big TV apps do).
  function pausedHtml() {
    var c = clean(P.item), f = facts(P.kind, P.item), meta = [];
    if (P.ep) meta.push(code(P.ep));
    if (f.year) meta.push(esc(f.year));
    if (P.kind === 'movie' && f.dur > 0) meta.push(longDur(f.dur));
    genres(f.genre).slice(0, 2).forEach(function (g) { meta.push(esc(g)); });
    var plot = P.ep && P.ep.plot ? P.ep.plot : f.plot;
    return '<div class="vo-info"><div class="vo-kicker">You’re watching</div>' +
      '<div class="vo-ititle">' + esc(c.title) + '</div>' +
      (P.ep && P.ep.title ? '<div class="vo-iep">' + esc(P.ep.title) + '</div>' : '') +
      '<div class="vo-imeta">' + meta.join('<i class="dot-sep">·</i>') + (f.rating > 0 ? '<span class="b rate">★ ' + f.rating.toFixed(1) + '</span>' : '') + '</div>' +
      (plot ? '<div class="vo-iplot">' + esc(plot) + '</div>' : '') + '</div>';
  }

  function aspectName(id) {
    var n = '';
    VOD_ASPECTS.forEach(function (a) { if (a.id === id) n = a.name; });
    return n;
  }

  // The player's controls, laid out like the big TV apps: title and clock on top; at the bottom a full-width
  // bar with elapsed and remaining time, then buttons. Arrows move between the buttons and OK presses one;
  // UP goes to the bar, where LEFT/RIGHT seek (faster the longer they are held).
  function renderOsd() {
    if (!P) return;
    var n = nowPos(), paused = P.started && Player.paused();
    if (P.target !== null && !P.seekTimer && Date.now() > P.holdUntil) P.target = null;
    var seeking = P.target !== null, pos = seeking ? P.target : n.pos, jump = seeking ? delta(P.target - P.seekFrom) : '';
    var pct = n.dur > 0 ? clamp(100 * pos / n.dur, 0, 100) : 0, at = pct.toFixed(2) + '%';
    var c = clean(P.item), sub = P.ep ? code(P.ep) + (P.ep.title ? ' · ' + esc(P.ep.title) : '') : [c.year, c.q].filter(Boolean).join(' · ');
    var now = Date.now(), left = n.dur > 0 ? Math.max(0, n.dur - pos) : 0, bar = P.zone === 'bar', next = nextEp();
    function b(id, cls, inner) {
      var label = btnLabel(id, paused);
      return '<span class="' + cls + (!bar && P.btn === id ? ' sel' : '') + '">' + inner + (label ? '<i class="vo-bl">' + label + '</i>' : '') + '</span>';
    }
    var el = $('vp-osd');
    el.className = 'v-osd' + (el.classList.contains('show') ? ' show' : '') + (paused ? ' paused' : '') +
      (seeking ? ' seeking' : '') + (bar ? ' z-bar' : '');
    el.innerHTML =
      '<div class="vo-top"><div class="vo-tl">' +
          '<div class="vo-kind">' + (P.kind === 'movie' ? 'Movie' : 'Series') + '</div>' +
          '<div class="vo-title">' + esc(c.title) + '</div>' + (sub ? '<div class="vo-sub">' + sub + '</div>' : '') +
        '</div><div class="vo-tr"><div class="vo-clock">' + clock(now) + '</div>' +
          (n.dur > 0 ? '<div class="vo-ends">Ends at ' + clock(now + left) + '</div>' : '') + '</div></div>' +
      (paused && !seeking && !bar ? pausedHtml() : '') +
      '<div class="vo-bot">' +
        '<div class="vo-bar"><i style="width:' + at + '"></i><b style="left:' + at + '"><span class="vo-tip">' + dur(pos) + '<small>' + jump + '</small></span></b></div>' +
        '<div class="vo-times"><span>' + dur(pos) + '</span><span>' + (n.dur > 0 ? '−' + dur(left) : '') + '</span></div>' +
        '<div class="vo-ctl">' +
          '<div class="vo-hint">' + (bar ? '<span><kbd>◀ ▶</kbd>Seek</span><span><kbd>▼</kbd>Buttons</span>'
            : '<span><kbd>▲</kbd>Seek bar</span><span><kbd>BACK</kbd>Stop</span>') + '</div>' +
          '<div class="vo-btns">' +
            b('back', 'vo-b', PICON.back + '<em>10</em>') +
            b('play', 'vo-b main', paused ? PICON.play : PICON.pause) +
            b('fwd', 'vo-b', PICON.fwd + '<em>10</em>') +
          '</div>' +

          '<div class="vo-pills">' +
            b('aspect', 'vo-p', PICON.aspect + '<span>' + aspectName(P.aspect) + '</span>') +
            (next ? b('next', 'vo-p', PICON.next + '<span>Next · ' + code(next.ep) + '</span>') : '') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // Each press moves 10 s. On the bar, presses in quick succession move further (fixed: always 10 s, the
  // buttons). The jump happens when the presses pause.
  function seekBy(dir, big, fixed) {
    var now = Date.now();
    P.streak = now - P.lastKey < 700 && P.lastDir === dir ? P.streak + 1 : 0;
    P.lastKey = now;
    P.lastDir = dir;
    var step = big ? 30000 : fixed || P.streak < 3 ? 10000 : P.streak < 8 ? 30000 : 60000, n = nowPos();
    if (P.target === null) P.seekFrom = n.pos;
    var base = P.target !== null ? P.target : n.pos;
    P.target = clamp(base + dir * step, 0, Math.max(0, (n.dur || 1e12) - 500));
    clearTimeout(P.seekTimer);
    P.seekTimer = setTimeout(applySeek, SEEK_APPLY_MS);
    showOsd();
  }

  function applySeek() {
    if (!P || P.target === null) return;
    clearTimeout(P.seekTimer);
    P.seekTimer = 0;
    P.holdUntil = Date.now() + SEEK_HOLD_MS;
    Player.seek(P.target);
    renderOsd();
  }

  function togglePause() {
    if (!P || !P.started) return;
    if (Player.paused()) Player.resume();
    else { Player.pause(); saveProgress(false); }
    showOsd();
  }

  function cycleAspect() {
    var i = 0;
    VOD_ASPECTS.forEach(function (a, n) { if (a.id === P.aspect) i = n; });
    P.aspect = VOD_ASPECTS[(i + 1) % VOD_ASPECTS.length].id;
    Store.set('vodAspect', P.aspect);
    Player.setPlayAspect(P.aspect);
    showOsd();
  }

  function pressButton(id) {
    if (id === 'back') seekBy(-1, false, true);
    else if (id === 'fwd') seekBy(1, false, true);
    else if (id === 'play') togglePause();
    else if (id === 'aspect') cycleAspect();
    else if (id === 'next') playNext();
  }

  function osdShown() { return $('vp-osd').classList.contains('show'); }

  function playerKey(e, k) {
    e.preventDefault();
    if (P.nextTimer && P.state === 'ended') {      // "Next episode" countdown
      if (k === KEY.ENTER || k === KEY.PLAY || k === KEY.PLAY_PAUSE || k === KEY.FAST_FORWARD) playNext();
      else if (k === KEY.BACK || k === KEY.STOP) leavePlayer();
      return;
    }
    switch (k) {
      case KEY.BACK:
        if (P.zone === 'bar' && osdShown()) { P.zone = 'btns'; showOsd(); return; }
        leavePlayer(); return;
      case KEY.STOP: leavePlayer(); return;
      case KEY.PLAY_PAUSE: togglePause(); return;
      case KEY.PLAY: if (P.started && Player.paused()) togglePause(); else showOsd(); return;
      case KEY.PAUSE: if (P.started && !Player.paused()) togglePause(); else showOsd(); return;
      case KEY.REWIND: seekBy(-1, true); return;
      case KEY.FAST_FORWARD: seekBy(1, true); return;
    }
    if (k === KEY.ENTER && P.state === 'error') { startPlay(P.item, P.ep, nowPos().pos || P.startMs); return; }
    var nav = k === KEY.LEFT || k === KEY.RIGHT || k === KEY.UP || k === KEY.DOWN || k === KEY.ENTER;
    if (!nav) { showOsd(); return; }
    if (!osdShown()) { P.zone = 'btns'; P.btn = 'play'; showOsd(); return; }   // the first press only shows them
    if (P.zone === 'bar') {
      if (k === KEY.LEFT || k === KEY.RIGHT) { seekBy(k === KEY.LEFT ? -1 : 1, false); return; }
      if (k === KEY.ENTER) applySeek();
      if (k === KEY.DOWN || k === KEY.ENTER) P.zone = 'btns';
      showOsd();
      return;
    }
    var list = pButtons(), i = Math.max(0, list.indexOf(P.btn));
    if (k === KEY.LEFT) P.btn = list[Math.max(0, i - 1)];
    else if (k === KEY.RIGHT) P.btn = list[Math.min(list.length - 1, i + 1)];
    else if (k === KEY.UP) P.zone = 'bar';
    else if (k === KEY.DOWN) { $('vp-osd').classList.remove('show'); return; }
    else if (k === KEY.ENTER) { pressButton(list[i]); return; }
    showOsd();
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
      open: function (arg) { openKind(kind, arg); },
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
            Player.play(P.url, '', P.resumeAt, { aspect: P.aspect });
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
    App.go(name, { title: true });
    if (App.current() !== name) return;
    openDetail(it, 'home');
  };

  App.register('movies', makeScreen('movie', 'movies'));
  App.register('series', makeScreen('series', 'series'));
})();
