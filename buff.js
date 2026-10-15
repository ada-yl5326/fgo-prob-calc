/*
 * buff 成功率的计算核心（不依赖浏览器，tests/test_web_buff.py 用 Node 对照验证）。规则见《世界线规则.md》。
 *
 * 一个 buff 组 = 好几个 buff，每个 buff 单独判定、单独 SL：
 *     普通 buff：成功率 p
 *     二项分布 buff：一个技能判定 n 次（例如一次打 n 个目标），第 i 次的成功率 pᵢ（可以都相同），
 *                     命中次数「至少 / 恰好 / 至多」x 次才算成功：
 *                     命中次数的分布用逐次卷积算（pᵢ 都相同时就是二项分布 C(n,k) pᵏ (1−p)ⁿ⁻ᵏ）
 *     SL n 次后 = 1 − (1 − 单次成功率)^(n+1)（整个 buff 一起重抽）
 * 放在我方行动阶段：buff 组的成功率 = Π 各 buff SL 后的成功率（一个技能 SL 完才判定下一个，前面的结果保留）；
 * 放在敌方行动阶段：每条世界线重新判定一次，不能单独 SL：成功率 = Π 各 buff 的单次成功率。
 */
(function (root) {
  'use strict';

  var MAX_ITEMS = 10;                                    // 一个 buff 组最多几个 buff
  var MAX_N = 100;                                       // 二项分布最多判定几次
  var MAX_EACH = 10;                                     // 每次成功率分别填时最多几次
  var MODES = ['atLeast', 'exactly', 'atMost'];          // 至少 / 恰好 / 至多

  /** SL n 次后 = 1 − (1 − p)^(n+1) */
  function withSL(p, sl) {
    if (p <= 0 || p >= 1 || !sl) return p;
    return -Math.expm1((sl + 1) * Math.log1p(-p));
  }

  /** 命中次数的分布：dist[k] = 恰好命中 k 次的概率（每次的成功率 ps[i]，互相独立） */
  function countDist(ps) {
    var dist = [1];
    ps.forEach(function (p) {
      var next = new Array(dist.length + 1).fill(0);
      for (var k = 0; k < dist.length; k++) {
        next[k] += dist[k] * (1 - p);
        next[k + 1] += dist[k] * p;
      }
      dist = next;
    });
    return dist;
  }

  /**
   * 一个 buff 的单次成功率。
   * item: { type: 'plain', p } 或 { type: 'binom', ps: [每次的成功率], x, mode: 'atLeast' | 'exactly' | 'atMost' }
   * 二项分布另外返回 dist（命中次数的分布）
   */
  function itemRate(item) {
    if (item.type !== 'binom') return { single: Math.min(1, Math.max(0, item.p)) };
    var dist = countDist(item.ps), x = item.x, s = 0;
    for (var k = 0; k < dist.length; k++) {
      if (item.mode === 'exactly' ? k === x : item.mode === 'atMost' ? k <= x : k >= x) s += dist[k];
    }
    return { single: Math.min(1, Math.max(0, s)), dist: dist };
  }

  /**
   * items: [{ type, p | ps, x, mode, sl }] → {
   *   items: [{ single: 单次成功率, final: SL 后, sl, dist? }],
   *   my: 放在我方行动阶段的成功率（Π SL 后）, enemy: 放在敌方行动阶段的成功率（Π 单次）
   * }
   */
  function evaluate(items) {
    var out = items.map(function (it) {
      var r = itemRate(it), sl = it.sl || 0;
      return { single: r.single, final: withSL(r.single, sl), sl: sl, dist: r.dist };
    });
    return {
      items: out,
      my: out.reduce(function (a, r) { return a * r.final; }, 1),
      enemy: out.reduce(function (a, r) { return a * r.single; }, 1),
    };
  }

  var api = { MAX_ITEMS: MAX_ITEMS, MAX_N: MAX_N, MAX_EACH: MAX_EACH, MODES: MODES, withSL: withSL, countDist: countDist, itemRate: itemRate, evaluate: evaluate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Buff = api;
})(typeof self !== 'undefined' ? self : this);
