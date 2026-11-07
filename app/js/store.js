/* Local storage, favourites and watch history.

   Store: JSON values under the 'tiptv.' prefix.
   Library: favourites and watch history per playlist and per kind ('live' | 'movie' | 'series').
     Favourites come in three lists, 'red' | 'green' | 'blue' (movies and series use only 'red').
     A list keeps the order items were added in, and moveFav reorders it. Ids must not look like
     integers for that order to hold (live ids are URLs, so live lists can be reordered).
     Category settings per kind: { order: [category keys], hidden: { key: true } } (see app.js catKey).
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
  var LISTS = ['red', 'green', 'blue'];
  var HISTORY_MAX = 200;
  var owner = 'default';          // playlist id; set by the app when a playlist loads
  var cache = {};

  function key(type, kind, who) { return type + '.' + (who || owner) + '.' + kind; }
  function load(type, kind) {
    var k = key(type, kind);
    if (!cache[k]) cache[k] = Store.get(k, type === 'hist' ? [] : {});
    return cache[k];
  }
  // Storage type of a favourites list. 'red' keeps the original 'fav' key, so older favourites are red.
  function favType(list) { return !list || list === 'red' ? 'fav' : 'fav-' + list; }
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

  // list defaults to 'red'.
  function isFav(kind, id, list) { return !!load(favType(list), kind)[String(id)]; }

  // Lists ('red', ...) that hold the item.
  function favLists(kind, id) { return LISTS.filter(function (l) { return isFav(kind, id, l); }); }

  function toggleFav(kind, item, list) {
    var t = favType(list), f = load(t, kind), id = String(item.id);
    if (f[id]) delete f[id]; else f[id] = slim(item);
    save(t, kind);
    return !!f[id];
  }

  // Items of one list in its saved order. Without a list: every favourite of the kind, once each.
  function favs(kind, list) {
    var out = [], seen = {};
    (list ? [list] : LISTS).forEach(function (l) {
      var f = load(favType(l), kind);
      for (var id in f) if (f.hasOwnProperty(id) && !seen[id]) { seen[id] = true; out.push(f[id]); }
    });
    return out;
  }

  // Moves an item to position 'to' within its list.
  function moveFav(kind, list, id, to) {
    var t = favType(list), f = load(t, kind), ids = [], k, next = {};
    id = String(id);
    for (k in f) if (f.hasOwnProperty(k) && k !== id) ids.push(k);
    if (!f[id]) return;
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    ids.forEach(function (k2) { next[k2] = f[k2]; });
    cache[key(t, kind)] = next;
    save(t, kind);
  }

  // Without a list: clears all three.
  function clearFavs(kind, list) {
    (list ? [list] : LISTS).forEach(function (l) { cache[key(favType(l), kind)] = {}; save(favType(l), kind); });
  }

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
    var h = load('hist', kind), moved, i, to;
    LISTS.forEach(function (l) {
      var t = favType(l), f = load(t, kind), next = {}, id, changed = false;
      for (id in f) {                       // rebuilt so the list keeps its order
        if (!f.hasOwnProperty(id)) continue;
        var nid = fn(id) || id;
        next[nid] = f[id];
        if (nid !== id) { next[nid].id = nid; if (next[nid].url) next[nid].url = nid; changed = true; }
      }
      if (changed) { cache[key(t, kind)] = next; save(t, kind); }
    });
    moved = false;
    for (i = 0; i < h.length; i++) {
      if (!(to = fn(h[i].id))) continue;
      h[i].id = to; if (h[i].url) h[i].url = to; moved = true;
    }
    if (moved) save('hist', kind);
  }

  /* ---------- category order and hidden categories ---------- */

  function catPrefs(kind) { return load('cats', kind); }      // edit the object, then saveCatPrefs
  function saveCatPrefs(kind) { save('cats', kind); }

  // Deletes everything saved for a playlist.
  function dropOwner(id) {
    KINDS.forEach(function (kind) {
      LISTS.forEach(function (l) { Store.del(key(favType(l), kind, id)); });
      Store.del(key('hist', kind, id));
      Store.del(key('cats', kind, id));
    });
    cache = {};
  }

  return {
    KINDS: KINDS, LISTS: LISTS,
    setOwner: function (id) { owner = String(id || 'default'); cache = {}; },
    owner: function () { return owner; },
    isFav: isFav, favLists: favLists, toggleFav: toggleFav, favs: favs, moveFav: moveFav, clearFavs: clearFavs,
    record: record, history: history, entry: entry, forget: forget, clearHistory: clearHistory,
    catPrefs: catPrefs, saveCatPrefs: saveCatPrefs,
    rekey: rekey, dropOwner: dropOwner
  };
})();
