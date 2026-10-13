/*
 * 击破概率计算核心（JavaScript 版）。结果与 Python 版 killprob/core.py 完全一致（tests/test_web_core.py 对照验证）。
 * 不依赖浏览器：网页、Node（测试）、以后的微信小程序都能直接使用。
 *
 * 游戏机制与取整规则同 core.py：
 *     随机数 = 1.0 + a / 1000      （a = -100 ~ 99，共 200 个值，等概率，每张卡独立）
 *     单卡伤害 = 向下取整(随机数 × 均伤)，取整前先按 15 位有效数字修整浮点误差（与 Excel 的 ROUNDDOWN 一致）
 *     各卡伤害之和 >= HP 即为击破
 *
 * 精确计算的做法与 Python 版不同，但结果相同：
 *     单卡伤害都是整数，几张卡相加在双精度下没有任何舍入误差（远小于 2^53），相加顺序不影响结果。
 *     所以把卡分成前两张、后两张，各自列出全部 200² = 40000 种和并排序，
 *     再用双指针数出 a + b >= HP 的组合数——手机上几毫秒即可（Python 版的 200³ 排序在手机上太慢）。
 */
(function (root) {
  'use strict';

  var RAND_COUNT = 200;
  var RAND_VALUES = [];                                  // 0.900 ~ 1.099
  for (var a = -100; a < 100; a++) RAND_VALUES.push(1.0 + a / 1000);
  var MAX_CARDS = 4;                                     // 一回合 3 张 + EX

  /** 与 Excel 的 ROUNDDOWN(x, 0) 一致的向下取整：先按 15 位有效数字修整浮点误差，再向下取整 */
  function excelFloor(x) {
    return Math.floor(Number(x.toPrecision(15)));
  }

  /** 一张卡在 200 个随机数下的全部实际伤害（从小到大） */
  function cardOutcomes(avgDamage) {
    var out = new Float64Array(RAND_COUNT);
    for (var i = 0; i < RAND_COUNT; i++) out[i] = excelFloor(RAND_VALUES[i] * avgDamage);
    return out;
  }

  /** 若干张卡所有随机数组合的伤害和（200^k 个），从小到大排序 */
  function sortedSums(cards) {
    var s = new Float64Array([0]);
    for (var c = 0; c < cards.length; c++) {
      var card = cards[c], t = new Float64Array(s.length * card.length), k = 0;
      for (var i = 0; i < s.length; i++) {
        for (var j = 0; j < card.length; j++) t[k++] = s[i] + card[j];
      }
      s = t;
    }
    return s.sort();                                     // TypedArray 的 sort 按数值排序
  }

  /**
   * 预处理均伤（只和均伤有关，改 HP 时不用重算）。
   * 返回 { a, b, total, min, max, mean }：a、b 为前两张 / 后两张卡的全部伤害和；
   * total = 组合总数 200^n；min / max = 随机数全部为 0.900 / 1.099 时的总伤害；mean = 总伤害的平均值。
   */
  function prepare(avgDamages) {
    if (avgDamages.length > MAX_CARDS) throw new Error('精确计算最多支持 ' + MAX_CARDS + ' 张卡');
    var cards = avgDamages.map(cardOutcomes);
    var mean = 0;
    cards.forEach(function (card) {
      for (var i = 0; i < RAND_COUNT; i++) mean += card[i] / RAND_COUNT;
    });
    var a = sortedSums(cards.slice(0, 2)), b = sortedSums(cards.slice(2));
    return {
      a: a, b: b, total: a.length * b.length,
      min: a[0] + b[0], max: a[a.length - 1] + b[b.length - 1], mean: mean,
    };
  }

  /** 总伤害 >= x 的组合数 */
  function countAtLeast(prep, x) {
    var a = prep.a, b = prep.b, n = b.length, j = n, count = 0;
    for (var i = 0; i < a.length; i++) {                 // a 从小到大，满足 a[i] + b[j] >= x 的 j 只会越来越靠前
      while (j > 0 && a[i] + b[j - 1] >= x) j--;
      count += n - j;
    }
    return count;
  }

  /** 精确计算：返回 { probability, kills, total, exact }，与 Python 版 exact() 相同 */
  function exact(avgDamages, hp) {
    var prep = prepare(avgDamages), kills = countAtLeast(prep, hp);
    return { probability: kills / prep.total, kills: kills, total: prep.total, exact: true };
  }

  /** 总伤害的最小值和最大值，与 Python 版 damage_range() 相同 */
  function damageRange(avgDamages) {
    var prep = prepare(avgDamages);
    return [prep.min, prep.max];
  }

  /**
   * 总伤害分布（用于画柱状图）：把 [min, max] 分成约 maxBins 段，每段宽度为整数。
   * HP 在范围内时，让 HP 正好落在分段边界上，这样每段要么全部击破、要么全部未击破。
   * 返回 [{ from, to, count }]：总伤害在 from ~ to（含两端）的组合数。
   */
  function histogram(prep, hp, maxBins) {
    var lo = prep.min, hi = prep.max;
    var width = Math.max(1, Math.ceil((hi - lo + 1) / maxBins));
    var h = Math.ceil(hp);                               // 总伤害是整数：>= hp 等价于 >= ceil(hp)
    var anchor = h > lo && h <= hi ? h : lo;
    var start = anchor - Math.ceil((anchor - lo) / width) * width;
    var edges = [];
    for (var e = start; e <= hi; e += width) edges.push(e);
    edges.push(e);
    var atLeast = edges.map(function (x) { return countAtLeast(prep, x); });
    var bins = [];
    for (var k = 0; k + 1 < edges.length; k++) {
      bins.push({ from: edges[k], to: edges[k + 1] - 1, count: atLeast[k] - atLeast[k + 1] });
    }
    return bins;
  }

  /**
   * 累积概率曲线（用于画图）：在等间距（间距为整数）的点 x 上计算「总伤害 >= x」的组合数，
   * 也就是 HP 为 x 时的击破组合数。把 [min, max+1] 分成约 segments 段：
   * 第一个点是 min（必定 >= min，即 100%），最后一个点是 max+1（0%）；
   * HP 在范围内时正好是其中一个点，所以曲线经过「HP，击破率」。
   * 返回 [{ x, count }]，x 从小到大，count 从 total 降到 0。
   */
  function curve(prep, hp, segments) {
    var lo = prep.min, hi = prep.max;
    var width = Math.max(1, Math.ceil((hi - lo + 1) / segments));
    var h = Math.ceil(hp);                               // 总伤害是整数：>= hp 等价于 >= ceil(hp)
    var anchor = h > lo && h <= hi ? h : lo;
    var start = anchor - Math.ceil((anchor - lo) / width) * width;
    var xs = [];
    for (var e = start; e <= hi; e += width) xs.push(Math.max(lo, e));   // 第一个点不早于 min
    xs.push(hi + 1);                                      // 最后一个点：max+1
    return xs.map(function (x) { return { x: x, count: countAtLeast(prep, x) }; });
  }

  /**
   * SL（失败后重来）n 次后的击破率：一共 n + 1 次机会，每次重新抽随机数、互相独立，至少击破一次：
   *     1 − (1 − p)^(n+1)
   * 用 log1p / expm1 计算，p 很小时也不损失精度。
   */
  function withSL(p, sl) {
    if (p <= 0 || p >= 1 || !sl) return p;
    return -Math.expm1((sl + 1) * Math.log1p(-p));
  }

  var api = {
    RAND_COUNT: RAND_COUNT, RAND_VALUES: RAND_VALUES, MAX_CARDS: MAX_CARDS,
    excelFloor: excelFloor, cardOutcomes: cardOutcomes, prepare: prepare, countAtLeast: countAtLeast,
    exact: exact, damageRange: damageRange, histogram: histogram, curve: curve, withSL: withSL,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KillProb = api;
})(typeof self !== 'undefined' ? self : this);
