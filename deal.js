/*
 * 发牌概率计算核心（JavaScript）。不依赖浏览器：网页、Node（测试）、以后的微信小程序都能直接使用。
 * 结果由 tests/test_web_deal.py 与「逐一枚举所有发牌结果」的 Python 版对照验证，并与 Excel 计算器的发牌概率表一致。
 *
 * 发牌机制：
 *     场上 k 名从者（k = 3 或 2），每人 5 张指令卡，牌库共 N = 5k 张。
 *     牌库随机洗好后，第 1 回合发出前 5 张，第 2 回合发出接下来的 5 张……k 个回合发完后重新洗牌。
 *     所以每种发牌结果的可能性都相同。
 *
 * 以「打手」为主视角：只关心打手的 5 张牌分别在哪个回合发出；其他从者的牌只看张数，不看颜色。
 * 打手的牌按「种类」分组：开了纹章的牌各自独一无二；没开纹章的同色牌彼此不区分。
 *
 * 公式（多元超几何分布）：
 *     第 1 回合打手各种类的牌恰好发出 y 张的组合数 = Π C(n_种类, y_种类) × C(N − 5, 5 − Σy)
 *         （N − 5 = 其他从者的牌数），除以 C(N, 5) 即为概率。
 *     前两回合：第 2 回合从剩下的 N − 5 张里发 5 张，其中打手每种牌还剩 n_种类 − y1_种类 张（合计 5 − Σy1 张），
 *         其他从者还剩 N − 10 + Σy1 张：
 *         组合数 = Π C(n_种类 − y1_种类, y2_种类) × C(N − 10 + Σy1, 5 − Σy2)，总数 = C(N, 5) × C(N − 5, 5)。
 *     「仅含」：y 恰好等于指定的牌；「包含」：对所有 y ≥ 指定的牌求和
 *         （前两回合时对 (y1, y2) 一起求和：第 1 回合多发的牌会让第 2 回合可用的牌变少，所以不会算错）。
 */
(function (root) {
  'use strict';

  var COLORS = ['B', 'A', 'Q'];
  var DECKS = ['BBBAQ', 'BBAAQ', 'BBAQQ', 'BAAQQ', 'BAAAQ', 'BAQQQ'];   // 每名从者 5 张牌的全部 6 种配卡
  var HAND = 5;                                                         // 每回合发 5 张

  /** 组合数 C(n, k)；这里 n 不超过 15，双精度下完全精确 */
  function comb(n, k) {
    if (k < 0 || n < 0 || k > n) return 0;
    var r = 1;
    for (var i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }

  function gcd(a, b) {
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  /** 由配卡（如 'BBAAQ'）和纹章开关得到打手的 5 张牌 [{ color, marked }] */
  function deckCards(deck, marked) {
    return deck.split('').map(function (color, i) { return { color: color, marked: !!(marked && marked[i]) }; });
  }

  /**
   * 把打手的牌分成种类：开了纹章的牌各成一类；没开纹章的同色牌为一类。
   * 返回 [{ key, color, marked, size, members }]，按 B、A、Q 排序，同色时纹章牌在前。
   */
  function cardTypes(cards) {
    var types = [], byKey = {};
    cards.forEach(function (card, i) {
      var key = card.marked ? 'm' + i : card.color;
      if (!byKey[key]) {
        byKey[key] = { key: key, color: card.color, marked: !!card.marked, size: 0, members: [] };
        types.push(byKey[key]);
      }
      byKey[key].size++;
      byKey[key].members.push(i);
    });
    types.sort(function (a, b) {
      return COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || (b.marked - a.marked) || (a.members[0] - b.members[0]);
    });
    return types;
  }

  /** 第 t 回合可能发出的打手牌张数向量 y：仅含时 y = need；包含时 need ≤ y ≤ remaining */
  function candidates(remaining, need, exact) {
    if (exact) {
      return need.every(function (v, j) { return v <= remaining[j]; }) ? [need.slice()] : [];
    }
    var out = [];
    (function walk(j, y) {
      if (j === remaining.length) { out.push(y.slice()); return; }
      for (var v = need[j]; v <= remaining[j]; v++) { y.push(v); walk(j + 1, y); y.pop(); }
    })(0, []);
    return out;
  }

  function sum(v) {
    return v.reduce(function (s, x) { return s + x; }, 0);
  }

  /**
   * 计算发牌概率。
   *   servants: 场上从者数（3 或 2），牌库 N = 5 × servants
   *   cards:    打手的 5 张牌 [{ color, marked }]（可用 deckCards() 生成）
   *   turns:    每个回合要求发出的打手牌的下标，例如 [[0, 1]] = 第 1 回合要 0、1 号牌；
   *             [[0, 1], [2, 3, 4]] = 第 1 回合要 0、1 号，第 2 回合要 2、3、4 号
   *   mode:     'include'（包含：至少发出这些牌，允许同时发出打手的其他牌）
   *             'exact'  （仅含：该回合发出的打手牌恰好是这些）
   * 返回 { favorable, total, probability, types, need, turnTotals, terms }：
   *   favorable / total 为满足条件的发牌组合数 / 全部组合数（未约分）；
   *   terms 为求和的每一项 [{ turns: [{ y, others, factors, ways }], ways }]，用于显示计算过程。
   */
  function dealProbability(opts) {
    var servants = opts.servants, N = HAND * servants, T = opts.turns.length;
    if (T < 1 || T > servants) throw new Error('回合数应为 1 ~ ' + servants);
    if (opts.cards.length !== HAND) throw new Error('打手应有 5 张牌');

    var types = cardTypes(opts.cards), typeOf = [];
    types.forEach(function (type, j) { type.members.forEach(function (i) { typeOf[i] = j; }); });
    var used = {};
    var need = opts.turns.map(function (indices) {
      var v = types.map(function () { return 0; });
      indices.forEach(function (i) {
        if (used[i]) throw new Error('同一张牌不能指定在两个回合');
        used[i] = true;
        v[typeOf[i]]++;
      });
      return v;
    });
    var exact = opts.mode === 'exact';

    var turnTotals = [];
    for (var t = 0; t < T; t++) turnTotals.push(comb(N - HAND * t, HAND));
    var total = turnTotals.reduce(function (p, x) { return p * x; }, 1);

    var favorable = 0, terms = [];
    (function step(t, remaining, othersLeft, picked, ways) {
      if (t === T) { favorable += ways; terms.push({ turns: picked.slice(), ways: ways }); return; }
      candidates(remaining, need[t], exact).forEach(function (y) {
        var k = sum(y);
        if (k > HAND) return;
        var factors = [], w = 1;
        y.forEach(function (v, j) {
          if (v > 0) factors.push({ n: remaining[j], k: v });
          w *= comb(remaining[j], v);
        });
        factors.push({ n: othersLeft, k: HAND - k, others: true });
        w *= comb(othersLeft, HAND - k);
        if (!w) return;
        picked.push({ y: y, others: HAND - k, factors: factors, ways: w });
        step(t + 1, remaining.map(function (r, j) { return r - y[j]; }), othersLeft - (HAND - k), picked, ways * w);
        picked.pop();
      });
    })(0, types.map(function (type) { return type.size; }), N - HAND, [], 1);

    return {
      favorable: favorable, total: total, probability: favorable / total,
      types: types, need: need, turnTotals: turnTotals, terms: terms, servants: servants, mode: opts.mode,
    };
  }

  var api = {
    COLORS: COLORS, DECKS: DECKS, HAND: HAND,
    comb: comb, gcd: gcd, deckCards: deckCards, cardTypes: cardTypes, dealProbability: dealProbability,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Deal = api;
})(typeof self !== 'undefined' ? self : this);
