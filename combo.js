/*
 * 综合击破概率的计算核心（不依赖浏览器，tests/test_web_combo.py 用 Node 对照验证）。
 *
 * 方案：若干个回合；每个回合可以放一个伤害组（这一回合的击破率，已含 SL），
 * 发牌组按它的共享范围占连续的 1 ~ 3 个回合，放在第 k 回合表示第 k 回合重新洗牌、这几个回合共享一轮发牌。
 *
 *     综合击破率 = Π 各回合的击破率 × Π 各发牌组的发牌概率
 *
 * 能直接相乘的原因：每轮洗牌之间互相独立；击破率是「发到了指定的牌」前提下的条件概率，伤害随机数与发牌无关，
 * 每回合也各自独立。同一轮洗牌里的几个回合不独立，所以用发牌组的「共享发牌概率」整体计算，不能拆开相乘。
 * 没放伤害组的回合按 100%（不需要击破），没被发牌组占用的回合按 100%（不要求发牌）。
 *
 * 洗牌：3 人每 3 回合洗一次（2 人每 2 回合）；周期内有从者退场时，下一回合立刻洗牌。
 * 发牌组放的位置如果不是正常的洗牌回合，就要求前一回合有从者退场（页面会标出来，但无法替用户确认）。
 *
 * 按条件分配伤害（发牌组有「或者」的几种条件时，不同的牌型打出的伤害不同）：
 *     被发牌组占用的回合，击破格可以分成「条件 1 … 条件 n / 其他」，每格放一个伤害组。
 *     这一轮洗牌里只要有回合分了条件，就不能再把击破率和发牌概率分开相乘，改为：
 *         每种条件的价值 v_k = 这一轮各回合在条件 k 下的击破率之积（分了条件的回合用条件 k 那格，其余回合用原来的伤害组）；
 *         一手牌满足好几种条件时按 v 最高的那种打，所以按 v 从高到低划分发牌结果（deal.js 的 regionCounts）：
 *         这一轮的成功率 = Σ 第 i 块的组合数 × v_第 i 块 / 全部组合数 + 「其他」（一种条件都不满足）的组合数 × v_其他 / 全部组合数
 *     「其他」那格没放伤害组 = 没满足条件就失败（v_其他 = 0）；条件格没放伤害组 = 这一回合不需要击破（100%）。
 *     几种条件只在同一个回合有差别时这样算是精确的；在不同回合都有差别时，相当于「看到后面的牌再决定按哪种打」，结果略偏高。
 */
(function (root) {
  'use strict';

  var MAX_TURNS = 20;

  /**
   * plan:  { turns, kill: [伤害组 id | null] × turns, deal: [{ at: 从第几回合开始（0 起）, id }],
   *          split: [null | { alts: [伤害组 id | null] × 条件数, other: 伤害组 id | null }] × turns（可省略） }
   * kill(id) → { name, rate: SL 后的击破率 | null（没输入完整） }
   * deal(id) → { name, rate: 发牌概率 | null（条件有误）, span: 占几个回合, servants: 场上人数,
   *              alts: 条件数, regions(order) → { counts, other, total }（按优先顺序划分发牌结果，见 deal.js 的 regionCounts） }
   * 返回 {
   *   turns, value: 综合击破率 | null, problems: [说明],
   *   placements: [{ at, end, id, name, rate, span, servants, shown: 实际显示占几格, reshuffle: 'first' | 'natural' | 'forced', conflict: null | 文字 }],
   *   cover: 每回合被哪个发牌组占用（placements 的序号，-1 = 没有）,
   *   kills: 每回合 { id, name, rate } | null,
   *   splits: 每回合实际生效的分条件 { alts: [{ id, name, rate } | null], other: { id, name, rate } | null } | null（不在发牌组里的回合不生效）,
   *   blocks: 公式按洗牌分组 [{ from, to, placement: 序号 | -1, factors: [{ kind, turn, name, rate }] }]；
   *           分了条件的一轮只有一个 kind = 'mix' 的因子，带 to、regions: [{ alt: 条件序号 | 'other', count, value }]、total,
   *   factors: 全部不是 100% 的因子（按回合顺序），weakest: 最小的那个
   * }
   */
  function evaluate(plan, kill, deal) {
    var n = plan.turns, problems = [];
    var kills = [];
    for (var t = 0; t < n; t++) {
      var id = plan.kill[t];
      if (!id) { kills.push(null); continue; }
      var k = kill(id);
      kills.push({ id: id, name: k.name, rate: k.rate });
      if (k.rate === null) problems.push('T' + (t + 1) + ' 的「' + k.name + '」还没输入完整');
    }

    var placements = plan.deal.map(function (p) {
      var d = deal(p.id);
      return { at: p.at, id: p.id, name: d.name, rate: d.rate, span: d.span, servants: d.servants, end: p.at + d.span - 1, conflict: null,
        alts: d.alts || 1, regions: d.regions || null };
    }).sort(function (a, b) { return a.at - b.at; });

    var cycleStart = 0, cycleLen = placements.length ? placements[0].servants : 3;
    var cover = [];
    for (t = 0; t < n; t++) cover.push(-1);
    placements.forEach(function (p, i) {
      if (p.at === 0) p.reshuffle = 'first';
      else p.reshuffle = (p.at - cycleStart) % cycleLen === 0 ? 'natural' : 'forced';
      cycleStart = p.at;
      cycleLen = p.servants;
      var next = placements[i + 1];
      p.shown = Math.min(p.span, n - p.at, next ? next.at - p.at : Infinity);
      if (p.rate === null) p.conflict = '「' + p.name + '」的条件有误';
      else if (p.end >= n) p.conflict = '「' + p.name + '」占 ' + p.span + ' 个回合，超出了最后一回合';
      else if (next && p.end >= next.at) p.conflict = '「' + p.name + '」占 ' + p.span + ' 个回合，和 T' + (next.at + 1) + ' 的发牌组重叠';
      if (p.conflict) problems.push(p.conflict);
      for (var u = p.at; u < p.at + p.shown; u++) cover[u] = i;
    });

    // 分条件的回合：只有被发牌组占用时才生效；条件格按发牌组现在的条件数对齐（多出来的不算）
    var splits = [];
    for (t = 0; t < n; t++) {
      var sp = plan.split && plan.split[t], owner = cover[t] >= 0 ? placements[cover[t]] : null;
      if (!sp || !owner) { splits.push(null); continue; }
      var info = function (gid, label) {
        if (!gid) return null;
        var g = kill(gid);
        if (g.rate === null) problems.push('T' + (t + 1) + ' ' + label + '的「' + g.name + '」还没输入完整');
        return { id: gid, name: g.name, rate: g.rate };
      };
      var alts = [];
      for (var a = 0; a < (owner.alts || 1); a++) alts.push(info(sp.alts && sp.alts[a], '条件 ' + (a + 1)));
      splits.push({ alts: alts, other: info(sp.other, '其他情况') });
    }

    var blocks = [], factors = [];
    for (t = 0; t < n;) {
      var pi = cover[t], p = pi >= 0 ? placements[pi] : null;
      var to = p ? p.at + p.shown - 1 : t, f = [];
      var mixed = false;
      for (var v = t; v <= to; v++) if (splits[v]) mixed = true;
      if (mixed) {
        f.push(mixFactor(p, t, to, kills, splits));
      } else {
        for (v = t; v <= to; v++) {
          if (kills[v] && kills[v].rate !== 1) f.push({ kind: 'kill', turn: v, name: kills[v].name, rate: kills[v].rate });
        }
        if (p && p.rate !== 1) f.push({ kind: 'deal', turn: p.at, to: p.end, name: p.name, rate: p.rate });
      }
      blocks.push({ from: t, to: to, placement: pi, factors: f });
      factors = factors.concat(f);
      t = to + 1;
    }

    if (!problems.length && factors.some(function (f) { return f.rate === null; })) problems.push('有一轮分了条件的发牌组无法计算');
    var value = null;
    if (!problems.length) value = factors.reduce(function (acc, f) { return acc * f.rate; }, 1);
    var weakest = null;
    factors.forEach(function (f) { if (f.rate !== null && (!weakest || f.rate < weakest.rate)) weakest = f; });
    return { turns: n, value: value, problems: problems, placements: placements, cover: cover, kills: kills, splits: splits,
      blocks: blocks, factors: factors, weakest: weakest };
  }

  /** 分了条件的一轮洗牌（第 from ~ to 回合，发牌组 p）：按击破率从高到低划分发牌结果后加权求和 */
  function mixFactor(p, from, to, kills, splits) {
    var n = p.alts || 1, values = [], other = 1, ok = p.rate !== null && !!p.regions;
    var rateOf = function (x) { if (x && x.rate === null) ok = false; return x ? x.rate : 1; };
    for (var k = 0; k < n; k++) {
      var val = 1;
      for (var t = from; t <= to; t++) val *= splits[t] ? rateOf(splits[t].alts[k]) : rateOf(kills[t]);
      values.push(val);
    }
    for (t = from; t <= to; t++) other *= splits[t] ? (splits[t].other ? rateOf(splits[t].other) : 0) : rateOf(kills[t]);
    var f = { kind: 'mix', turn: from, to: to, name: p.name, rate: null, regions: [], total: null };
    if (!ok) return f;
    var order = values.map(function (val, i) { return i; }).sort(function (a, b) { return values[b] - values[a] || a - b; });
    var reg = p.regions(order), sum = 0;
    order.forEach(function (k, i) {
      f.regions.push({ alt: k, count: reg.counts[i], value: values[k] });
      sum += reg.counts[i] * values[k];
    });
    f.regions.push({ alt: 'other', count: reg.other, value: other });
    sum += reg.other * other;
    f.total = reg.total;
    f.rate = sum / reg.total;
    return f;
  }

  /**
   * 在第 at 回合放一个发牌组：去掉与它占用的回合重叠的其他发牌组；回合不够时自动增加。
   * spanOf(id) → 发牌组占几个回合；moveFrom = 从方案里拖过来的那一项的序号（移动时先去掉原来的）
   */
  function placeDeal(plan, id, at, spanOf, moveFrom) {
    var span = spanOf(id), end = at + span - 1;
    plan.deal = plan.deal.filter(function (p, i) {
      return i !== moveFrom && (p.at + spanOf(p.id) - 1 < at || p.at > end);
    });
    plan.deal.push({ at: at, id: id });
    plan.deal.sort(function (a, b) { return a.at - b.at; });
    ensureTurns(plan, Math.min(MAX_TURNS, end + 1));
  }

  function ensureTurns(plan, n) {
    while (plan.turns < n) { plan.turns++; plan.kill.push(null); if (plan.split) plan.split.push(null); }
  }

  var api = { MAX_TURNS: MAX_TURNS, evaluate: evaluate, placeDeal: placeDeal, ensureTurns: ensureTurns };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Combo = api;
})(typeof self !== 'undefined' ? self : this);
