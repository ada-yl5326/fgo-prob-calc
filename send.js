/*
 * 送人概率的计算核心（不依赖浏览器；规则见《送人概率规则.md》，tests/test_web_send.py 用 Python 独立实现对照验证）。
 *
 * 敌方行动阶段：敌人按行动顺序轮流行动，每次行动执行预设动作序列里下一个还没执行的动作；
 * 没有合法目标时这次行动被跳过（行动次数照样用掉，预设动作顺延）。
 *
 * 精确计算（compute）：按行动一步一步展开全部分支，状态相同的合并。
 *     状态 = 每个敌人执行到预设序列的第几个 + 每名会倒下的从者（是否退场、用了几次战续、剩几次无敌、
 *            「对谁不合法」、这一条命挨过哪几下攻击）+ 是否已中断。
 *     一名从者这一条命挨过的攻击（各下的均伤，见 hitAvg）决定了他此时已经倒下的概率
 *         F(挨过的攻击) = 这几下伤害之和 >= HP 的概率（击破概率页的精确计数，全部 200^n 种随机数组合），
 *     挨下一下 x 时：倒下的概率 = (F(挨过的 + x) − F(挨过的)) / (1 − F(挨过的))，否则还站着。
 *     伤害都是非负整数，伤害和只增不减，所以这样分支与逐个随机数组合统计完全等价。
 * 计算量太大时（分支数超过 maxWork，或状态数超过 maxStates）返回 null，由 run() 改用模拟（simulate）。
 */
(function (root) {
  'use strict';

  var KP = typeof module === 'object' && module.exports ? require('./killprob.js') : root.KillProb;

  var MAX_ENEMIES = 6, MAX_ACTIONS = 6, MAX_SERVANTS = 3, MAX_INV = 9, MAX_GUTS = 9;
  var DENSE_LIMIT = 1 << 20;                             // 按伤害和计数时计数表最多 100 万格
  var MAX_STATES = 300000;                               // 精确计算的状态数上限，超过改用模拟
  var MAX_WORK = 1000000;                                // 精确计算展开的分支数上限（电脑上约 1 秒），超过改用模拟
  var SIM_ACTIONS = 3000000;                             // 模拟时总共模拟的敌方行动数（次数 = 它 ÷ 每回合的行动数）
  var SIM_RUNS = 200000;                                 // 模拟次数
  var COLORS = { B: 1.5, A: 1, Q: 0.8 };
  var DECKS = ['BBBAQ', 'BBAAQ', 'BBAQQ', 'BAAQQ', 'BAAAQ', 'BAQQQ'];
  var ROLES = ['must', 'may', 'keep', 'immortal'];       // 要退场 / 可以退场 / 不能退场 / 不会死

  /**
   * 检查并整理输入。cfg = {
   *   enemies: [{ actions, normal: { dmg, aoe }, crit: null | { dmg, rate, aoe }, skill: 开技能概率 (0 ~ 1),
   *               deck: null | 'BBAAQ', np: null | { at: [第几个预设动作，1 起], dmg: 0 = 无伤害宝具, aoe },
   *               mult: [对每名从者的伤害倍率 %，默认 100] }]（按行动顺序）,
   *   servants: [{ role, hp, inv, guts: [每次战续的血量], taunt, weight }],
   *   backup: 有后备队友（默认 true）
   * }
   * 返回内部模型；输入有误时抛出 Error（message 是给用户看的说明）。
   */
  function model(cfg) {
    var ss = cfg.servants || [], es = cfg.enemies || [];
    if (ss.length < 1 || ss.length > MAX_SERVANTS) throw new Error('我方从者要有 1 ~ ' + MAX_SERVANTS + ' 名');
    if (es.length < 1 || es.length > MAX_ENEMIES) throw new Error('敌人要有 1 ~ ' + MAX_ENEMIES + ' 个');
    var servants = ss.map(function (s, i) {
      var name = '从者 ' + (i + 1);
      if (ROLES.indexOf(s.role) < 0) throw new Error(name + '的角色有误');
      var mortal = s.role !== 'immortal';
      var hp = mortal ? num(s.hp, 1, 1e12, name + '的 HP') : 0;
      var guts = mortal ? (s.guts || []).map(function (g, k) { return num(g, 1, 1e12, name + '第 ' + (k + 1) + ' 次战续的血量'); }) : [];
      if (guts.length > MAX_GUTS) throw new Error(name + '的战续次数最多 ' + MAX_GUTS + ' 次');
      var inv = mortal ? Math.round(num(s.inv || 0, 0, MAX_INV, name + '的无敌次数')) : 0;
      var weight = num(s.weight === undefined ? 1 : s.weight, 0, 1e9, name + '的被攻击权重');
      if (!(weight > 0)) throw new Error(name + '的被攻击权重要大于 0');
      return { role: s.role, mortal: mortal, hps: [hp].concat(guts), inv: inv, taunt: !!s.taunt, weight: weight };
    });
    // 只有「不能退场」时算的是「指定的从者都没退场」的概率
    if (!servants.some(function (s) { return s.role === 'must' || s.role === 'keep'; })) throw new Error('至少要有一名「要退场」或「不能退场」的从者');
    var enemies = es.map(function (e, j) {
      var name = '敌人 ' + (j + 1);
      var n = Math.round(num(e.actions, 1, MAX_ACTIONS, name + '的行动次数'));
      var mult = servants.map(function (s, i) {
        var m = e.mult && e.mult[i] !== undefined && e.mult[i] !== null && e.mult[i] !== '' ? e.mult[i] : 100;
        return num(m, 0, 1e6, name + '对从者 ' + (i + 1) + ' 的伤害倍率');
      });
      var colors = e.deck ? deckColors(e.deck, name) : [{ card: 1, p: 1 }];
      var skill = num(e.skill || 0, 0, 1, name + '的开技能概率');
      var normal = num(e.normal && e.normal.dmg, 0, 1e12, name + '的普通攻击均伤');
      var kinds = [], crit = e.crit ? num(e.crit.rate, 0, 1, name + '的暴击率') : 0;
      colors.forEach(function (c) {
        if (crit < 1) kinds.push({ p: c.p * (1 - crit), dmg: normal, card: c.card, aoe: !!e.normal.aoe, np: false, crit: false });
        if (crit > 0) {
          kinds.push({ p: c.p * crit, dmg: num(e.crit.dmg, 0, 1e12, name + '的暴击均伤'), card: c.card, aoe: !!e.crit.aoe, np: false, crit: true });
        }
      });
      var presets = [];
      for (var k = 0; k < n; k++) presets.push(false);
      var npKind = null;
      if (e.np) {
        (e.np.at || []).forEach(function (a) {
          a = Math.round(a);
          if (a >= 1 && a <= n) presets[a - 1] = true;
        });
        var d = num(e.np.dmg || 0, 0, 1e12, name + '的宝具均伤');
        npKind = { p: 1, dmg: d, card: 1, aoe: !!e.np.aoe, np: true, crit: false, none: d === 0 };
      }
      var lastNP = presets.lastIndexOf(true);
      var all = npKind ? kinds.concat([npKind]) : kinds.slice();
      all.forEach(function (k, idx) { k.idx = idx; });
      return { actions: n, presets: presets, lastNP: lastNP, kinds: kinds, npKind: npKind, all: all, skill: skill, mult: mult };
    });
    // 行动顺序：按顺序轮流，行动次数用完的跳过
    var slots = [], left = enemies.map(function (e) { return e.actions; });
    for (var any = true; any;) {
      any = false;
      enemies.forEach(function (e, j) { if (left[j] > 0) { slots.push(j); left[j]--; any = true; } });
    }
    var remain = [], cnt = enemies.map(function (e) { return e.actions; });
    slots.forEach(function (j) { cnt[j]--; remain.push(cnt.slice()); });   // remain[t][j] = 第 t 次行动之后敌人 j 还剩几次
    return {
      servants: servants, enemies: enemies, slots: slots, remain: remain, backup: cfg.backup !== false,
      taunted: servants.some(function (s) { return s.taunt; }),
    };
  }

  function num(v, lo, hi, what) {
    var x = typeof v === 'string' ? Number(v.trim()) : v;
    if (typeof x !== 'number' || !isFinite(x) || x < lo || x > hi) throw new Error(what + '有误');
    return x;
  }

  function deckColors(deck, name) {
    if (DECKS.indexOf(deck) < 0) throw new Error(name + '的牌型有误');
    var out = [];
    ['B', 'A', 'Q'].forEach(function (c) {
      var k = deck.split(c).length - 1;
      if (k) out.push({ card: COLORS[c], p: k / 5 });
    });
    return out;
  }

  /** 敌人 j 的这种攻击打到从者 i 时的均伤（单次伤害 = 向下取整(均伤 × 随机数)，与我方单卡伤害算法相同） */
  function hitAvg(m, j, kind, i) {
    return kind.dmg * kind.card * m.enemies[j].mult[i] / 100;
  }

  /** 计算「伤害之和 >= H 的概率」 */
  function Damage() {
    this.out = new Map();
    this.ops = 0;                                        // 计数时做过的加法次数（计入精确计算的计算量）
  }
  Damage.prototype.outcomes = function (avg) {
    var o = this.out.get(avg);
    if (!o) { o = KP.cardOutcomes(avg); this.out.set(avg, o); }
    return o;
  };
  /**
   * avgs 从小到大排列。12 下以内：分成前后两半，各自按伤害和直接计数（与击破概率页相同的做法，组合数是精确的整数），
   * 再对前一半的每个和，查出后一半里和 >= H − 它的组合数；伤害和范围太大时交给击破概率页的计算核心。
   */
  Damage.prototype.atLeast = function (avgs, H) {
    var lo = 0, hi = 0, R = KP.RAND_COUNT, k;
    for (k = 0; k < avgs.length; k++) { var o = this.outcomes(avgs[k]); lo += o[0]; hi += o[R - 1]; }
    if (lo >= H) return 1;
    if (hi < H) return 0;
    if (avgs.length > KP.MAX_CARDS) return this.dense(avgs, H);
    var half = Math.floor(avgs.length / 2), a = this.counts(avgs.slice(0, half)), b = this.counts(avgs.slice(half));
    if (!a || !b) { var prep = KP.prepare(avgs); return KP.countAtLeast(prep, H) / prep.total; }
    var suf = new Float64Array(b.c.length + 1);
    for (k = b.c.length - 1; k >= 0; k--) suf[k] = suf[k + 1] + b.c[k];
    var count = 0;
    for (k = 0; k < a.c.length; k++) {
      if (!a.c[k]) continue;
      var need = H - (a.lo + k) - b.lo;                  // 后一半的和要 >= H − 前一半的和
      count += a.c[k] * (need <= 0 ? suf[0] : need < suf.length ? suf[need] : 0);
    }
    return count / Math.pow(R, avgs.length);
  };
  /** 几下攻击所有随机数组合的伤害和：{ lo: 最小的和, c[k] = 和为 lo + k 的组合数 }；范围太大时返回 null */
  Damage.prototype.counts = function (avgs) {
    var lo = 0, c = new Float64Array([1]), R = KP.RAND_COUNT;
    for (var k = 0; k < avgs.length; k++) {
      var o = this.outcomes(avgs[k]), len = c.length + o[R - 1] - o[0];
      if (len > DENSE_LIMIT) return null;
      var t = new Float64Array(len);
      this.ops += c.length * R;
      for (var i = 0; i < c.length; i++) {
        var n = c[i];
        if (!n) continue;
        for (var r = 0; r < R; r++) t[i + o[r] - o[0]] += n;
      }
      c = t;
      lo += o[0];
    }
    return { lo: lo, c: c };
  };
  /** 超过 12 下时：按伤害和逐下累加概率（< H 的部分逐格记录，>= H 的部分合在一起） */
  Damage.prototype.dense = function (avgs, H) {
    var base = 0, arr = new Float64Array([1]), over = 0, R = KP.RAND_COUNT;
    for (var k = 0; k < avgs.length; k++) {
      var o = this.outcomes(avgs[k]), nb = base + o[0];
      var len = Math.max(0, Math.min(arr.length - 1 + o[R - 1] - o[0] + 1, H - nb));
      var next = new Float64Array(len);
      this.ops += arr.length * R;
      for (var i = 0; i < arr.length; i++) {
        var q = arr[i] / R;
        if (!q) continue;
        for (var r = 0; r < R; r++) {
          var x = i + o[r] - o[0];
          if (x < len) next[x] += q; else over += q;
        }
      }
      base = nb;
      arr = next;
    }
    return over;
  };

  // ---------------------------------------------------------------- 精确计算

  /*
   * 状态存成一个整数数组：[敌人 0 … E−1 执行到预设序列的第几个, 中断（0 没有 / 1 战续中断 / 2 嘲讽中断）,
   *                       每名从者 5 格：退场?, 用了几次战续, 剩几次无敌, 对第几个敌人不合法（−1 = 没有）, 挨过的攻击]。
   * 「挨过的攻击」是一棵树上的节点（每名从者每一条命一棵）：节点 = 这条命挨过的几下攻击（不分先后），记着已倒下的概率 F；
   * 树枝 = 再挨一下某种攻击，记着这一下倒下的概率。
   */
  var SV = 5, DEAD = 0, LIFE = 1, INV = 2, BAN = 3, NODE = 4;

  function Exact(m) {
    var self = this;
    this.m = m;
    this.E = m.enemies.length;
    this.dmg = new Damage();
    // 每名从者「一下的均伤」各种取值的编号；hitId[j][k][i] = 敌人 j 第 k 种攻击打到从者 i 时的编号（−2 = 不受影响，−1 = 倍率 0%）
    this.avgs = m.servants.map(function () { return { list: [], index: new Map() }; });
    this.hitId = m.enemies.map(function (e, j) {
      return e.all.map(function (kind) {
        return m.servants.map(function (sv, i) {
          if (!sv.mortal || kind.none) return -2;
          var a = hitAvg(m, j, kind, i);
          if (a === 0) return -1;
          var A = self.avgs[i], id = A.index.get(a);
          if (id === undefined) { id = A.list.length; A.list.push(a); A.index.set(a, id); }
          return id;
        });
      });
    });
    this.trees = m.servants.map(function (sv) {
      return sv.hps.map(function (H) { return { H: H, nodes: [{ F: 0, ids: [] }], byKey: new Map([['', 0]]), edges: new Map() }; });
    });
  }

  /** 从者 i 第 life 条命、挨过 node 的情况下再挨一下 x：{ child, down: 这一下倒下的概率 } */
  Exact.prototype.edge = function (i, life, node, x) {
    var T = this.trees[i][life], ek = node * 64 + x, e = T.edges.get(ek);
    if (e) return e;
    var ids = T.nodes[node].ids.concat([x]).sort(function (a, b) { return a - b; });
    var key = ids.join(','), child = T.byKey.get(key);
    if (child === undefined) {
      var list = this.avgs[i].list;
      var avgs = ids.map(function (id) { return list[id]; }).sort(function (a, b) { return a - b; });
      child = T.nodes.length;
      T.nodes.push({ F: this.dmg.atLeast(avgs, T.H), ids: ids });
      T.byKey.set(key, child);
    }
    var f0 = T.nodes[node].F, f1 = T.nodes[child].F;
    e = { child: child, down: f0 >= 1 ? 1 : Math.min(1, Math.max(0, (f1 - f0) / (1 - f0))) };
    T.edges.set(ek, e);
    return e;
  };

  Exact.prototype.alive = function (s, i) {
    return !this.m.servants[i].mortal || !s[this.E + 1 + SV * i + DEAD];
  };

  Exact.prototype.clearBans = function (s) {
    for (var i = 0, o = this.E + 1; i < this.m.servants.length; i++, o += SV) s[o + BAN] = -1;
  };

  /** 敌人 j 行动时的合法目标（从者序号） */
  Exact.prototype.legal = function (s, j) {
    var m = this.m, all = [], i, taunt = false, E = this.E;
    for (i = 0; i < m.servants.length; i++) if (this.alive(s, i)) { all.push(i); if (m.servants[i].taunt) taunt = true; }
    return all.filter(function (k) { return (!taunt || m.servants[k].taunt) && s[E + 1 + SV * k + BAN] !== j; });
  };

  /** 一次攻击打到 targets：结果逐个交给 emit(p, 状态) */
  Exact.prototype.strike = function (s, j, kind, targets, p, emit) {
    var base = s.slice(), E = this.E, ids = this.hitId[j][kind.idx], off = [], ed = [], n, k;
    base[j]++;
    this.clearBans(base);
    for (n = 0; n < targets.length; n++) {
      var i = targets[n], o = E + 1 + SV * i, hid = ids[i];
      if (hid === -2 || base[o + DEAD]) continue;        // 不会死的从者、无伤害宝具
      if (base[o + INV] > 0) { base[o + INV]--; continue; }
      if (hid === -1) continue;                          // 伤害倍率 0%
      off.push(o);
      ed.push(this.edge(i, base[o + LIFE], base[o + NODE], hid));
    }
    for (var mask = 0; mask < 1 << off.length; mask++) {   // 第 k 位 = 第 k 名受伤的从者这一下倒下
      var pr = p;
      for (k = 0; k < off.length && pr > 0; k++) pr *= mask & (1 << k) ? ed[k].down : 1 - ed[k].down;
      if (!(pr > 0)) continue;
      var c = mask === (1 << off.length) - 1 ? base : base.slice(), cross = [];
      for (k = 0; k < off.length; k++) {
        if (mask & (1 << k)) cross.push(off[k]); else c[off[k] + NODE] = ed[k].child;
      }
      emit(pr, this.settle(c, j, kind, cross));
    }
  };

  /** 结算这一下倒下的从者（cross = 他们在状态数组里的位置）：战续 / 退场，「对 j 不合法」，中断 */
  Exact.prototype.settle = function (s, j, kind, cross) {
    var m = this.m, E = this.E, revived = [], i, o;
    for (var x = 0; x < cross.length; x++) {
      o = cross[x];
      i = (o - E - 1) / SV;
      s[o + NODE] = 0;
      if (s[o + LIFE] + 1 < m.servants[i].hps.length) { s[o + LIFE]++; revived.push(i); } else s[o + DEAD] = 1;
    }
    var count = 0;
    for (i = 0; i < m.servants.length; i++) if (this.alive(s, i)) count++;
    for (var r = 0; r < revived.length; r++) {
      i = revived[r];
      if (count === 1 && !m.backup) { if (!s[E]) s[E] = 1; } else if (!kind.np || m.servants[i].taunt || count === 1) s[E + 1 + SV * i + BAN] = j;
    }
    if (m.taunted && !s[E]) {
      var standing = false;
      for (i = 0; i < m.servants.length; i++) if (m.servants[i].taunt && this.alive(s, i)) standing = true;
      if (!standing) s[E] = 2;
    }
    return s;
  };

  /** 第 t 次行动从状态 s 出发的全部结果，逐个交给 emit(p, 状态) */
  Exact.prototype.step = function (s, t, emit) {
    var m = this.m, j = m.slots[t], e = m.enemies[j], qi = s[j], self = this;
    var isNP = e.presets[qi], pSkill = !isNP && qi === 0 ? e.skill : 0, c;
    if (pSkill > 0) { c = s.slice(); c[j]++; this.clearBans(c); emit(pSkill, c); }
    var pa = 1 - pSkill;
    if (pa <= 0) return;
    var legal = this.legal(s, j);
    if (!legal.length) { c = s.slice(); this.clearBans(c); emit(pa, c); return; }   // 没有合法目标：跳过，预设动作顺延
    var weight = 0, everyone = [], i;
    legal.forEach(function (k) { weight += m.servants[k].weight; });
    for (i = 0; i < m.servants.length; i++) if (this.alive(s, i)) everyone.push(i);
    (isNP ? [e.npKind] : e.kinds).forEach(function (kind) {
      var pk = pa * kind.p;
      if (kind.aoe) self.strike(s, j, kind, everyone, pk, emit);
      else legal.forEach(function (k) { self.strike(s, j, kind, [k], pk * m.servants[k].weight / weight, emit); });
    });
  };

  /** 第 t 次行动之后整理状态，让等价的状态合并：行动次数已用完的敌人、后面全是普通行动的敌人，预设位置不再重要 */
  Exact.prototype.canon = function (s, t) {
    var m = this.m;
    for (var j = 0; j < this.E; j++) {
      var e = m.enemies[j];
      if (m.remain[t][j] === 0) s[j] = 0;
      else if (s[j] > e.lastNP && s[j] > 1) s[j] = Math.max(1, e.lastNP + 1);   // 后面全是普通行动（不再判定开技能）
    }
    return s;
  };

  /** 状态合并用的键：预设位置（每个 3 位）和中断合成 2 个字符，每名从者 2 个字符（节点编号太大时 4 个） */
  var keyBuf = new Uint16Array(64);
  function flatKey(s, E) {
    var head = s[E], n = 0;
    for (var j = 0; j < E; j++) head = head * 8 + s[j];
    keyBuf[n++] = head & 0xffff;
    keyBuf[n++] = head >>> 16;
    for (var o = E + 1; o < s.length; o += SV) {
      keyBuf[n++] = s[o] | s[o + 1] << 1 | s[o + 2] << 5 | (s[o + 3] + 1) << 9;
      var node = s[o + 4];
      if (node < 0xffff) keyBuf[n++] = node;
      else { keyBuf[n++] = 0xffff; keyBuf[n++] = node & 0xffff; keyBuf[n++] = node >>> 16; }
    }
    return String.fromCharCode.apply(null, keyBuf.subarray(0, n));
  }

  /**
   * 精确计算。返回 { exact: true, success, fail, mustAlive, keepDead, endGuts, endTaunt,
   *                 servants: [{ out: 退场概率, guts: 触发过战续的概率 }], states: 最多时的状态数 }；
   * 分支数超过 maxWork 或状态数超过 maxStates 时返回 null。
   */
  function compute(cfg, opts) {
    var m = model(cfg), maxStates = (opts && opts.maxStates) || MAX_STATES, maxWork = (opts && opts.maxWork) || MAX_WORK;
    var X = new Exact(m), E = X.E;
    var s0 = m.enemies.map(function () { return 0; }).concat([0]);
    m.servants.forEach(function (sv) { s0.push(0, 0, sv.inv, -1, 0); });
    var cur = new Map(), peak = 1, t, base = 0, next, work = 0, over = false;
    var emit = function (p, s) {
      if (++work + X.dmg.ops / 1000 > maxWork) over = true;   // 计数的 1000 次加法约等于展开一个分支
      if (over) return;
      p *= base;
      if (!(p > 0)) return;
      X.canon(s, t);
      var k = flatKey(s, E), v = next.get(k);
      if (v) v.p += p; else next.set(k, { s: s, p: p });
    };
    cur.set(flatKey(s0, E), { s: s0, p: 1 });
    for (t = 0; t < m.slots.length; t++) {
      next = new Map();
      cur.forEach(function (v) {
        if (over) return;
        if (v.s[E]) { base = 1; emit(v.p, v.s); return; }
        base = v.p;
        X.step(v.s, t, emit);
      });
      cur = next;
      peak = Math.max(peak, cur.size);
      if (over || cur.size > maxStates) return null;
    }
    var res = emptyResult(m);
    cur.forEach(function (v) {
      var s = v.s;
      tally(m, res, {
        end: s[E] === 1 ? 'guts' : s[E] === 2 ? 'taunt' : null,
        sv: m.servants.map(function (sv, i) {
          var o = E + 1 + SV * i;
          return sv.mortal ? { dead: !!s[o + DEAD], life: s[o + LIFE] } : null;
        }),
      }, v.p);
    });
    res.exact = true;
    res.states = peak;
    res.work = work;
    return res;
  }

  // ---------------------------------------------------------------- 模拟（与精确计算分开实现同一套规则，测试时互相对照）

  /** 结束时的一个状态计入结果：s = { end, sv: [{ dead, life } | null] } */
  function tally(m, res, s, p) {
    var mustAlive = false, keepDead = false;
    m.servants.forEach(function (sv, i) {
      var x = s.sv[i];
      if (!x) return;
      if (x.dead) res.servants[i].out += p;
      if (x.life > 0) res.servants[i].guts += p;
      if (sv.role === 'must' && !x.dead) mustAlive = true;
      if (sv.role === 'keep' && x.dead) keepDead = true;
    });
    if (mustAlive || keepDead) res.fail += p; else res.success += p;
    if (mustAlive) res.mustAlive += p;
    if (keepDead) res.keepDead += p;
    if (s.end === 'guts') res.endGuts += p;
    if (s.end === 'taunt') res.endTaunt += p;
  }

  function emptyResult(m) {
    return {
      success: 0, fail: 0, mustAlive: 0, keepDead: 0, endGuts: 0, endTaunt: 0,
      servants: m.servants.map(function () { return { out: 0, guts: 0 }; }),
    };
  }

  /**
   * 模拟 runs 次（rand() → [0, 1)，默认 Math.random）。结果格式同 compute，另有 exact: false、runs。
   */
  function simulate(cfg, runs, rand) {
    var m = model(cfg), dmg = new Damage(), res = emptyResult(m);
    rand = rand || Math.random;
    runs = runs || SIM_RUNS;
    var N = m.servants.length, E = m.enemies.length, R = KP.RAND_COUNT, T = m.slots.length, i, k;
    var mortal = m.servants.map(function (sv) { return sv.mortal; });
    var taunt = m.servants.map(function (sv) { return sv.taunt; });
    var weight = m.servants.map(function (sv) { return sv.weight; });
    var hps = m.servants.map(function (sv) { return sv.hps; });
    var cum = m.enemies.map(function (e) { var acc = 0; return e.kinds.map(function (kd) { acc += kd.p; return acc; }); });
    var outs = m.enemies.map(function (e, j) {
      return e.all.map(function (kind) {
        return m.servants.map(function (sv, x) { return !sv.mortal || kind.none ? null : dmg.outcomes(hitAvg(m, j, kind, x)); });
      });
    });
    var dead = new Uint8Array(N), life = new Int32Array(N), inv = new Int32Array(N), ban = new Int32Array(N);
    var taken = new Float64Array(N), q = new Int32Array(E), legal = new Int32Array(N), targets = new Int32Array(N);
    var cross = new Int32Array(N), revived = new Int32Array(N);
    var sv = m.servants.map(function () { return { dead: false, life: 0 }; }), state = { end: null, sv: [] };
    for (var n = 0; n < runs; n++) {
      var end = 0;
      for (i = 0; i < N; i++) { dead[i] = 0; life[i] = 0; inv[i] = m.servants[i].inv; ban[i] = -1; taken[i] = 0; }
      for (k = 0; k < E; k++) q[k] = 0;
      for (var t = 0; t < T && !end; t++) {
        var j = m.slots[t], e = m.enemies[j], qi = q[j], isNP = e.presets[qi];
        if (!isNP && qi === 0 && e.skill > 0 && rand() < e.skill) { q[j]++; ban.fill(-1); continue; }
        var anyTaunt = false, nl = 0, wsum = 0, na = 0;
        for (i = 0; i < N; i++) if ((!mortal[i] || !dead[i]) && taunt[i]) anyTaunt = true;
        for (i = 0; i < N; i++) {
          if (mortal[i] && dead[i]) continue;
          targets[na++] = i;
          if ((!anyTaunt || taunt[i]) && ban[i] !== j) { legal[nl++] = i; wsum += weight[i]; }
        }
        if (!nl) { ban.fill(-1); continue; }               // 没有合法目标：跳过，预设动作顺延
        var kind;
        if (isNP) kind = e.npKind;
        else {
          var x = rand() * cum[j][cum[j].length - 1];
          for (k = 0; k < e.kinds.length - 1 && x >= cum[j][k]; k++);
          kind = e.kinds[k];
        }
        if (!kind.aoe) {
          var y = rand() * wsum;
          for (k = 0; k < nl - 1; k++) { y -= weight[legal[k]]; if (y < 0) break; }
          targets[0] = legal[k];
          na = 1;
        }
        q[j]++;
        ban.fill(-1);
        var nc = 0, ids = outs[j][kind.idx];
        for (k = 0; k < na; k++) {
          i = targets[k];
          if (!ids[i] || dead[i]) continue;
          if (inv[i] > 0) { inv[i]--; continue; }
          taken[i] += ids[i][Math.floor(rand() * R)];
          if (taken[i] >= hps[i][life[i]]) { cross[nc++] = i; taken[i] = 0; }
        }
        var nr = 0, count = 0;
        for (k = 0; k < nc; k++) {
          i = cross[k];
          if (life[i] + 1 < hps[i].length) { life[i]++; revived[nr++] = i; } else dead[i] = 1;
        }
        for (i = 0; i < N; i++) if (!mortal[i] || !dead[i]) count++;
        for (k = 0; k < nr; k++) {
          i = revived[k];
          if (count === 1 && !m.backup) { if (!end) end = 1; } else if (!kind.np || taunt[i] || count === 1) ban[i] = j;
        }
        if (m.taunted && !end) {
          var standing = false;
          for (i = 0; i < N; i++) if (taunt[i] && (!mortal[i] || !dead[i])) standing = true;
          if (!standing) end = 2;
        }
      }
      for (i = 0; i < N; i++) { sv[i].dead = !!dead[i]; sv[i].life = life[i]; state.sv[i] = mortal[i] ? sv[i] : null; }
      state.end = end === 1 ? 'guts' : end === 2 ? 'taunt' : null;
      tally(m, res, state, 1);
    }
    scale(res, 1 / runs);
    res.exact = false;
    res.runs = runs;
    return res;
  }

  function scale(res, k) {
    ['success', 'fail', 'mustAlive', 'keepDead', 'endGuts', 'endTaunt'].forEach(function (f) { res[f] *= k; });
    res.servants.forEach(function (x) { x.out *= k; x.guts *= k; });
  }

  /** 精确计算；计算量太大时改用模拟（默认模拟 SIM_ACTIONS ÷ 行动数 次，至少 5 万次、最多 SIM_RUNS 次） */
  function run(cfg, opts) {
    var r = compute(cfg, opts);
    if (r) return r;
    var runs = opts && opts.runs;
    if (!runs) runs = Math.max(50000, Math.min(SIM_RUNS, Math.floor(SIM_ACTIONS / model(cfg).slots.length)));
    return simulate(cfg, runs);
  }

  var api = {
    MAX_ENEMIES: MAX_ENEMIES, MAX_ACTIONS: MAX_ACTIONS, MAX_SERVANTS: MAX_SERVANTS, MAX_INV: MAX_INV, MAX_GUTS: MAX_GUTS,
    MAX_STATES: MAX_STATES, MAX_WORK: MAX_WORK, SIM_RUNS: SIM_RUNS, DECKS: DECKS, ROLES: ROLES,
    model: model, compute: compute, simulate: simulate, run: run, withSL: KP.withSL,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Send = api;
})(typeof self !== 'undefined' ? self : this);
