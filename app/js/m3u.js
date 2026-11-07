/* M3U / M3U8 playlist parser. Returns [{num, name, logo, group, id, url, ua}]. */
var M3U = (function () {
  'use strict';

  // Index of the comma that starts the title, skipping commas inside quoted attributes.
  function titleComma(line) {
    var quoted = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) return i;
    }
    return -1;
  }

  function attrs(text) {
    var out = {}, re = /([\w-]+)="([^"]*)"/g, m;
    while ((m = re.exec(text))) out[m[1].toLowerCase()] = m[2];
    return out;
  }

  function parse(text) {
    var lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    var list = [], cur = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('#EXTINF') === 0) {
        var comma = titleComma(line);
        var a = attrs(comma === -1 ? line : line.slice(0, comma));
        cur = {
          name: comma === -1 ? '' : line.slice(comma + 1).trim(),
          logo: a['tvg-logo'] || '',
          group: (a['group-title'] || '').split(';')[0].trim(),
          id: a['tvg-id'] || '',
          ua: a['user-agent'] || ''
        };
      } else if (line.indexOf('#EXTGRP:') === 0) {
        if (cur && !cur.group) cur.group = line.slice(8).trim();
      } else if (line.indexOf('#EXTVLCOPT:http-user-agent=') === 0) {
        if (cur) cur.ua = line.slice(27).trim();
      } else if (line.charAt(0) !== '#') {
        cur = cur || { name: '', logo: '', group: '', id: '', ua: '' };
        cur.url = line;
        cur.num = list.length + 1;
        if (!cur.name) cur.name = 'Channel ' + cur.num;
        if (!cur.group) cur.group = 'Uncategorized';
        list.push(cur);
        cur = null;
      }
    }
    return list;
  }

  return { parse: parse };
})();
