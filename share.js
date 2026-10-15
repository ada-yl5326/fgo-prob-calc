/*
 * 工作文件的导入导出（不依赖页面：网页、Node 测试都能用）。
 *
 * 工作文件 = 一个工作目录的全部内容：伤害组、发牌组、送人组、综合页的方案。
 *     { app: 'Laplace NS', format: 3, name, exportedAt, data: { kill: { groups }, deal: { groups }, send: { groups }, combo: 方案 } }
 *     （format 2 以前没有送人组，读进来送人组为空）
 * 文件就是这段 JSON（方便阅读）。
 * 分享码用更短的紧凑格式（见 compact()：不写字段名和组的编号，牌型、选牌写成短字符串，数字去掉千分位逗号），
 *     「LN2z.」+ 压缩后的 base64url；不压缩更短、或浏览器不支持压缩时用「LN2r.」。
 *     以前的「LNS1.」「LNS0.」（完整 JSON）也能读。
 * 分享链接 = 网址 + 「#i=」+ 分享码（「#」后面的内容不会发到服务器）；二维码里放的就是分享链接。
 * 读进来的内容在页面里还会经过各页面自己的检查（GroupStore 的 clean、综合页的 load），格式不对的部分会被丢掉。
 */
(function (root) {
  'use strict';

  var APP = 'Laplace NS';
  var FORMAT = 3;                                        // 文件格式的版本：以后改格式时加 1，并继续能读旧版本（2 = v0.8 起伤害维度可以增减；3 = v0.9 起有送人组）
  var COMPACT = 4;                                       // 紧凑格式（分享码）的版本，见 compact()
  var DECKS = ['BBBAQ', 'BBAAQ', 'BBAQQ', 'BAAQQ', 'BAAAQ', 'BAQQQ'];
  var ROLES = ['must', 'may', 'keep', 'immortal'];       // 送人组的从者角色：要退场 / 可以退场 / 不能退场 / 不会死
  var MAX_TEXT = 2 * 1024 * 1024;                        // 导入的内容最多 2 MB

  // ---------- base64url ----------

  function toBase64Url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    var s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function pipe(bytes, stream) {
    return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // ---------- 工作文件 ----------

  /** 打包成工作文件 */
  function pack(name, data) {
    return { app: APP, format: FORMAT, name: String(name || '未命名'), exportedAt: new Date().toISOString(), data: data };
  }

  /** 检查工作文件，返回 { name, data }；不是工作文件时抛出带说明的错误 */
  function unpack(obj) {
    if (!obj || typeof obj !== 'object' || obj.app !== APP || typeof obj.format !== 'number' || !obj.data || typeof obj.data !== 'object') {
      throw new Error('无法识别：这不是 Laplace NS 的工作文件或分享码');
    }
    if (obj.format > FORMAT) throw new Error('这个文件来自更新的版本，请先刷新网页、更新到最新版再导入');
    var d = obj.data;
    var groups = function (x) { return x && Array.isArray(x.groups) ? x.groups : []; };
    return {
      name: String(obj.name || '导入的工作目录').slice(0, 30),
      data: { kill: { groups: groups(d.kill) }, deal: { groups: groups(d.deal) }, send: { groups: groups(d.send) },
        combo: d.combo && typeof d.combo === 'object' ? d.combo : null },
    };
  }

  // ---------- 紧凑格式（分享码用）----------
  // [4, 名称, 伤害组们, 发牌组们, 方案, 送人组们]；组用在数组里的位置（从 1 开始）互相引用，0 = 没有。
  //   伤害组：[名称, [主目标各维度的均伤], HP, SL, [[AOE 1 各维度的均伤…, AOE 1 HP], …]]（末尾空的项省略）
  //   （版本 2 = v0.7 以前，主目标固定 4 维、AOE 目标 1 维：[名称, 4 张卡的均伤, HP, SL, [AOE 1 群体伤害, AOE 1 HP, …]]，仍然能读）
  //   发牌组：[名称, 人数 × 10 + 回合范围, 「配卡+纹章位」用 | 隔开, [[15 位选牌, 仅含位, 不能有位], …], 正在编辑第几种条件]
  //   方案：[回合数, 各回合的伤害组, [[第几回合, 发牌组], …], [[第几回合, [各条件的伤害组], 其他, [各条件的送人组], 其他的送人组], …],
  //          各回合的送人组]（分条件的格子没放送人组时，后两项省略）
  //   送人组：[名称, 敌人们, 从者们, 有后备队友 ? 1 : 0, SL]
  //     敌人：[行动次数, 普通攻击均伤, 开关位, 暴击均伤, 暴击率, 牌型（DECKS 里第几个，从 1 开始）, 放宝具的位（第 k 次 = 第 k−1 位）,
  //           宝具均伤, 开技能概率, [对各从者的伤害倍率]]
  //           开关位：1 普通攻击全体，2 暴击，4 暴击全体，8 牌型，16 宝具，32 宝具全体，64 开技能，128 伤害倍率
  //     从者：[角色（ROLES 里第几个，从 0 开始）, HP, 被攻击权重, 开关位（1 嘲讽，2 战续血量分别填）, 无敌次数, 战续次数, [各次战续的血量]]
  //   （版本 3 = v0.8，没有送人组、方案里没有送人格，仍然能读）
  // 和页面的数据结构对应；以后页面的数据结构变了，这里要一起改（并把 COMPACT 加 1，继续能读旧版本）。

  var num = function (s) { return String(s === undefined || s === null ? '' : s).replace(/[,，\s]/g, ''); };
  var trim = function (a, empty) { while (a.length && empty(a[a.length - 1])) a.pop(); return a; };
  var str = function (x) { return typeof x === 'string' ? x : ''; };
  var int = function (x, lo, hi) { return typeof x === 'number' && x === Math.floor(x) && x >= lo && x <= hi ? x : null; };
  var arr = function (x) { return Array.isArray(x) ? x : []; };
  var blank = function (v) { return v === '' || (Array.isArray(v) && !v.length); };

  /** 送人组 → 紧凑格式 */
  function compactSend(g) {
    var x = g.data || {};
    var E = arr(x.enemies).map(function (e) {
      var nm = e.normal || {}, cr = e.crit || {}, dk = e.deck || {}, np = e.np || {}, sk = e.skill || {}, mu = e.mult || {};
      var flag = (nm.aoe ? 1 : 0) | (cr.on ? 2 : 0) | (cr.aoe ? 4 : 0) | (dk.on ? 8 : 0) | (np.on ? 16 : 0) | (np.aoe ? 32 : 0) | (sk.on ? 64 : 0) | (mu.on ? 128 : 0);
      var at = 0;
      arr(np.at).forEach(function (k) { if (int(k, 1, 6)) at |= 1 << (k - 1); });
      return trim([e.actions || 3, num(nm.dmg), flag, num(cr.dmg), num(cr.rate), DECKS.indexOf(dk.value) + 1, at, num(np.dmg), num(sk.rate),
        arr(mu.values).map(num)], blank);
    });
    var S = arr(x.servants).map(function (v) {
      return trim([Math.max(0, ROLES.indexOf(v.role)), num(v.hp), num(v.weight), (v.taunt ? 1 : 0) | (v.gutsEach ? 2 : 0), v.inv || 0, v.guts || 0,
        arr(v.gutsHp).map(num)], blank);
    });
    return trim([str(g.name), E, S, x.backup === false ? 0 : 1, num(x.sl)], blank);
  }

  /** 紧凑格式 → 送人组（读进页面后还会经过送人页自己的检查） */
  function expandSend(r, i) {
    r = arr(r);
    var enemies = arr(r[1]).map(function (e) {
      e = arr(e);
      var flag = int(e[2], 0, 255) || 0, at = int(e[6], 0, 63), atList = [];
      for (var k = 1; k <= 6; k++) if (at & (1 << (k - 1))) atList.push(k);
      var mv = arr(e[9]);
      return {
        actions: int(e[0], 1, 6) || 3,
        normal: { dmg: str(e[1]), aoe: !!(flag & 1) },
        crit: { on: !!(flag & 2), dmg: str(e[3]), rate: str(e[4]), aoe: !!(flag & 4) },
        deck: { on: !!(flag & 8), value: DECKS[(int(e[5], 1, 6) || 2) - 1] },
        np: { on: !!(flag & 16), at: at === null ? [1] : atList, dmg: str(e[7]), aoe: !!(flag & 32) },
        skill: { on: !!(flag & 64), rate: str(e[8]) },
        mult: { on: !!(flag & 128), values: [0, 1, 2].map(function (k) { return str(mv[k]); }) },
      };
    });
    var servants = arr(r[2]).map(function (v) {
      v = arr(v);
      var flag = int(v[3], 0, 3) || 0;
      return { role: ROLES[int(v[0], 0, 3) || 0], hp: str(v[1]), weight: str(v[2]), taunt: !!(flag & 1), inv: int(v[4], 0, 99) || 0,
        guts: int(v[5], 0, 99) || 0, gutsHp: arr(v[6]).map(str), gutsEach: !!(flag & 2) };
    });
    return { id: 's' + (i + 1), name: str(r[0]), data: { enemies: enemies, servants: servants, backup: r[3] !== 0, sl: str(r[4]) } };
  }

  function compact(file) {
    var d = file.data, plan = d.combo;
    var kIndex = {}, dIndex = {}, sIndex = {}, sendGroups = d.send ? arr(d.send.groups) : [];
    d.kill.groups.forEach(function (g, i) { kIndex[g.id] = i + 1; });
    d.deal.groups.forEach(function (g, i) { dIndex[g.id] = i + 1; });
    sendGroups.forEach(function (g, i) { sIndex[g.id] = i + 1; });
    var K = d.kill.groups.map(function (g) {
      var x = g.data || {};
      var aoe = (x.aoe || []).map(function (a) { return (a.cards || []).map(num).concat(num(a.hp)); });
      var row = [str(g.name), (x.cards || []).map(num), num(x.hp), num(x.sl)];
      return aoe.length ? row.concat([aoe]) : trim(row, function (v) { return v === ''; });
    });
    var bits = function (rows) {                         // 3 × 3 的开关 → 9 位
      var v = 0;
      (rows || []).forEach(function (r, o) { (r || []).forEach(function (on, t) { if (on) v |= 1 << (o * 3 + t); }); });
      return v;
    };
    var D = d.deal.groups.map(function (g) {
      var x = g.data || {};
      var owners = trim((x.owners || []).map(function (o) {
        var m = 0;
        (o.marked || []).forEach(function (on, i) { if (on) m |= 1 << i; });
        return o.deck ? o.deck + (m ? m : '') : '';
      }), function (v) { return v === ''; }).join('|');
      var alts = (x.alts || []).map(function (a) {
        var picks = (a.picks || []).map(function (p) { return (p || []).join(''); }).join('').replace(/0+$/, '');
        return trim([picks, bits(a.exact), bits(a.none)], function (v) { return v === 0; });
      });
      return trim([str(g.name), (x.servants || 3) * 10 + (x.scope || 1), owners, alts, x.alt || 0], function (v) { return v === 0; });
    });
    var C = null;
    if (plan) {
      C = [plan.turns,
        trim((plan.kill || []).map(function (id) { return kIndex[id] || 0; }), function (v) { return v === 0; }),
        (plan.deal || []).filter(function (p) { return dIndex[p.id]; }).map(function (p) { return [p.at, dIndex[p.id]]; }),
        (plan.split || []).map(function (sp, i) {
          if (!sp) return null;
          var row = [i, (sp.alts || []).map(function (id) { return kIndex[id] || 0; }), kIndex[sp.other] || 0];
          var sends = arr(sp.sends).map(function (id) { return sIndex[id] || 0; }), other = sIndex[sp.sendOther] || 0;
          if (sends.some(Boolean) || other) row.push(sends, other);
          return row;
        }).filter(Boolean),
        trim(arr(plan.send).map(function (id) { return sIndex[id] || 0; }), function (v) { return v === 0; })];
      trim(C, function (v) { return Array.isArray(v) && !v.length; });
    }
    return [COMPACT, str(file.name), K, D, C, sendGroups.map(compactSend)];
  }

  /** 紧凑格式 → { name, data }（结构和页面的一样；读进页面后还会经过各页面自己的检查） */
  function expand(a) {
    if (Array.isArray(a) && a[0] > COMPACT) throw new Error('这个分享码来自更新的版本，请先刷新网页、更新到最新版再导入');
    if (!Array.isArray(a) || [2, 3, 4].indexOf(a[0]) < 0 || !Array.isArray(a[2]) || !Array.isArray(a[3])) throw new Error('无法识别：分享码不完整或已损坏');
    var v2 = a[0] === 2;
    var kill = a[2].map(function (r, i) {
      r = Array.isArray(r) ? r : [];
      var cards, rest, aoe = [];
      if (v2) {                                          // 版本 2：主目标 4 维，AOE 目标 1 维（群体伤害, HP 两两一组）
        cards = [1, 2, 3, 4].map(function (j) { return str(r[j]); });
        rest = r.slice(5);
        var flat = Array.isArray(r[7]) ? r[7] : [];
        for (var k = 0; k + 1 < flat.length; k += 2) aoe.push({ cards: [str(flat[k])], hp: str(flat[k + 1]) });
      } else {
        cards = (Array.isArray(r[1]) ? r[1] : []).map(str);
        rest = r.slice(2);
        (Array.isArray(r[4]) ? r[4] : []).forEach(function (x) {
          if (Array.isArray(x) && x.length >= 2) aoe.push({ cards: x.slice(0, -1).map(str), hp: str(x[x.length - 1]) });
        });
      }
      return { id: 'k' + (i + 1), name: str(r[0]), data: { cards: cards, hp: str(rest[0]), sl: str(rest[1]), aoe: aoe } };
    });
    var flags = function (v) {
      var out = [];
      for (var o = 0; o < 3; o++) { var row = []; for (var t = 0; t < 3; t++) row.push(!!(int(v, 0, 511) & (1 << (o * 3 + t)))); out.push(row); }
      return out;
    };
    var deal = a[3].map(function (r, i) {
      r = Array.isArray(r) ? r : [];
      var sv = int(r[1], 0, 99) || 31;
      var owners = str(r[2]).split('|');
      var own = [0, 1, 2].map(function (o) {
        var m = /^([BAQ]{5})(\d*)$/.exec(owners[o] || '');
        var bitsOf = m && m[2] ? Number(m[2]) : 0;
        return { deck: m ? m[1] : '', marked: [0, 1, 2, 3, 4].map(function (k) { return !!(bitsOf & (1 << k)); }) };
      });
      var alts = (Array.isArray(r[3]) && r[3].length ? r[3] : [[]]).map(function (x) {
        x = Array.isArray(x) ? x : [];
        var digits = (str(x[0]) + '000000000000000').slice(0, 15);
        var picks = [0, 1, 2].map(function (o) { return digits.slice(o * 5, o * 5 + 5).split('').map(Number); });
        return { picks: picks, exact: flags(x[1] || 0), none: flags(x[2] || 0) };
      });
      return { id: 'd' + (i + 1), name: str(r[0]), data: { servants: Math.floor(sv / 10), scope: sv % 10, owners: own, alts: alts, alt: int(r[4], 0, 9) || 0 } };
    });
    var send = arr(a[5]).map(expandSend);               // 版本 3 以前没有送人组
    var combo = null, c = a[4];
    if (Array.isArray(c)) {
      var n = int(c[0], 1, 99) || 3;
      var kid = function (x) { var i = int(x, 1, kill.length); return i ? kill[i - 1].id : null; };
      var did = function (x) { var i = int(x, 1, deal.length); return i ? deal[i - 1].id : null; };
      var sid = function (x) { var i = int(x, 1, send.length); return i ? send[i - 1].id : null; };
      var plan = { turns: n, kill: [], deal: [], split: [], send: [] };
      for (var t = 0; t < n; t++) { plan.kill.push(kid((c[1] || [])[t])); plan.split.push(null); plan.send.push(sid(arr(c[4])[t])); }
      (Array.isArray(c[2]) ? c[2] : []).forEach(function (p) {
        if (Array.isArray(p) && int(p[0], 0, n - 1) !== null && did(p[1])) plan.deal.push({ at: p[0], id: did(p[1]) });
      });
      (Array.isArray(c[3]) ? c[3] : []).forEach(function (s) {
        if (!Array.isArray(s) || int(s[0], 0, n - 1) === null) return;
        var alts = (Array.isArray(s[1]) ? s[1] : []).slice(0, 5).map(kid);
        plan.split[s[0]] = { alts: alts, other: kid(s[2]), sends: alts.map(function (x, k) { return sid(arr(s[3])[k]); }), sendOther: sid(s[4]) };
      });
      combo = plan;
    }
    return { name: str(a[1]).slice(0, 30) || '导入的工作目录', data: { kill: { groups: kill }, deal: { groups: deal }, send: { groups: send }, combo: combo } };
  }

  /** 分享码：紧凑格式 → 压缩（更短时）→ base64url（Promise） */
  function encode(file) {
    var bytes = new TextEncoder().encode(JSON.stringify(compact(file)));
    var raw = 'LN2r.' + toBase64Url(bytes);
    if (typeof CompressionStream === 'undefined') return Promise.resolve(raw);
    return pipe(bytes, new CompressionStream('deflate-raw')).then(function (z) {
      var zipped = 'LN2z.' + toBase64Url(z);
      return zipped.length < raw.length ? zipped : raw;
    });
  }

  /**
   * 读入：分享码、分享链接（含「#i=」）或工作文件的 JSON 文字都可以。返回 Promise<{ name, data }>
   */
  function decode(text) {
    return Promise.resolve().then(function () {
      var s = String(text || '').trim();
      if (!s) throw new Error('没有内容：请粘贴分享码或分享链接，或者选择文件');
      if (s.length > MAX_TEXT) throw new Error('内容太大，无法导入');
      if (s.charAt(0) === '{') {
        var obj;
        try { obj = JSON.parse(s); } catch (e) { throw new Error('无法识别：文件内容不完整或已损坏'); }
        return unpack(obj);
      }
      var at = s.search(/#(i|import)=/);
      if (at >= 0) s = s.slice(s.indexOf('=', at) + 1);
      s = s.replace(/\s+/g, '');
      try { s = decodeURIComponent(s); } catch (e) { /* 保持原样 */ }
      var kind = s.slice(0, 5), body = s.slice(5);
      var KINDS = { 'LN2z.': [true, true], 'LN2r.': [true, false], 'LNS1.': [false, true], 'LNS0.': [false, false] };   // [紧凑格式, 压缩]
      if (!KINDS[kind] || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('无法识别：分享码不完整，请检查是否复制全了');
      var bytes;
      try { bytes = fromBase64Url(body); } catch (e) { throw new Error('无法识别：分享码不完整，请检查是否复制全了'); }
      var raw;
      if (!KINDS[kind][1]) raw = Promise.resolve(bytes);
      else if (typeof DecompressionStream === 'undefined') throw new Error('这个浏览器太旧，读不了压缩的分享码，请让对方发文件');
      else raw = pipe(bytes, new DecompressionStream('deflate-raw'));
      return raw.then(function (b) {
        var obj;
        try { obj = JSON.parse(new TextDecoder().decode(b)); } catch (e) { throw new Error('无法识别：分享码不完整或已损坏'); }
        return KINDS[kind][0] ? expand(obj) : unpack(obj);
      }, function () { throw new Error('无法识别：分享码不完整或已损坏'); });
    });
  }

  /**
   * 只留下方案里用到的组（分享某个方案时，不把无关的组一起带出去）。方案里一个组都没用到时原样返回
   */
  function usedOnly(data) {
    var plan = data.combo || {}, kill = {}, deal = {}, send = {}, any = false;
    (plan.kill || []).forEach(function (id) { if (id) { kill[id] = any = true; } });
    (plan.send || []).forEach(function (id) { if (id) { send[id] = any = true; } });
    (plan.split || []).forEach(function (sp) {
      if (!sp) return;
      (sp.alts || []).concat(sp.other).forEach(function (id) { if (id) { kill[id] = any = true; } });
      arr(sp.sends).concat(sp.sendOther).forEach(function (id) { if (id) { send[id] = any = true; } });
    });
    (plan.deal || []).forEach(function (p) { if (p && p.id) { deal[p.id] = any = true; } });
    if (!any) return data;
    return {
      kill: { groups: data.kill.groups.filter(function (g) { return kill[g.id]; }) },
      deal: { groups: data.deal.groups.filter(function (g) { return deal[g.id]; }) },
      send: { groups: (data.send ? data.send.groups : []).filter(function (g) { return send[g.id]; }) },
      combo: plan,
    };
  }

  /** 不和 taken 里重复的名称：「名称」「名称（2）」「名称（3）」……；名称最长 max 个字 */
  function uniqueName(name, taken, max) {
    max = max || 30;
    var base = String(name || '').trim().slice(0, max) || '未命名', n = 1, s = base;
    while (taken.indexOf(s) >= 0) {
      n++;
      var tail = '（' + n + '）';
      s = base.slice(0, max - tail.length) + tail;
    }
    return s;
  }

  var api = {
    APP: APP, FORMAT: FORMAT, COMPACT: COMPACT, pack: pack, unpack: unpack, compact: compact, expand: expand,
    encode: encode, decode: decode, usedOnly: usedOnly, uniqueName: uniqueName,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Share = api;
})(typeof self !== 'undefined' ? self : this);
