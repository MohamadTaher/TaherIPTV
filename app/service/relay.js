/* Stream relay: a background service that turns the one connection a provider allows into instant
   channel changes (js/player.js opens http://127.0.0.1:PORT/live?... instead of the provider's address).

   What the provider does (measured on the TV, 2026-11-11, MPEG-TS over HTTP from an Xtream server):
   - the moment a connection opens, the server sends its last ~6 MB at once (about 12 s of a 4 Mbit/s
     channel), then real time;
   - it keeps only the newest connection per account and closes the older one about 1.5 s later;
   - it spreads connections over several stream servers. On the same server the bytes are identical, so
     the end of one read can be found inside the next (a splice). The servers are 10-15 s apart from each
     other and not byte-identical, they share the stream clock, and which one you get cannot be chosen:
     a ticket for one is refused by the others, and asking again brings the same offer.

   So a reconnect is seamless only when the same server comes back, about half the time. The relay
   therefore does everything that needs the connection in the first seconds after a channel change,
   when a jump in the picture is least noticed, and never touches a settled channel again:

   1. A neighbour's first seconds of video are fetched ahead and kept: its preview. Changing to it shows
      the preview at once, however old it is.
   2. While the preview plays (or, on a cold start, while the opening burst plays), the relay fetches the
      new neighbours' previews, then connects the watched channel for good. Until that is done the player
      is fed only LEAD_S ahead of the picture, so whatever happens next shows within LEAD_S.
   3. Same server and recent enough: the live data is spliced to the preview byte-exactly, no jump.
      Otherwise the stream is cut over to the new data at once: at the same clock position if the new
      data has it (other server, no skip), else with a skip (old preview) or a short repeat.
   4. The channel is settled: it keeps the connection and plays undisturbed until the next change.

   Routes (all GET):
     /live?c=<client id>&u=<stream url>&ua=<user agent>   the stream, for a player
     /watch?c=<client id>&u=<stream url>&ua=..            that player is now the one on screen (c=0: none)
     /play?c=<client id>                                  it has just started showing frames
     /ping   { version, lend }   lend: a neighbour asked for now would be fetched
     /stat   state for debugging      /exit   stop the service

   Node built-ins only. Kept to old syntax: the service runtime differs per TV model year (Node 12 on
   Tizen 6, Node 18 on Tizen 9). */
'use strict';
var http = require('http'), https = require('https'), urlMod = require('url');

var VERSION = 5;
var PORT = 18769;
var MB = 1048576;

var KEEP_MAX = 64 * MB;       // most bytes kept per stream
var RETAIN_S = 26;            // seconds of the newest video always kept
var PREVIEW_S = 4;            // video handed to a player that is not on screen (enough for it to get ready)
var LEAD_S = 3;               // while a channel settles its player is fed this far ahead of the picture, no more
var WARM_S = 7;               // video fetched for a neighbour, or its whole opening burst if that is shorter
var NEED_S = 6.5;             // video the watched channel must have in hand to lend the connection for a fetch
var RETURN_S = 3.5;           // ...and for a fetch in progress to be allowed to finish
var MAX_FETCH = 1;            // neighbours fetched per channel change: each one delays the moment the channel settles
var ASK_MS = 900;             // after the picture starts, the player has this long to ask for neighbours
var PLAY_WAIT_MS = 4000;      // a player that never reports its picture is taken to have started by now
var QUIET_MS = 500;           // the opening burst is over after a window this long...
var QUIET_VIDEO_S = 0.75;     // ...that brought less than this much video (under 1.5x real time)...
var QUIET_BYTES = 64 * 1024;  // ...or, where the clock cannot be read, less than this much data...
var BURST_MIN = 512 * 1024;   // ...once at least this much has arrived,
var BURST_CAP_MS = 12000;     // or after this long whatever the rate
var FRESH_MS = 6000;          // a request for a neighbour reuses a fetch this recent, otherwise it fetches again
var PAST_S = 1.5;             // new data this far past our end without a byte match comes from another server
var RUNWAY_S = 4;             // when the other server is behind the picture, the video restarts this far before its end
var GIVE_UP = 40 * MB;        // reconnect data searched for the splice point before giving up
var SIG = 564;                // splice signature: the last three whole packets
var GC_MS = 40000;            // streams without a player are dropped after this
var EMPTY_GC_MS = 6000;       // ...and sooner if they never got data
var RETRY_MS = 500;           // pause before reconnecting after the server closed the watched stream; doubles
var RETRY_MAX_MS = 15000;     // while it keeps being closed (another device on the account), up to this
var MAX_FAILS = 6;            // connects in a row that may fail before the players are told
var TAKEN_DROPS = 4;          // closed this many times in a row soon after connecting: the account is in use on
                              // another device. Stop and tell the player, instead of the two fighting for it.
var UP_TIMEOUT_MS = 20000;

var seq = 0;
var all = [];           // every stream held
var byUrl = {};         // url -> its newest stream
var clients = {};       // client id -> client
var watched = null;     // the stream on screen
var watchCid = 0;
var pendWatch = null;   // { cid, s }: /watch arrived before the player connected
var upS = null;         // the stream that holds (or is opening) the upstream connection
var server = null, timer = 0, started = Date.now();
var log = [];

function note(s) { log.push(((Date.now() - started) / 1000).toFixed(1) + ' ' + s); if (log.length > 300) log.shift(); }
function tag(s) { return '#' + s.id + ' ' + s.url.slice(s.url.lastIndexOf('/') + 1); }

function Stream(url, ua) {
  this.id = ++seq; this.url = url; this.ua = ua || ''; this.made = Date.now();
  this.chunks = [];      // { off, buf }: absolute offset of each piece
  this.start = 0;        // offset of the first byte still held
  this.end = 0;          // offset after the last byte
  this.phase0 = 0;       // offset of a known packet start (moves at a cut)
  this.tail = Buffer.alloc(0);   // the last bytes, for the splice signature
  this.clients = [];
  this.need = false;     // a player waits for a fetch of this stream
  this.phase = 'idle';   // upstream: idle | conn | burst | live
  this.req = null; this.upSeq = 0;
  this.connAt = 0; this.firstAt = 0; this.lastData = 0;
  this.winAt = 0; this.winBytes = 0; this.winPcr = -1; this.burstBytes = 0;
  this.splice = null; this.skipLeft = 0;
  this.pcrPid = -1; this.pcrLast = -1; this.idx = [];   // idx: { off, t } about every 0.25 s of video
  this.flow = false;     // settled: it keeps the connection and its player is fed everything
  this.fetches = 0;      // neighbours fetched since it came on screen
  this.watchAt = 0; this.played = 0;
  this.fails = 0; this.drops = 0; this.retryAt = 0; this.dead = false; this.lastErr = ''; this.host = '';
  this.connects = 0; this.splices = 0; this.cuts = 0; this.how = '';
}

/* ---------- stream data ---------- */

function clockOf(b, i) {
  return (b[i + 6] * 33554432 + b[i + 7] * 131072 + b[i + 8] * 512 + b[i + 9] * 2 + (b[i + 10] >> 7)) / 90000;
}

// Program clock of every packet that carries one: tells how many seconds of video the bytes hold.
function scanPcr(s, buf, off) {
  var i = (188 - ((off - s.phase0) % 188)) % 188;
  for (; i + 12 <= buf.length; i += 188) {
    if (buf[i] !== 0x47 || !(buf[i + 3] & 0x20) || buf[i + 4] === 0 || !(buf[i + 5] & 0x10)) continue;
    var pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    if (s.pcrPid < 0) s.pcrPid = pid; else if (pid !== s.pcrPid) continue;
    var t = clockOf(buf, i);
    if (s.pcrLast >= 0 && (t < s.pcrLast - 1 || t > s.pcrLast + 120)) {   // the clock jumped (a cut): start afresh
      s.idx = [];
      s.clients.forEach(function (c) { c.startPcr = -1; c.from = Math.max(c.from, off + i); });
    }
    s.pcrLast = t;
    if (!s.idx.length || t - s.idx[s.idx.length - 1].t >= 0.25) s.idx.push({ off: off + i, t: t });
  }
}

// Clock of the last indexed packet at or before off (the first one if off is before them all).
function pcrAt(s, off) {
  var t = -1;
  for (var i = 0; i < s.idx.length && s.idx[i].off <= off; i++) t = s.idx[i].t;
  return t < 0 && s.idx.length ? s.idx[0].t : t;
}

// Clock of the first indexed packet at or after off.
function pcrFrom(s, off) {
  for (var i = 0; i < s.idx.length; i++) if (s.idx[i].off >= off) return s.idx[i].t;
  return -1;
}

// Offset of the first indexed packet whose clock has reached t; the end of the data if none has.
function offFor(s, t) {
  for (var i = 0; i < s.idx.length; i++) if (s.idx[i].t >= t) return s.idx[i].off;
  return s.end;
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

// Forgets everything from offset at on: video that was held but never handed to the player.
function truncate(s, at) {
  while (s.chunks.length && s.chunks[s.chunks.length - 1].off >= at) s.chunks.pop();
  var last = s.chunks[s.chunks.length - 1];
  if (last && last.off + last.buf.length > at) last.buf = last.buf.slice(0, at - last.off);
  s.end = at;
  s.idx = s.idx.filter(function (x) { return x.off < at; });
  s.pcrLast = s.idx.length ? s.idx[s.idx.length - 1].t : -1;
  s.tail = last ? last.buf.slice(-1024) : Buffer.alloc(0);
  s.clients.forEach(function (c) { c.ci = Math.min(c.ci, Math.max(0, s.chunks.length - 1)); if (c.pos > at) c.pos = at; });
}

// Where a new player starts reading: the oldest video held, on a packet start.
function startPos(s) {
  if (!s.end) return 0;
  for (var i = 0; i < s.idx.length; i++) if (s.idx[i].off >= s.start) return s.idx[i].off;
  var pos = s.start;
  if ((pos - s.phase0) % 188) pos += 188 - ((pos - s.phase0) % 188);
  return Math.min(pos, s.end);
}

// The player that shows this stream, if it is the one on screen.
function viewer(s) {
  var c = clients[watchCid];
  return c && c.s === s && !c.gone ? c : null;
}

function base(s, c) {
  if (c.startPcr < 0) c.startPcr = pcrFrom(s, c.from);
  return c.startPcr;
}

// Stream clock of the picture on screen (it started at the player's first packet and runs with the wall clock).
function pictureClock(s) {
  var c = viewer(s);
  if (!c || !s.idx.length || base(s, c) < 0) return -1;
  return c.startPcr + (s.played ? (Date.now() - s.played) / 1000 : 0);
}

// Seconds of video held ahead of the picture.
function room(s) {
  var p = pictureClock(s);
  return p < 0 || s.pcrLast < 0 ? 0 : s.pcrLast - p;
}

// How far a player may read. A settled channel's player gets everything. A player not on screen gets a
// preview. The player on screen of a channel that is still settling is kept LEAD_S ahead of its picture,
// so a cut made now is on screen within LEAD_S.
function limitFor(c) {
  var s = c.s;
  if (s.flow && s === watched) return s.end;
  if (!s.idx.length || base(s, c) < 0) return Math.min(s.end, c.from + 2 * MB);
  var onScreen = s === watched && c.cid === watchCid && s.played;
  return offFor(s, c.startPcr + (onScreen ? (Date.now() - s.played) / 1000 + LEAD_S : PREVIEW_S));
}

function pump(c) {
  if (c.gone || c.busy) return;
  var s = c.s, lim = limitFor(c);
  while (c.pos < lim && s.chunks.length) {
    while (c.ci < s.chunks.length - 1 && s.chunks[c.ci].off + s.chunks[c.ci].buf.length <= c.pos) c.ci++;
    var ch = s.chunks[c.ci];
    if (c.pos < ch.off) c.pos = ch.off;   // fell behind what is held
    if (c.pos >= ch.off + ch.buf.length) break;
    var b = c.pos === ch.off ? ch.buf : ch.buf.slice(c.pos - ch.off);
    if (c.pos + b.length > lim) b = b.slice(0, lim - c.pos);
    if (!b.length) break;
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
  s.splice = null;
  if (s.end > 0) {
    // Reconnecting: look for the last three whole packets we hold inside the new data and continue after them.
    var partial = (s.end - s.phase0) % 188, stop = s.tail.length - partial;
    s.splice = { needle: stop >= SIG ? Buffer.from(s.tail.slice(stop - SIG, stop)) : null, skip: partial, carry: null,
      pend: [], bytes: 0, first: -1, last: -1, marks: [], keys: [], done: false };
  }
  note('connect ' + tag(s) + (s.splice ? ' (to join ' + ((s.end - s.start) / MB).toFixed(1) + ' MB held)' : ''));
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
      fetchUp(s, my, urlMod.resolve(url, res.headers.location), hops + 1);
      return;
    }
    if (code !== 200) { res.resume(); upEnded(s, my, 'HTTP ' + code); return; }
    s.phase = 'burst'; s.firstAt = s.winAt = Date.now(); s.winBytes = 0; s.winPcr = s.splice ? -1 : s.pcrLast;
    note('  from ' + o.host + (s.host && s.host !== o.host ? ' (was on ' + s.host + ')' : '') + ' after ' + (Date.now() - s.connAt) + ' ms');
    s.host = o.host;
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
  var sp = s.splice;
  if (sp.needle) {
    var hay = sp.carry ? Buffer.concat([sp.carry, b]) : b, at = hay.indexOf(sp.needle);
    if (at >= 0) {
      s.splice = null; s.splices++;
      note('  spliced ' + tag(s) + ' ' + ((sp.bytes + at) / MB).toFixed(2) + ' MB in, ' + (Date.now() - s.connAt) + ' ms after connect');
      var from = at + SIG + sp.skip;
      if (from >= hay.length) s.skipLeft = from - hay.length; else append(s, hay.slice(from));
      if (s === watched) settle(s, 'spliced');
      return;
    }
    sp.carry = hay.length > SIG - 1 ? hay.slice(hay.length - (SIG - 1)) : hay;
  }
  pendClock(s, sp, b);
  sp.pend.push(b); sp.bytes += b.length;
  decide(s);
}

// Reads the clock of reconnect data that is still being searched, and notes where a cut could start:
// every packet with a clock, and every packet flagged as a random access point (a key frame).
function pendClock(s, sp, b) {
  for (var i = (188 - (sp.bytes % 188)) % 188; i + 12 <= b.length; i += 188) {
    if (b[i] !== 0x47 || !(b[i + 3] & 0x20) || b[i + 4] === 0) continue;
    var flags = b[i + 5];
    if ((flags & 0x10) && (s.pcrPid < 0 || (((b[i + 1] & 0x1f) << 8) | b[i + 2]) === s.pcrPid)) {
      var t = clockOf(b, i);
      if (sp.first < 0) sp.first = t;
      sp.last = t;
      if (!sp.marks.length || t - sp.marks[sp.marks.length - 1].t >= 0.2) sp.marks.push({ n: sp.pend.length, i: i, t: t });
    }
    if ((flags & 0x40) && sp.last >= 0) sp.keys.push({ n: sp.pend.length, i: i, t: sp.last });
  }
}

// Where in the reconnect data to start so that the clock is at t: a key frame if the stream flags them.
function markFor(sp, t) {
  var k;
  for (k = 0; k < sp.keys.length; k++) if (sp.keys[k].t >= t - 0.2) return sp.keys[k];
  for (k = 0; k < sp.marks.length; k++) if (sp.marks[k].t >= t) return sp.marks[k];
  return null;
}

// The reconnect data has no byte to continue from (yet). Decide by the clock whether to keep waiting for
// one or to cut over now. T is the clock of the last video handed to the player, E the clock where the
// video we hold ends, F..L the clock range of the new data so far.
function decide(s) {
  var sp = s.splice;
  if (!sp) return;
  if (sp.bytes > GIVE_UP) { cutOver(s, null, -1, 'gave up searching'); return; }
  if (sp.first < 0) { if (sp.bytes > 2 * MB) cutOver(s, null, -1, 'new data has no clock'); return; }
  if (s.pcrLast < 0) { cutOver(s, null, -1, 'our data has no clock'); return; }
  var c = viewer(s), E = s.pcrLast, T = c ? pcrAt(s, c.pos) : E, F = sp.first, L = sp.last;
  // Nothing in common with what we hold (it was too old): on with the new data now, at the price of a skip.
  if (F > E) { cutOver(s, null, -1, 'skip of ' + (F - T).toFixed(1) + ' s (what we held was too old)'); return; }
  // Same server: the byte to continue from comes when the new data reaches the end of ours. Keep waiting
  // unless it has gone past that point without a match, or the burst is over and it never got there:
  // then it is another server, and the clock they share says where to join.
  var past = L > E + PAST_S;
  if (!past && !sp.done) return;
  if (L < T + 1) cutOver(s, markFor(sp, L - RUNWAY_S), -1, 'repeat of ' + (T - L + RUNWAY_S).toFixed(1) + ' s (other server is behind)');
  else if (F <= T) cutOver(s, markFor(sp, T), -1, 'other server, joined at the same clock position');
  else cutOver(s, null, F, 'other server, joined at the same clock position');   // ours runs on until the new data begins
}

// Continues the stream with the reconnect data from start on. What we held but had not yet handed to the
// player is dropped, or kept up to clock keepTo when the new data only begins there.
function cutOver(s, start, keepTo, why) {
  var sp = s.splice, c = viewer(s), at = c ? c.pos : s.end;
  if (keepTo >= 0) at = Math.max(at, offFor(s, keepTo));
  s.splice = null; s.cuts++;
  note('  cut ' + tag(s) + ': ' + why + (start ? ' at clock ' + start.t.toFixed(2) : '') + ', ' + ((s.end - at) / MB).toFixed(2) +
    ' MB of ours dropped, ' + sp.keys.length + ' key frames flagged');
  if (at < s.end) truncate(s, at);
  s.phase0 = s.end;   // the new data starts on a packet edge of its own
  var a = start || { n: 0, i: 0 };
  sp.pend.forEach(function (b, n) { if (n === a.n) append(s, b.slice(a.i)); else if (n > a.n) append(s, b); });
  if (c) { c.from = at; c.startPcr = -1; }
  if (s.played) s.played = Date.now();
  if (s === watched) settle(s, why.split(' (')[0]);
}

// The watched channel has its connection for good.
function settle(s, how) {
  if (s.flow) return;
  s.flow = true; s.how = how;
  note('settled ' + tag(s) + ': ' + how + ', ' + ((Date.now() - s.watchAt) / 1000).toFixed(1) + ' s after it came on screen');
  s.clients.forEach(pump);
}

function upEnded(s, my, why) {
  if (my !== s.upSeq) return;
  var now = Date.now();
  s.upSeq++; s.req = null; s.phase = 'idle'; s.splice = null;
  if (upS === s) upS = null;
  s.fails++; s.lastErr = why;
  // Closed again soon after connecting: another device is using the account. Back off instead of fighting it.
  s.drops = now - s.connAt < 20000 ? s.drops + 1 : 0;
  s.retryAt = now + Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(2, s.drops));
  note('ended ' + tag(s) + ': ' + why);
  if (s === watched && s.drops >= TAKEN_DROPS) {
    note('given up ' + tag(s) + ': the account is in use on another device');
    s.drops = 0;
    kill(s);
    schedule();
    return;
  }
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

function fetchedS(s) { return s.idx.length ? s.pcrLast - s.idx[0].t : 0; }

function nextDue() {
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    if (s.need && !s.clients.length) s.need = false;
    if (s.need && !s.dead && s !== watched && Date.now() >= s.retryAt) return s;
  }
  return null;
}

// Would a neighbour asked for now be fetched? Only while nothing is watched, or the watched channel is
// still settling and has video in hand.
function canLend() {
  var w = watched;
  if (!w) return true;
  return !w.flow && w.end > 0 && !w.splice && w.fetches < MAX_FETCH && room(w) >= NEED_S;
}

// Decides who gets the connection. Runs on every event and ten times a second.
function schedule() {
  var now = Date.now(), w = watched, f = upS, d;
  if (f && f.phase === 'burst' && now - f.winAt >= QUIET_MS) {
    // The burst is over when data arrives at about the speed of the video.
    var clock = f.splice ? f.splice.last : f.pcrLast;
    var slow = clock < 0 || f.winPcr < 0 ? f.winBytes < QUIET_BYTES : clock - f.winPcr < QUIET_VIDEO_S;
    if ((slow && f.burstBytes >= BURST_MIN) || now - f.firstAt > BURST_CAP_MS) {
      f.phase = 'live';
      if (f.splice) { f.splice.done = true; decide(f); }
    }
    f.winAt = now; f.winBytes = 0; f.winPcr = clock;
  }
  f = upS;
  if (f && f !== w && (f.phase === 'live' || fetchedS(f) >= WARM_S)) {   // a neighbour's preview is in
    f.need = false;
    closeUp(f, 'fetched ' + fetchedS(f).toFixed(1) + ' s');
    f = null;
  }
  if (!w) {
    if (!f && (d = nextDue())) connect(d);
    return;
  }
  if (w.flow) {   // settled: the connection stays with the watched channel
    if (f && f !== w) { closeUp(f, 'watched channel is settled'); f = null; }
    if (!f && now >= w.retryAt) connect(w);
    return;
  }
  // Settling: neighbours first, while the watched channel plays what it holds; then its own connection.
  var w1 = viewer(w);
  if (w1) pump(w1);
  if (f && f !== w) {
    if (room(w) >= RETURN_S) return;
    if (fetchedS(f) >= 2) f.need = false;
    closeUp(f, 'watched channel needs it back');
    f = null;
  }
  if (w.end === 0) {   // nothing to show yet: the channel itself comes first
    if (!f && now >= w.retryAt) connect(w);
    return;
  }
  d = nextDue();
  if (d && !w.splice && w.fetches < MAX_FETCH && room(w) >= NEED_S) {
    if (f === w) closeUp(w, 'lend, ' + room(w).toFixed(1) + ' s in hand');
    w.fetches++;
    connect(d);
    return;
  }
  var played = w.played || (now - w.watchAt > PLAY_WAIT_MS ? now - ASK_MS : 0);
  if (!played || now - played < ASK_MS) return;   // the player may still ask for neighbours
  if (f === w) { if (!w.splice) settle(w, 'kept its first connection'); return; }
  if (now >= w.retryAt) connect(w);
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

// The stream a player gets. For the screen: whatever is held, however old (its preview). For a
// neighbour: a fetch under way or just done, otherwise a new fetch.
function pick(url, ua, cid) {
  if (pendWatch && pendWatch.cid === cid) return pendWatch.s;
  var s = byUrl[url], now = Date.now(), forScreen = cid === watchCid;
  if (s && !s.dead) {
    if (s.phase !== 'idle' || s === watched) return s;
    if (s.end > 0 && (forScreen || now - s.lastData < FRESH_MS)) return s;
  }
  s = new Stream(url, ua);
  s.need = true;
  byUrl[url] = s;
  all.push(s);
  return s;
}

function setWatched(s) {
  watched = s;
  s.need = false; s.flow = false; s.fetches = 0; s.played = 0; s.watchAt = Date.now(); s.how = '';
  if (upS && upS !== s) closeUp(upS, 'switch');
  note('watch ' + tag(s) + (s.end ? ', preview ' + fetchedS(s).toFixed(1) + ' s, ' + ((Date.now() - s.lastData) / 1000).toFixed(0) + ' s old' : ', nothing held'));
  schedule();
}

function serve(req, res, q) {
  var cid = parseInt(q.c, 10) || 0, s = pick(q.u, q.ua, cid);
  res.useChunkedEncodingByDefault = false;   // raw bytes until the connection closes, like the provider's server
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'close', 'Cache-Control': 'no-store' });
  if (res.flushHeaders) res.flushHeaders();
  var c = { res: res, s: s, cid: cid, pos: startPos(s), ci: 0, busy: false, gone: false, startPcr: -1 };
  c.from = c.pos;
  s.clients.push(c);
  if (cid) clients[cid] = c;
  if (pendWatch && pendWatch.cid === cid) pendWatch = null;
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
  setWatched(s);
}

// The player has started showing frames: from here its picture advances with the clock.
function playing(q) {
  var c = clients[parseInt(q.c, 10) || 0];
  if (c && c.s === watched && !c.s.played) { c.s.played = Date.now(); schedule(); }
}

function stat() {
  return {
    version: VERSION, node: process.version, up: upS ? tag(upS) : null, watched: watched ? tag(watched) : null, lend: canLend(),
    streams: all.map(function (s) {
      return {
        id: tag(s), phase: s.phase, need: s.need, clients: s.clients.length, heldMB: +((s.end - s.start) / MB).toFixed(1),
        videoS: +fetchedS(s).toFixed(1), ageS: s.lastData ? +((Date.now() - s.lastData) / 1000).toFixed(1) : null,
        roomS: s === watched ? +room(s).toFixed(1) : undefined, flow: s.flow, how: s.how || undefined, host: s.host,
        connects: s.connects, splices: s.splices, cuts: s.cuts, err: s.lastErr || undefined
      };
    }),
    log: log.slice(-120)
  };
}

function handle(req, res) {
  var u = urlMod.parse(req.url, true), p = u.pathname;
  if (p === '/live' && u.query.u) { serve(req, res, u.query); return; }
  if (p === '/watch') watch(u.query);
  else if (p === '/play') playing(u.query);
  var out = p === '/stat' ? stat() : { ok: p === '/ping' || p === '/watch' || p === '/play' || p === '/exit', version: VERSION, lend: canLend() };
  if (p === '/exit') setTimeout(function () { process.exit(0); }, 50);
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
