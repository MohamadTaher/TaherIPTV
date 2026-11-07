/* Local storage, favourites and watch history.

   Store: JSON values under the 'tiptv.' prefix.
   Library: favourites and watch history per playlist and per kind ('live' | 'movie' | 'series').
     Items are plain objects with at least { id, name }; 'logo' or 'poster' is kept when present.
     Live ids are stream URLs, movie ids are stream ids (or URLs for M3U), series ids are series ids.
     History entries add { pos, dur, at } (ms; pos/dur are 0 for live) and, for series, the last
     episode watched as { ep: { id, title, season, num } }. */
var Store = (function () {
  'use strict';
  var P = 'tiptv.';
  return {
    get: function (k, d) {
      try { var v = localStorage.getItem(P + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) { /* storage full or unavailable */ }
    },
    del: function (k) {
      try { localStorage.removeItem(P + k); } catch (e) { /* unavailable */ }
    }
  };
})();

var Library = (function () {
  'use strict';
  var KINDS = ['live', 'movie', 'series'];
  var HISTORY_MAX = 200;
  var owner = 'default';          // playlist id; set by the app when a playlist loads
  var cache = {};

  function key(type, kind) { return type + '.' + owner + '.' + kind; }
  function load(type, kind) {
    var k = key(type, kind);
    if (!cache[k]) cache[k] = Store.get(k, type === 'fav' ? {} : []);
    return cache[k];
  }
  function save(type, kind) { Store.set(key(type, kind), cache[key(type, kind)]); }

  function slim(item) {
    var out = { id: String(item.id), name: item.name || '' };
    if (item.logo) out.logo = item.logo;
    if (item.poster) out.poster = item.poster;
    if (item.url) out.url = item.url;
    if (item.group) out.group = item.group;
    return out;
  }

  /* ---------- favourites ---------- */

  function isFav(kind, id) { return !!load('fav', kind)[String(id)]; }

  function toggleFav(kind, item) {
    var f = load('fav', kind), id = String(item.id);
    if (f[id]) delete f[id]; else f[id] = slim(item);
    save('fav', kind);
    return !!f[id];
  }

  function favs(kind) {
    var f = load('fav', kind), out = [];
    for (var id in f) if (f.hasOwnProperty(id)) out.push(f[id]);
    return out;
  }

  function clearFavs(kind) { cache[key('fav', kind)] = {}; save('fav', kind); }

  /* ---------- history ---------- */

  // Records that an item was watched (moves it to the front). pos/dur in ms, extra merged in.
  function record(kind, item, pos, dur, extra) {
    var h = load('hist', kind), id = String(item.id), e = null;
    for (var i = 0; i < h.length; i++) if (h[i].id === id) { e = h.splice(i, 1)[0]; break; }
    e = e || slim(item);
    e.pos = pos || 0;
    e.dur = dur || 0;
    e.at = Date.now();
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) e[k] = extra[k];
    h.unshift(e);
    if (h.length > HISTORY_MAX) h.length = HISTORY_MAX;
    save('hist', kind);
    return e;
  }

  function history(kind) { return load('hist', kind).slice(); }

  function entry(kind, id) {
    var h = load('hist', kind);
    for (var i = 0; i < h.length; i++) if (h[i].id === String(id)) return h[i];
    return null;
  }

  function forget(kind, id) {
    var h = load('hist', kind);
    for (var i = 0; i < h.length; i++) if (h[i].id === String(id)) { h.splice(i, 1); save('hist', kind); return; }
  }

  function clearHistory(kind) { cache[key('hist', kind)] = []; save('hist', kind); }

  // Renames saved ids (and urls) of one kind: fn(id) returns the new id, or null to keep it.
  function rekey(kind, fn) {
    var f = load('fav', kind), h = load('hist', kind), moved = false, id, to, i;
    for (id in f) {
      if (!f.hasOwnProperty(id) || !(to = fn(id))) continue;
      f[to] = f[id]; f[to].id = to; if (f[to].url) f[to].url = to;
      delete f[id]; moved = true;
    }
    if (moved) save('fav', kind);
    moved = false;
    for (i = 0; i < h.length; i++) {
      if (!(to = fn(h[i].id))) continue;
      h[i].id = to; if (h[i].url) h[i].url = to; moved = true;
    }
    if (moved) save('hist', kind);
  }

  return {
    KINDS: KINDS,
    setOwner: function (id) { owner = String(id || 'default'); cache = {}; },
    owner: function () { return owner; },
    isFav: isFav, toggleFav: toggleFav, favs: favs, clearFavs: clearFavs,
    record: record, history: history, entry: entry, forget: forget, clearHistory: clearHistory,
    rekey: rekey
  };
})();
