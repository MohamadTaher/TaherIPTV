/* Runs app/js/player.js against a fake AVPlay and a fake one-connection IPTV server, on a virtual clock.
   Checks the turn-taking pre-buffer: node tools/playersim.js   (exit code 1 if a check fails)

   The fake server follows what the provider's own app showed (2026-11-11): on connect it sends a few
   seconds of recent video at once, and it keeps only the newest connection per account. A player whose
   connection was cut keeps playing what it has, then stalls. 'oldest' is the other policy seen in the
   wild: the newest connection is the one that gets cut. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');

var CONNECT_MS = 400;   // open -> prepared
var STOCK_MS = 8000;    // video a connection delivers at once

function world(policy, singleHost) {
  var clock = 1000000, timers = [], seq = 0, store = {}, players = [], conn = {}, states = [], stats = { maxOpening: 0, opens: 0 };
  if (singleHost) store['tiptv.singleHosts'] = JSON.stringify(singleHost);

  function setT(fn, ms) { timers.push({ at: clock + (ms || 0), id: ++seq, fn: fn }); return seq; }
  function clearT(id) { timers = timers.filter(function (t) { return t.id !== id; }); }
  function advance(ms) {
    var end = clock + ms;
    for (;;) {
      var next = null;
      timers.forEach(function (t) { if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t; });
      if (!next) break;
      clearT(next.id);
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = end;
  }
  function hostOf(url) { return /^[a-z]+:\/\/([^\/]+)/.exec(url)[1]; }
  function limited(url) { return /^one\./.test(hostOf(url)); }

  function makePlayer() {
    if (players.length >= 4) throw new Error('no more players');
    var p = { state: 'NONE', url: '', live: false, stock: 0, l: {}, gen: 0, n: players.length };
    function drop() {
      p.gen++;
      if (p.url && conn[hostOf(p.url)] === p) conn[hostOf(p.url)] = null;
      p.live = false; p.stock = 0;
    }
    // The connection is gone: a playing player runs dry after its stock, an idle one keeps the stock.
    function cut() {
      p.live = false;
      if (p.state === 'PLAYING') drain();
    }
    function drain() {
      var g = p.gen;
      setT(function () {
        if (g !== p.gen || p.live) return;
        p.dry = true;
        if (p.l.onbufferingstart) p.l.onbufferingstart();
        setT(function () { if (g === p.gen && !p.live && p.l.onstreamcompleted) p.l.onstreamcompleted(); }, 2000);
      }, p.stock);
    }
    p.cut = cut;
    p.api = {
      open: function (url) { if (p.state !== 'NONE') throw new Error('INVALID_STATE'); p.state = 'IDLE'; p.url = url; p.dry = false; stats.opens++; },
      setStreamingProperty: function () {}, setBufferingParam: function () {}, setDisplayRect: function () {}, setDisplayMethod: function () {}, setVideoStillMode: function () {},
      setListener: function (l) { p.l = l; },
      prepareAsync: function (ok) {
        var g = p.gen;
        p.opening = true;
        stats.maxOpening = Math.max(stats.maxOpening, players.filter(function (x) { return x.opening && limited(x.url); }).length);
        setT(function () {
          p.opening = false;
          if (g !== p.gen) return;
          var h = hostOf(p.url), prev = conn[h];
          p.stock = STOCK_MS; p.live = true; p.state = 'READY';
          if (limited(p.url)) {
            if (policy === 'oldest' && prev && prev !== p) setT(function () { if (g === p.gen) cut(); }, 300);
            else { conn[h] = p; if (prev && prev !== p) prev.cut(); }
          }
          ok();
        }, CONNECT_MS);
      },
      play: function () {
        if (p.state !== 'READY' && p.state !== 'PAUSED' && p.state !== 'PLAYING') throw new Error('INVALID_STATE');
        if (p.state !== 'PLAYING') p.playAt = clock;
        p.state = 'PLAYING';
        if (!p.live) drain();
      },
      pause: function () { p.state = 'PAUSED'; },
      stop: function () { drop(); p.state = 'IDLE'; },
      close: function () { drop(); p.state = 'NONE'; p.url = ''; },
      getState: function () { return p.state; },
      getCurrentTime: function () { return p.state === 'PLAYING' ? clock - p.playAt : 0; }, getDuration: function () { return 0; }, getCurrentStreamInfo: function () { return []; },
      seekTo: function (ms, ok) { ok(); }
    };
    players.push(p);
    return p.api;
  }

  var el = { classList: { toggle: function () {} }, pause: function () {}, load: function () {}, removeAttribute: function () {} };
  var box = {
    webapis: { avplaystore: { getPlayer: makePlayer } },
    document: { getElementById: function () { return el; } },
    localStorage: { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); } },
    setTimeout: setT, clearTimeout: clearT, requestAnimationFrame: function (fn) { return setT(fn, 16); },
    Date: { now: function () { return clock; } }, XMLHttpRequest: function () {}, console: console
  };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'player.js'), 'utf8'), box);
  box.Player.onState(function (s) { states.push({ at: clock, s: s }); });

  return {
    Player: box.Player, advance: advance, states: states, stats: stats,
    now: function () { return clock; },
    // The player showing the picture, and whether it still has its connection.
    playing: function () { return players.filter(function (p) { return p.state === 'PLAYING'; }); },
    holder: function (host) { return conn[host]; },
    saw: function (s, since) { return states.some(function (x) { return x.s === s && x.at >= (since || 0); }); }
  };
}

var failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
}
function ch(host, n) { return { url: 'http://' + host + '/live/u/p/' + n + '.ts', ua: '' }; }

var ONE = 'one.example:8080', MANY = 'many.example';
var single = {}; single[ONE] = true;

// 1. Watching A on a one-connection host; the next two channels get pre-buffered by taking turns.
(function () {
  var w = world('newest', single), A = ch(ONE, 1), B = ch(ONE, 2), C = ch(ONE, 3), D = ch(ONE, 4);
  w.Player.play(A.url, '');
  w.advance(2000);
  check('1 cold start plays', w.saw('playing') && w.playing().length === 1);
  w.Player.preload([B, C]);
  w.advance(12000);
  var p = w.playing();
  check('1 next channels are pre-buffered', w.Player.isPreloaded(B.url) && w.Player.isPreloaded(C.url));
  check('1 one picture, on channel A', p.length === 1 && p[0].url === A.url, p.map(function (x) { return x.url; }).join(','));
  check('1 the connection is back on the watched channel', p.length === 1 && w.holder(ONE) === p[0] && p[0].live);
  check('1 never two opens at once', w.stats.maxOpening <= 1, 'max ' + w.stats.maxOpening);
  check('1 watched channel never stalled or failed', !w.saw('buffering') && !w.saw('error'));
  var opens = w.stats.opens;
  w.Player.preload([B, C]);   // the same request again (the app repeats it when the picture resumes)
  w.advance(30000);
  check('1 the round is not repeated', w.stats.opens === opens, (w.stats.opens - opens) + ' more opens');
  check('1 still playing live after 30 s', w.playing().length === 1 && w.playing()[0].live && !w.saw('buffering'));

  // 2. Switch to pre-buffered B: instant, then B gets the connection.
  var t = w.now();
  w.Player.play(B.url, '');
  w.advance(100);
  check('2 switch to a pre-buffered channel is instant', w.saw('playing', t) && w.playing().some(function (x) { return x.url === B.url; }));
  w.Player.preload([C, D]);
  w.advance(12000);
  p = w.playing();
  check('2 one picture, on channel B', p.length === 1 && p[0].url === B.url);
  check('2 the connection is on the watched channel', p.length === 1 && w.holder(ONE) === p[0] && p[0].live);
  check('2 no stall or error after the switch', !w.saw('buffering', t) && !w.saw('error', t));
  check('2 next channel pre-buffered', w.Player.isPreloaded(D.url));

  // 3. Switch with no preload request afterwards: the channel must still get its connection back.
  t = w.now();
  w.Player.play(D.url, '');
  w.advance(15000);
  p = w.playing();
  check('3 connection returns without a preload request', p.length === 1 && p[0].url === D.url && p[0].live && w.holder(ONE) === p[0]);
  check('3 no stall or error', !w.saw('buffering', t) && !w.saw('error', t));
})();

// 4. A server that cuts the newest connection instead: no error reaches the screen, and it stops trying.
(function () {
  var w = world('oldest', single), A = ch(ONE, 1), n = 2;
  w.Player.play(A.url, '');
  w.advance(2000);
  for (var i = 0; i < 4; i++) { w.Player.preload([ch(ONE, n++), ch(ONE, n++)]); w.advance(40000); }
  var opens = w.stats.opens;
  w.Player.preload([ch(ONE, n++), ch(ONE, n++)]);
  w.advance(40000);
  var p = w.playing();
  check('4 other policy: no error shown', !w.saw('error'));
  check('4 other policy: still playing A live', p.length === 1 && p[0].url === A.url && p[0].live);
  check('4 other policy: turn-taking given up', w.stats.opens === opens, (w.stats.opens - opens) + ' more opens');
})();

// 5. A host without a limit still pre-buffers the old way, all at once.
(function () {
  var w = world('newest', single), A = ch(MANY, 1), B = ch(MANY, 2), C = ch(MANY, 3), D = ch(MANY, 4);
  w.Player.play(A.url, '');
  w.advance(2000);
  w.Player.preload([B, C, D]);
  w.advance(1000);
  check('5 unlimited host: three pre-buffers within a second', w.Player.isPreloaded(B.url) && w.Player.isPreloaded(C.url) && w.Player.isPreloaded(D.url));
  var t = w.now();
  w.Player.play(C.url, '');
  w.advance(100);
  check('5 unlimited host: instant switch', w.saw('playing', t) && !w.saw('error'));
})();

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
