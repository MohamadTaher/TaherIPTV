/* Runs app/service/relay.js on this PC against a fake one-connection IPTV provider and checks what each
   player is given:  node tools/relaysim.js   (about 90 s; exit code 1 if a check fails)

   The fake provider behaves like the real one (measured 2026-11-11): on connect it sends the last 12 s at
   once, then real time in 4 s pieces; a new connection closes the older one 300 ms later. In the second
   part it also hands every connection to the other of two stream servers, which are 15 s apart and not
   byte-identical, as the real provider does about half the time.

   Every packet carries its own number, so a missing, repeated or damaged packet downstream is detected.
   The rule under test: a jump in a channel's stream may only happen in the first seconds after the
   channel came on screen, at most once, and never after that. */
'use strict';
var http = require('http'), path = require('path');
var relay = require(path.join(__dirname, '..', 'app', 'service', 'relay.js'));

var RELAY = 18770, UP = 18771;
var PPS = 400;            // packets per second of video (about 0.6 Mbit/s)
var BACKLOG_S = 12, SEG_S = 4, LEAD_S = 15;
var t0 = Date.now();
var up = { conns: 0, live: [], maxAtOnce: 0, twoServers: false, flip: 0, mark: 0 };

function packet(k, n, srv) {
  var b = Buffer.alloc(188);
  b[0] = 0x47; b[1] = 0x01; b[2] = k;
  if (n % 10 === 0) {       // adaptation field with the program clock; one key frame a second
    var base = Math.round(n / PPS * 90000);
    b[3] = 0x30; b[4] = 7; b[5] = 0x10 | (n % PPS === 0 ? 0x40 : 0);
    b[6] = Math.floor(base / 33554432) & 0xff; b[7] = Math.floor(base / 131072) & 0xff; b[8] = Math.floor(base / 512) & 0xff;
    b[9] = Math.floor(base / 2) & 0xff; b[10] = (base % 2) << 7;
  } else b[3] = 0x10;
  b.writeUInt32BE(n, 12); b[16] = k; b[17] = srv;
  for (var j = 18; j < 188; j++) b[j] = (n * 31 + k * 7 + j) & 0xff;
  return b;
}

// Newest packet a server has: server 1 is LEAD_S ahead of server 0.
function liveEdge(srv) { return Math.floor((Date.now() - t0) / 1000 / SEG_S) * SEG_S * PPS + (BACKLOG_S + 30 + (srv ? LEAD_S : 0)) * PPS; }

var upstream = http.createServer(function (req, res) {
  var m = /^\/live\/(\d+)\.ts$/.exec(req.url), s = /^\/s(\d)\/(\d+)\?token=\d+$/.exec(req.url);
  if (m) {
    var to = up.twoServers ? (up.flip++ % 2) : 0;
    res.writeHead(302, { Location: '/s' + to + '/' + m[1] + '?token=' + (++up.conns) });
    res.end();
    return;
  }
  if (!s) { res.writeHead(404); res.end(); return; }
  var srv = +s[1], k = +s[2], me = { res: res, k: k, n: liveEdge(srv) - BACKLOG_S * PPS, dead: false, timer: 0, held: Buffer.alloc(0) };
  up.live.forEach(function (o) {   // newest wins
    setTimeout(function () { if (!o.dead) { o.dead = true; clearInterval(o.timer); o.res.destroy(); } }, 300);
  });
  up.live.push(me);
  up.maxAtOnce = Math.max(up.maxAtOnce, up.live.filter(function (o) { return !o.dead; }).length);
  res.useChunkedEncodingByDefault = false;
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'close' });
  function send() {
    if (me.dead) return;
    var edge = liveEdge(srv), parts = [];
    while (me.n < edge && parts.length < 3000) parts.push(packet(k, me.n++, srv));
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

function get(pathname, done) {
  http.get({ host: '127.0.0.1', port: RELAY, path: pathname, agent: false }, function (res) {
    var t = '';
    res.on('data', function (b) { t += b; });
    res.on('end', function () { if (done) done(JSON.parse(t)); });
  }).on('error', function () {});
}

// A player. It reads what the relay gives it and records every break in the packet numbers, with the
// time since it came on screen. show() does what the app does when its channel goes on screen.
function player(cid, k) {
  var p = { cid: cid, k: k, next: -1, packets: 0, breaks: [], junk: 0, carry: Buffer.alloc(0), shownAt: 0, gotData: 0, playSent: false };
  p.url = 'http://127.0.0.1:' + UP + '/live/' + k + '.ts';
  function ok(buf, i) {
    if (buf[i] !== 0x47 || buf[i + 16] !== k) return false;
    return buf[i + 187] === ((buf.readUInt32BE(i + 12) * 31 + k * 7 + 187) & 0xff);
  }
  p.open = function () {
    p.req = http.get({ host: '127.0.0.1', port: RELAY, path: '/live?c=' + cid + '&u=' + encodeURIComponent(p.url), agent: false }, function (res) {
      res.on('data', function (b) {
        if (!p.gotData) { p.gotData = Date.now(); p.started(); }
        var buf = p.carry.length ? Buffer.concat([p.carry, b]) : b, i = 0;
        while (i + 188 <= buf.length) {
          if (!ok(buf, i)) { i++; p.junk++; continue; }   // lost the packet edge: look for the next one
          var n = buf.readUInt32BE(i + 12);
          if (p.next >= 0 && n !== p.next) p.breaks.push({ ms: p.shownAt ? Date.now() - p.shownAt : -1, s: (n - p.next) / PPS });
          p.next = n + 1; p.packets++;
          i += 188;
        }
        p.carry = buf.slice(i);
      });
      res.on('error', function () {});
    });
    p.req.on('error', function () {});
    return p;
  };
  // The TV's player reports its picture about 0.4 s after it has data and is on screen.
  p.started = function () {
    if (p.playSent || !p.shownAt || !p.gotData) return;
    p.playSent = true;
    setTimeout(function () { get('/play?c=' + cid); }, 400);
  };
  p.show = function () {
    p.shownAt = Date.now();
    get('/watch?c=' + cid + '&u=' + encodeURIComponent(p.url));
    if (!p.req) p.open();
    p.started();
    return p;
  };
  p.close = function () { if (p.req) p.req.destroy(); };
  p.seconds = function () { return p.packets / PPS; };
  p.late = function () { return p.breaks.filter(function (b) { return b.ms < 0 || b.ms > 9000; }); };
  p.tell = function () { return p.breaks.map(function (b) { return (b.s > 0 ? '+' : '') + b.s.toFixed(1) + ' s at ' + (b.ms / 1000).toFixed(1) + ' s'; }).join(', ') || 'no jump'; };
  return p;
}

var failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
}
function how(st, k) {
  var s = st.streams.filter(function (x) { return new RegExp(' ' + k + '\\.ts$').test(x.id) && x.how; })[0];
  return s ? s.how : 'not settled';
}

function part(title, twoServers, done) {
  console.log('--- ' + title);
  up.twoServers = twoServers; up.flip = 0;
  relay.start(RELAY);
  var at = function (s, fn) { setTimeout(fn, s * 1000); };
  var A = player(1, 1).show(), B, D;
  at(1, function () { B = player(2, 2).open(); });   // the app asks for the next channel once A plays
  at(9, function () {
    check('neighbour B has a preview', B.seconds() >= 3 && B.seconds() <= 5.5, B.seconds().toFixed(1) + ' s');
    get('/stat', function (st) { check('A is settled within 9 s', how(st, 1) !== 'not settled', how(st, 1)); if (process.env.SIMLOG) console.log(st.log.join(' || ')); });
    B.show();          // change to B, a few seconds after its preview was fetched
    A.close();
    D = player(4, 4).open();
  });
  at(11, function () { check('B was on screen at once: its player kept getting video past the preview', B.seconds() > 4.2, B.seconds().toFixed(1) + ' s'); });
  at(24, function () {
    get('/stat', function (st) {
      check('B is settled', how(st, 2) !== 'not settled', how(st, 2));
      if (!twoServers) check('same server: B continued from its preview byte-exactly', B.breaks.length === 0 && B.junk === 0 && how(st, 2) === 'spliced', B.tell());
    });
    if (!twoServers) check('same server: A was never cut', A.breaks.length === 0 && A.junk === 0, A.tell());
    check('A: at most one jump, and only in its first seconds', A.breaks.length <= 1 && !A.late().length, A.tell());
    check('B: at most one jump, and only in its first seconds', B.breaks.length <= 1 && !B.late().length, B.tell());
    check('neighbour D has a preview', D.seconds() >= 3 && D.seconds() <= 5.5, D.seconds().toFixed(1) + ' s');
    up.mark = up.conns;
  });
  at(30, function () {
    check('settled channel is left alone: no new connections for 6 s', up.conns === up.mark, (up.conns - up.mark) + ' connects');
    check('B kept receiving video', B.seconds() > 20, B.seconds().toFixed(1) + ' s received');
    D.show();          // change to D: its preview is now about 20 s old
    B.close();
  });
  at(42, function () {
    check('D (old preview): one jump at most, in its first seconds', D.breaks.length <= 1 && !D.late().length, D.tell());
    check('D kept playing', D.seconds() > 12, D.seconds().toFixed(1) + ' s received');
    get('/watch?c=0');
    D.close();
  });
  at(44, function () {
    check('provider left alone while nothing is watched', up.live.length === 0, up.live.length + ' connections');
    check('never more than the handover of two connections', up.maxAtOnce <= 2, 'max ' + up.maxAtOnce);
    relay.stop();
    done();
  });
}

upstream.listen(UP, '127.0.0.1', function () {
  part('one stream server', false, function () {
    part('two stream servers, 15 s apart, alternating', true, function () {
      console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
      upstream.close();
      process.exit(failed ? 1 : 0);
    });
  });
});
