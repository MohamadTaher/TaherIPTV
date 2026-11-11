/* Movies and series screens: browse (categories + poster grid), detail, and the full-screen player.

   Both screens live in <div id="vod">; #vod's class says which of the three views shows (m-browse,
   m-detail, m-player). The player view is transparent so the video plays under the page.
   History and favourites go through Library: movies as 'movie', one entry per series as 'series'
   ({ ep: last episode, eps: { episodeId: { pos, dur } }, done, hasNext }). */
(function () {
  'use strict';

  var KEY = App.KEY, $ = App.$, esc = App.esc, clamp = App.clamp, pad = App.pad, dur = App.dur;
  var COLS = 5;
  var ROWS = 3;                 // grid rows on screen
  var CAT_ROWS = 16;
  var EP_ROWS = 7;
  var SEASONS_SHOWN = 8;
  var DONE = 0.95;              // watched this much = finished
  var SAVE_MS = 10000;          // save the position this often while playing
  var OSD_MS = 5000;
  var NEXT_MS = 5000;           // "Next episode" countdown
  var SEEK_APPLY_MS = 450;      // seeks wait this long for more key presses
  var SEEK_HOLD_MS = 1500;      // keep showing the target while the TV catches up
  var RECENT_MAX = 100;

  var built = false;
  var V = { kind: 'movie', view: 'browse' };   // view: 'browse' | 'detail' | 'player'
  var ST = {};                  // browse state per kind
  var cache = {};               // per kind: { src, byId, recent }
  var D = null;                 // detail state
  var P = null;                 // player state
  var reqSeq = 0;

  /* ---------- data ---------- */

  function fresh() {
    return { cat: 0, index: 0, top: 0, zone: 'grid', query: '', sort: Store.get('vodSort', 'server'),
      cats: [], view: [], hist: {}, ver: 0, drawn: '' };
  }

  function items(kind) {
    var d = App.data();
    return d ? (kind === 'movie' ? d.movies : d.series) || [] : [];
  }

  // Lookup tables for the loaded list (rebuilt when the list changes).
  function lookups(kind) {
    var src = items(kind), c = cache[kind];
    if (c && c.src === src) return c;
    c = cache[kind] = { src: src, byId: {}, recent: [] };
    src.forEach(function (it) { c.byId[it.id] = it; });
    c.recent = src.filter(function (it) { return it.added > 0; })
      .sort(function (a, b) { return b.added - a.added; }).slice(0, RECENT_MAX);
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

  function buildCats(kind) {
    var K = ST[kind], list = items(kind), counts = {}, groups = [], order = list.groupOrder, prev = K.cats[K.cat];
    list.forEach(function (it) {
      if (!counts[it.group]) { counts[it.group] = 0; groups.push(it.group); }
      counts[it.group]++;
    });
    if (order) groups.sort(function (a, b) { return (order[a] === undefined ? 1e9 : order[a]) - (order[b] === undefined ? 1e9 : order[b]); });
    else groups.sort(function (a, b) { return a.localeCompare(b); });
    K.cats = [{ id: 'all', name: 'All', count: list.length },
              { id: 'fav', name: 'Favourites', count: favItems(kind).length },
              { id: 'cont', name: 'Continue watching', count: contItems(kind).length }];
    var rc = lookups(kind).recent.length;
    if (rc) K.cats.push({ id: 'recent', name: 'Recently added', count: rc });
    groups.forEach(function (g) { K.cats.push({ id: 'group', group: g, name: g, count: counts[g] }); });
    K.cat = 0;
    for (var i = 0; prev && i < K.cats.length; i++) {
      if (K.cats[i].id === prev.id && K.cats[i].group === prev.group) { K.cat = i; break; }
    }
  }

  // Items of the current category, filtered by the search text and sorted.
  function buildView(kind, keepId) {
    var K = ST[kind], cat = K.cats[K.cat], list;
    K.hist = histMap(kind);
    if (!cat) list = [];
    else if (cat.id === 'all') list = items(kind);
    else if (cat.id === 'fav') list = favItems(kind);
    else if (cat.id === 'cont') list = contItems(kind);
    else if (cat.id === 'recent') list = lookups(kind).recent;
    else list = items(kind).filter(function (it) { return it.group === cat.group; });
    var q = K.query.trim().toLowerCase();
    if (q) list = list.filter(function (it) { return (it.name || '').toLowerCase().indexOf(q) !== -1; });
    if (K.sort === 'name' && cat && cat.id !== 'cont' && cat.id !== 'recent') {
      list = list.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    }
    K.view = list;
    K.ver++;
    var at = 0;
    for (var i = 0; keepId && i < list.length; i++) if (list[i].id === keepId) { at = i; break; }
    K.index = at;
    K.top = 0;
    scrollTo(K);
  }

  function scrollTo(K) {
    var row = Math.floor(K.index / COLS), rows = Math.ceil(K.view.length / COLS);
    if (row < K.top) K.top = row;
    else if (row > K.top + ROWS - 1) K.top = row - ROWS + 1;
    K.top = clamp(K.top, 0, Math.max(0, rows - ROWS));
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
        '<aside class="v-side"><div class="v-side-head"><span id="v-kind"></span><span id="v-total"></span></div><div id="v-cats"></div></aside>' +
        '<section class="v-main">' +
          '<div class="v-top"><div class="v-search">' +
            '<svg viewBox="0 0 24 24" class="icon"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5l5 5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>' +
            '<input id="v-search-input" type="text" spellcheck="false" autocomplete="off"></div>' +
            '<div id="v-meta" class="v-meta"></div></div>' +
          '<div id="v-grid" class="v-grid"></div>' +
          '<div class="v-scroll"><i id="v-thumb"></i></div>' +
          '<div id="v-legend" class="legend"></div>' +
        '</section>' +
      '</div>' +
      '<div class="v-detail" id="v-detail">' +
        '<div id="vd-bd" class="vd-bd"></div>' +
        '<div id="vd-head"></div>' +
        '<div class="vd-main">' +
          '<div id="vd-info"></div>' +
          '<div id="vd-btns" class="vd-btns"></div>' +
          '<div id="vd-seasons" class="vd-seasons"></div>' +
          '<div id="vd-eps" class="vd-eps"></div>' +
        '</div>' +
        '<div id="vd-legend" class="legend"></div>' +
      '</div>' +
      '<div class="v-play">' +
        '<div id="vp-state" class="v-state"></div>' +
        '<div id="vp-next" class="v-next"></div>' +
        '<div id="vp-osd" class="v-osd"></div>' +
      '</div>';
    $('v-search-input').addEventListener('input', function () {
      if (V.view !== 'browse') return;
      var K = ST[V.kind];
      K.query = this.value;
      buildView(V.kind, null);
      renderBrowse();
    });
  }

  function openKind(kind) {
    build();
    V.kind = kind;
    V.view = 'browse';
    D = null;
    if (!ST[kind]) {
      ST[kind] = fresh();
      buildCats(kind);
      buildView(kind, null);
    } else {
      refreshBrowse(kind);
    }
    $('v-search-input').value = ST[kind].query;
    $('v-search-input').placeholder = kind === 'movie' ? 'Search movies' : 'Search series';
    setMode();
    renderBrowse();
  }

  // Counts and lists change after favourites or history do; keep the focused item.
  function refreshBrowse(kind) {
    var K = ST[kind], focused = K.view[K.index];
    buildCats(kind);
    buildView(kind, focused && focused.id);
  }

  function backToBrowse() {
    D = null;
    V.view = 'browse';
    refreshBrowse(V.kind);
    setMode();
    renderBrowse();
  }

  /* ---------- browse: rendering ---------- */

  function progressOf(kind, h) {
    if (!h) return 0;
    if (kind === 'series' && !h.ep) return 0;
    return inProgress(h) ? 100 * h.pos / h.dur : 0;
  }

  function cardHtml(kind, K, it, i) {
    var pct = progressOf(kind, K.hist[it.id]);
    return '<div class="v-card' + (i === K.index ? ' sel' : '') + '" data-i="' + i + '">' + App.logoHtml(it, 'v-poster') +
      (isFav(kind, it) ? '<span class="v-heart">♥</span>' : '') +
      (it.rating > 0 ? '<span class="v-rate">★ ' + it.rating.toFixed(1) + '</span>' : '') +
      '<div class="v-title">' + esc(it.name || '') + '</div>' +
      (pct > 0 ? '<div class="v-prog"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : '') + '</div>';
  }

  function renderBrowse() {
    var kind = V.kind, K = ST[kind];
    $('v-browse').className = 'v-browse z-' + K.zone;
    $('v-kind').textContent = kind === 'movie' ? 'Movies' : 'Series';
    $('v-total').textContent = App.count(items(kind).length);
    renderCats();
    renderGrid(true);
    renderLegend();
  }

  function renderCats() {
    var K = ST[V.kind], start = App.windowStart(K.cat, K.cats.length, CAT_ROWS), html = '';
    for (var i = start; i < Math.min(K.cats.length, start + CAT_ROWS); i++) {
      var c = K.cats[i];
      html += '<div class="v-cat' + (i === K.cat ? (K.zone === 'cats' ? ' sel' : ' cur') : '') + '">' +
        '<span class="n">' + esc(c.name) + '</span><span class="c">' + c.count + '</span></div>';
    }
    $('v-cats').innerHTML = html;
  }

  // Only the visible rows exist in the DOM. A move inside the window just moves the highlight.
  function renderGrid(force) {
    var kind = V.kind, K = ST[kind], el = $('v-grid');
    var stamp = K.ver + ':' + K.top + ':' + K.sort;
    if (force || K.drawn !== stamp) {
      K.drawn = stamp;
      if (!K.view.length) {
        var cat = K.cats[K.cat];
        el.innerHTML = '<div class="v-empty">' + (K.query ? 'No match for “' + esc(K.query) + '”<small>Press BACK to clear the search</small>'
          : cat && cat.id === 'fav' ? 'No favourites yet<small>Press the red button on a poster to add it</small>'
          : cat && cat.id === 'cont' ? 'Nothing in progress<small>What you start watching shows up here</small>'
          : 'Nothing here') + '</div>';
      } else {
        var html = '';
        for (var r = K.top; r < K.top + ROWS; r++) {
          if (r * COLS >= K.view.length) break;
          html += '<div class="v-row">';
          for (var c = r * COLS; c < Math.min(K.view.length, (r + 1) * COLS); c++) html += cardHtml(kind, K, K.view[c], c);
          html += '</div>';
        }
        el.innerHTML = html;
      }
    } else {
      var old = el.querySelector('.v-card.sel'), now = el.querySelector('.v-card[data-i="' + K.index + '"]');
      if (old) old.classList.remove('sel');
      if (now) now.classList.add('sel');
    }
    renderTop();
  }

  function renderTop() {
    var K = ST[V.kind], cat = K.cats[K.cat], rows = Math.ceil(K.view.length / COLS);
    $('v-meta').innerHTML = (cat ? esc(cat.name) : '') + (K.view.length
      ? '  ·  <b>' + (K.index + 1) + '</b> / ' + App.count(K.view.length) : '') + (K.sort === 'name' ? '  ·  A–Z' : '');
    var thumb = $('v-thumb');
    thumb.parentNode.style.visibility = rows > ROWS ? 'visible' : 'hidden';
    if (rows > ROWS) {
      var track = 936, h = Math.max(36, track * ROWS / rows);
      thumb.style.height = h + 'px';
      thumb.style.top = ((track - h) * K.top / (rows - ROWS)) + 'px';
    }
  }

  function renderLegend() {
    var K = ST[V.kind];
    $('v-legend').innerHTML = (K.zone === 'cats' ? '<span><kbd>▶</kbd>Posters</span>' : '<span><kbd>◀</kbd>Categories</span>') +
      '<span><kbd>OK</kbd>Open</span><span><i class="dot red"></i>Favourite</span><span><i class="dot green"></i>' +
      (K.sort === 'name' ? 'Server order' : 'A–Z') + '</span><span><i class="dot yellow"></i>Search</span>' +
      '<span><i class="dot blue"></i>Playlists</span><span><kbd>BACK</kbd>Home</span>';
  }

  /* ---------- browse: keys ---------- */

  function toggleFavItem(kind, it) {
    if (!it) return false;
    var on = Library.toggleFav(kind, slim(it));
    App.toast(on ? '♥  Added ' + it.name + ' to favourites' : 'Removed ' + it.name + ' from favourites');
    return on;
  }

  function browseFav(K) {
    var it = K.view[K.index];
    if (!it) return;
    toggleFavItem(V.kind, it);
    var keep = K.index;
    refreshBrowse(V.kind);
    if (K.cats[K.cat].id === 'fav') { K.index = clamp(keep, 0, Math.max(0, K.view.length - 1)); scrollTo(K); }
    renderBrowse();
  }

  function toggleSort(K) {
    K.sort = K.sort === 'name' ? 'server' : 'name';
    Store.set('vodSort', K.sort);
    var focused = K.view[K.index];
    buildView(V.kind, focused && focused.id);
    App.toast(K.sort === 'name' ? 'Sorted A–Z' : 'Server order');
    renderBrowse();
  }

  function focusSearch(K) {
    K.zone = 'search';
    renderBrowse();
    $('v-search-input').focus();
  }

  function browseBack(K) {
    if (K.query) {
      K.query = '';
      $('v-search-input').value = '';
      var focused = K.view[K.index];
      buildView(V.kind, focused && focused.id);
      renderBrowse();
      return;
    }
    App.go('home');
  }

  function searchKey(e, k, K) {
    var input = $('v-search-input');
    if (document.activeElement === input) {
      if (k === KEY.ENTER || k === KEY.IME_DONE || k === KEY.DOWN) {
        input.blur(); K.zone = 'grid'; e.preventDefault(); renderBrowse();
      } else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === 27) {
        input.blur(); e.preventDefault();
      }
      return; // let the keyboard type
    }
    e.preventDefault();
    if (k === KEY.ENTER || k === KEY.YELLOW) input.focus();
    else if (k === KEY.DOWN || k === KEY.BACK) { K.zone = 'grid'; renderBrowse(); }
    else if (k === KEY.LEFT) { K.zone = 'cats'; renderBrowse(); }
    else if (k === KEY.BLUE) App.go('playlists');
  }

  function catsKey(k, K) {
    switch (k) {
      case KEY.UP: case KEY.DOWN: case KEY.CH_UP: case KEY.CH_DOWN:
        var step = k === KEY.UP ? -1 : k === KEY.DOWN ? 1 : k === KEY.CH_UP ? -CAT_ROWS : CAT_ROWS;
        K.cat = clamp(K.cat + step, 0, K.cats.length - 1);
        buildView(V.kind, null);
        break;
      case KEY.RIGHT: case KEY.ENTER: K.zone = 'grid'; break;
      case KEY.GREEN: toggleSort(K); return;
      case KEY.YELLOW: focusSearch(K); return;
      case KEY.BLUE: App.go('playlists'); return;
      case KEY.BACK: browseBack(K); return;
      default: return;
    }
    renderBrowse();
  }

  function gridKey(k, K) {
    var n = K.view.length, last = Math.max(0, n - 1), col = K.index % COLS, row = Math.floor(K.index / COLS);
    switch (k) {
      case KEY.LEFT:
        if (col === 0) K.zone = 'cats'; else K.index--;
        break;
      case KEY.RIGHT:
        if (col < COLS - 1 && K.index < last) K.index++;
        break;
      case KEY.UP:
        if (row === 0) K.zone = 'search'; else K.index -= COLS;
        break;
      case KEY.DOWN:
        if (K.index + COLS <= last) K.index += COLS;
        else if (Math.floor(last / COLS) > row) K.index = last;   // a shorter last row
        break;
      case KEY.CH_UP: K.index = Math.max(col <= last ? col : 0, K.index - ROWS * COLS); break;
      case KEY.CH_DOWN: K.index = Math.min(last, K.index + ROWS * COLS); break;
      case KEY.ENTER: if (K.view[K.index]) openDetail(K.view[K.index]); return;
      case KEY.RED: browseFav(K); return;
      case KEY.GREEN: toggleSort(K); return;
      case KEY.YELLOW: focusSearch(K); return;
      case KEY.BLUE: App.go('playlists'); return;
      case KEY.BACK: browseBack(K); return;
      default: return;
    }
    scrollTo(K);
    if (K.zone === 'grid') renderGrid(false); else renderBrowse();
  }

  function browseKey(e, k) {
    var K = ST[V.kind];
    if (K.zone === 'search') { searchKey(e, k, K); return; }
    e.preventDefault();
    if (k >= 48 && k <= 57) return;     // digits do nothing here
    if (K.zone === 'cats') catsKey(k, K); else gridKey(k, K);
  }

  /* ---------- detail ---------- */

  function code(ep) { return 'S' + pad(ep.season) + 'E' + pad(ep.num); }

  function longDur(ms) {
    var m = Math.round(ms / 60000), h = Math.floor(m / 60);
    return h ? h + 'h ' + pad(m % 60) + 'm' : m + ' min';
  }

  function flatEps() {
    var out = [];
    if (!D || D.kind !== 'series' || !D.info) return out;
    D.info.seasons.forEach(function (s, si) {
      s.episodes.forEach(function (ep, ei) { out.push({ ep: ep, si: si, ei: ei }); });
    });
    return out;
  }

  function epProg(ep) {
    var h = Library.entry('series', D.item.id);
    return h && h.eps ? h.eps[ep.id] : null;
  }

  function openDetail(it) {
    var kind = V.kind, req = ++reqSeq;
    D = { kind: kind, item: it, info: null, loading: true, err: '', zone: 'btn', btn: 0, si: 0, ei: 0, etop: 0, req: req };
    V.view = 'detail';
    setMode();
    $('vd-bd').style.backgroundImage = '';
    renderDetail(true);
    var d = App.data(), p;
    try { p = kind === 'movie' ? d.movieInfo(it.id) : d.seriesInfo(it.id); } catch (e) { p = Promise.reject(e); }
    p.then(function (info) {
      if (!D || D.req !== req) return;
      D.info = info || null;
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
    D.etop = clamp(D.ei - Math.floor(EP_ROWS / 2), 0, Math.max(0, n - EP_ROWS));
  }

  function curEps() {
    var s = D && D.kind === 'series' && D.info && D.info.seasons[D.si];
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
    if (inProgress(prog)) return { ep: cur, pos: prog.pos, label: 'Resume ' + code(cur) + ' · ' + dur(prog.pos) };
    if (flat[i + 1]) return { ep: flat[i + 1].ep, pos: 0, label: 'Play next ' + code(flat[i + 1].ep) };
    return null;
  }

  function buttons() {
    var out = [], fav = isFav(D.kind, D.item) ? 'Remove from favourites' : 'Add to favourites';
    if (D.kind === 'movie') {
      var h = Library.entry('movie', D.item.id);
      if (inProgress(h)) out.push({ act: 'resume', label: 'Resume from ' + dur(h.pos), pos: h.pos });
      out.push({ act: 'play', label: inProgress(h) ? 'Play from start' : 'Play' });
    } else {
      var r = seriesResume(), first = flatEps()[0];
      if (r) out.push({ act: 'resume', label: r.label, ep: r.ep, pos: r.pos });
      else if (first) out.push({ act: 'play', label: 'Play ' + code(first.ep), ep: first.ep });
    }
    out.push({ act: 'fav', label: fav });
    return out;
  }

  function renderDetail(head) {
    if (!D) return;
    var series = D.kind === 'series';
    $('v-detail').className = 'v-detail' + (series ? ' series' : '');
    if (head) renderDetailHead();
    var btns = buttons(), html = '';
    D.btn = clamp(D.btn, 0, btns.length - 1);
    btns.forEach(function (b, i) {
      html += '<div class="vd-btn' + (D.zone === 'btn' && i === D.btn ? ' sel' : '') + '">' + esc(b.label) + '</div>';
    });
    $('vd-btns').innerHTML = html;
    renderSeasons();
    renderEps();
    var leg = '<span><kbd>OK</kbd>Select</span><span><i class="dot red"></i>Favourite</span>';
    if (series) leg = '<span><kbd>▲ ▼ ◀ ▶</kbd>Move</span><span><kbd>OK</kbd>Play</span><span><i class="dot green"></i>From start</span><span><i class="dot red"></i>Favourite</span>';
    $('vd-legend').innerHTML = leg + '<span><kbd>BACK</kbd>Back</span>';
  }

  function renderDetailHead() {
    var it = D.item, i = D.info || {}, series = D.kind === 'series';
    var m = {
      poster: i.poster || it.poster, year: i.year || it.year, genre: i.genre || it.genre, plot: i.plot || it.plot,
      rating: i.rating || it.rating
    };
    $('vd-head').innerHTML = App.logoHtml({ name: it.name, poster: m.poster }, 'vd-poster');
    $('vd-bd').style.backgroundImage = i.backdrop ? 'url("' + String(i.backdrop).replace(/["\\]/g, '') + '")' : '';
    var meta = [];
    if (m.year) meta.push(esc(m.year));
    if (m.genre) meta.push(esc(m.genre));
    if (m.rating > 0) meta.push('<span class="vd-rate">★ ' + m.rating.toFixed(1) + '</span>');
    if (!series && i.dur > 0) meta.push(longDur(i.dur));
    if (series && D.info) meta.push(D.info.seasons.length + (D.info.seasons.length === 1 ? ' season' : ' seasons'));
    var facts = '';
    if (i.director) facts += '<div><span class="k">Director</span>' + esc(i.director) + '</div>';
    if (i.cast) facts += '<div><span class="k">Cast</span>' + esc(i.cast) + '</div>';
    $('vd-info').innerHTML = '<div class="vd-title">' + esc(it.name) + '</div>' +
      '<div class="vd-meta">' + (meta.join('<span class="sep"></span>') || esc(it.group || '')) + '</div>' +
      (D.loading ? '<div class="vd-plot dim"><span class="spin-sm"></span>Loading…</div>'
        : '<div class="vd-plot">' + (m.plot ? esc(m.plot) : '<span class="dim">No description.</span>') + '</div>') +
      (facts ? '<div class="vd-facts">' + facts + '</div>' : '');
  }

  function renderSeasons() {
    var el = $('vd-seasons');
    if (D.kind !== 'series' || !D.info || !D.info.seasons.length) { el.innerHTML = ''; return; }
    var ss = D.info.seasons, start = App.windowStart(D.si, ss.length, SEASONS_SHOWN), html = '';
    for (var i = start; i < Math.min(ss.length, start + SEASONS_SHOWN); i++) {
      html += '<span class="vd-season' + (i === D.si ? (D.zone === 'season' ? ' sel' : ' cur') : '') + '">' +
        (ss[i].num ? 'Season ' + ss[i].num : 'Specials') + '</span>';
    }
    el.innerHTML = html;
  }

  function renderEps() {
    var el = $('vd-eps');
    if (D.kind !== 'series') { el.innerHTML = ''; return; }
    if (D.err) { el.innerHTML = '<div class="v-empty small">' + esc(D.err) + '</div>'; return; }
    if (D.loading) { el.innerHTML = '<div class="v-empty small"><div class="spinner" style="margin:0 auto 18px"></div>Loading episodes…</div>'; return; }
    var eps = curEps(), html = '';
    if (!eps.length) { el.innerHTML = '<div class="v-empty small">No episodes</div>'; return; }
    for (var i = D.etop; i < Math.min(eps.length, D.etop + EP_ROWS); i++) {
      var ep = eps[i], pr = epProg(ep), done = finished(pr), pct = inProgress(pr) ? 100 * pr.pos / pr.dur : 0;
      html += '<div class="vd-ep' + (D.zone === 'eps' && i === D.ei ? ' sel' : (i === D.ei ? ' cur' : '')) + '">' +
        '<span class="n">' + ep.num + '</span><span class="t">' + esc(ep.title) + '</span>' +
        (done ? '<span class="w">✓ Watched</span>' : pct > 0 ? '<span class="w">' + dur(pr.pos) + ' in</span>' : '') +
        '<span class="d">' + (ep.dur > 0 ? longDur(ep.dur) : '') + '</span>' +
        (pct > 0 ? '<div class="v-prog"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : '') + '</div>';
    }
    el.innerHTML = html;
  }

  function detailAct(b) {
    if (b.act === 'fav') {
      toggleFavItem(D.kind, D.item);
      renderDetail(false);
    } else if (D.kind === 'movie') {
      startPlay(D.item, null, b.act === 'resume' ? b.pos : 0);
    } else {
      startPlay(D.item, b.ep, b.pos || 0);
    }
  }

  function detailKey(e, k) {
    e.preventDefault();
    var series = D.kind === 'series', btns = buttons(), eps = curEps();
    if (k === KEY.BACK) { if (D.from === 'home') App.go('home'); else backToBrowse(); return; }
    if (k === KEY.RED) { toggleFavItem(D.kind, D.item); renderDetail(false); return; }
    if (k === KEY.BLUE) { App.go('playlists'); return; }
    if (!series) {
      if (k === KEY.LEFT) D.btn = clamp(D.btn - 1, 0, btns.length - 1);
      else if (k === KEY.RIGHT) D.btn = clamp(D.btn + 1, 0, btns.length - 1);
      else if (k === KEY.ENTER) { detailAct(btns[D.btn]); return; }
      else if (k === KEY.PLAY || k === KEY.PLAY_PAUSE) { detailAct(btns[0]); return; }
      renderDetail(false);
      return;
    }
    if (D.loading || D.err) return;
    var hasSeasons = D.info && D.info.seasons.length > 0;
    switch (D.zone) {
      case 'btn':
        if (k === KEY.LEFT) D.btn = clamp(D.btn - 1, 0, btns.length - 1);
        else if (k === KEY.RIGHT) D.btn = clamp(D.btn + 1, 0, btns.length - 1);
        else if (k === KEY.DOWN && hasSeasons) D.zone = D.info.seasons.length > 1 ? 'season' : 'eps';
        else if (k === KEY.ENTER) { detailAct(btns[D.btn]); return; }
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
        if (D.ei >= D.etop + EP_ROWS || D.ei < D.etop) scrollEps();
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
    Player.preload([]);
    renderPlayer();
    Player.play(P.url, '', startMs);
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
    renderDetail(false);
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
    $('vp-osd').innerHTML = '<div class="v-osd-title">' + esc(P.item.name) + '</div>' +
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
            Player.play(P.url, '', P.resumeAt);
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
    openDetail(it);
    D.from = 'home';
  };

  App.register('movies', makeScreen('movie', 'movies'));
  App.register('series', makeScreen('series', 'series'));
})();
