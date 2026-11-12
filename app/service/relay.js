/* Stream relay: a background service that turns the one connection a provider allows into several
   unbroken streams for the TV's players (js/player.js opens http://127.0.0.1:PORT/live?... instead of
   the provider's address).

   Why it works (measured on the TV, 2026-11-11, MPEG-TS over HTTP from an Xtream server):
   - the moment a connection opens, the server sends the last ~24 s of the channel at once, then real time;
   - it keeps only the newest connection per account and closes the older one about 1.5 s later;
   - the bytes are identical on every connection to the same stream server, so the end of one read can
     be found inside the next. The provider spreads connections over several stream servers that are
     about 10 s apart from each other, and a ticket for one server is refused by the others (HTTP 403).
     So on a reconnect the relay asks the provider again, up to PIN_TRIES times, until it is offered
     the server the channel was on.

   So the relay holds the single connection for the watched channel, and lends it for a few seconds at a
   time to fetch the latest ~24 s of a neighbouring channel. When the connection comes back it finds the
   exact byte where the watched stream stopped and continues from there (a splice). The player reads one
   continuous stream and never notices; it is ~24 s behind live, which is what covers the absences.
   A neighbour's fetch stays usable for about 10 s: switching to it within that time splices too.

   When the exact byte is not there, the stream clock decides at once what to do instead of waiting:
   - the new data starts after ours ended (our data was too old): continue with a skip forward;
   - same clock but other bytes (the provider sent us to another of its stream servers, which are not
     byte-identical): continue from the first packet past our clock position;
   - the other server is behind ours: wait for it to reach our position, a few seconds at most.

   Routes (all GET):
     /live?c=<client id>&u=<stream url>&ua=<user agent>   the stream, for a player
     /watch?c=<client id>&u=<stream url>&ua=..            that player is now the one on screen (c=0: none)
     /play?c=<client id>                                  it has just started showing frames
     /ping   { version, lend }   lend: a pre-buffer asked for now would be fetched soon
     /stat   state for debugging      /exit   stop the service

   Node built-ins only. Kept to old syntax: the service runtime differs per TV model year. */
'use strict';
var http = require('http'), https = require('https'), urlMod = require('url');

var VERSION = 4;
var PORT = 18769;
var MB = 1048576;

var KEEP_MAX = 64 * MB;       // most bytes kept per stream
var RETAIN_S = 26;            // seconds of the newest video always kept, so a new viewer can start TARGET_LAG_S back
var TARGET_LAG_S = 22;        // a new viewer starts this far behind the newest video held
var MARGIN_S = 6;             // video the watched channel must still have in hand when its connection returns
var QUIET_MS = 500;           // the opening burst is over after a window this long...
var QUIET_VIDEO_S = 0.75;     // ...that brought less than this much video (under 1.5x real time)...
var QUIET_BYTES = 64 * 1024;  // ...or, where the clock cannot be read, less than this much data...
var BURST_MIN = 512 * 1024;   // ...once at least this much has arrived,
var BURST_CAP_MS = 12000;     // or after this long whatever the rate
var EMPTY_GC_MS = 6000;       // a stream that never got data and has no player is dropped after this
var FRESH_MS = 6000;          // a pre-buffer request reuses a fetch this recent, otherwise it fetches again
var VALID_MS = 10000;         // a fetch older than this no longer overlaps a reconnect: switching to it would skip
var AHEAD_S = 0.5;            // new data starting this far past our end cannot overlap: skip at once
var PAST_S = 1.5;             // new data this far past our end without a byte match: another server, cut by the clock
var BEHIND_MS = 6000;         // longest wait for a server that is behind ours
var PIN_TRIES = 6;            // times the provider is asked again for the server a channel was on
var GIVE_UP = 80 * MB;        // reconnect data searched for the splice point before giving up
var SIG = 564;                // splice signature: the last three whole packets
var GC_MS = 40000;            // unused streams are dropped after this
var RETRY_MS = 500;           // pause before reconnecting after the server closed the watched stream
var MAX_FAILS = 6;            // connects in a row that may fail before the players are told
var UP_TIMEOUT_MS = 20000;

var seq = 0;
var all = [];           // every stream held
var byUrl = {};         // url -> its newest stream
var clients = {};       // client id -> client
var pins = {};          // url -> the stream server it was last served from
var watched = null;     // the stream on screen
var watchCid = 0;
var pendWatch = null;   // { cid, s }: /watch arrived before the player connected
var upS = null;         // the stream that holds (or is opening) the upstream connection
var server = null, timer = 0, started = Date.now();
var log = [];

function note(s) { log.push(((Date.now() - started) / 1000).toFixed(1) + ' ' + s); if (log.length > 200) log.shift(); }
function tag(s) { return '#' + s.id + ' ' + s.url.slice(s.url.lastIndexOf('/') + 1); }

function Stream(url, ua) {
  this.id = ++seq; this.url = url; this.ua = ua || ''; this.made = Date.now();
  this.chunks = [];      // { off, buf }: absolute offset of each piece
  this.start = 0;        // offset of the first byte still held
  this.end = 0;          // offset after the last byte
  this.phase0 = 0;       // offset of a known packet start (moves only after a gap)
  this.tail = Buffer.alloc(0);   // the last bytes, for the splice signature
  this.clients = [];
  this.need = false;     // a player waits for a fetch of this stream
  this.phase = 'idle';   // idle | conn | burst | live
  this.req = null; this.upSeq = 0;
  this.connAt = 0; this.firstAt = 0; this.lastData = 0; this.lastLive = 0;
  this.winAt = 0; this.winBytes = 0; this.winPcr = -1; this.burstBytes = 0; this.burstMs = 3000;
  this.splice = null; this.skipLeft = 0;
  this.pcrPid = -1; this.pcrLast = -1; this.idx = [];   // idx: { off, t } about every 0.5 s of video
  this.playAt = 0; this.playPcr = -1;
  this.fails = 0; this.retryAt = 0; this.dead = false; this.lastErr = '';
  this.connects = 0; this.splices = 0; this.gaps = 0;
}

/* ---------- stream data ---------- */

// Program clock of every packet that carries one: tells how many seconds of video the bytes hold.
function scanPcr(s, buf, off) {
  var i = (188 - ((off - s.phase0) % 188)) % 188;
  for (; i + 12 <= buf.length; i += 188) {
    if (buf[i] !== 0x47 || !(buf[i + 3] & 0x20) || buf[i + 4] === 0 || !(buf[i + 5] & 0x10)) continue;
    var pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    if (s.pcrPid < 0) s.pcrPid = pid; else if (pid !== s.pcrPid) continue;
    var t = (buf[i + 6] * 33554432 + buf[i + 7] * 131072 + buf[i + 8] * 512 + buf[i + 9] * 2 + (buf[i + 10] >> 7)) / 90000;
    if (s.pcrLast >= 0 && (t < s.pcrLast - 1 || t > s.pcrLast + 120)) { s.idx = []; s.playPcr = -1; s.playAt = Date.now(); }   // clock jumped
    s.pcrLast = t;
    if (!s.idx.length || t - s.idx[s.idx.length - 1].t >= 0.5) s.idx.push({ off: off + i, t: t });
    if (s.playPcr < 0 && s === watched) s.playPcr = s.idx[0].t;
  }
}

function pcrAt(s, off) {
  var t = -1;
  for (var i = 0; i < s.idx.length && s.idx[i].off <= off; i++) t = s.idx[i].t;
  return t < 0 && s.idx.length ? s.idx[0].t : t;
}

function append(s, buf) {
  if (!buf.length) return;
  scanPcr(s, buf, s.end);
  s.chunks.push({ off: s.end, buf: buf });
  s.end += buf.length;
  s.tail = buf.length >= 1024 ? buf.slice(buf.length - 1024) : Buffer.concat([s.tail, buf]).slice(-1024);
  trim(s);
  for (var i = 0; i < s.clients.length; i++) pump(s.clients[i]);
}

// Drops old bytes: what lies behind every reader and is older than RETAIN_S of video, or beyond the cap.
function trim(s) {
  var min = s.end, n = 0, keep = s.start, want = s.pcrLast - RETAIN_S;
  s.clients.forEach(function (c) { if (c.pos < min) min = c.pos; });
  for (var i = 0; i < s.idx.length && s.idx[i].t <= want; i++) keep = s.idx[i].off;
  var floor = Math.max(Math.min(min - MB, keep), s.end - KEEP_MAX);
  while (s.chunks.length > 1 && s.chunks[0].off + s.chunks[0].buf.length <= floor) { s.chunks.shift(); n++; }
  if (!n) return;
  s.start = s.chunks[0].off;
  s.clients.forEach(function (c) { c.ci = Math.max(0, c.ci - n); });
  while (s.idx.length > 1 && s.idx[1].off <= s.start) s.idx.shift();
}

// Where a new player starts reading: TARGET_LAG_S behind the newest video, on a packet start.
function startPos(s) {
  if (!s.end) return 0;
  var pos = s.start, want = s.pcrLast - TARGET_LAG_S;
  for (var i = 0; i < s.idx.length; i++) { if (s.idx[i].off >= s.start) { pos = s.idx[i].off; if (s.idx[i].t >= want) break; } }
  if (pos === s.start && (s.start - s.phase0) % 188) pos += 188 - ((s.start - s.phase0) % 188);
  return Math.min(pos, s.end);
}

function pump(c) {
  if (c.gone || c.busy) return;
  var s = c.s;
  while (c.pos < s.end) {
    while (c.ci < s.chunks.length - 1 && s.chunks[c.ci].off + s.chunks[c.ci].buf.length <= c.pos) c.ci++;
    var ch = s.chunks[c.ci];
    if (c.pos < ch.off) c.pos = ch.off;   // fell behind what is held
    var b = c.pos === ch.off ? ch.buf : ch.buf.slice(c.pos - ch.off);
    c.pos += b.length;
    if (!c.res.write(b)) {
      c.busy = true;
      c.res.once('drain', function () { c.busy = false; pump(c); });
      return;
    }
  }
}

/* ---------- upstream: one connection at a time ---------- */

function connect(s) {
  upS = s;
  var my = ++s.upSeq;
  s.connAt = Date.now(); s.firstAt = 0; s.phase = 'conn'; s.connects++; s.burstBytes = 0; s.skipLeft = 0;
  s.asked = 0; s.offered = '';
  s.splice = null;
  if (s.end > 0) {
    // Reconnecting: look for the last three whole packets we hold inside the new data and continue after them.
    var partial = (s.end - s.phase0) % 188, stop = s.tail.length - partial;
    if (stop >= SIG) s.splice = { needle: Buffer.from(s.tail.slice(stop - SIG, stop)), skip: partial, carry: null, pend: [], bytes: 0,
      first: -1, last: -1, cut: null, until: 0 };
  }
  note('connect ' + tag(s) + (s.splice ? ' (splice)' : ''));
  fetchUp(s, my, s.url, 0);
}

function fetchUp(s, my, url, hops) {
  var o = urlMod.parse(url);
  o.headers = { 'User-Agent': s.ua || 'Mozilla/5.0 (SMART-TV; Tizen) TaherIPTV', 'Accept': '*/*', 'Connection': 'close' };
  o.agent = false;
  var req = (o.protocol === 'https:' ? https : http).get(o, function (res) {
    if (my !== s.upSeq) { req.destroy(); return; }
    var code = res.statusCode;
    if (code >= 300 && code < 400 && res.headers.location && hops < 5) {
      res.resume();
      var loc = urlMod.resolve(url, res.headers.location), lo = urlMod.parse(loc), pin = pins[s.url];
      // Only on the stream server the channel was on do the bytes line up for a splice: ask again for it.
      if (s.end > 0 && pin && pin !== lo.host && s.asked < PIN_TRIES) { s.asked++; s.offered = lo.host; fetchUp(s, my, url, hops); return; }
      fetchUp(s, my, loc, hops + 1);
      return;
    }
    if (code !== 200) { res.resume(); upEnded(s, my, 'HTTP ' + code); return; }
    if (hops > 0) pins[s.url] = o.host;
    s.phase = 'burst'; s.firstAt = s.winAt = Date.now(); s.winBytes = 0; s.winPcr = s.pcrLast;
    note('  from ' + o.host + (s.asked ? ' (asked ' + s.asked + ' more times, was offered ' + s.offered + ')' : '') + ' after ' + (Date.now() - s.connAt) + ' ms');
    res.on('data', function (b) { if (my === s.upSeq) onData(s, b); });
    res.on('end', function () { upEnded(s, my, 'closed by server'); });
    res.on('error', function (e) { upEnded(s, my, String(e && e.message)); });
  });
  s.req = req;
  req.on('error', function (e) { upEnded(s, my, String(e && e.message)); });
  req.setTimeout(UP_TIMEOUT_MS, function () { req.destroy(new Error('timed out')); });
}

function onData(s, b) {
  s.lastData = Date.now(); s.fails = 0; s.winBytes += b.length; s.burstBytes += b.length;
  if (s.skipLeft) {   // the rest of a packet we already hold part of
    if (b.length <= s.skipLeft) { s.skipLeft -= b.length; return; }
    b = b.slice(s.skipLeft); s.skipLeft = 0;
  }
  if (!s.splice) { append(s, b); return; }
  var sp = s.splice, hay = sp.carry ? Buffer.concat([sp.carry, b]) : b, at = hay.indexOf(sp.needle);
  if (at < 0) {
    pendClock(s, sp, b);
    sp.pend.push(b); sp.bytes += b.length;
    sp.carry = hay.length > SIG - 1 ? hay.slice(hay.length - (SIG - 1)) : hay;
    if (sp.bytes > GIVE_UP) gap(s, 'gave up');
    else if (s.pcrLast >= 0 && sp.first >= 0) {
      if (sp.first > s.pcrLast + AHEAD_S) gap(s, 'ours too old');
      else if (sp.cut && sp.last > s.pcrLast + PAST_S) gap(s, 'other server');
    }
    return;
  }
  s.splice = null; s.splices++;
  note('  spliced ' + tag(s) + ' ' + ((sp.bytes + at) / MB).toFixed(2) + ' MB in, ' + (Date.now() - s.connAt) + ' ms after connect');
  var from = at + SIG + sp.skip;
  if (from >= hay.length) { s.skipLeft = from - hay.length; return; }
  append(s, hay.slice(from));
}

// Reads the clock of reconnect data that is still being searched, and remembers the first packet whose
// clock is past where our data ended: the place to continue from if the bytes turn out not to match.
function pendClock(s, sp, b) {
  for (var i = (188 - (sp.bytes % 188)) % 188; i + 12 <= b.length; i += 188) {
    if (b[i] !== 0x47 || !(b[i + 3] & 0x20) || b[i + 4] === 0 || !(b[i + 5] & 0x10)) continue;
    if (s.pcrPid >= 0 && (((b[i + 1] & 0x1f) << 8) | b[i + 2]) !== s.pcrPid) continue;
    var t = (b[i + 6] * 33554432 + b[i + 7] * 131072 + b[i + 8] * 512 + b[i + 9] * 2 + (b[i + 10] >> 7)) / 90000;
    if (sp.first < 0) sp.first = t;
    sp.last = t;
    if (!sp.cut && t > s.pcrLast) sp.cut = { n: sp.pend.length, i: i };
  }
}

// No byte to continue from. The stream goes on from the clock position where ours ended when the new
// data reaches that far back ('other server'), otherwise with everything that arrived (a skip or a repeat).
function gap(s, why) {
  var sp = s.splice;
  s.splice = null; s.gaps++;
  s.phase0 = s.end;
  if (why === 'other server' && sp.cut) {
    note('cut by clock ' + tag(s) + ' at ' + s.pcrLast.toFixed(2) + ' (new data from ' + sp.first.toFixed(2) + ')');
    sp.pend.forEach(function (b, n) { if (n === sp.cut.n) append(s, b.slice(sp.cut.i)); else if (n > sp.cut.n) append(s, b); });
    return;
  }
  // For diagnosis: the clock range of the new data against where our data ended.
  var first = -1, last = -1;
  sp.pend.forEach(function (b) {
    for (var i = 0; i + 12 <= b.length; i += 188) {
      if (b[i] !== 0x47 || !(b[i + 3] & 0x20) || b[i + 4] === 0 || !(b[i + 5] & 0x10)) continue;
      if ((((b[i + 1] & 0x1f) << 8) | b[i + 2]) !== s.pcrPid) continue;
      var t = (b[i + 6] * 33554432 + b[i + 7] * 131072 + b[i + 8] * 512 + b[i + 9] * 2 + (b[i + 10] >> 7)) / 90000;
      if (first < 0) first = t;
      last = t;
    }
  });
  note('gap ' + tag(s) + ' (' + why + '): ' + (sp.bytes / MB).toFixed(2) + ' MB searched, ours ended at clock ' + s.pcrLast.toFixed(2) +
    ', new data covers ' + first.toFixed(2) + ' to ' + last.toFixed(2));
  sp.pend.forEach(function (b) { append(s, b); });
}

function upEnded(s, my, why) {
  if (my !== s.upSeq) return;
  s.upSeq++; s.req = null; s.phase = 'idle'; s.splice = null;
  if (upS === s) upS = null;
  s.fails++; s.lastErr = why; s.retryAt = Date.now() + RETRY_MS;
  note('ended ' + tag(s) + ': ' + why);
  // A stream nobody could fetch, or one that keeps failing: tell its players.
  if ((s !== watched && s.end === 0 && s.fails >= 2) || s.fails > MAX_FAILS) kill(s);
  schedule();
}

function closeUp(s, why) {
  if (s.phase === 'idle') return;
  s.upSeq++;
  if (s.req) { try { s.req.destroy(); } catch (e) { /* already gone */ } }
  s.req = null; s.phase = 'idle'; s.splice = null;
  if (upS === s) upS = null;
  note('close ' + tag(s) + ' (' + why + ')');
}

function kill(s) {
  s.dead = true; s.need = false;
  closeUp(s, 'dead');
  s.clients.slice().forEach(function (c) { try { c.res.destroy(); } catch (e) { /* gone */ } });
  if (byUrl[s.url] === s) delete byUrl[s.url];
}

// Seconds of video the watched channel still has ahead of the picture.
function stock(s) {
  var now = Date.now();
  if (s.pcrLast < 0 || s.playPcr < 0) return s.phase === 'live' ? 20 : 20 - (now - (s.lastLive || s.made)) / 1000;
  return s.pcrLast - (s.playPcr + (now - s.playAt) / 1000);
}

function nextDue() {
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    if (s.need && !s.clients.length) s.need = false;
    if (s.need && !s.dead && s !== watched && Date.now() >= s.retryAt) return s;
  }
  return null;
}

// Seconds the connection is away from the watched channel for one neighbour: its fetch plus our way back.
function awayS(w) { return 2 * Math.max(2, Math.min(8, w.burstMs / 1000)); }

// Would a pre-buffer asked for now be fetched soon?
function canLend() {
  var w = watched;
  if (!w) return true;
  if (w.end === 0 || w.splice || (upS === w && w.phase !== 'live')) return false;
  return stock(w) >= MARGIN_S + awayS(w);
}

// Decides who gets the connection. Runs on every event and ten times a second.
function schedule() {
  var now = Date.now(), w = watched, f = upS, d;
  if (f && f.phase === 'burst' && now - f.winAt >= QUIET_MS) {
    // The burst is over when data arrives at about the speed of the video. While the splice point is
    // still being looked for nothing is appended, so the clock cannot tell: only silence ends it then.
    var slow = f.splice || f.pcrLast < 0 || f.winPcr < 0 ? f.winBytes < QUIET_BYTES : f.pcrLast - f.winPcr < QUIET_VIDEO_S;
    if ((slow && f.burstBytes >= BURST_MIN) || now - f.firstAt > BURST_CAP_MS) {
      f.phase = 'live'; f.burstMs = now - f.connAt; f.lastLive = now;
      // Still no place to continue from: a server that is behind ours gets a little time to catch up.
      if (f.splice && f.splice.last >= 0 && f.splice.last < f.pcrLast) f.splice.until = now + BEHIND_MS;
      else if (f.splice) gap(f, 'no match');
    }
    f.winAt = now; f.winBytes = 0; f.winPcr = f.pcrLast;
  }
  if (f && f.splice && f.splice.until && now > f.splice.until) gap(f, 'server behind');
  if (f && f.phase === 'live') f.lastLive = now;
  var away = w ? awayS(w) : 0;
  if (f) {
    if (f === w) {
      // Lend the connection only when the watched channel has video to spare.
      if (w.phase === 'live' && (d = nextDue()) && stock(w) >= MARGIN_S + away) { closeUp(w, 'lend'); connect(d); }
      return;
    }
    if (w && (w.end === 0 || stock(w) < MARGIN_S + away / 2)) {   // the watched channel needs it back now
      if (f.end > 2 * MB) f.need = false;
      closeUp(f, 'needed back');
    } else if (f.phase === 'live') {   // the neighbour's burst is in
      f.need = false;
      closeUp(f, 'fetched');
    } else return;
  }
  if (w && now < w.retryAt) return;
  if (w && (w.end === 0 || stock(w) < MARGIN_S + away)) { connect(w); return; }
  d = nextDue();
  if (d) connect(d); else if (w) connect(w);
}

function housekeeping() {
  var now = Date.now();
  if (!watched && upS && !upS.clients.length) closeUp(upS, 'idle');
  all = all.filter(function (s) {
    var idle = !s.clients.length && s !== watched && s.phase === 'idle' && !(pendWatch && pendWatch.s === s);
    if (!idle || now - Math.max(s.lastData, s.made) < (s.end ? GC_MS : EMPTY_GC_MS)) return true;
    if (byUrl[s.url] === s) delete byUrl[s.url];
    return false;
  });
  schedule();
}

/* ---------- players ---------- */

// The stream a player gets: one being fetched, one fetched recently enough, or a new fetch.
function pick(url, ua, cid) {
  if (pendWatch && pendWatch.cid === cid) return pendWatch.s;
  var s = byUrl[url], now = Date.now(), forScreen = cid === watchCid;
  if (s && !s.dead) {
    if (s.phase !== 'idle' || s === watched) return s;
    if (s.end > 0 && now - s.lastData < (forScreen ? VALID_MS : FRESH_MS)) return s;
  }
  s = new Stream(url, ua);
  s.need = true;
  byUrl[url] = s;
  all.push(s);
  return s;
}

function setWatched(s, cid) {
  var c = clients[cid];
  watched = s;
  s.need = false;
  s.playAt = Date.now();
  s.playPcr = s.idx.length ? pcrAt(s, c ? c.from : startPos(s)) : -1;
  if (upS && upS !== s) closeUp(upS, 'switch');
  note('watch ' + tag(s) + ' stock ' + stock(s).toFixed(1));
  schedule();
}

function serve(req, res, q) {
  var cid = parseInt(q.c, 10) || 0, s = pick(q.u, q.ua, cid);
  res.useChunkedEncodingByDefault = false;   // raw bytes until the connection closes, like the provider's server
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'close', 'Cache-Control': 'no-store' });
  if (res.flushHeaders) res.flushHeaders();
  var c = { res: res, s: s, cid: cid, pos: startPos(s), ci: 0, busy: false, gone: false };
  c.from = c.pos;
  s.clients.push(c);
  if (cid) clients[cid] = c;
  if (pendWatch && pendWatch.cid === cid) { pendWatch = null; if (watched === s && s.idx.length) s.playPcr = pcrAt(s, c.from); }
  function bye() {
    if (c.gone) return;
    c.gone = true;
    s.clients = s.clients.filter(function (x) { return x !== c; });
    if (clients[cid] === c) delete clients[cid];
  }
  res.on('close', bye);
  res.on('error', bye);
  if (s.dead) { res.destroy(); return; }
  pump(c);
  schedule();
}

function watch(q) {
  var cid = parseInt(q.c, 10) || 0;
  watchCid = cid;
  pendWatch = null;
  if (!cid) {
    if (watched) note('watch none');
    watched = null;
    if (upS) closeUp(upS, 'nothing watched');
    return;
  }
  var c = clients[cid], s = c ? c.s : pick(q.u, q.ua, cid);
  if (!c) pendWatch = { cid: cid, s: s };
  setWatched(s, cid);
}

// The player has started showing frames: from here its picture advances with the clock.
function playing(q) {
  var c = clients[parseInt(q.c, 10) || 0];
  if (!c || c.s !== watched) return;
  c.s.playAt = Date.now();
  c.s.playPcr = c.s.idx.length ? pcrAt(c.s, c.from) : -1;
}

function stat() {
  return {
    version: VERSION, node: process.version, up: upS ? tag(upS) : null, watched: watched ? tag(watched) : null, lend: canLend(),
    streams: all.map(function (s) {
      return {
        id: tag(s), phase: s.phase, need: s.need, clients: s.clients.length, heldMB: +((s.end - s.start) / MB).toFixed(1),
        videoS: s.idx.length ? +(s.pcrLast - s.idx[0].t).toFixed(1) : null, ageS: s.lastData ? +((Date.now() - s.lastData) / 1000).toFixed(1) : null,
        stockS: s === watched ? +stock(s).toFixed(1) : undefined, burstMs: s.burstMs,
        connects: s.connects, splices: s.splices, gaps: s.gaps, err: s.lastErr || undefined
      };
    }),
    log: log.slice(-120)
  };
}

function handle(req, res) {
  var u = urlMod.parse(req.url, true), p = u.pathname;
  if (p === '/live' && u.query.u) { serve(req, res, u.query); return; }
  var out = { ok: true, version: VERSION, lend: canLend() };
  if (p === '/watch') watch(u.query);
  else if (p === '/play') playing(u.query);
  else if (p === '/stat') out = stat();
  else if (p === '/exit') setTimeout(function () { process.exit(0); }, 50);
  else if (p !== '/ping') out = { ok: false };
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(out));
}

function start(port) {
  if (server) return server;
  server = http.createServer(handle);
  server.on('error', function (e) { note('server error ' + (e && e.message)); server = null; });
  server.listen(port || PORT, '127.0.0.1');
  var n = 0;
  timer = setInterval(function () { if (++n % 20 === 0) housekeeping(); else schedule(); }, 100);
  return server;
}

function stop() {
  clearInterval(timer);
  all.forEach(function (s) { closeUp(s, 'stop'); s.clients.slice().forEach(function (c) { try { c.res.destroy(); } catch (e) { /* gone */ } }); });
  all = []; byUrl = {}; clients = {}; watched = null; upS = null; pendWatch = null; watchCid = 0;
  if (server) { server.close(); server = null; }
}

// Tizen service entry points.
module.exports.onStart = function () { start(); };
module.exports.onRequest = function () { start(); };
module.exports.onStop = function () {};
module.exports.onExit = function () {};
// For tools/relaysim.js.
module.exports.start = start;
module.exports.stop = stop;
module.exports.VERSION = VERSION;
