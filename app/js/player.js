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
   - hosts that allow one connection (common for paid IPTV accounts) pre-buffer by taking turns.

   Taking turns (one-connection hosts): the provider's own app showed (2026-11-11) that the server sends a
   few seconds of recent video the moment a connection opens, and keeps only the newest connection. So
   pre-buffers open one at a time; each takes the connection, and the players it cut keep what they have
   buffered. The watched channel plays from its buffer meanwhile, then rejoins: the same channel is opened
   again in a spare player and the picture swaps to it, so the live connection ends up on the watched
   channel. A switch to a pre-buffered channel shows its buffered video at once and rejoins the same way.

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
  var SHARE_MAX = 2;          // channels pre-buffered on a one-connection host (one player is kept for rejoining)
  var SHARE_ROUND_MS = 3000;  // the watched channel lost the connection this long ago: start no more pre-buffers, rejoin
  var SHARE_AGE_MS = 120000;  // buffered video this old is not worth showing; dropped, not fetched again
  var SHARE_FAILS = 2;        // taking turns failed this often on a host: given up there until the app restarts
  var STALL_MS = 700;         // a cut channel buffering this long has run out of buffered video
  var REJOIN_TRIES = 2;       // rejoin attempts before the channel is simply started again
  var SWAP_MS = 1500;         // a rejoin swap keeps the old player on screen at most this long
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
  var shareFails = {};    // host -> times taking turns failed (this session)
  var conflictAt = {};    // host -> when it was found to allow one connection
  var roundDone = '';     // the pre-buffer request last served on the watched channel's host; not served twice
  var lastSwap = null;    // { ms, frames } of the last rejoin swap, for info()

  // Pool entries: { p, role: 'free'|'active'|'pre', broken, url, ready, failed, started, opened, claim,
  //                 cut, cutAt, dry, rejoin, swapped }
  // claim = token of a switch waiting for this pre-buffer to finish.
  // cut = a later open on its one-connection host took the connection; it plays out what it has buffered.
  // dry = that buffer ran out. rejoin = a pre-buffer of the watched channel itself. swapped = it took over.
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
    conflictAt[h] = Date.now();
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
    clearTimeout(e.stall);
    e.cut = false; e.cutAt = 0; e.dry = false; e.rejoin = false; e.swapped = false; e.rejoins = 0;
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
    clearTimeout(e.stall);
    e.cut = false; e.cutAt = 0; e.dry = false; e.rejoin = false; e.swapped = false; e.rejoins = 0;
    p.open(url);
    try { p.setVideoStillMode('false'); } catch (err) { /* optional */ }
    if (ua) { try { p.setStreamingProperty('USER_AGENT', ua); } catch (err) { /* optional */ } }
    // UHD mode, set between open and prepare. Single-quality 4K streams play at 3840x2160 without it
    // (tested on the TV 2026-11-07); Samsung's docs require it for adaptive streams to pick UHD variants.
    try { p.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (err) { /* not a UHD model */ }
    try { p.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', START_BUFFER_S); } catch (err) { /* optional */ }
    p.setListener({
      // Buffering before the first frame is part of 'loading'; only stalls after it are shown.
      onbufferingstart: function () {
        if (!e.started) return;
        // A cut channel that keeps buffering has played out what it had.
        if (e.cut) { clearTimeout(e.stall); e.stall = setTimeout(function () { drained(e); }, STALL_MS); }
        emitFor(e, 'buffering');
      },
      onbufferingprogress: function () {},
      onbufferingcomplete: function () { clearTimeout(e.stall); if (e.started) emitFor(e, 'playing'); },
      onstreamcompleted: function () {
        if (e.cut) { drained(e); return; }   // expected: the server closed it when a later open took the connection
        if (!lostTurn(e)) emitFor(e, 'ended');
      },
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
    var opened = e.opened, shared = !!singleHosts[host(url)];
    setTimeout(function () {
      if (e.opened !== opened || e.ready || e.failed) return;
      hung(e);
    }, role === 'pre' ? PRE_READY_MS : PREPARE_MS);
    p.prepareAsync(function () {
      if (e.opened !== opened) return;
      e.ready = true;
      e.hangs = 0;
      if (e.onReady) { var f = e.onReady; e.onReady = null; f(); }
      if (shared) setTimeout(shareStep, 0);   // its turn is over: the next pre-buffer, or the rejoin
    }, function (err) {
      if (e.opened !== opened) return;
      failed(e, String(err));
    });
    takeTurn(e);
  }

  /* ---------- taking turns on a one-connection host ---------- */

  // Opening e took the connection from every other player on its host.
  function takeTurn(e) {
    var h = host(e.url);
    if (!singleHosts[h]) return;
    pool.forEach(function (x) {
      if (x === e || x.cut || !x.url || host(x.url) !== h) return;
      x.cut = true;
      x.cutAt = Date.now();
    });
    if (active && active !== e && active.cut) setTimeout(shareStep, SHARE_ROUND_MS + 50);
  }

  // Channels to keep pre-buffered now, most likely first.
  function wanted() {
    var want = [], shared = 0;
    lastWant.forEach(function (c) {
      if (!c || !c.url || want.length >= PRE_MAX || (preFails[c.url] || 0) >= PRE_TRIES || (active && active.url === c.url)) return;
      var h = host(c.url);
      if (singleHosts[h]) {
        if ((shareFails[h] || 0) >= SHARE_FAILS || shared >= SHARE_MAX) return;
        shared++;
      }
      want.push(c);
    });
    return want;
  }

  // One step of taking turns: open the next wanted pre-buffer on a one-connection host, one at a time,
  // or, once the watched channel has been without its connection long enough, let it rejoin.
  // Runs after every request, every finished pre-buffer and on timers.
  function shareStep() {
    if (!native || storeOk === false) return;
    var a = active, ah = a && a.url ? host(a.url) : '';
    if (a && singleHosts[ah] && !a.started) return;   // the channel being started keeps the connection
    var busy = {}, rejoining = false;
    pool.forEach(function (e) {
      if (e.role !== 'pre' || !e.url) return;
      if (!e.ready && !e.failed) busy[host(e.url)] = true;
      if (e.rejoin) rejoining = true;
    });
    var want = preloadOn ? wanted().filter(function (c) { return singleHosts[host(c.url)]; }) : [];
    var key = token + '|' + want.map(function (c) { return c.url; }).join('|');
    var closed = !!a && a.cut && (a.dry || Date.now() - a.cutAt > SHARE_ROUND_MS);
    want.forEach(function (c) {
      var h = host(c.url);
      if (busy[h] || preFor(c.url)) return;
      if (h === ah && (closed || rejoining || key === roundDone)) return;
      var e = freeEntry(true);
      if (!e || storeOk !== true || e.role !== 'free') return;
      e.ua = c.ua;
      try { openOn(e, c.url, c.ua, 'pre'); busy[h] = true; } catch (err) { retire(e); }
    });
    if (a && a.cut && !busy[ah] && !rejoining) {
      roundDone = key;
      rejoin(a);
    }
  }

  // The watched channel lost its connection to a pre-buffer: open it again in a spare player and swap
  // to that one when it is ready. The new connection is the newest, so it is the one the server keeps.
  function rejoin(a) {
    a.rejoins = (a.rejoins || 0) + 1;
    var e = a.rejoins > REJOIN_TRIES ? null : (freeEntry(true) || freeEntry());
    if (e && e !== a && storeOk === true && e.role === 'free') {
      e.ua = a.ua;
      try {
        openOn(e, a.url, a.ua, 'pre');
        e.rejoin = true;
        e.onReady = function () {
          if (active !== a) { release(e); shareStep(); return; }   // the user moved on meanwhile
          e.swapped = true;
          promote(token, e);
        };
        return;
      } catch (err) { retire(e); }
    }
    startCold(token, a.url, a.ua, true);
  }

  // The watched channel played out its buffer before it could rejoin.
  function drained(e) {
    if (e !== active || e.dry) return;
    e.dry = true;
    emitFor(e, 'buffering');
    shareStep();
    var my = token;
    setTimeout(function () { if (my === token && active === e && e.dry) startCold(my, e.url, e.ua, true); }, PRE_READY_MS);
  }

  // The watched channel died although it should hold the connection, so taking turns does not work as
  // assumed on this host (some servers cut the newest connection instead). Count it, drop the
  // pre-buffers there and start the channel again on its own.
  function lostTurn(e) {
    var h = host(e.url);
    if (e !== active || e.tok !== token || !singleHosts[h] || e.retried) return false;
    var fresh = !!conflictAt[h] && Date.now() - conflictAt[h] < 2 * CONFLICT_MS;   // the host was only just found out
    var shared = e.swapped || fresh;
    pool.forEach(function (x) { if (x !== e && x.url && host(x.url) === h) shared = true; });
    if (!shared) return false;
    if (!fresh) shareFails[h] = (shareFails[h] || 0) + 1;
    pool.forEach(function (x) { if (x.role === 'pre' && !claimed(x) && host(x.url) === h) release(x); });
    startCold(token, e.url, e.ua, true);
    return true;
  }

  // A pre-buffer that lost the connection before it was ready has nothing to show.
  function dropCut(e) {
    var url = e.url, ua = e.ua, c = e.claim;
    release(e);
    if (c === token) startCold(c, url, ua);
    else setTimeout(shareStep, 0);
  }

  // A pre-buffer failed: count it, fall back if a switch was waiting on it, retry shortly.
  function preFailed(e, retirePlayer) {
    var url = e.url, ua = e.ua, claim = e.claim;
    if (!e.rejoin) preFails[url] = (preFails[url] || 0) + 1;
    if (retirePlayer) retire(e); else release(e);
    if (claim === token) startCold(claim, url, ua);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { preload(lastWant); }, PRE_RETRY_MS);
  }

  // prepareAsync never answered. A player that hangs twice in a row is retired.
  function hung(e) {
    if (e.cut && e.role === 'pre') { dropCut(e); return; }
    e.hangs = (e.hangs || 0) + 1;
    var bad = e.hangs >= 2;
    if (e.role === 'pre') { preFailed(e, bad); return; }
    var wasActive = e === active, tok = e.tok;
    if (bad) retire(e); else release(e);
    if (wasActive && tok === token) onState('error', 'Timed out connecting to the stream');
  }

  function failed(e, msg) {
    if (e.cut) {   // expected: a later open on its one-connection host took the connection
      if (e === active) drained(e);
      else if (e.role === 'pre' && !e.ready) dropCut(e);
      return;      // a ready pre-buffer keeps what it buffered
    }
    e.failed = true;
    if (e.role === 'pre') {
      // A second connection refused while this host is already playing points to a one-connection account.
      if (active && host(active.url) === host(e.url)) markSingle(host(e.url));
      preFailed(e, false);
      return;
    }
    if (e !== active) return;
    if (lostTurn(e)) return;
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
      } catch (err) {
        // A cut pre-buffer that will not play its buffered video: start the channel normally.
        if (e.cut && e.tok === token) startCold(token, e.url, e.ua, true);
        else emitFor(e, 'error', err.message || String(err));
      }
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
    var old = active, same = !!old && old !== e && old.url === e.url;
    active = e; e.role = 'active'; e.tok = my; e.retried = false; e.claim = 0; e.rejoin = false;
    // A pre-buffer that was cut plays what it buffered; it rejoins after the next pre-buffers had their turn.
    if (e.cut) { e.cutAt = Date.now(); setTimeout(shareStep, SHARE_ROUND_MS + 50); }
    try { e.p.setDisplayMethod(ASPECTS[aspect]); } catch (err) { /* keep going */ }
    // Same channel in a new player (a rejoin): the old one holds its last frame when it stops.
    if (same) { try { old.p.setVideoStillMode('true'); } catch (err) { /* optional */ } }
    begin(e);
    if (same) handOver(old, e);
    else if (old && old !== e) setTimeout(function () { if (old !== active) release(old); }, 0);
  }

  // A rejoin swap: the old player stays on screen until the new one is showing frames (its clock moves),
  // so there is no black gap between them. Closing the old one at once, as a channel change does, flickers.
  function handOver(old, e) {
    var t0 = Date.now(), first = -1, frames = false;
    (function poll() {
      var done = e !== active || Date.now() - t0 > SWAP_MS;
      if (!done) {
        try {
          var t = e.p.getCurrentTime();
          if (first < 0) first = t; else if (t > first) { done = true; frames = true; }
        } catch (err) { done = true; }
      }
      if (!done) { setTimeout(poll, 40); return; }
      lastSwap = { ms: Date.now() - t0, frames: frames };
      if (old !== active) release(old);
    })();
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
    roundDone = '';
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
    var want = wanted();
    var urls = want.map(function (c) { return c.url; });
    pool.forEach(function (e) {
      if (e.role !== 'pre' || claimed(e)) return;
      if (e.rejoin && active && active.url === e.url) return;
      var shared = !!singleHosts[host(e.url)];
      var stale = Date.now() - e.opened > (shared ? SHARE_AGE_MS : PRE_MAX_AGE_MS);
      if (urls.indexOf(e.url) === -1 || stale) release(e);
    });
    want.forEach(function (c) {
      if (singleHosts[host(c.url)] || preFor(c.url)) return;   // one-connection hosts take turns, see shareStep
      var e = freeEntry(true);
      if (!e || storeOk !== true || e.role !== 'free') return;   // without AVPlayStore the only player is the active one
      e.ua = c.ua;
      try { openOn(e, c.url, c.ua, 'pre'); } catch (err) { retire(e); }
    });
    shareStep();
  }

  function setPreload(on) {
    preloadOn = !!on;
    if (!preloadOn) pool.forEach(function (e) { if (e.role === 'pre' && !claimed(e) && !e.rejoin) release(e); });
  }

  // The account says it allows one connection (Xtream max_connections), so there is no need to find out by failing.
  function oneConnection(server) {
    var h = host(server);
    if (h && !singleHosts[h]) { markSingle(h); conflictAt[h] = 0; }
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
    // '+' ready, '~' cut (plays what it buffered), '!' ran dry, 'R' rejoining; the last path part tells channels apart.
    out.pool = pool.map(function (e) {
      return (e.broken ? 'X ' : '') + e.role + (e.ready ? '+' : '') + (e.cut ? '~' : '') + (e.dry ? '!' : '') + (e.rejoin ? 'R' : '') +
        (e.url ? ' ' + host(e.url) + ' ' + e.url.slice(e.url.lastIndexOf('/') + 1) : '');
    });
    out.shareFails = shareFails;
    out.swap = lastSwap;
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
    oneConnection: oneConnection,
    isPreloaded: function (url) { var e = native && preFor(url); return !!(e && e.ready); },
    isPreloading: function (url) { return !!(native && preFor(url)); },
    info: info,
    setAspect: setAspect,
    onState: function (fn) { onState = fn; }
  };
})();
