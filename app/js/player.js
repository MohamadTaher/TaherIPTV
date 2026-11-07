/* Video playback, always full screen under the page.
   Samsung AVPlay on the TV, HTML5 <video> in a desktop browser.
   State callback receives: 'loading' | 'buffering' | 'playing' | 'ended' | 'error' | 'idle'.

   Instant channel switching: on the TV, channels the user is likely to pick next are opened in
   spare players in PREBUFFER_MODE (webapis.avplaystore allows 4). Switching to one of them only
   needs play(), about 0.6 s instead of 1.5-3 s. Switching to one that is still pre-buffering waits
   for it (it is already connected), with a normal start as the fallback.

   Defences, all from failures seen on the TV (2026-11-07):
   - some streams never finish preparing; a player can end up broken (its state reads wrong and
     every prepare hangs), so a player that hangs twice in a row, or refuses to open, is retired;
   - a failed pre-buffer is retried, PRE_TRIES times in all, then that stream is skipped;
   - hosts that refuse a second connection (common for paid IPTV accounts) get normal starts only.

   Movies and episodes (js/vod.js) add play(url, ua, startMs) to resume, plus seek, pause, resume and paused. */
var Player = (function () {
  'use strict';

  var native = typeof webapis !== 'undefined';
  var vid = document.getElementById('html-player');

  var PREPARE_MS = 20000;     // give up on a normal start after this
  var PRE_READY_MS = 8000;    // give up on a pre-buffer after this (they take 0.3-3 s when healthy)
  var PRE_WAIT_MS = 2500;     // switching to a pre-buffer still in progress waits this long, then starts normally
  var PRE_TRIES = 3;          // attempts per stream before pre-buffering it is given up
  var PRE_RETRY_MS = 500;     // pause before retrying a failed pre-buffer
  var START_BUFFER_S = 1;     // seconds buffered before the first frame
  var SEEK_WAIT_MS = 4000;    // start playing even if the resume seek never answers
  var ZAP_GAP_MS = 600;       // a play this soon after the previous one counts as a fast zap...
  var ZAP_WAIT_MS = 350;      // ...and waits this long, so channels passed over are never opened
  var POOL_MAX = 4;           // AVPlayStore limit, measured on the TV
  var PRE_MAX = 3;            // pre-buffered channels kept at once (the 4th player is the active one)
  var PRE_MAX_AGE_MS = 60000; // live pre-buffers go stale; reopen after this
  var CONFLICT_MS = 15000;    // active stream failing this soon after a pre-buffer on its host = one-connection host
  var RECT = [0, 0, 1920, 1080];
  var ASPECTS = { fit: 'PLAYER_DISPLAY_MODE_LETTER_BOX', fill: 'PLAYER_DISPLAY_MODE_FULL_SCREEN' };

  var aspect = 'fit';
  var token = 0;          // bumps on every play/stop so late callbacks from old streams are ignored
  var pending = 0;        // timer of a play that has not started yet
  var lastPlay = 0;
  var startAt = 0;        // resume position (ms) of the current play(); 0 = from the start
  var onState = function () {};
  var preloadOn = true;
  var singleHosts = loadHosts();
  var preFails = {};      // url -> failed pre-buffer attempts (this session)
  var lastWant = [];      // last preload() request, for retries
  var retryTimer = 0;

  // Pool entries: { p, role: 'free'|'active'|'pre', broken, url, ready, failed, started, opened, claim }
  // claim = token of a switch waiting for this pre-buffer to finish.
  var pool = [];
  var active = null;
  var storeOk = null;     // null = untested

  /* ---------- pool ---------- */

  function host(url) { var m = /^[a-z]+:\/\/([^\/?#]+)/i.exec(url || ''); return m ? m[1].toLowerCase() : ''; }

  function loadHosts() {
    try { return JSON.parse(localStorage.getItem('tiptv.singleHosts')) || {}; } catch (e) { return {}; }
  }
  function markSingle(h) {
    if (!h || singleHosts[h]) return;
    singleHosts[h] = true;
    try { localStorage.setItem('tiptv.singleHosts', JSON.stringify(singleHosts)); } catch (e) { /* storage unavailable */ }
    pool.forEach(function (e) { if (e.role === 'pre' && !claimed(e) && host(e.url) === h) release(e); });
  }

  // A player that is not in use. The first touch of AVPlay costs ~400 ms, so this runs on first play.
  // Pre-buffering passes noEvict: it must not push out a channel it asked for a moment ago.
  function freeEntry(noEvict) {
    var i;
    for (i = 0; i < pool.length; i++) if (pool[i].role === 'free' && !pool[i].broken) return pool[i];
    if (storeOk !== false && pool.length < POOL_MAX) {
      try {
        var e = { p: webapis.avplaystore.getPlayer(), role: 'free' };
        storeOk = true;
        pool.push(e);
        return e;
      } catch (err) {
        if (storeOk === null) storeOk = false;
      }
    }
    if (!pool.length) {   // no AVPlayStore: one player, no pre-buffering
      try { pool.push({ p: webapis.avplay, role: 'free' }); return pool[0]; } catch (err) { return null; }
    }
    if (noEvict) return null;
    // Pool full: reuse the oldest pre-buffer nobody is waiting for.
    var oldest = null;
    pool.forEach(function (x) { if (x.role === 'pre' && !claimed(x) && !x.broken && (!oldest || x.opened < oldest.opened)) oldest = x; });
    if (oldest) { release(oldest); return oldest; }
    // Every spare player is retired: try one again rather than not playing at all.
    for (i = 0; i < pool.length; i++) {
      if (pool[i].broken && pool[i].role === 'free') { pool[i].broken = false; return pool[i]; }
    }
    return null;
  }

  // stop() and close() block for 80-800 ms on the TV. getState() is not always trustworthy,
  // so close() is always attempted.
  function release(e) {
    if (!e) return;
    var s = 'NONE';
    try { s = e.p.getState(); } catch (err) { /* treat as open */ }
    if (s !== 'NONE' && s !== 'IDLE') { try { e.p.stop(); } catch (err) { /* not playing */ } }
    try { e.p.close(); } catch (err) { /* already closed */ }
    if (e === active) active = null;
    e.role = 'free'; e.url = ''; e.ready = false; e.failed = false; e.started = false;
    e.onReady = null; e.opened = 0; e.claim = 0;
  }

  // Only the current switch's claim counts; a superseded one frees the pre-buffer again.
  function claimed(e) { return !!e.claim && e.claim === token; }

  function retire(e) {
    release(e);
    e.broken = true;
  }

  function preFor(url) {
    for (var i = 0; i < pool.length; i++) if (pool[i].role === 'pre' && pool[i].url === url && !pool[i].failed) return pool[i];
    return null;
  }

  function emitFor(e, state, detail) {
    if (e === active && e.tok === token) onState(state, detail || '');
  }

  // open + listener + display settings, shared by normal starts and pre-buffers.
  // Throws if the player refuses to open; the caller retires it and tries another.
  function openOn(e, url, ua, role) {
    var p = e.p;
    e.role = role; e.url = url; e.ready = false; e.failed = false; e.started = false;
    e.opened = Date.now(); e.onReady = null; e.claim = 0;
    e.bitrate = 0; e.switched = false;
    p.open(url);
    if (ua) { try { p.setStreamingProperty('USER_AGENT', ua); } catch (err) { /* optional */ } }
    // UHD mode, set between open and prepare. Single-quality 4K streams play at 3840x2160 without it
    // (tested on the TV 2026-11-07); Samsung's docs require it for adaptive streams to pick UHD variants.
    try { p.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (err) { /* not a UHD model */ }
    try { p.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', START_BUFFER_S); } catch (err) { /* optional */ }
    p.setListener({
      // Buffering before the first frame is part of 'loading'; only stalls after it are shown.
      onbufferingstart: function () { if (e.started) emitFor(e, 'buffering'); },
      onbufferingprogress: function () {},
      onbufferingcomplete: function () { if (e.started) emitFor(e, 'playing'); },
      onstreamcompleted: function () { emitFor(e, 'ended'); },
      oncurrentplaytime: function () {},
      // Adaptive streams switch quality as bandwidth changes; remember the bitrate for info().
      onevent: function (type, data) {
        if (type !== 'PLAYER_MSG_BITRATE_CHANGE') return;
        var m = /(\d+)/.exec(data || ''), br = m ? parseInt(m[1], 10) : 0;
        if (e.bitrate && br !== e.bitrate) e.switched = true;
        e.bitrate = br;
      },
      onerror: function (err) { failed(e, String(err)); }
    });
    p.setDisplayRect(RECT[0], RECT[1], RECT[2], RECT[3]);
    p.setDisplayMethod(ASPECTS[aspect]);
    if (role === 'pre') p.setStreamingProperty('PREBUFFER_MODE', '0');
    var opened = e.opened;
    setTimeout(function () {
      if (e.opened !== opened || e.ready || e.failed) return;
      hung(e);
    }, role === 'pre' ? PRE_READY_MS : PREPARE_MS);
    p.prepareAsync(function () {
      if (e.opened !== opened) return;
      e.ready = true;
      e.hangs = 0;
      if (e.onReady) { var f = e.onReady; e.onReady = null; f(); }
    }, function (err) {
      if (e.opened !== opened) return;
      failed(e, String(err));
    });
  }

  // A pre-buffer failed: count it, fall back if a switch was waiting on it, retry shortly.
  function preFailed(e, retirePlayer) {
    var url = e.url, ua = e.ua, claim = e.claim;
    preFails[url] = (preFails[url] || 0) + 1;
    if (retirePlayer) retire(e); else release(e);
    if (claim === token) startCold(claim, url, ua);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { preload(lastWant); }, PRE_RETRY_MS);
  }

  // prepareAsync never answered. A player that hangs twice in a row is retired.
  function hung(e) {
    e.hangs = (e.hangs || 0) + 1;
    var bad = e.hangs >= 2;
    if (e.role === 'pre') { preFailed(e, bad); return; }
    var wasActive = e === active, tok = e.tok;
    if (bad) retire(e); else release(e);
    if (wasActive && tok === token) onState('error', 'Timed out connecting to the stream');
  }

  function failed(e, msg) {
    e.failed = true;
    if (e.role === 'pre') {
      // A second connection refused while this host is already playing points to a one-connection account.
      if (active && host(active.url) === host(e.url)) markSingle(host(e.url));
      preFailed(e, false);
      return;
    }
    if (e !== active) return;
    // The active stream died right after we opened a pre-buffer on the same host: the host
    // probably dropped it for the extra connection. Mark the host and restart this channel once.
    var h = host(e.url), recent = false;
    pool.forEach(function (x) { if (x.role === 'pre' && host(x.url) === h && Date.now() - x.opened < CONFLICT_MS) recent = true; });
    if (recent && !singleHosts[h] && !e.retried) {
      markSingle(h);
      var url = e.url, ua = e.ua;
      release(e);
      startCold(token, url, ua, true);
      return;
    }
    emitFor(e, 'error', msg);
  }

  function begin(e) {
    if (e !== active) return;
    var done = false, at = e.tok === token ? startAt : 0;
    function start() {
      if (done || e !== active) return;
      done = true;
      try {
        e.p.play();
        e.started = true;
        emitFor(e, 'playing');
      } catch (err) { emitFor(e, 'error', err.message || String(err)); }
    }
    if (at > 0) {   // resume: seek while ready, then play
      try { e.p.seekTo(at, start, start); setTimeout(start, SEEK_WAIT_MS); return; } catch (err) { /* start from the beginning */ }
    }
    start();
  }

  /* ---------- switching ---------- */

  function startCold(my, url, ua, retried) {
    // One connection at a time for normal starts: the old stream closes first.
    release(active);
    var pre = preFor(url);
    if (pre) release(pre);
    for (var tries = 0; tries < POOL_MAX; tries++) {
      var e = freeEntry();
      if (!e) break;
      active = e; e.tok = my; e.ua = ua; e.retried = !!retried;
      try {
        openOn(e, url, ua, 'active');
        e.onReady = function () { begin(e); };
        return;
      } catch (err) {
        // INVALID_STATE on a closed player: it is broken, use another one.
        active = null;
        retire(e);
      }
    }
    onState('error', 'Player not available');
  }

  // A ready pre-buffer: start it first, then close the old one (Samsung's documented order).
  function promote(my, e) {
    var old = active;
    active = e; e.role = 'active'; e.tok = my; e.retried = false; e.claim = 0;
    try { e.p.setDisplayMethod(ASPECTS[aspect]); } catch (err) { /* keep going */ }
    begin(e);
    if (old && old !== e) setTimeout(function () { if (old !== active) release(old); }, 0);
  }

  // A pre-buffer still in progress: it is already connected, so wait for it a little.
  // The old channel keeps playing meanwhile.
  function claim(my, e) {
    e.claim = my;
    e.onReady = function () { if (my === token) promote(my, e); else e.claim = 0; };
    setTimeout(function () {
      if (my !== token || e.claim !== my || e.role !== 'pre') return;
      startCold(my, e.url, e.ua);
    }, PRE_WAIT_MS);
  }

  function playAv(my, url, ua) {
    var e = preFor(url);
    if (e && e.ready) promote(my, e);
    else if (e) claim(my, e);
    else startCold(my, url, ua);
  }

  function playHtml(url, startMs) {
    var my = token;
    vid.onloadedmetadata = startMs > 0 ? function () { if (my === token) vid.currentTime = startMs / 1000; } : null;
    vid.onwaiting = function () { if (my === token) onState('buffering', ''); };
    vid.onplaying = function () { if (my === token) onState('playing', ''); };
    vid.onended = function () { if (my === token) onState('ended', ''); };
    vid.onerror = function () {
      if (my !== token) return;
      var hls = /\.m3u8(\?|$)/i.test(url) && !vid.canPlayType('application/vnd.apple.mpegurl');
      onState('error', hls ? 'This browser cannot play HLS. It plays on the TV.' : 'Stream failed to load');
    };
    vid.src = url;
    var p = vid.play();
    if (p && p.catch) p.catch(function () { /* reported through onerror */ });
  }

  // Reports 'loading' at once, lets the page paint it, then swaps streams.
  function play(url, ua, startMs) {
    token++;
    startAt = startMs > 0 ? startMs : 0;
    var my = token, now = Date.now();
    clearTimeout(pending);
    onState('loading', '');
    function go() {
      if (my !== token) return;
      if (native) playAv(my, url, ua);
      else { vid.pause(); playHtml(url, startAt); }
    }
    // Fast zaps wait a moment so channels passed over are never opened, unless the target is pre-buffered.
    if (!(native && preFor(url)) && now - lastPlay < ZAP_GAP_MS) pending = setTimeout(go, ZAP_WAIT_MS);
    else requestAnimationFrame(function () { pending = setTimeout(go, 0); });
    lastPlay = now;
  }

  function stop() {
    token++;
    startAt = 0;
    clearTimeout(pending);
    if (native) pool.forEach(release);
    else { vid.pause(); vid.removeAttribute('src'); vid.load(); }
    onState('idle', '');
  }

  /* ---------- movies and episodes: seek and pause ---------- */

  // Jumps to an absolute position (ms), kept inside the video. Before the first frame it sets the start instead.
  function seek(ms) {
    ms = Math.max(0, Math.round(ms));
    if (!native) {
      if (isFinite(vid.duration)) ms = Math.min(ms, Math.max(0, vid.duration * 1000 - 500));
      try { vid.currentTime = ms / 1000; } catch (e) { /* not loaded yet */ }
      return;
    }
    if (!active) return;
    if (!active.started) { startAt = ms; return; }
    try { var d = active.p.getDuration(); if (d > 0) ms = Math.min(ms, Math.max(0, d - 500)); } catch (e) { /* unknown length */ }
    try { active.p.seekTo(ms, function () {}, function () {}); } catch (e) { /* not seekable */ }
  }

  function pause() {
    if (!native) { vid.pause(); return; }
    if (active && active.started) { try { active.p.pause(); } catch (e) { /* not playing */ } }
  }

  function resume() {
    if (!native) { var p = vid.play(); if (p && p.catch) p.catch(function () { /* reported through onerror */ }); return; }
    if (active && active.started) { try { active.p.play(); } catch (e) { /* not paused */ } }
  }

  function paused() {
    if (!native) return vid.paused;
    try { return !!active && active.p.getState() === 'PAUSED'; } catch (e) { return false; }
  }

  // Keep these channels pre-buffered ([{url, ua}], most likely first) and drop the rest.
  function preload(list) {
    lastWant = list || [];
    if (!native || !preloadOn || storeOk === false) return;
    var want = [];
    lastWant.forEach(function (c) {
      if (c && c.url && want.length < PRE_MAX && (preFails[c.url] || 0) < PRE_TRIES && !singleHosts[host(c.url)] &&
          !(active && active.url === c.url)) want.push(c);
    });
    var urls = want.map(function (c) { return c.url; });
    pool.forEach(function (e) {
      if (e.role !== 'pre' || claimed(e)) return;
      var stale = Date.now() - e.opened > PRE_MAX_AGE_MS;
      if (urls.indexOf(e.url) === -1 || stale) release(e);
    });
    want.forEach(function (c) {
      if (preFor(c.url)) return;
      var e = freeEntry(true);
      if (!e || storeOk !== true || e.role !== 'free') return;   // without AVPlayStore the only player is the active one
      e.ua = c.ua;
      try { openOn(e, c.url, c.ua, 'pre'); } catch (err) { retire(e); }
    });
  }

  function setPreload(on) {
    preloadOn = !!on;
    if (!preloadOn) pool.forEach(function (e) { if (e.role === 'pre' && !claimed(e)) release(e); });
  }

  function setAspect(mode) {
    aspect = ASPECTS[mode] ? mode : 'fit';
    vid.classList.toggle('fill', aspect === 'fill');
    if (active) { try { active.p.setDisplayMethod(ASPECTS[aspect]); } catch (e) { /* not open */ } }
    return aspect;
  }

  // Position, duration (ms; 0 for live) and video size. Also used by tools/tvdebug.py.
  function info() {
    var out = { native: native, time: 0, duration: 0, width: 0, height: 0, aspect: aspect };
    if (!native) {
      out.time = Math.round(vid.currentTime * 1000);
      out.duration = isFinite(vid.duration) ? Math.round(vid.duration * 1000) : 0;
      out.width = vid.videoWidth;
      out.height = vid.videoHeight;
      return out;
    }
    out.preFails = preFails;
    out.pool = pool.map(function (e) { return (e.broken ? 'X ' : '') + e.role + (e.ready ? '+' : '') + (e.url ? ' ' + host(e.url) : ''); });
    var av = active && active.p;
    if (!av) { out.state = 'NONE'; return out; }
    try { out.state = av.getState(); } catch (e) { out.state = 'ERR ' + e.message; }
    try { out.time = av.getCurrentTime(); } catch (e) { /* not playing */ }
    try { out.duration = av.getDuration(); } catch (e) { /* live or not ready */ }
    try { out.tracks = av.getCurrentStreamInfo(); } catch (e) { /* not ready */ }
    var size = videoSize(active, out.tracks);
    if (size) { out.width = size.w; out.height = size.h; }
    out.bitrate = active.bitrate;
    return out;
  }

  function trackSize(t) {
    try {
      var x = JSON.parse(t.extra_info);
      return { w: parseInt(x.Width, 10) || 0, h: parseInt(x.Height, 10) || 0, br: parseInt(x.Bit_rate, 10) || 0 };
    } catch (err) { return null; }
  }

  // AVPlay keeps reporting the size an adaptive stream started with, even after it switches quality:
  // getCurrentStreamInfo updates Bit_rate but not Width/Height, and getTotalTrackInfo lists only the
  // first variant (seen on the TV 2026-11-07). So once the bitrate has changed, the size comes from
  // the manifest: the variant whose bitrate is closest. Single-quality streams never fetch anything.
  function videoSize(e, current) {
    var cur = null;
    (current || []).forEach(function (t) { if (t.type === 'VIDEO') cur = trackSize(t); });
    if (!e.switched || !cur) return cur;
    var list = variants[e.url];
    if (!list) { fetchVariants(e.url); return cur; }
    var best = null;
    list.forEach(function (s) { if (!best || Math.abs(s.br - e.bitrate) < Math.abs(best.br - e.bitrate)) best = s; });
    return best || cur;
  }

  var variants = {};      // stream url -> [{ w, h, br }] from its manifest; [] while loading or if it has none
  var variantCount = 0;

  function fetchVariants(url) {
    if (++variantCount > 50) { variants = {}; variantCount = 1; }
    variants[url] = [];
    var x = new XMLHttpRequest();
    x.open('GET', url);
    x.timeout = 5000;
    x.onload = function () { if (x.status === 200) variants[url] = parseVariants(x.responseText || ''); };
    x.send();
  }

  // HLS master playlist (#EXT-X-STREAM-INF) or DASH manifest (<Representation>).
  function parseVariants(text) {
    var out = [], m, a, b, w, h;
    var hls = /#EXT-X-STREAM-INF:([^\r\n]*)/g, dash = /<Representation\b([^>]*)>/g;
    while ((m = hls.exec(text))) {
      b = /(?:^|,)BANDWIDTH=(\d+)/.exec(m[1]);
      w = /RESOLUTION=(\d+)x(\d+)/.exec(m[1]);
      if (b && w) out.push({ br: +b[1], w: +w[1], h: +w[2] });
    }
    while ((m = dash.exec(text))) {
      a = m[1];
      b = /bandwidth="(\d+)"/.exec(a); w = /width="(\d+)"/.exec(a); h = /height="(\d+)"/.exec(a);
      if (b && w && h) out.push({ br: +b[1], w: +w[1], h: +h[1] });
    }
    return out;
  }

  return {
    native: native,
    play: play,
    stop: stop,
    seek: seek,
    pause: pause,
    resume: resume,
    paused: paused,
    preload: preload,
    setPreload: setPreload,
    isPreloaded: function (url) { var e = native && preFor(url); return !!(e && e.ready); },
    isPreloading: function (url) { return !!(native && preFor(url)); },
    info: info,
    setAspect: setAspect,
    onState: function (fn) { onState = fn; }
  };
})();
