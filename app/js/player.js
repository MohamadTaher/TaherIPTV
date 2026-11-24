/* Video playback, always full screen under the page.
   Samsung AVPlay on the TV, HTML5 <video> in a desktop browser.
   State callback receives: 'loading' | 'buffering' | 'playing' | 'ended' | 'error' | 'idle'.

   One player, one stream at a time: close the old stream, open the new one, prepare, play.
   Nothing is opened ahead of time. Pre-buffering neighbours, taking turns on a one-connection
   account and a local relay were all tried (2026-11) and dropped: paid accounts usually allow
   one connection, where every one of them cost flicker, time jumps or stuck starts.

   info().start holds where the time of the last start went, in ms from the key press.

   Movies and episodes (js/vod.js) add play(url, ua, startMs) to resume, plus seek, pause, resume and paused. */
var Player = (function () {
  'use strict';

  var native = typeof webapis !== 'undefined';
  var vid = document.getElementById('html-player');

  var PREPARE_MS = 15000;     // give up on a start after this
  var START_BUFFER_S = 1;     // seconds buffered before the first frame
  var SEEK_WAIT_MS = 4000;    // start playing even if the resume seek never answers
  var ZAP_GAP_MS = 600;       // a play this soon after the previous one counts as a fast zap...
  var ZAP_WAIT_MS = 350;      // ...and waits this long, so channels passed over are never opened
  var FRAME_POLL_MS = 50;     // how often the clock is read to time the first frame
  var FRAME_POLLS = 100;      // ...and for how long (5 s)
  var RECT = [0, 0, 1920, 1080];
  var ASPECTS = { fit: 'PLAYER_DISPLAY_MODE_LETTER_BOX', fill: 'PLAYER_DISPLAY_MODE_FULL_SCREEN' };
  var MODES = { auto: 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO', fit: ASPECTS.fit, fill: ASPECTS.fill };
  // Movies and episodes bring their own mode (play(..., { aspect: 'auto' | 'fill' }), setPlayAspect); the Fit/Fill
  // toggle is for live channels.

  var aspect = 'fit';
  var own = '';           // the current play's own display mode ('auto' | 'fit' | 'fill'); '' = the Fit/Fill setting
  var token = 0;          // bumps on every play/stop so late callbacks from old streams are ignored
  var pending = 0;        // timer of a play that has not started yet
  var lastPlay = 0;
  var startAt = 0;        // resume position (ms) of the current play(); 0 = from the start
  var onState = function () {};

  var av = null;          // the AVPlay player. Its first touch costs ~400 ms, so it is taken on first play
  var cur = null;         // the stream on the player: { tok, url, ready, started, bitrate, switched }
  var hangTimer = 0;
  var lastStart = null;   // { wait, closed, opened, prepared, play, frame }: ms from play() to each step

  /* ---------- AVPlay ---------- */

  function emit(c, state, detail) {
    if (c === cur && c.tok === token) onState(state, detail || '');
  }

  // stop() and close() block for 80-800 ms on the TV. getState() is not always trustworthy,
  // so close() is always attempted.
  function closePlayer(p) {
    if (!p) return;
    var s = 'NONE';
    try { s = p.getState(); } catch (err) { /* treat as open */ }
    if (s !== 'NONE' && s !== 'IDLE') { try { p.stop(); } catch (err) { /* not playing */ } }
    try { p.close(); } catch (err) { /* already closed */ }
  }

  function closeCurrent() {
    clearTimeout(hangTimer);
    cur = null;
    closePlayer(av);
  }

  // The stream failed: free the connection, then say so.
  function fail(c, msg) {
    if (c !== cur) return;
    var mine = c.tok === token;
    closeCurrent();
    if (mine) onState('error', msg);
  }

  // prepareAsync never answered. Such a player can stay broken: its state reads wrong and every later
  // prepare hangs (seen on the TV 2026-11-07). So the next start gets another player. It is taken
  // before the close, because after a close the store hands the same player out again.
  function hung(c) {
    if (c !== cur) return;
    var stuck = av, mine = c.tok === token;
    try { av = webapis.avplaystore.getPlayer(); } catch (err) { /* no store, or none left: keep this one */ }
    clearTimeout(hangTimer);
    cur = null;
    closePlayer(stuck);
    if (mine) onState('error', 'Timed out connecting to the stream');
  }

  function listener(c) {
    return {
      // Buffering before the first frame is part of 'loading'; only stalls after it are shown.
      onbufferingstart: function () { if (c.started) emit(c, 'buffering'); },
      onbufferingprogress: function () {},
      onbufferingcomplete: function () { if (c.started) emit(c, 'playing'); },
      onstreamcompleted: function () { emit(c, 'ended'); },
      oncurrentplaytime: function () {},
      // Adaptive streams switch quality as bandwidth changes; remember the bitrate for info().
      onevent: function (type, data) {
        if (type !== 'PLAYER_MSG_BITRATE_CHANGE') return;
        var m = /(\d+)/.exec(data || ''), br = m ? parseInt(m[1], 10) : 0;
        if (c.bitrate && br !== c.bitrate) c.switched = true;
        c.bitrate = br;
      },
      onerror: function (err) { fail(c, String(err)); }
    };
  }

  // Times the first frame: the moment the player's clock moves.
  function watchFrame(c, T, t0) {
    var first = -1, polls = 0;
    (function poll() {
      if (c !== cur || ++polls > FRAME_POLLS) return;
      var now;
      try { now = av.getCurrentTime(); } catch (err) { return; }
      if (first < 0) first = now;
      else if (now !== first) { T.frame = Date.now() - t0; return; }
      setTimeout(poll, FRAME_POLL_MS);
    })();
  }

  function begin(c, T, t0) {
    var done = false, at = c.tok === token ? startAt : 0;
    function start() {
      if (done || c !== cur) return;
      done = true;
      try {
        av.play();
        c.started = true;
        T.play = Date.now() - t0;
        emit(c, 'playing');
        watchFrame(c, T, t0);
      } catch (err) { fail(c, err.message || String(err)); }
    }
    if (at > 0) {   // resume: seek while ready, then play
      try { av.seekTo(at, start, start); setTimeout(start, SEEK_WAIT_MS); return; } catch (err) { /* start from the beginning */ }
    }
    start();
  }

  function applyDisplay() {
    try {
      av.setDisplayRect(RECT[0], RECT[1], RECT[2], RECT[3]);
      av.setDisplayMethod(MODES[mode()]);
    } catch (err) { /* not open */ }
  }

  function playAv(my, url, ua, t0) {
    var T = { wait: Date.now() - t0, closed: 0, opened: 0, prepared: 0, play: 0, frame: 0 };
    var c = { tok: my, url: url, ready: false, started: false, bitrate: 0, switched: false };
    lastStart = T;
    closeCurrent();
    T.closed = Date.now() - t0;
    cur = c;
    try {
      if (!av) av = webapis.avplay;
      av.open(url);
      if (ua) { try { av.setStreamingProperty('USER_AGENT', ua); } catch (err) { /* optional */ } }
      // UHD mode, set between open and prepare. Single-quality 4K streams play at 3840x2160 without it
      // (tested on the TV 2026-11-07); Samsung's docs require it for adaptive streams to pick UHD variants.
      try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (err) { /* not a UHD model */ }
      try { av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', START_BUFFER_S); } catch (err) { /* optional */ }
      av.setListener(listener(c));
      applyDisplay();
      T.opened = Date.now() - t0;
      hangTimer = setTimeout(function () { if (!c.ready) hung(c); }, PREPARE_MS);
      av.prepareAsync(function () {
        if (c !== cur) return;
        applyDisplay();   // again once the stream is known: set before prepare, it does not always hold
        c.ready = true;
        clearTimeout(hangTimer);
        T.prepared = Date.now() - t0;
        begin(c, T, t0);
      }, function (err) { fail(c, String(err)); });
    } catch (err) {
      fail(c, err.message || 'Player not available');
    }
  }

  /* ---------- browser ---------- */

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

  /* ---------- play and stop ---------- */

  // Reports 'loading' at once, lets the page paint it, then swaps streams.
  // opts.aspect 'auto' | 'fit' | 'fill': this play's own display mode (movies, episodes) instead of the Fit/Fill setting.
  function play(url, ua, startMs, opts) {
    token++;
    startAt = startMs > 0 ? startMs : 0;
    own = opts && MODES[opts.aspect] ? opts.aspect : '';
    vid.classList.toggle('fill', mode() === 'fill');
    var my = token, now = Date.now();
    clearTimeout(pending);
    onState('loading', '');
    function go() {
      if (my !== token) return;
      if (native) playAv(my, url, ua, now);
      else { vid.pause(); playHtml(url, startAt); }
    }
    // Fast zaps wait a moment so channels passed over are never opened.
    if (now - lastPlay < ZAP_GAP_MS) pending = setTimeout(go, ZAP_WAIT_MS);
    else requestAnimationFrame(function () { pending = setTimeout(go, 0); });
    lastPlay = now;
  }

  function stop() {
    token++;
    startAt = 0;
    clearTimeout(pending);
    if (native) closeCurrent();
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
    if (!cur) return;
    if (!cur.started) { startAt = ms; return; }
    try { var d = av.getDuration(); if (d > 0) ms = Math.min(ms, Math.max(0, d - 500)); } catch (e) { /* unknown length */ }
    try { av.seekTo(ms, function () {}, function () {}); } catch (e) { /* not seekable */ }
  }

  function pause() {
    if (!native) { vid.pause(); return; }
    if (cur && cur.started) { try { av.pause(); } catch (e) { /* not playing */ } }
  }

  function resume() {
    if (!native) { var p = vid.play(); if (p && p.catch) p.catch(function () { /* reported through onerror */ }); return; }
    if (cur && cur.started) { try { av.play(); } catch (e) { /* not paused */ } }
  }

  function paused() {
    if (!native) return vid.paused;
    try { return !!cur && av.getState() === 'PAUSED'; } catch (e) { return false; }
  }

  function mode() { return own || aspect; }

  // Changes the current play's own display mode ('auto' | 'fit' | 'fill'). Returns the mode in use.
  function setPlayAspect(m) {
    own = MODES[m] ? m : '';
    vid.classList.toggle('fill', mode() === 'fill');
    if (cur) applyDisplay();
    return mode();
  }

  function setAspect(m) {
    aspect = ASPECTS[m] ? m : 'fit';
    vid.classList.toggle('fill', mode() === 'fill');
    if (cur) applyDisplay();
    return aspect;
  }

  /* ---------- info ---------- */

  // Position, duration (ms; 0 for live), video size and the timing of the last start.
  // Also used by tools/tvdebug.py.
  function info() {
    var out = { native: native, time: 0, duration: 0, width: 0, height: 0, aspect: mode() };
    if (!native) {
      out.time = Math.round(vid.currentTime * 1000);
      out.duration = isFinite(vid.duration) ? Math.round(vid.duration * 1000) : 0;
      out.width = vid.videoWidth;
      out.height = vid.videoHeight;
      return out;
    }
    out.start = lastStart;
    if (!cur) { out.state = 'NONE'; return out; }
    try { out.state = av.getState(); } catch (e) { out.state = 'ERR ' + e.message; }
    try { out.time = av.getCurrentTime(); } catch (e) { /* not playing */ }
    try { out.duration = av.getDuration(); } catch (e) { /* live or not ready */ }
    try { out.tracks = av.getCurrentStreamInfo(); } catch (e) { /* not ready */ }
    var size = videoSize(cur, out.tracks);
    if (size) { out.width = size.w; out.height = size.h; }
    out.bitrate = cur.bitrate;
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
  function videoSize(c, current) {
    var now = null;
    (current || []).forEach(function (t) { if (t.type === 'VIDEO') now = trackSize(t); });
    if (!c.switched || !now) return now;
    var list = variants[c.url];
    if (!list) { fetchVariants(c.url); return now; }
    var best = null;
    list.forEach(function (s) { if (!best || Math.abs(s.br - c.bitrate) < Math.abs(best.br - c.bitrate)) best = s; });
    return best || now;
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
    info: info,
    setAspect: setAspect,
    setPlayAspect: setPlayAspect,
    onState: function (fn) { onState = fn; }
  };
})();
