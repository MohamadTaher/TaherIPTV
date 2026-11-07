/* Settings screen: account details, PIN security, watch history and favourites.

   Tabs: Account | Security | Watch history | Favourites. Focus is on the tab row ('tabs') or in the
   tab's content ('content'). Rows that can be activated are collected per render in ST.acts.

   Security: a 4-digit PIN (Store 'pin' holds a hash, never the digits) and per-action locks
   (Store 'pinLocks': playlists, clear, settings). This file replaces App.guard so app.js and the other
   screens ask for the PIN through App.guard(action, fn). The PIN dialog captures every key while it
   is open, because it can appear over a screen that owns the keys (e.g. the playlists sheet). */
(function () {
  'use strict';

  var KEY = App.KEY, $ = App.$, esc = App.esc, clamp = App.clamp, toast = App.toast;
  var TABS = ['Account', 'Security', 'Watch history', 'Favourites'];
  var KINDS = [['live', 'live TV'], ['movie', 'movies'], ['series', 'series']];
  var LOCKS = [
    ['playlists', 'Ask for PIN to change playlists'],
    ['clear', 'Ask for PIN to clear history and favourites'],
    ['settings', 'Ask for PIN to open Settings']
  ];

  var ST = {
    tab: 0, zone: 'tabs', idx: 0, acts: [],
    confirm: '',        // key of the clear row waiting for a second OK
    busy: false,        // reloading the playlist
    locked: false       // waiting for the PIN to open Settings
  };

  /* ---------- PIN storage ---------- */

  function hash(pin) {
    var s = 'taher-iptv:' + pin, h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function pinOn() { return !!Store.get('pin', ''); }
  function pinOk(pin) { return hash(pin) === Store.get('pin', ''); }
  function locks() {
    var l = Store.get('pinLocks', {});
    return { playlists: !!l.playlists, clear: !!l.clear, settings: !!l.settings };
  }
  function isLocked(action) { return pinOn() && locks()[action]; }

  /* ---------- PIN dialog ---------- */

  // Pad layout, 3 columns: digits, then delete / 0 / cancel.
  var PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'cancel'];
  var D = { el: null, open: false, digits: '', pad: 4, opts: null, cb: null, busy: false };

  function dialogEl() {
    if (D.el) return D.el;
    var el = document.createElement('div');
    el.className = 'pin-modal';
    el.innerHTML = '<div class="pin-box"><h2 id="pin-title"></h2><div id="pin-sub" class="pin-sub"></div>' +
      '<div id="pin-dots" class="pin-dots"></div><div id="pin-err" class="pin-err"></div>' +
      '<div id="pin-pad" class="pin-pad"></div><div id="pin-warn" class="pin-warn"></div>' +
      '<div class="pin-hint">Number keys or the pad · OK select · BACK delete / cancel</div></div>';
    document.body.appendChild(el);
    D.el = el;
    return el;
  }

  function renderPin() {
    var dots = '', pad = '';
    for (var i = 0; i < 4; i++) {
      dots += '<div class="pin-dot' + (i < D.digits.length ? ' full' : '') + '">' + (i < D.digits.length ? '●' : '') + '</div>';
    }
    PAD.forEach(function (p, i) {
      var label = p === 'del' ? '⌫ Delete' : p === 'cancel' ? 'Cancel' : p;
      pad += '<div class="pin-key' + (p.length > 1 ? ' small' : '') + (i === D.pad ? ' sel' : '') + '">' + label + '</div>';
    });
    $('pin-dots').innerHTML = dots;
    $('pin-pad').innerHTML = pad;
  }

  // opts: { title, sub, warn, check(pin) -> bool, err }; cb(pin) gets the PIN, or null when cancelled.
  function askPin(opts, cb) {
    if (D.open) return;
    dialogEl();
    D.open = true; D.digits = ''; D.pad = 4; D.opts = opts; D.cb = cb; D.busy = false;
    $('pin-title').textContent = opts.title;
    $('pin-sub').textContent = opts.sub || '';
    $('pin-warn').textContent = opts.warn || '';
    $('pin-err').textContent = '';
    renderPin();
    D.el.classList.add('show');
    document.addEventListener('keydown', pinKey, true);
  }

  function closePin(pin) {
    document.removeEventListener('keydown', pinKey, true);
    D.open = false;
    D.el.classList.remove('show');
    var cb = D.cb;
    D.cb = null;
    if (cb) cb(pin);
  }

  function addDigit(d) {
    if (D.busy || D.digits.length >= 4) return;
    D.digits += d;
    $('pin-err').textContent = '';
    renderPin();
    if (D.digits.length < 4) return;
    D.busy = true;
    setTimeout(submitPin, 180);   // let the fourth dot show
  }

  function submitPin() {
    var pin = D.digits;
    if (!D.opts.check || D.opts.check(pin)) { closePin(pin); return; }
    D.digits = '';
    D.busy = false;
    $('pin-err').textContent = D.opts.err || 'Wrong PIN';
    renderPin();
    var dots = $('pin-dots');
    dots.classList.remove('shake');
    void dots.offsetWidth;        // restart the animation
    dots.classList.add('shake');
  }

  // Capturing handler: nothing else sees keys while the dialog is open.
  function pinKey(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (D.busy) return;
    var k = e.keyCode;
    if (k >= 96 && k <= 105) k -= 48;                            // numpad
    if (k >= 48 && k <= 57) { addDigit(String(k - 48)); return; }
    if (k === 27 || k === 8 || k === KEY.BACK) {                 // Esc, Backspace, BACK
      if (D.digits.length) { D.digits = D.digits.slice(0, -1); renderPin(); } else closePin(null);
      return;
    }
    if (k === KEY.LEFT) D.pad = D.pad % 3 ? D.pad - 1 : D.pad;
    else if (k === KEY.RIGHT) D.pad = D.pad % 3 < 2 ? D.pad + 1 : D.pad;
    else if (k === KEY.UP) D.pad = D.pad >= 3 ? D.pad - 3 : D.pad;
    else if (k === KEY.DOWN) D.pad = D.pad < 9 ? D.pad + 3 : D.pad;
    else if (k === KEY.ENTER) {
      var p = PAD[D.pad];
      if (p === 'del') { D.digits = D.digits.slice(0, -1); }
      else if (p === 'cancel') { closePin(null); return; }
      else { addDigit(p); return; }
    }
    renderPin();
  }

  // Asks for the current PIN; cb() runs only when it is right.
  function verifyPin(title, cb) {
    askPin({ title: title, sub: 'Enter your 4-digit PIN', check: pinOk }, function (pin) { if (pin) cb(); });
  }

  /* ---------- guard (replaces the no-op in app.js) ---------- */

  App.guard = function (action, fn) {
    if (!isLocked(action)) { fn(); return; }
    verifyPin('PIN required', fn);
  };

  /* ---------- PIN actions ---------- */

  // Choose and confirm a new PIN; keeps the existing locks, or turns on the sensible defaults.
  function setPin(changing) {
    askPin({
      title: changing ? 'New PIN' : 'Set a PIN', sub: 'Choose 4 digits',
      warn: 'There is no way to recover a forgotten PIN. It can only be cleared by reinstalling the app or clearing its data.'
    }, function (first) {
      if (!first) return;
      askPin({ title: 'Confirm PIN', sub: 'Enter the same 4 digits again', check: function (p) { return p === first; }, err: 'PINs do not match' }, function (second) {
        if (!second) return;
        Store.set('pin', hash(first));
        if (!changing) Store.set('pinLocks', { playlists: true, clear: true, settings: false });
        toast(changing ? 'PIN changed' : 'PIN set');
        render();
      });
    });
  }

  function removePin() {
    verifyPin('Remove PIN', function () {
      Store.del('pin');
      Store.del('pinLocks');
      toast('PIN removed');
      render();
    });
  }

  function toggleLock(action) {
    if (!pinOn()) { toast('Set a PIN first'); return; }
    var l = locks();
    if (!l[action]) { l[action] = true; Store.set('pinLocks', l); render(); return; }
    verifyPin('Turn lock off', function () { l[action] = false; Store.set('pinLocks', l); render(); });
  }

  /* ---------- history and favourites ---------- */

  function items(type, kind) { return type === 'hist' ? Library.history(kind) : Library.favs(kind); }

  function clearKind(type, kind) {
    if (type === 'hist') Library.clearHistory(kind); else Library.clearFavs(kind);
  }

  // One row per kind plus "all". The first OK arms the row, the second (after the PIN, if locked) clears.
  function clearRows(ctx, type) {
    var noun = type === 'hist' ? 'history' : 'favourites', total = 0, html = '';
    KINDS.forEach(function (kd) {
      var n = items(type, kd[0]).length;
      total += n;
      html += clearRow(ctx, type + kd[0], 'Clear ' + kd[1] + ' ' + noun, n, function () {
        clearKind(type, kd[0]);
        return n + ' ' + kd[1] + ' ' + noun + ' cleared';
      });
    });
    html += clearRow(ctx, type + 'all', 'Clear all ' + noun, total, function () {
      KINDS.forEach(function (kd) { clearKind(type, kd[0]); });
      return 'All ' + noun + ' cleared (' + total + ')';
    });
    return html;
  }

  function clearRow(ctx, key, label, n, run) {
    var armed = ST.confirm === key;
    return row(ctx, label, armed ? '<small class="warn">Press OK again to confirm</small>' : '<small>' + n + '</small>', function () {
      if (!n) { toast('Nothing to clear'); return; }
      if (!armed) { ST.confirm = key; render(); return; }
      ST.confirm = '';
      App.guard('clear', function () {
        var msg = run();
        App.refreshLive();
        toast(msg);
        render();
      });
      render();
    });
  }

  /* ---------- rows ---------- */

  // A focusable row; its action is recorded in ctx.acts at the position used for focus.
  function row(ctx, label, right, act, cls) {
    var i = ctx.acts.length;
    ctx.acts.push(act);
    var sel = ST.zone === 'content' && ST.idx === i ? ' sel' : '';
    return '<div class="st-row' + (cls ? ' ' + cls : '') + sel + '"><span>' + label + '</span>' + right + '</div>';
  }

  function kv(k, v, cls) {
    return '<div class="st-kv"><span class="k">' + k + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + v + '</span></div>';
  }

  // Host only: no scheme, no user:pass@, no path or query (links can carry credentials).
  function hostOf(url) {
    var m = /^[a-z]+:\/\/([^\/?#]+)/i.exec(url || '');
    return m ? m[1].replace(/^.*@/, '') : '—';
  }

  function version() {
    try { return tizen.application.getCurrentApplication().appInfo.version || '—'; } catch (e) { return '—'; }
  }

  /* ---------- tabs ---------- */

  function accountTab(ctx) {
    var pl = App.playlist(), d = App.data();
    if (!pl) return '<div class="st-state">No playlist yet.<br>Add one in Playlists (blue button).</div>';
    if (App.loading() && !ST.busy) return '<div class="st-state">Loading playlist…</div>';
    if (!d) return '<div class="st-state">The playlist is not loaded.</div>' + reloadButton(ctx);

    var a = d.account, left = '', right = '', note = '';
    if (a) {
      var now = Date.now(), expired = a.expiry && a.expiry < now, days = a.expiry ? Math.ceil((a.expiry - now) / 864e5) : 0;
      left = kv('Expiry date', a.expiry ? App.dayStr(a.expiry) + (expired ? ' · expired' : ' · ' + days + (days === 1 ? ' day left' : ' days left')) : 'Unlimited', expired ? 'bad' : 'amber') +
        kv('Username', esc(a.user)) +
        kv('Password', '●●●●●●●●') +
        kv('Status', esc(a.status), a.active ? 'ok' : 'bad') +
        kv('Connections', a.activeConn + ' / ' + a.maxConn);
      right = kv('Created', a.created ? App.dayStr(a.created) : '—') +
        kv('Trial', a.trial ? 'Yes' : 'No') +
        kv('Server', esc(hostOf(pl.type === 'xtream' ? pl.server : pl.url))) +
        kv('Formats', esc(a.formats.join(', ') || '—'));
    } else {
      left = kv('Playlist', esc(pl.name)) + kv('Type', pl.type === 'demo' ? 'Built-in demo' : 'M3U playlist');
      right = kv('Host', pl.type === 'demo' ? '—' : /^https?:/i.test(pl.url) ? esc(hostOf(pl.url)) : 'Bundled with the app');
      note = '<div class="st-note" style="margin:16px 0 0">Plain M3U links carry no account details such as expiry or connections.</div>';
    }
    return '<div class="st-grid"><div>' + left + '</div><div>' + right + '</div></div>' + note +
      '<div class="st-stats">' +
      stat(App.count(d.live.length), 'Live channels') + stat(App.count(d.movies.length), 'Movies') +
      stat(App.count(d.series.length), 'Series') + stat(esc(version()), 'App version') + '</div>' +
      reloadButton(ctx);
  }

  function stat(n, label) { return '<div class="st-stat"><b>' + n + '</b><span>' + label + '</span></div>'; }

  function reloadButton(ctx) {
    return row(ctx, ST.busy ? '<span><i class="st-spin"></i>Reloading…</span>' : 'Reload playlist', '', function () {
      if (ST.busy || !App.playlist()) return;
      ST.busy = true;
      render();
      var done = function () { ST.busy = false; render(); };
      App.reload().then(done, done);
    }, 'st-btn');
  }

  function securityTab(ctx) {
    var on = pinOn(), l = locks(), html = '';
    html += '<div class="st-kv" style="margin-bottom:14px"><span class="k">PIN</span><span class="v ' + (on ? 'ok' : '') + '">' + (on ? 'On' : 'Off') + '</span></div>';
    html += row(ctx, on ? 'Change PIN' : 'Set PIN', '<small>' + (on ? 'asks for the current PIN first' : '4 digits') + '</small>', function () {
      if (on) verifyPin('Current PIN', function () { setPin(true); }); else setPin(false);
    });
    if (on) html += row(ctx, 'Remove PIN', '<small>asks for the current PIN</small>', removePin);
    html += '<div class="st-label">Protect these actions</div>';
    LOCKS.forEach(function (lk) {
      var state = on && l[lk[0]];
      html += row(ctx, lk[1], '<span class="st-pill' + (state ? ' on' : '') + '">' + (state ? 'On' : 'Off') + '</span>',
        function () { toggleLock(lk[0]); }, on ? '' : 'off');
    });
    html += '<div class="st-note warn">A forgotten PIN cannot be recovered. It can only be cleared by reinstalling the app or clearing its data.</div>';
    return html;
  }

  function libraryTab(ctx, type) {
    var pl = App.playlist();
    var what = type === 'hist' ? 'Watch history' : 'Favourites';
    return '<div class="st-note">' + what + ' kept for ' + (pl ? '<b>' + esc(pl.name) + '</b>' : 'the active playlist') +
      '. Clearing needs two presses of OK' + (isLocked('clear') ? ' and your PIN' : '') + '.</div>' + clearRows(ctx, type);
  }

  /* ---------- render ---------- */

  function render() {
    var root = $('settings');
    if (!$('st-body')) build(root);
    var ctx = { acts: [] }, html;
    if (ST.locked) html = '<div class="st-state">Settings are locked.<br>Enter your PIN to continue.</div>';
    else if (ST.tab === 0) html = accountTab(ctx);
    else if (ST.tab === 1) html = securityTab(ctx);
    else html = libraryTab(ctx, ST.tab === 2 ? 'hist' : 'fav');
    ST.acts = ctx.acts;
    if (ST.idx >= ctx.acts.length) ST.idx = Math.max(0, ctx.acts.length - 1);

    var tabs = '';
    TABS.forEach(function (t, i) {
      var cls = i === ST.tab ? (ST.zone === 'tabs' ? ' on focus' : ' on dim') : '';
      tabs += '<div class="st-tab' + cls + '">' + t + '</div>';
    });
    $('st-tabs').innerHTML = tabs;
    $('st-col').innerHTML = html;
    var pl = App.playlist();
    $('st-pl').innerHTML = pl ? '<span class="k">Playlist</span>' + esc(pl.name) : '<span class="k">No playlist</span>';
    tick();
  }

  function build(root) {
    root.innerHTML = '<div class="st-head"><div class="st-title"><b>Settings</b></div>' +
      '<div class="st-right"><div id="st-pl" class="st-pl"></div><div class="st-clock"><b id="st-time"></b><span id="st-date"></span></div></div></div>' +
      '<div id="st-tabs" class="st-tabs"></div><div id="st-body" class="st-body"><div id="st-col" class="st-col"></div></div>' +
      '<div class="legend"><span><kbd>◀ ▶</kbd>Tabs</span><span><kbd>OK</kbd>Select</span>' +
      '<span><i class="dot blue"></i>Playlists</span><span><kbd>BACK</kbd>Back</span></div>';
  }

  function tick() {
    if (!$('st-time')) return;
    var now = new Date();
    $('st-time').textContent = App.hhmm(now);
    $('st-date').textContent = App.dateStr(now);
  }

  /* ---------- screen ---------- */

  function setTab(i) {
    ST.tab = clamp(i, 0, TABS.length - 1);
    ST.idx = 0;
    ST.confirm = '';
    render();
  }

  function key(e, k) {
    e.preventDefault();
    if (ST.locked) return;
    if (k === KEY.BLUE) { App.go('playlists'); return; }
    if (ST.zone === 'tabs') {
      if (k === KEY.LEFT) setTab(ST.tab - 1);
      else if (k === KEY.RIGHT) setTab(ST.tab + 1);
      else if ((k === KEY.DOWN || k === KEY.ENTER) && ST.acts.length) { ST.zone = 'content'; ST.idx = 0; render(); }
      else if (k === KEY.BACK) App.go('home');
      return;
    }
    if (k === KEY.UP) {
      if (ST.idx > 0) ST.idx--; else ST.zone = 'tabs';
      ST.confirm = '';
      render();
    } else if (k === KEY.DOWN) {
      ST.idx = clamp(ST.idx + 1, 0, ST.acts.length - 1);
      ST.confirm = '';
      render();
    } else if (k === KEY.ENTER) {
      if (ST.acts[ST.idx]) ST.acts[ST.idx]();
    } else if (k === KEY.BACK) {
      ST.zone = 'tabs'; ST.confirm = ''; render();
    }
  }

  App.register('settings', {
    open: function () {
      ST.tab = 0; ST.zone = 'tabs'; ST.idx = 0; ST.confirm = ''; ST.locked = isLocked('settings');
      render();
      if (!ST.locked) return;
      askPin({ title: 'Settings locked', sub: 'Enter your 4-digit PIN', check: pinOk }, function (pin) {
        if (pin) { ST.locked = false; render(); } else App.go('home');
      });
    },
    close: function () { ST.locked = false; ST.confirm = ''; },
    key: key,
    tick: tick,
    onLoad: function () { if (App.current() === 'settings') render(); }
  });
})();
