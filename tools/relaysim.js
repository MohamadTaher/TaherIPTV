/* Runs app/service/relay.js on this PC against a fake one-connection IPTV server and checks that every
   player gets one continuous stream:  node tools/relaysim.js   (about 45 s; exit code 1 if a check fails)

   The fake server behaves like the real one (measured 2026-11-11): on connect it sends the last 24 s at
   once, then real time in 4 s pieces; a new connection closes the older one 300 ms later, in the middle of a packet.
   Every packet carries its own number, so a missing, repeated or damaged packet downstream is detected. */
'use strict';
var http = require('http'), path = require('path');
var relay = require(path.join(__dirname, '..', 'app', 'service', 'relay.js'));

var RELAY = 18770, UP = 18771;
var PPS = 400;            // packets per second of video (about 0.6 Mbit/s)
var BACKLOG_S = 24;
var SEG_S = 4;            // live video arrives a whole segment at a time, as from the real server
var t0 = Date.now();
var up = { conns: 0, live: [], maxAtOnce: 0, overlapMs: 0 };

function packet(k, n) {
  var b = Buffer.alloc(188);
  b[0] = 0x47; b[1] = 0x01; b[2] = k;
  if (n % 10 === 0) {       // adaptation field with the program clock
    var base = Math.round(n / PPS * 90000);
    b[3] = 0x30; b[4] = 7; b[5] = 0x10;
    b[6] = Math.floor(base / 33554432) & 0xff; b[7] = Math.floor(base / 131072) & 0xff; b[8] = Math.floor(base / 512) & 0xff;
    b[9] = Math.floor(base / 2) & 0xff; b[10] = (base % 2) << 7;
  } else b[3] = 0x10;
  b.writeUInt32BE(n, 12); b[16] = k;
  for (var j = 17; j < 188; j++) b[j] = (n * 31 + k * 7 + j) & 0xff;
  return b;
}

function liveEdge() { return Math.floor((Date.now() - t0) / 1000 / SEG_S) * SEG_S * PPS + BACKLOG_S * PPS; }

var upstream = http.createServer(function (req, res) {
  var m = /^\/live\/(\d+)\.ts$/.exec(req.url), s = /^\/s\/(\d+)\?token=\d+$/.exec(req.url);
  if (m) { res.writeHead(302, { Location: '/s/' + m[1] + '?token=' + (++up.conns) }); res.end(); return; }
  if (!s) { res.writeHead(404); res.end(); return; }
  var k = +s[1], me = { res: res, n: liveEdge() - BACKLOG_S * PPS, dead: false, timer: 0, held: Buffer.alloc(0) };
  // Newest wins: the older connection is closed shortly after, half-way through a packet.
  up.live.forEach(function (o) {
    setTimeout(function () {
      if (o.dead) return;
      o.dead = true;
      clearInterval(o.timer);
      o.res.destroy();
    }, 300);
  });
  me.k = k;
  up.live.push(me);
  up.maxAtOnce = Math.max(up.maxAtOnce, up.live.filter(function (o) { return !o.dead; }).length);
  res.useChunkedEncodingByDefault = false;
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'close' });
  function send() {
    if (me.dead) return;
    var edge = liveEdge(), parts = [];
    while (me.n < edge && parts.length < 3000) parts.push(packet(k, me.n++));   // the backlog goes out in a few big writes
    if (!parts.length) return;
    // Writes end part-way through a packet, as on a real connection, so a cut rarely falls on a packet edge.
    var out = Buffer.concat([me.held].concat(parts)), keep = (me.n * 37) % 188;
    me.held = out.slice(out.length - keep);
    res.write(out.slice(0, out.length - keep));
  }
  send();
  me.timer = setInterval(send, 50);
  res.on('close', function () { me.dead = true; clearInterval(me.timer); up.live = up.live.filter(function (o) { return o !== me; }); });
});

// A player: reads everything the relay gives it and checks the packet numbers run on without a break.
function player(cid, k) {
  var p = { cid: cid, k: k, first: -1, next: -1, packets: 0, bad: [], carry: Buffer.alloc(0), req: null, lastAt: 0 };
  var url = 'http://127.0.0.1:' + UP + '/live/' + k + '.ts';
  p.url = url;
  p.req = http.get('http://127.0.0.1:' + RELAY + '/live?c=' + cid + '&u=' + encodeURIComponent(url), function (res) {
    res.on('data', function (b) {
      p.lastAt = Date.now();
      var buf = p.carry.length ? Buffer.concat([p.carry, b]) : b, i = 0;
      for (; i + 188 <= buf.length; i += 188) {
        var n = buf.readUInt32BE(i + 12);
        if (buf[i] !== 0x47 || buf[i + 16] !== k || buf[i + 187] !== ((n * 31 + k * 7 + 187) & 0xff)) { if (p.bad.length < 5) p.bad.push('damaged packet after ' + p.next); continue; }
        if (p.first < 0) p.first = n;
        else if (n !== p.next && p.bad.length < 5) p.bad.push('expected ' + p.next + ' got ' + n + ' (' + ((n - p.next) / PPS).toFixed(1) + ' s)');
        p.next = n + 1; p.packets++;
      }
      p.carry = buf.slice(i);
    });
    res.on('error', function () {});
  });
  p.req.on('error', function () {});
  p.close = function () { p.req.destroy(); };
  p.seconds = function () { return p.packets / PPS; };
  p.behindLive = function () { return (liveEdge() - p.next) / PPS; };
  return p;
}

function get(pathname, done) {
  http.get('http://127.0.0.1:' + RELAY + pathname, function (res) {
    var t = '';
    res.on('data', function (b) { t += b; });
    res.on('end', function () { done && done(JSON.parse(t)); });
  }).on('error', function () {});
}
function watch(p) { get('/watch?c=' + p.cid + '&u=' + encodeURIComponent(p.url)); }

var failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
}
function at(s, fn) { setTimeout(fn, s * 1000); }

relay.start(RELAY);
upstream.listen(UP, '127.0.0.1', function () {
  var A, B, C, D, B2;
  // Watch channel 1 from cold: /watch first, as the app does, then the player connects.
  A = { cid: 1, url: 'http://127.0.0.1:' + UP + '/live/1.ts' };
  watch(A);
  A = player(1, 1);
  at(5, function () {
    check('watched channel started with the backlog', A.seconds() > 20, A.seconds().toFixed(1) + ' s of video');
    B = player(2, 2);      // two neighbours are pre-buffered
    C = player(3, 3);
  });
  at(17, function () {
    check('neighbour B fetched', B.seconds() > 20, B.seconds().toFixed(1) + ' s');
    check('neighbour C fetched', C.seconds() > 20, C.seconds().toFixed(1) + ' s');
    check('watched channel unbroken while the connection was lent', !A.bad.length, A.bad.join('; ') || A.packets + ' packets in order');
    check('watched channel is back near live', A.behindLive() < 1, A.behindLive().toFixed(1) + ' s behind the server');
    get('/stat', function (st) {
      var a = st.streams.filter(function (x) { return /1\.ts$/.test(x.id); })[0];
      check('reconnect was spliced, not skipped', a.splices >= 1 && a.gaps === 0, 'splices ' + a.splices + ', gaps ' + a.gaps);
    });
  });
  at(19, function () {     // switch to B, about 10 s after it was fetched
    watch(B);
    A.close();
    C.close();
    D = player(4, 4);
    B2 = player(5, 2);     // the app renews B's pre-buffer: a new fetch, the old player keeps its stream
  });
  at(34, function () {
    check('switched channel continues without a skip', !B.bad.length && B.behindLive() < 1, B.bad.join('; ') || B.behindLive().toFixed(1) + ' s behind the server');
    check('new neighbour D fetched after the switch', D.seconds() > 20 && !D.bad.length, D.seconds().toFixed(1) + ' s');
    get('/stat', function (st) {
      var b = st.streams.filter(function (x) { return /2\.ts$/.test(x.id) && x.splices; })[0];
      check('switch was spliced, not skipped', !!b && b.gaps === 0, b ? 'splices ' + b.splices + ', gaps ' + b.gaps : 'no spliced stream');
    });
  });
  at(36, function () {     // 30 s of nothing watched, then come back: too old to splice, must restart cleanly
    get('/watch?c=0');
    B.close(); D.close(); B2.close();
  });
  at(40, function () {
    check('server was left alone while nothing is watched', up.live.length === 0, up.live.length + ' connections');
    check('never two upstream connections for long', up.maxAtOnce <= 2, 'max ' + up.maxAtOnce + ' at once, ' + up.conns + ' connects in all');
    console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
    relay.stop();
    upstream.close();
    process.exit(failed ? 1 : 0);
  });
});
