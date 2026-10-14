/*
 * 发牌概率计算核心（JavaScript）。不依赖浏览器：网页、Node（测试）、以后的微信小程序都能直接使用。
 * 结果由 tests/test_web_deal.py 与「逐一枚举所有发牌结果」的 Python 版对照验证，并与 Excel 计算器的发牌概率表一致。
 *
 * 发牌机制：
 *     场上 k 名从者（k = 3 或 2），每人 5 张指令卡，牌库共 N = 5k 张。
 *     牌库随机洗好后，第 1 回合发出前 5 张，第 2 回合发出接下来的 5 张……k 个回合发完后重新洗牌。
 *     所以每种发牌结果的可能性都相同。
 *
 * 可以同时指定几名从者的牌（每名从者 5 张）；没有指定任何条件的从者，他的牌和其他牌一样只看张数，不看颜色。
 * 每名从者的牌按「种类」分组：开了纹章的牌各自独一无二；没开纹章的同色牌彼此不区分；不同从者的牌互不替代。
 *
 * 条件按「回合 × 从者」分别给出：
 *     包含：该回合至少发到指定的牌（没指定牌时 = 不限）；
 *     仅含：该回合发到的这名从者的牌恰好是指定的这些（没指定牌时 = 一张都不能有）。
 *
 * 公式（多元超几何分布）：
 *     第 1 回合各种类的牌恰好发出 y 张的组合数 = Π C(n_种类, y_种类) × C(其他牌数, 5 − Σy)，除以 C(N, 5) 即为概率。
 *     共享发牌（同一轮洗牌里的几个回合）：后一回合从剩下的牌里发，每种牌还剩 n_种类 − 前面发出的张数，
 *         组合数逐回合相乘，总数 = C(N, 5) × C(N − 5, 5) × …。
 *     「包含」对所有满足条件的 y 一起求和：前面回合多发的牌会让后面回合可用的牌变少，这些情况自动是 0，所以不会算错。
 *
 * 「或者」（几种条件满足任意一种）：用容斥原理，见 computeAny()。
 *
 * 快速算法：几个回合的组合数之积可以按种类拆开——
 *     Π_回合 Π_种类 C(剩余, y) = Π_种类 [n! / (y_1! … y_T! (n − Σy)!)]（每种牌分到各回合的分法），
 *     其他牌的组合数只和每回合发了几张指定从者的牌 k_t 有关。
 *     所以逐个种类累加「各回合已发张数 (k_1 … k_T)」的分布（最多 6³ = 216 种状态），最后乘上其他牌的组合数，
 *     几名从者、三个回合也只要几毫秒。计算过程只列出前几十项，用逐回合枚举的方式生成。
 */
(function (root) {
  'use strict';

  var COLORS = ['B', 'A', 'Q'];
  var DECKS = ['BBBAQ', 'BBAAQ', 'BBAQQ', 'BAAQQ', 'BAAAQ', 'BAQQQ'];   // 每名从者 5 张牌的全部 6 种配卡
  var HAND = 5;                                                         // 每回合发 5 张
  var FACT = [1, 1, 2, 6, 24, 120];                                     // 0! ~ 5!（一种牌最多 5 张）

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

  /** 由配卡（如 'BBAAQ'）和纹章开关得到一名从者的 5 张牌 [{ color, marked }] */
  function deckCards(deck, marked) {
    return deck.split('').map(function (color, i) { return { color: color, marked: !!(marked && marked[i]) }; });
  }

  /**
   * 把一名从者的牌分成种类：开了纹章的牌各成一类；没开纹章的同色牌为一类。
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

  function sum(v) {
    return v.reduce(function (s, x) { return s + x; }, 0);
  }

  /**
   * 一种牌（共 size 张）分到第 from ~ T−1 回合的全部分法 [{ y: [各回合张数], w: 分法数 }]：
   * 每回合 y_t ≥ need_t；仅含时 y_t = need_t；合计不超过 size（其余的在这几个回合之后才发）。
   */
  function splits(size, need, exact, from, T) {
    var out = [];
    (function walk(t, y, used, denom) {
      if (t === T) { out.push({ y: y.slice(), w: FACT[size] / (denom * FACT[size - used]) }); return; }
      var hi = exact[t] ? need[t] : size - used;
      for (var v = need[t]; v <= hi && used + v <= size; v++) {
        y.push(v);
        walk(t + 1, y, used + v, denom * FACT[v]);
        y.pop();
      }
    })(from, [], 0, 1);
    return out;
  }

  /**
   * 第 from ~ T−1 回合满足条件的发法数（快速算法）。
   *   sizes:  每种牌还剩几张；need[t][j] / exact[t][j]：第 t 回合第 j 种牌的要求
   *   others: 还剩几张「其他牌」
   * 返回 { ways: 发法数, count: 计算过程里的项数 }
   */
  function countWays(sizes, need, exact, from, T, others) {
    var n = T - from;
    if (n <= 0) return { ways: 1, count: 1 };
    var states = Math.pow(HAND + 1, n);                  // 状态 = 各回合已发的指定牌张数 k_t（0 ~ 5），按 6 进制编号
    var ways = new Float64Array(states), count = new Float64Array(states);
    ways[0] = 1; count[0] = 1;
    for (var j = 0; j < sizes.length; j++) {
      var opts = splits(sizes[j], need.map(function (v) { return v[j]; }), exact.map(function (v) { return v[j]; }), from, T);
      var nw = new Float64Array(states), nc = new Float64Array(states);
      for (var s = 0; s < states; s++) {
        if (!ways[s]) continue;
        for (var o = 0; o < opts.length; o++) {
          var y = opts[o].y, t2 = s, ok = true, mul = 1, digit;
          for (var t = 0; t < n; t++, mul *= HAND + 1) {
            digit = Math.floor(s / mul) % (HAND + 1);
            if (digit + y[t] > HAND) { ok = false; break; }
            t2 += y[t] * mul;
          }
          if (!ok) continue;
          nw[t2] += ways[s] * opts[o].w;
          nc[t2] += count[s];
        }
      }
      ways = nw; count = nc;
    }
    var total = 0, terms = 0;
    for (var st = 0; st < states; st++) {
      if (!ways[st]) continue;
      var left = others, f = 1;
      for (var u = 0, m = 1; u < n; u++, m *= HAND + 1) {
        var k = Math.floor(st / m) % (HAND + 1);
        f *= comb(left, HAND - k);
        left -= HAND - k;
      }
      if (!f) continue;
      total += ways[st] * f;
      terms += count[st];
    }
    return { ways: total, count: terms };
  }

  /** 第 t 回合可能发出的各种牌张数 y：need ≤ y ≤ 剩余（仅含时 y = need），合计不超过 5 */
  function candidates(remaining, need, exact) {
    var out = [];
    (function walk(j, y, used) {
      if (j === remaining.length) { out.push(y.slice()); return; }
      var hi = exact[j] ? need[j] : remaining[j];
      for (var v = need[j]; v <= hi && used + v <= HAND; v++) { y.push(v); walk(j + 1, y, used + v); y.pop(); }
    })(0, [], 0);
    return out;
  }

  /**
   * 计算发牌概率。
   *   servants: 场上从者数（3 或 2），牌库 N = 5 × servants
   *   turns:    算前几个回合（共享发牌，1 ~ servants）
   *   owners:   每名从者一项（最多 servants 项）：null = 不指定；或者
   *             { cards: 5 张牌 [{ color, marked }]（可用 deckCards() 生成），
   *               picks: 5 张牌各要求在第几回合发到（0 = 不要求，1 ~ turns），
   *               exact: 每个回合是否「仅含」[bool × turns] }
   *   maxTerms: 计算过程最多列出几项（默认 40；传 Infinity 列出全部）
   * 返回 { favorable, total, probability, servants, turns, N, others, owners（参与计算的从者序号）, types, need, exact,
   *        turnTotals, terms, termCount, truncated }：
   *   favorable / total 为满足条件的发牌组合数 / 全部组合数（未约分）；
   *   types 为参与计算的牌的种类 [{ owner, key, color, marked, size, members }]；
   *   terms 为计算过程的前几项 [{ turns: [{ y, others, factors, ways }], ways }]，termCount 为总项数。
   */
  function compute(opts) {
    var servants = opts.servants, N = HAND * servants, T = opts.turns;
    if (!(T >= 1 && T <= servants)) throw new Error('回合数应为 1 ~ ' + servants);
    var owners = opts.owners || [];
    if (owners.length > servants) throw new Error('最多 ' + servants + ' 名从者');
    var maxTerms = opts.maxTerms === undefined ? 40 : opts.maxTerms;

    // 只有给了条件（指定了牌，或某回合「仅含」）的从者才单独计算；其余从者的牌算作其他牌，结果完全相同
    var types = [], need = [], exact = [], used = [];
    for (var t = 0; t < T; t++) { need.push([]); exact.push([]); }
    owners.forEach(function (o, idx) {
      if (!o) return;
      if (o.cards.length !== HAND) throw new Error('每名从者应有 5 张牌');
      var picks = o.picks || [0, 0, 0, 0, 0], ex = o.exact || [];
      var active = picks.some(function (p) { return p >= 1 && p <= T; });
      for (var t = 0; t < T; t++) if (ex[t]) active = true;
      if (!active) return;
      used.push(idx);
      cardTypes(o.cards).forEach(function (type) {
        types.push({ owner: idx, key: idx + ':' + type.key, color: type.color, marked: type.marked, size: type.size, members: type.members });
        for (var t = 0; t < T; t++) {
          need[t].push(type.members.filter(function (i) { return picks[i] === t + 1; }).length);
          exact[t].push(!!ex[t]);
        }
      });
    });
    need.forEach(function (v, t) {
      if (sum(v) > HAND) throw new Error('第 ' + (t + 1) + ' 回合指定的牌超过 5 张');
    });

    var tracked = sum(types.map(function (type) { return type.size; }));
    var others = N - tracked;
    var turnTotals = [];
    for (t = 0; t < T; t++) turnTotals.push(comb(N - HAND * t, HAND));
    var total = turnTotals.reduce(function (p, x) { return p * x; }, 1);
    var sizes = types.map(function (type) { return type.size; });
    var fast = countWays(sizes, need, exact, 0, T, others);

    // 计算过程：逐回合枚举，只列出前 maxTerms 项；后面的回合已经不可能满足时跳过
    var terms = [];
    (function step(t, remaining, othersLeft, picked, ways) {
      if (terms.length >= maxTerms) return;
      if (t === T) { terms.push({ turns: picked.slice(), ways: ways }); return; }
      candidates(remaining, need[t], exact[t]).forEach(function (y) {
        if (terms.length >= maxTerms) return;
        var k = sum(y), factors = [], w = 1;
        y.forEach(function (v, j) {
          if (v > 0) factors.push({ n: remaining[j], k: v, type: j });
          w *= comb(remaining[j], v);
        });
        factors.push({ n: othersLeft, k: HAND - k, others: true });
        w *= comb(othersLeft, HAND - k);
        if (!w) return;
        var rest = remaining.map(function (r, j) { return r - y[j]; });
        if (t + 1 < T && !countWays(rest, need, exact, t + 1, T, othersLeft - (HAND - k)).ways) return;
        picked.push({ y: y, others: HAND - k, factors: factors, ways: w });
        step(t + 1, rest, othersLeft - (HAND - k), picked, ways * w);
        picked.pop();
      });
    })(0, sizes, others, [], 1);

    return {
      favorable: fast.ways, total: total, probability: fast.ways / total,
      servants: servants, turns: T, N: N, others: others, owners: used, types: types, need: need, exact: exact,
      turnTotals: turnTotals, terms: terms, termCount: fast.ways ? fast.count : 0, truncated: fast.ways ? terms.length < fast.count : false,
    };
  }

  /** 一名从者第 t 回合每种牌要发到几张：need[t][j]（只看 1 ~ T 回合） */
  function needOf(owner, types, T) {
    var picks = (owner && owner.picks) || [0, 0, 0, 0, 0], out = [];
    for (var t = 0; t < T; t++) {
      out.push(types.map(function (type) {
        return type.members.filter(function (i) { return picks[i] === t + 1; }).length;
      }));
    }
    return out;
  }

  /**
   * 两组条件同时满足时的条件（容斥原理用）。a、b 是 compute() 的参数：场上人数、回合数、各从者的牌相同，只有 picks / exact 不同。
   * 每名从者、每个回合、每种牌：
   *     包含 + 包含 → 包含，张数取较多的；
   *     仅含 + 包含 → 仅含，仅含的张数都不少于包含的才可能；
   *     仅含 + 仅含 → 两者完全相同才可能（没指定牌的仅含 = 一张都不能有）。
   * 再换算回「每张牌在第几回合发到」：同种牌按顺序分配，某种牌各回合合计超过这种牌的张数、或某回合超过 5 张时不可能。
   * 返回新的参数；不可能同时满足时返回 null。
   */
  function intersect(a, b) {
    var T = a.turns, owners = [], perTurn = [];
    for (var t = 0; t < T; t++) perTurn.push(0);
    for (var o = 0; o < a.servants; o++) {
      var oa = a.owners[o] || null, ob = b.owners[o] || null, base = oa || ob;
      if (!base) { owners.push(null); continue; }
      var types = cardTypes(base.cards), na = needOf(oa, types, T), nb = needOf(ob, types, T);
      var picks = [0, 0, 0, 0, 0], exact = [], need = [];
      for (t = 0; t < T; t++) {
        var ea = !!(oa && oa.exact && oa.exact[t]), eb = !!(ob && ob.exact && ob.exact[t]), row = [];
        for (var j = 0; j < types.length; j++) {
          var x = na[t][j], y = nb[t][j];
          if (ea && eb ? x !== y : ea ? x < y : eb ? y < x : false) return null;
          row.push(ea ? x : eb ? y : Math.max(x, y));
        }
        need.push(row);
        exact.push(ea || eb);
      }
      for (j = 0; j < types.length; j++) {
        var next = 0;
        for (t = 0; t < T; t++) {
          for (var c = 0; c < need[t][j]; c++) {
            if (next >= types[j].members.length) return null;          // 这种牌不够分
            picks[types[j].members[next++]] = t + 1;
          }
          perTurn[t] += need[t][j];
        }
      }
      owners.push({ cards: base.cards, picks: picks, exact: exact });
    }
    for (t = 0; t < T; t++) if (perTurn[t] > HAND) return null;
    return { servants: a.servants, turns: T, owners: owners };
  }

  /**
   * 几种条件满足任意一种（「或者」）的概率。list = 几组 compute() 的参数（场上人数、回合数、各从者的牌相同）。
   * 几种条件可能同时满足，直接相加会重复计算，所以用容斥原理：
   *     满足任意一种的组合数 = Σ 单个 − Σ 两两同时满足 + Σ 三个同时满足 − …
   * 「同时满足」的条件由 intersect() 得到，仍是普通的条件，用 compute() 精确计算；组合数都是整数，没有误差。
   * 返回 { favorable, total, probability, alternatives: 每种条件各自的 compute() 结果,
   *        parts: [{ set: 条件序号, sign: +1 / −1, favorable, opts: 同时满足时的条件（不可能时为 null） }] }
   */
  function computeAny(list, maxTerms) {
    var alternatives = list.map(function (q) {
      return compute({ servants: q.servants, turns: q.turns, owners: q.owners, maxTerms: maxTerms });
    });
    var k = list.length, favorable = 0, parts = [];
    for (var mask = 1; mask < (1 << k); mask++) {
      var set = [], opts = null, possible = true;
      for (var i = 0; i < k; i++) {
        if (!(mask & (1 << i))) continue;
        set.push(i);
        if (possible) opts = opts ? intersect(opts, list[i]) : list[i];
        if (!opts) possible = false;
      }
      var fav = set.length === 1 ? alternatives[set[0]].favorable
        : possible ? compute({ servants: opts.servants, turns: opts.turns, owners: opts.owners, maxTerms: 0 }).favorable : 0;
      var sign = set.length % 2 ? 1 : -1;
      favorable += sign * fav;
      parts.push({ set: set, sign: sign, favorable: fav, opts: possible ? opts : null });
    }
    parts.sort(function (x, y) {                         // 先列单个条件，再列两两、三个……同时满足
      if (x.set.length !== y.set.length) return x.set.length - y.set.length;
      return x.set.join() < y.set.join() ? -1 : 1;
    });
    var total = alternatives[0].total;
    return { favorable: favorable, total: total, probability: favorable / total, alternatives: alternatives, parts: parts };
  }

  /**
   * 旧的调用方式（只指定打手一名从者，整组统一包含 / 仅含），保留给测试和以前的代码：
   *   cards: 打手的 5 张牌；turns: 每个回合要求发出的牌的下标，例如 [[0, 1], [2]]；mode: 'include' / 'exact'
   */
  function dealProbability(opts) {
    var T = opts.turns.length, picks = [0, 0, 0, 0, 0], seen = {};
    opts.turns.forEach(function (indices, t) {
      indices.forEach(function (i) {
        if (seen[i]) throw new Error('同一张牌不能指定在两个回合');
        seen[i] = true;
        picks[i] = t + 1;
      });
    });
    var ex = [];
    for (var t = 0; t < T; t++) ex.push(opts.mode === 'exact');
    return compute({ servants: opts.servants, turns: T, owners: [{ cards: opts.cards, picks: picks, exact: ex }], maxTerms: opts.maxTerms });
  }

  var api = {
    COLORS: COLORS, DECKS: DECKS, HAND: HAND,
    comb: comb, gcd: gcd, deckCards: deckCards, cardTypes: cardTypes, compute: compute, dealProbability: dealProbability,
    intersect: intersect, computeAny: computeAny,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Deal = api;
})(typeof self !== 'undefined' ? self : this);
