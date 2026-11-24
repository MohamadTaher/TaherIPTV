/* Runs app/js/player.js on this PC against a fake TV player and a fake clock.

     node tools/playersim.js [path to player.js]

   Checks the rules the player must keep on the TV: one stream open at a time, the old one closed
   before the new one opens, channels passed over in a fast zap never opened (the first press
   starts at once), late answers from an
   old stream ignored, and a failed or stuck start closed so the connection is free again. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');

var file = process.argv[2] || path.join(__dirname, '..', 'app', 'js', 'player.js');
var failures = 0;

function check(ok, what) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + what);
}

// A fresh player module, fake TV and fake clock for every scenario.
function world() {
  var now = 1000000, timers = [], seq = 0, log = [], states = [], players = [];

  function setTimeout_(fn, ms) { timers.push({ id: ++seq, at: now + (ms || 0), fn: fn }); return seq; }
  function clearTimeout_(id) { timers = timers.filter(function (t) { return t.id !== id; }); }
  function run(ms) {
    var end = now + ms;
    for (;;) {
      var next = null;
      timers.forEach(function (t) { if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t; });
      if (!next) break;
      clearTimeout_(next.id);
      now = Math.max(now, next.at);
      next.fn();
    }
    now = Math.max(now, end);
  }

  function fakePlayer(name) {
    var p = { name: name, state: 'NONE', url: '', playedAt: 0, listener: null };
    function say(what) { log.push(name + ' ' + what); }
    p.getState = function () { return p.state; };
    p.open = function (url) {
      if (p.state !== 'NONE') throw new Error('INVALID_STATE');
      var others = players.filter(function (x) { return x !== p && x.state !== 'NONE'; });
      say('open ' + url + (others.length ? ' WHILE-OTHER-OPEN' : ''));
      p.state = 'IDLE'; p.url = url; p.playedAt = 0;
    };
    p.setStreamingProperty = function () {};
    p.setBufferingParam = function () {};
    p.setDisplayRect = function () {};
    p.displays = [];   // 'STATE:mode' for every display mode set
    p.setDisplayMethod = function (m) { p.displays.push(p.state + ':' + m.replace('PLAYER_DISPLAY_MODE_', '')); };
    p.setListener = function (l) { p.listener = l; };
    // 'slow' takes 3 s, 'bad' fails, 'hang' never answers. An answer still arrives after a close:
    // the worst case, which the player must ignore.
    p.prepareAsync = function (ok, err) {
      var url = p.url;
      say('prepare ' + url);
      if (/hang/.test(url)) return;
      setTimeout_(function () {
        if (/bad/.test(url)) { err('PLAYER_ERROR_CONNECTION_FAILED'); return; }
        if (p.url === url && p.state === 'IDLE') p.state = 'READY';
        ok();
      }, /slow/.test(url) ? 3000 : 500);
    };
    p.seekTo = function (ms, ok) { say('seek ' + ms); setTimeout_(ok, 100); };
    p.play = function () {
      if (p.state !== 'READY' && p.state !== 'PAUSED') throw new Error('INVALID_STATE');
      say('play ' + p.url); p.state = 'PLAYING'; p.playedAt = now;
    };
    p.pause = function () { p.state = 'PAUSED'; };
    p.stop = function () { now += 200; say('stop'); p.state = 'IDLE'; };          // blocks, as on the TV
    p.close = function () { now += 100; say('close'); p.state = 'NONE'; p.url = ''; };
    p.getCurrentTime = function () { return p.state === 'PLAYING' ? Math.max(0, now - p.playedAt - 150) : 0; };
    p.getDuration = function () { return 0; };
    p.getCurrentStreamInfo = function () { return []; };
    players.push(p);
    return p;
  }

  var main = fakePlayer('main');
  var ctx = {
    document: { getElementById: function () { return { classList: { toggle: function () {} } }; } },
    webapis: {
      avplay: main,
      avplaystore: { getPlayer: function () { if (players.length >= 4) throw new Error('none left'); return fakePlayer('spare' + players.length); } }
    },
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    requestAnimationFrame: function (fn) { return setTimeout_(fn, 16); },
    Date: { now: function () { return now; } },
    XMLHttpRequest: function () {}, localStorage: { getItem: function () { return null; }, setItem: function () {} }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nthis.Player = Player;', ctx);
  ctx.Player.onState(function (s, d) { states.push(d ? s + ':' + d : s); });
  return {
    P: ctx.Player, run: run, log: log, states: states, players: players,
    open: function () { return players.filter(function (p) { return p.state !== 'NONE'; }); },
    opened: function (url) { return log.filter(function (l) { return l.indexOf(' open ' + url) !== -1; }).length; },
    plays: function () { return log.filter(function (l) { return / play /.test(l); }); }
  };
}

function neverTwo(w) { return !w.log.some(function (l) { return /WHILE-OTHER-OPEN/.test(l); }); }

console.log('1. a channel starts');
(function () {
  var w = world();
  w.P.play('A');
  w.run(2000);
  var s = w.P.info().start;
  check(w.states.join(',') === 'loading,playing', 'states are loading then playing (got ' + w.states.join(',') + ')');
  check(w.log.join(' | ') === 'main open A | main prepare A | main play A', 'open, prepare, play in that order');
  check(s && s.frame > 0 && s.frame >= s.play && s.play >= s.prepared && s.prepared >= s.opened && s.opened >= s.closed,
    'info().start times every step: ' + JSON.stringify(s));
  check(w.P.info().state === 'PLAYING', 'info() reports PLAYING');
})();

console.log('2. changing channel closes the old stream first');
(function () {
  var w = world();
  w.P.play('A'); w.run(3000);
  w.P.play('B'); w.run(3000);
  var i = w.log.indexOf('main close'), j = w.log.indexOf('main open B');
  check(i !== -1 && j !== -1 && i < j, 'A is closed before B is opened');
  check(neverTwo(w), 'never two streams open at once');
  check(w.open().length === 1 && w.open()[0].url === 'B', 'only B is open at the end');
  check(w.P.info().start.closed >= 300, 'the blocking close is counted in the timing (' + w.P.info().start.closed + ' ms)');
})();

console.log('3. a fast zap skips the channels passed over');
(function () {
  var w = world();
  w.P.play('A'); w.run(3000);
  w.P.play('B'); w.run(100); w.P.play('C'); w.run(100); w.P.play('D'); w.run(3000);
  check(w.opened('B') === 1, 'B, the first press, starts at once');
  check(w.opened('C') === 0, 'C, passed over, was never opened');
  check(w.opened('D') === 1 && w.plays().pop() === 'main play D', 'D was opened once and plays');
  check(neverTwo(w), 'never two streams open at once');
})();

console.log('4. a late answer from the old stream is ignored');
(function () {
  var w = world();
  w.P.play('slow'); w.run(1000);
  w.P.play('B'); w.run(5000);
  check(w.plays().join(',') === 'main play B', 'only B was played (got ' + w.plays().join(',') + ')');
  check(w.states.join(',') === 'loading,loading,playing', 'one playing state, for B (got ' + w.states.join(',') + ')');
  var v = world();
  v.P.play('slow'); v.run(1000);
  v.P.play('hang'); v.run(20000);
  check(v.states.join(',') === 'loading,loading,error:Timed out connecting to the stream',
    'it does not cancel the timeout of the new stream (got ' + v.states.join(',') + ')');
})();

console.log('5. a failed start reports an error and frees the connection');
(function () {
  var w = world();
  w.P.play('bad'); w.run(2000);
  check(/^loading,error:/.test(w.states.join(',')), 'error reported (got ' + w.states.join(',') + ')');
  check(w.open().length === 0, 'nothing left open');
  w.P.play('B'); w.run(2000);
  check(w.plays().pop() === 'main play B', 'the next channel plays');
})();

console.log('6. a start that never answers times out and the next one gets another player');
(function () {
  var w = world();
  w.P.play('hang'); w.run(14000);
  check(w.states.join(',') === 'loading', 'still loading at 14 s');
  w.run(2000);
  check(w.states.join(',') === 'loading,error:Timed out connecting to the stream', 'timed out (got ' + w.states.join(',') + ')');
  check(w.open().length === 0, 'the stuck stream was closed');
  w.P.play('B'); w.run(2000);
  check(w.plays().pop() === 'spare1 play B', 'B plays on a different player (got ' + w.plays().pop() + ')');
  check(neverTwo(w), 'never two streams open at once');
})();

console.log('7. stop closes the stream and late answers do nothing');
(function () {
  var w = world();
  w.P.play('slow'); w.run(1000);
  w.P.stop(); w.run(5000);
  check(w.states.join(',') === 'loading,idle', 'loading then idle (got ' + w.states.join(',') + ')');
  check(w.open().length === 0 && w.plays().length === 0, 'closed, never played');
})();

console.log('8. a movie resumes from its saved position');
(function () {
  var w = world();
  w.P.play('movie', '', 60000); w.run(2000);
  var i = w.log.indexOf('main seek 60000'), j = w.log.indexOf('main play movie');
  check(i !== -1 && j !== -1 && i < j, 'seeks to 60 s before playing');
})();

console.log('9. movies show the stream\'s own aspect ratio; live channels follow Fit/Fill');
(function () {
  var w = world();
  w.P.setAspect('fill');
  w.P.play('movie', '', 0, { aspect: 'auto' }); w.run(2000);
  var p = w.open()[0], d = p.displays;
  check(d[d.length - 1] === 'READY:AUTO_ASPECT_RATIO', 'auto is set again once the stream is ready (got ' + d.join(',') + ')');
  w.P.setAspect('fit');
  check(p.displays[p.displays.length - 1] === 'PLAYING:AUTO_ASPECT_RATIO', 'the Fit/Fill toggle does not change a movie (got ' + p.displays.slice(-1) + ')');
  check(w.P.info().aspect === 'auto', 'info() reports auto (got ' + w.P.info().aspect + ')');
  w.P.play('live'); w.run(2000);
  var q = w.open()[0];
  check(q.displays[q.displays.length - 1] === 'READY:LETTER_BOX', 'a live channel after it uses Fit again (got ' + q.displays.join(',') + ')');
  w.P.setAspect('fill');
  check(q.displays[q.displays.length - 1] === 'PLAYING:FULL_SCREEN', 'Fill applies to the live channel (got ' + q.displays.slice(-1) + ')');
})();

console.log('10. a movie\'s own mode changes while it plays and does not touch the live setting');
(function () {
  var w = world();
  w.P.setAspect('fit');
  w.P.play('movie', '', 0, { aspect: 'fill' }); w.run(2000);
  var p = w.open()[0];
  check(p.displays[p.displays.length - 1] === 'READY:FULL_SCREEN', 'a movie can start in Fill (got ' + p.displays.join(',') + ')');
  check(w.P.setPlayAspect('auto') === 'auto', 'setPlayAspect returns the mode in use');
  check(p.displays[p.displays.length - 1] === 'PLAYING:AUTO_ASPECT_RATIO', 'Original applies at once (got ' + p.displays.slice(-1) + ')');
  w.P.play('live'); w.run(2000);
  var q = w.open()[0];
  check(q.displays[q.displays.length - 1] === 'READY:LETTER_BOX', 'live keeps its own Fit setting (got ' + q.displays.join(',') + ')');
})();

console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
