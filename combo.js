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
 */
(function (root) {
  'use strict';

  var MAX_TURNS = 20;

  /**
   * plan:  { turns, kill: [伤害组 id | null] × turns, deal: [{ at: 从第几回合开始（0 起）, id }] }
   * kill(id) → { name, rate: SL 后的击破率 | null（没输入完整） }
   * deal(id) → { name, rate: 发牌概率 | null（条件有误）, span: 占几个回合, servants: 场上人数 }
   * 返回 {
   *   turns, value: 综合击破率 | null, problems: [说明],
   *   placements: [{ at, end, id, name, rate, span, servants, shown: 实际显示占几格, reshuffle: 'first' | 'natural' | 'forced', conflict: null | 文字 }],
   *   cover: 每回合被哪个发牌组占用（placements 的序号，-1 = 没有）,
   *   kills: 每回合 { id, name, rate } | null,
   *   blocks: 公式按洗牌分组 [{ from, to, placement: 序号 | -1, factors: [{ kind, turn, name, rate }] }],
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
      return { at: p.at, id: p.id, name: d.name, rate: d.rate, span: d.span, servants: d.servants, end: p.at + d.span - 1, conflict: null };
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

    var blocks = [], factors = [];
    for (t = 0; t < n;) {
      var pi = cover[t], p = pi >= 0 ? placements[pi] : null;
      var to = p ? p.at + p.shown - 1 : t, f = [];
      for (var v = t; v <= to; v++) {
        if (kills[v] && kills[v].rate !== 1) f.push({ kind: 'kill', turn: v, name: kills[v].name, rate: kills[v].rate });
      }
      if (p && p.rate !== 1) f.push({ kind: 'deal', turn: p.at, to: p.end, name: p.name, rate: p.rate });
      blocks.push({ from: t, to: to, placement: pi, factors: f });
      factors = factors.concat(f);
      t = to + 1;
    }

    var value = null;
    if (!problems.length) value = factors.reduce(function (acc, f) { return acc * f.rate; }, 1);
    var weakest = null;
    factors.forEach(function (f) { if (f.rate !== null && (!weakest || f.rate < weakest.rate)) weakest = f; });
    return { turns: n, value: value, problems: problems, placements: placements, cover: cover, kills: kills, blocks: blocks, factors: factors, weakest: weakest };
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
    while (plan.turns < n) { plan.turns++; plan.kill.push(null); }
  }

  var api = { MAX_TURNS: MAX_TURNS, evaluate: evaluate, placeDeal: placeDeal, ensureTurns: ensureTurns };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Combo = api;
})(typeof self !== 'undefined' ? self : this);
