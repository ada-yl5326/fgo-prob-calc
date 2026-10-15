/*
 * 综合击破概率的计算核心（不依赖浏览器，tests/test_web_combo.py 用 Node 对照验证）。规则见《世界线规则.md》。
 *
 * 方案：若干个回合。每个回合按结算顺序分 5 步：发牌 → 我方 buff → 击破 → 敌方 buff → 送人。
 * 发牌组按它的共享范围占连续的 1 ~ 3 个回合，放在第 k 回合表示第 k 回合重新洗牌、这几个回合共享一轮发牌。
 *
 * 世界线：一条世界线 = 从头到尾的一次完整经过（包括在哪里失败、在哪里 SL）。世界线互不重叠，
 * 所以综合概率 = 能走到成功的世界线的概率之和。遍历时有两种分叉：
 *   随机的分叉（判定成功 / 失败、发到哪种牌）：每种结果都走一遍，按概率相加；
 *   玩家自己选的分叉（用哪种方法救、先试哪种打法、用哪组 buff）：每种选法都完整走一遍，取结果最好的（不能相加）。
 * 走到相同状态的分支后面完全一样，所以合并起来只算一次（动态规划），不会漏掉任何一条。
 *
 * 一个回合里（同一手牌）：
 *   我方 buff：buff 一个一个判定，失败时用这个 buff 自己的 SL 次数重抽（只重抽它，前面的保留）；
 *              buff 组全部成功 → 用「击破」格的伤害组；有 buff 失败了 → 用「buff 失败时」格的伤害组（空着 = 失败）。
 *   击破 → 敌方 buff → 送人：换出牌 = 一条新的世界线，从击破开始全部重抽（我方 buff 保留）；
 *              换出牌的次数 = 伤害组的 SL 次数（没放伤害组时 = 送人组的 SL 次数）。
 *              敌方 buff 一个一个判定（每条世界线判定一次，不能单独 SL）；全部成功 → 用「送人」格的送人组，
 *              有失败 → 用「buff 失败时」格的送人组（空着 = 这条世界线失败）。
 *   额外 SL：每个回合的每个阶段可以有专用的次数，整个方案还可以有全局的次数（每条世界线一共只能用这么多次）。
 *              用在哪一步就只重抽那一步和后面的（例如送人失败时用一次，击破的结果保留）。
 *   发牌阶段的 SL：只能用发牌阶段专用的次数（全局额外 SL 不能用来重新发牌）。看到发到的牌之后，可以选择重新发牌，
 *              这一轮洗牌从头再来；不满足条件时重新发，满足了但打法不好时也可以重新发（取结果最好的）：
 *                  V(x) = Σ 各种发牌的比例 × max(这种发牌接着打的成功率, V(x − 1))，V(−1) 视为不能重新发
 *              没分条件时就是 发牌概率 SL x 次后 = 1 − (1 − 发牌概率)^(x+1)。
 *   一手牌同时满足几种条件（按条件分配）时：同一个伤害组 = 同一种出牌，只试一次；不同伤害组 = 不同出牌，各自一组世界线。
 *              技能只能放一次，所以用不同 buff 组的打法只能选一种（选最好的），用同一组 buff 的打法共用一次 buff 判定。
 *
 * 不用全局额外 SL 时，各回合、各轮洗牌互相独立：
 *     综合 = Π 各回合的成功率 × Π 各发牌组的发牌概率（同一轮洗牌里分了条件时，按「恰好满足哪几种条件」加权，见 mix）
 * 有全局额外 SL 时，前面的回合用掉了，后面就少了，所以从最后一个回合往前一起算（结果不能拆成各回合相乘）。
 *
 * 洗牌：3 人每 3 回合洗一次（2 人每 2 回合）；周期内有从者退场时，下一回合立刻洗牌。
 * 发牌组放的位置如果不是正常的洗牌回合，就要求前一回合有从者退场（页面会标出来，但无法替用户确认）。
 * 发牌组占好几个回合、几种条件又在不同回合有差别时，按条件分配相当于「看到后面的牌再决定按哪种打」，结果略偏高。
 */
(function (root) {
  'use strict';

  var MAX_TURNS = 20;
  var MAX_EXTRA = 9;                                     // 每个阶段的额外 SL 最多几次
  var MAX_GLOBAL = 9;                                    // 全局额外 SL 最多几次
  var WORK_LIMIT = 6e7;                                  // 世界线计算的工作量上限（动态规划的格子数）
  var TOO_BIG = '额外 SL 和 SL 次数太多，计算量太大：请减少一些额外 SL 或伤害组的 SL 次数';
  var STAGES = ['d', 'b', 'k', 'e', 's'];                // 额外 SL 的阶段：发牌、我方 buff、击破、敌方 buff、送人

  /** SL n 次后 = 1 − (1 − p)^(n+1)（与 killprob.js 的 withSL 相同） */
  function withSL(p, sl) {
    if (p <= 0 || p >= 1 || !sl) return p;
    return -Math.expm1((sl + 1) * Math.log1p(-p));
  }

  var clampInt = function (v, hi) { return Number.isInteger(v) && v > 0 ? Math.min(v, hi) : 0; };

  /** 一个回合各阶段的额外 SL 次数 { d, b, k, e, s }（d = 发牌阶段：只用在这一回合开始的发牌组上） */
  function extraOf(x) {
    x = x && typeof x === 'object' ? x : {};
    return { d: clampInt(x.d, MAX_EXTRA), b: clampInt(x.b, MAX_EXTRA), k: clampInt(x.k, MAX_EXTRA), e: clampInt(x.e, MAX_EXTRA), s: clampInt(x.s, MAX_EXTRA) };
  }
  var noExtra = function (x) { return !x.b && !x.k && !x.e && !x.s; };

  // ==================== 一个回合：遍历世界线（动态规划） ====================

  /**
   * 一种出牌（从击破到送人）的参数：k 单次击破率，c 换出牌次数，qs 敌方 buff 的单次成功率，
   * s 送人成功率（不含 SL），sf 敌方 buff 失败时的送人成功率（null = 失败）
   */
  function lineOf(play, kill) {
    var k = 1, c = 0;
    if (kill) {
      var plain = kill.single === undefined || kill.single === null;
      k = plain ? kill.rate : kill.single;
      c = plain ? 0 : kill.sl || 0;
    } else if (play.send) c = play.send.sl || 0;
    return {
      k: k, c: c, kill: kill, play: play,
      qs: play.ebuff && play.ebuff.items ? play.ebuff.items.map(function (x) { return x.single; }) : [],
      s: play.send ? play.send.rate : 1,
      sf: play.ebuff && play.sfail ? play.sfail.rate : null,
    };
  }

  /** 资源（击破、敌方 buff、送人阶段的额外 SL，全局额外 SL）的编号：r = ((xk·E + xe)·S + xs)·Gd + g */
  function makeDims(ex, Gd) {
    var K = ex.k + 1, E = ex.e + 1, S = ex.s + 1, NR = K * E * S * Gd;
    var d = { NR: NR, Gd: Gd, dK: E * S * Gd, dE: S * Gd, dS: Gd, xk: new Int16Array(NR), xe: new Int16Array(NR), xs: new Int16Array(NR), g: new Int16Array(NR) };
    for (var r = 0; r < NR; r++) {
      d.g[r] = r % Gd;
      d.xs[r] = Math.floor(r / Gd) % S;
      d.xe[r] = Math.floor(r / (S * Gd)) % E;
      d.xk[r] = Math.floor(r / (E * S * Gd));
    }
    d.start = ((ex.k * E + ex.e) * S + ex.s) * Gd;        // 这一回合开始时的资源（g = 0）
    return d;
  }

  /**
   * 一种出牌的世界线：从击破开始，还能换 L.c 次出牌、资源 r 时的最好结果。
   * 成功 → W[g]（后面回合的值）；放弃这种出牌 → fail[r]（换下一种出牌）。返回各资源下的值 Float64Array(NR)
   * 位置：0 击破，1 ~ m 第几个敌方 buff，m+1 送人，m+2 敌方 buff 失败时的送人
   */
  function lineDP(L, dims, W, fail, budget) {
    var m = L.qs.length, P = m + 3, SO = m + 1, SF = m + 2, NR = dims.NR;
    var cur = new Float64Array(NR * P), prev = null;
    for (var c = 0; c <= L.c; c++) {
      budget.work += NR * P;
      if (budget.work > WORK_LIMIT) throw new Error(TOO_BIG);
      for (var r = 0; r < NR; r++) {
        var g = dims.g[r], base = r * P;
        var low = c > 0 ? Math.max(fail[r], prev[r]) : fail[r];   // 放弃，或者换出牌（从击破重来）
        var best;
        if (L.sf !== null) {                             // 敌方 buff 失败后的送人
          best = low;
          if (dims.xs[r] > 0) best = Math.max(best, cur[(r - dims.dS) * P + SF]);
          if (g > 0) best = Math.max(best, cur[(r - 1) * P + SF]);
          cur[base + SF] = L.sf * W[g] + (1 - L.sf) * best;
        }
        best = low;                                      // 送人
        if (dims.xs[r] > 0) best = Math.max(best, cur[(r - dims.dS) * P + SO]);
        if (g > 0) best = Math.max(best, cur[(r - 1) * P + SO]);
        cur[base + SO] = L.s * W[g] + (1 - L.s) * best;
        for (var i = m - 1; i >= 0; i--) {               // 敌方 buff
          var pos = 1 + i, next = i === m - 1 ? SO : pos + 1;
          best = low;
          if (dims.xe[r] > 0) best = Math.max(best, cur[(r - dims.dE) * P + pos]);
          if (g > 0) best = Math.max(best, cur[(r - 1) * P + pos]);
          if (L.sf !== null) best = Math.max(best, cur[base + SF]);
          cur[base + pos] = L.qs[i] * cur[base + next] + (1 - L.qs[i]) * best;
        }
        best = low;                                      // 击破
        if (dims.xk[r] > 0) best = Math.max(best, cur[(r - dims.dK) * P]);
        if (g > 0) best = Math.max(best, cur[(r - 1) * P]);
        cur[base] = L.k * cur[base + (m ? 1 : SO)] + (1 - L.k) * best;
      }
      var now = new Float64Array(NR), same = !!prev;
      for (r = 0; r < NR; r++) {
        now[r] = cur[r * P];
        if (same && now[r] !== prev[r]) same = false;
      }
      prev = now;
      if (same) break;                                   // 再多换几次出牌结果也不变了
    }
    return prev;
  }

  /** 几种出牌依次试（先试哪种由玩家选，取最好的）：返回各资源下的值；一种都没成功 = 0 */
  function linesDP(lines, dims, W, budget) {
    var n = lines.length, F = [new Float64Array(dims.NR)];
    for (var mask = 1; mask < (1 << n); mask++) {
      var best = null;
      for (var j = 0; j < n; j++) {
        if (!(mask & (1 << j))) continue;
        var v = lineDP(lines[j], dims, W, F[mask ^ (1 << j)], budget);
        if (!best) best = v;
        else for (var r = 0; r < dims.NR; r++) if (v[r] > best[r]) best[r] = v[r];
      }
      F[mask] = best;
    }
    return F[(1 << n) - 1];
  }

  /**
   * 我方 buff 阶段：buff 一个一个判定，失败时先用自己的 SL，再用这个阶段的额外 SL（xb）、全局额外 SL（g），
   * 也可以不救、走「buff 失败时」。succ[g] / fail[g] = buff 组成功 / 失败后接着打的值。返回开始时各 g 的值
   */
  function buffStage(items, xb0, succ, fail) {
    var Gd = succ.length, XB = xb0 + 1, top = new Float64Array(XB * Gd);
    for (var x = 0; x < XB; x++) for (var g = 0; g < Gd; g++) top[x * Gd + g] = succ[g];
    for (var i = items.length - 1; i >= 0; i--) {
      var p = items[i].p, own = items[i].sl || 0, b0 = new Float64Array(XB * Gd), cur = new Float64Array(XB * Gd);
      for (x = 0; x < XB; x++) {
        for (g = 0; g < Gd; g++) {
          var idx = x * Gd + g, ok = top[idx], best = fail[g];
          if (x > 0) best = Math.max(best, b0[idx - Gd]);
          if (g > 0) best = Math.max(best, b0[idx - 1]);
          var v = b0[idx] = p * ok + (1 - p) * best;
          for (var s = 0; s < own; s++) {                 // 自己的 SL：只重抽这个 buff
            var nv = p * ok + (1 - p) * Math.max(fail[g], v);
            if (nv === v) break;
            v = nv;
          }
          cur[idx] = v;
        }
      }
      top = cur;
    }
    return top.slice(xb0 * Gd, xb0 * Gd + Gd);
  }

  /** 一个回合：W = 这一回合成功后（各 g）的值，返回这一回合开始时各 g 的值 */
  function runTurn(spec, W, budget) {
    var Gd = W.length, out = new Float64Array(Gd);
    if (!spec.clusters.length) return out;               // 其他格没放伤害组 = 失败
    var dims = makeDims(spec.extra, Gd);
    spec.clusters.forEach(function (cl) {
      var succ = linesDP(cl.lines, dims, W, budget), v = succ.slice(dims.start, dims.start + Gd);
      if (cl.buff) {
        var fail = cl.failLines.length ? linesDP(cl.failLines, dims, W, budget).slice(dims.start, dims.start + Gd) : new Float64Array(Gd);
        v = buffStage(cl.buffItems, spec.extra.b, v, fail);
      }
      for (var g = 0; g < Gd; g++) if (v[g] > out[g]) out[g] = v[g];
    });
    return out;
  }

  /**
   * 没有额外 SL 时的算式（计算过程用；和上面的动态规划结果相同）：
   *   一条世界线 A = 击破 × (敌方 buff × 送人 + (1 − 敌方 buff) × 失败时的送人)，换出牌 c 次 → 1 − (1 − A)^(c+1)
   *   几种出牌 → 1 − Π(1 − 各出牌)；有我方 buff：buff × 成功时 + (1 − buff) × 失败时；几组 buff 选最好的
   */
  function closedForm(spec) {
    var lineRate = function (L) {
      var q = L.qs.reduce(function (a, x) { return a * x; }, 1);
      var A = L.k * (q * L.s + (1 - q) * (L.sf === null ? 0 : L.sf));
      var onlyKill = L.kill && !L.qs.length && L.s === 1;   // 只有伤害组：直接用击破页算好的 SL 后的击破率
      return { line: L, q: q, A: A, rate: onlyKill ? L.kill.rate : withSL(A, L.c) };
    };
    var any = function (list) { return 1 - list.reduce(function (a, x) { return a * (1 - x.rate); }, 1); };
    var clusters = spec.clusters.map(function (cl) {
      var plays = cl.lines.map(lineRate), x = { buff: cl.buff, plays: plays, succ: any(plays) };
      if (!cl.buff) x.rate = x.succ;
      else {
        x.items = cl.buffItems;
        x.pb = cl.buffItems.reduce(function (a, it) { return a * withSL(it.p, it.sl); }, 1);
        x.failPlays = cl.failLines.map(lineRate);
        x.fail = any(x.failPlays);
        x.rate = x.pb * x.succ + (1 - x.pb) * x.fail;
      }
      return x;
    });
    var best = -1;
    clusters.forEach(function (x, i) { if (best < 0 || x.rate > clusters[best].rate) best = i; });
    return { clusters: clusters, best: best, rate: best < 0 ? 0 : clusters[best].rate };
  }

  /**
   * 有额外 SL（或者有的步骤不救更好）时的定量过程：把这一回合从头一步一步重新推一遍（只用来显示），
   * 每个状态写成「成功率 × 下一步 + (1 − 成功率) × max{各种救法}」。和上面的动态规划结果一致时才显示。
   * 返回 { rows: [{ id, kind: 'line' | 'buff', … }], start: 起点的编号, rate } 或 null（状态太多、不一致）
   */
  var TRACE_STATES = 3000, TRACE_ROWS = 80;
  function traceTurn(spec) {
    var ex = spec.extra, count = 0;
    var tooMany = function () { if (++count > TRACE_STATES) throw new Error('trace'); };

    /** 一组出牌依次试：F(mask, 资源) = 先试哪种由玩家选；V(第 j 种, 位置, 资源) = 这种出牌走到这一步时的成功率 */
    function solver(lines, tag) {
      var memoF = {}, memoV = {};
      function F(mask, xk, xe, xs) {
        var key = mask + ',' + xk + ',' + xe + ',' + xs;
        if (memoF[key]) return memoF[key];
        var best = null;
        for (var j = 0; j < lines.length; j++) {
          if (!(mask & (1 << j))) continue;
          var row = V(j, mask, 0, lines[j].c, xk, xe, xs);
          if (!best || row.v > best.v + 1e-15) best = row;
        }
        return (memoF[key] = best);
      }
      function V(j, mask, pos, c, xk, xe, xs) {
        var key = [j, mask, pos, c, xk, xe, xs].join(',');
        if (memoV[key]) return memoV[key];
        tooMany();
        var L = lines[j], m = L.qs.length, SO = m + 1, SF = m + 2;
        var p = pos === 0 ? L.k : pos <= m ? L.qs[pos - 1] : pos === SO ? L.s : L.sf;
        var next = pos === 0 ? (m ? 1 : SO) : pos < m ? pos + 1 : pos === m ? SO : null;
        var row = { kind: 'line', tag: tag, line: L, many: lines.length > 1, pos: pos, m: m, c: c, xk: xk, xe: xe, xs: xs, p: p };
        memoV[key] = row;
        row.next = next === null ? null : V(j, mask, next, c, xk, xe, xs);
        var pass = row.next ? row.next.v : 1;
        row.opts = [];
        if (p < 1) {
          var rest = mask & ~(1 << j);
          row.opts.push(rest ? { label: '不救，换下一种出牌', row: F(rest, xk, xe, xs) } : { label: '不救', v: 0 });
          if (c > 0) row.opts.push({ label: '换出牌', row: V(j, mask, 0, c - 1, xk, xe, xs) });
          if (pos === 0 && xk > 0) row.opts.push({ label: '用击破阶段的额外 SL', row: V(j, mask, 0, c, xk - 1, xe, xs) });
          if (pos >= 1 && pos <= m && xe > 0) row.opts.push({ label: '用敌方 buff 阶段的额外 SL', row: V(j, mask, pos, c, xk, xe - 1, xs) });
          if (pos >= 1 && pos <= m && L.sf !== null) row.opts.push({ label: '改用「没成功时用」的送人', row: V(j, mask, SF, c, xk, xe, xs) });
          if (pos >= SO && xs > 0) row.opts.push({ label: '用送人阶段的额外 SL', row: V(j, mask, pos, c, xk, xe, xs - 1) });
          row.opts.forEach(function (o) { if (o.row) o.v = o.row.v; });
          row.pick = 0;
          row.opts.forEach(function (o, i) { if (o.v > row.opts[row.pick].v + 1e-15) row.pick = i; });
        }
        row.v = p >= 1 ? pass : p * pass + (1 - p) * row.opts[row.pick].v;
        return row;
      }
      return function () { return lines.length ? F((1 << lines.length) - 1, ex.k, ex.e, ex.s) : null; };
    }

    try {
      var best = null;
      spec.clusters.forEach(function (cl) {
        var succ = solver(cl.lines, 'ok')(), top = succ;
        if (cl.buff) {
          var fail = solver(cl.failLines, 'fail')();
          var items = cl.buffItems, memo = {};
          var B = function (i, own, xb) {
            var key = i + ',' + own + ',' + xb;
            if (memo[key]) return memo[key];
            tooMany();
            var row = { kind: 'buff', buff: cl.buff, i: i, n: items.length, own: own, ownMax: items[i].sl || 0, xb: xb, p: items[i].p };
            memo[key] = row;
            row.next = i + 1 < items.length ? B(i + 1, items[i + 1].sl || 0, xb) : succ;
            row.opts = [fail ? { label: '不救，改用「没成功时用」的伤害组', row: fail } : { label: '不救（没放「没成功时用」的伤害组 = 失败）', v: 0 }];
            if (own > 0) row.opts.push({ label: '用这个 buff 自己的 SL', row: B(i, own - 1, xb) });
            if (xb > 0) row.opts.push({ label: '用我方 buff 阶段的额外 SL', row: B(i, own, xb - 1) });
            row.opts.forEach(function (o) { if (o.row) o.v = o.row.v; });
            row.pick = 0;
            row.opts.forEach(function (o, k) { if (o.v > row.opts[row.pick].v + 1e-15) row.pick = k; });
            var pass = row.next ? row.next.v : 1;
            row.v = row.p >= 1 ? pass : row.p * pass + (1 - row.p) * row.opts[row.pick].v;
            return row;
          };
          top = items.length ? B(0, items[0].sl || 0, ex.b) : succ;
        }
        if (top && (!best || top.v > best.v)) best = top;
      });
      if (!best) return null;
      // 从起点开始，按出现的顺序编号；每个状态只列一次
      var rows = [], queue = [best];
      best.id = 1;
      rows.push(best);
      while (queue.length) {
        var r = queue.shift();
        [r.next].concat((r.opts || []).map(function (o) { return o.row; })).forEach(function (x) {
          if (x && !x.id) { x.id = rows.length + 1; rows.push(x); queue.push(x); }
        });
      }
      return { start: best, rows: rows.slice(0, TRACE_ROWS), more: Math.max(0, rows.length - TRACE_ROWS), rate: best.v };
    } catch (e) {
      if (e.message === 'trace') return null;
      throw e;
    }
  }

  // ==================== 整个方案 ====================

  /**
   * plan:  { turns, kill: [伤害组 id | null] × turns, deal: [{ at: 从第几回合开始（0 起）, id }],
   *          以下都可以省略：
   *          send: [送人组 id] × turns, buff: [我方 buff 组 id] × turns, ebuff: [敌方 buff 组 id] × turns,
   *          kfail: [我方 buff 失败时的伤害组 id] × turns, sfail: [敌方 buff 失败时的送人组 id] × turns,
   *          extra: [{ b, k, e, s }（各阶段的额外 SL）| null] × turns, global: 全局额外 SL,
   *          split: [null | { alts: [伤害组 id | null] × 条件数, other: 伤害组 id | null,
   *                           sends / buffs / ebuffs / kfails / sfails: [组 id | null] × 条件数,
   *                           sendOther / buffOther / ebuffOther / kfailOther / sfailOther: 组 id | null }] × turns }
   *          分条件时，送人、我方 buff、敌方 buff、失败时的送人空着 = 跟随回合；伤害组、失败时的伤害组不跟随。
   * kill(id) → { name, rate: SL 后的击破率 | null（没输入完整）, single: 不含 SL 的击破率, sl: SL 次数 }（single、sl 可省略）
   * send(id) → { name, rate: 不含 SL 的送人成功率 | null, sl: SL 次数, pending: 还在计算 }
   * buff(id) → { name, rate: 我方阶段的成功率 | null（没输入完整）, items: [{ single, sl }] }
   * deal(id) → { name, rate: 发牌概率 | null（条件有误）, span: 占几个回合, servants: 场上人数,
   *              alts: 条件数, exact: 恰好满足各条件集合的组合数（deal.js 的 exactCounts） }
   * 返回 {
   *   turns, value: 综合击破率 | null, problems: [说明], notes: [不影响计算的提示], global: 全局额外 SL,
   *   base: 不用全局额外 SL 时的综合击破率（global = 0 时就是 value）,
   *   placements: [{ at, end, id, name, rate, span, servants, shown: 实际显示占几格, reshuffle: 'first' | 'natural' | 'forced', conflict: null | 文字 }],
   *   cover: 每回合被哪个发牌组占用（placements 的序号，-1 = 没有）,
   *   kills / sends / buffs / ebuffs / kfails / sfails: 每回合的组 { id, name, rate, … } | null, extras: 每回合 { b, k, e, s },
   *   splits: 每回合实际生效的分条件（各格的组，同上）| null（不在发牌组里的回合不生效）,
   *   blocks: 公式按洗牌分组 [{ from, to, placement: 序号 | -1, factors }],
   *   factors: 全部不是 100% 的因子（按回合顺序，不含全局额外 SL）：
   *     { kind: 'turn', turn, name, rate, detail } 一个回合（detail 见 turnDetail）/ { kind: 'deal', turn, to, name, rate } 发牌 /
   *     { kind: 'mix', turn, to, name, rate, total, regions: [{ set, count, value, turns: [{ turn, split, rate, detail }] } | { other: true, … }] } 分了条件的一轮,
   *   weakest: 最小的因子
   * }
   */
  function evaluate(plan, kill, deal, send, buff) {
    var n = plan.turns, problems = [], notes = [];
    var G = clampInt(plan.global, MAX_GLOBAL);
    var field = function (name, t) { var a = plan[name]; return Array.isArray(a) && typeof a[t] === 'string' ? a[t] : null; };

    var killInfo = function (id, where) {
      if (!id) return null;
      var k = kill(id);
      if (k.rate === null) problems.push(where + '的「' + k.name + '」还没输入完整');
      return { id: id, name: k.name, rate: k.rate, single: k.single, sl: k.sl };
    };
    var sendInfo = function (id, where) {
      if (!id || !send) return null;
      var x = send(id);
      if (x.rate === null) problems.push(where + '的送人组「' + x.name + '」' + (x.pending ? '还在计算' : '还没输入完整'));
      return { id: id, name: x.name, rate: x.rate, sl: x.sl || 0, pending: !!x.pending };
    };
    var buffInfo = function (id, where) {
      if (!id || !buff) return null;
      var x = buff(id);
      if (x.rate === null) problems.push(where + '的 buff 组「' + x.name + '」还没输入完整');
      return { id: id, name: x.name, rate: x.rate, enemy: x.enemy, items: x.items || null };
    };

    var T = function (t) { return 'T' + (t + 1) + ' '; };
    var kills = [], sends = [], buffs = [], ebuffs = [], kfails = [], sfails = [], extras = [];
    for (var t = 0; t < n; t++) {
      kills.push(killInfo(field('kill', t), 'T' + (t + 1) + ' '));
      sends.push(sendInfo(field('send', t), T(t)));
      buffs.push(buffInfo(field('buff', t), T(t) + '我方 buff '));
      ebuffs.push(buffInfo(field('ebuff', t), T(t) + '敌方 buff '));
      extras.push(extraOf(Array.isArray(plan.extra) ? plan.extra[t] : null));
    }

    var placements = plan.deal.map(function (p) {
      var d = deal(p.id);
      return { at: p.at, id: p.id, name: d.name, rate: d.rate, span: d.span, servants: d.servants, end: p.at + d.span - 1, conflict: null,
        alts: d.alts || 1, exact: d.exact || null, sl: p.at < n ? extras[p.at].d : 0 };
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

    // 失败时的格子：只有放了（或跟随到）buff 组时才用到
    for (t = 0; t < n; t++) {
      kfails.push(buffs[t] ? killInfo(field('kfail', t), T(t) + 'buff 失败时') : null);
      sfails.push(ebuffs[t] ? sendInfo(field('sfail', t), T(t) + 'buff 失败时') : null);
    }

    // 分条件的回合：只有被发牌组占用时才生效；条件格按发牌组现在的条件数对齐（多出来的不算）
    var splits = [];
    for (t = 0; t < n; t++) {
      var sp = plan.split && plan.split[t], owner = cover[t] >= 0 ? placements[cover[t]] : null;
      if (!sp || !owner) { splits.push(null); continue; }
      var pick = function (arr, a) { return Array.isArray(arr) && typeof arr[a] === 'string' ? arr[a] : null; };
      var cellOf = function (a, label) {                 // 一个条件格（a = 序号 / 'other'）
        var o = a === 'other';
        var get = function (many, one) { return o ? (typeof sp[one] === 'string' ? sp[one] : null) : pick(sp[many], a); };
        var where = T(t) + label;
        var c = {
          kill: killInfo(get('alts', 'other'), where),
          buff: buffInfo(get('buffs', 'buffOther'), where + '我方 buff '),
          ebuff: buffInfo(get('ebuffs', 'ebuffOther'), where + '敌方 buff '),
          send: sendInfo(get('sends', 'sendOther'), where),
        };
        c.kfail = c.buff || buffs[t] ? killInfo(get('kfails', 'kfailOther'), where + ' buff 失败时') : null;
        c.sfail = c.ebuff || ebuffs[t] ? sendInfo(get('sfails', 'sfailOther'), where + ' buff 失败时') : null;
        return c;
      };
      var cells = [];
      for (var a = 0; a < (owner.alts || 1); a++) cells.push(cellOf(a, '条件 ' + (a + 1)));
      splits.push({ cells: cells, other: cellOf('other', '其他情况'),
        alts: cells.map(function (c) { return c.kill; }) });
    }

    var budget = { work: 0 };
    var globalTable = [];                                // [{ from, to, W }]：从这一回合（这一轮洗牌）往后，还剩 g 次全局额外 SL 时的成功率
    var noteOnce = function (s) { if (notes.indexOf(s) < 0) notes.push(s); };

    /** 一种打法：条件格（空着的跟随回合）+ 回合的格子 */
    function playOf(t, cell) {
      var pl = cell
        ? { buff: cell.buff || buffs[t], kill: cell.kill, ebuff: cell.ebuff || ebuffs[t], send: cell.send || sends[t], kfail: cell.kfail,
            sfail: cell.sfail || sfails[t] }
        : { buff: buffs[t], kill: kills[t], ebuff: ebuffs[t], send: sends[t], kfail: kfails[t], sfail: sfails[t] };
      if (!pl.buff) pl.kfail = null;
      if (!pl.ebuff) pl.sfail = null;
      return pl;
    }

    /**
     * 一个回合的计算输入：which = undefined（不分条件）/ 满足的条件序号数组 / 'other'。
     * 按 buff 组分成几组（技能只能放一次，只能选一组）；同一组里伤害组相同的打法是同一种出牌，只算第一个
     */
    function specOf(t, which) {
      var plays = [];
      if (which === undefined || !splits[t]) plays.push({ play: playOf(t, null), alts: [] });
      else if (which === 'other') {
        if (splits[t].other.kill) plays.push({ play: playOf(t, splits[t].other), alts: ['other'] });
      } else which.forEach(function (a) { plays.push({ play: playOf(t, splits[t].cells[a]), alts: [a] }); });
      var clusters = [], byBuff = {};
      var sig = function (pl) { return [pl.kfail, pl.ebuff, pl.send, pl.sfail].map(function (x) { return x ? x.id : ''; }).join('|'); };
      plays.forEach(function (x) {
        var pl = x.play, bk = pl.buff ? pl.buff.id : '';
        var cl = byBuff[bk];
        if (!cl) {
          cl = byBuff[bk] = { buff: pl.buff, buffItems: pl.buff && pl.buff.items ? pl.buff.items.map(function (it) { return { p: it.single, sl: it.sl }; }) : [],
            lines: [], failLines: [], seen: {}, seenFail: {} };
          clusters.push(cl);
        }
        var key = pl.kill ? pl.kill.id : '';
        var same = cl.seen[key];
        if (same) {                                      // 同一种出牌：只算第一个
          same.alts = same.alts.concat(x.alts);
          if (sig(same.play) !== sig(pl)) {
            noteOnce(T(t) + '条件 ' + same.alts.map(function (a) { return a === 'other' ? '其他' : a + 1; }).join('、') +
              ' 用同一个伤害组（同一种出牌），但其他格子不同：按条件 ' + (same.alts[0] + 1) + ' 的格子算');
          }
          return;
        }
        var L = lineOf(pl, pl.kill);
        L.alts = x.alts.slice();
        cl.seen[key] = L;
        cl.lines.push(L);
        if (pl.kfail && !cl.seenFail[pl.kfail.id]) {
          var F = lineOf(pl, pl.kfail);
          F.alts = L.alts;
          cl.seenFail[pl.kfail.id] = F;
          cl.failLines.push(F);
        }
      });
      return { turn: t, which: which, clusters: clusters, extra: extras[t] };
    }

    /** 这个回合用到的组有没有还不能计算的 */
    function incomplete(spec) {
      return spec.clusters.some(function (cl) {
        if (cl.buff && cl.buff.rate === null) return true;
        return cl.lines.concat(cl.failLines).some(function (L) {
          var pl = L.play;
          return (L.kill && L.kill.rate === null) || [pl.ebuff, pl.send, pl.sfail].some(function (x) { return x && x.rate === null; });
        });
      });
    }

    /** 一个回合不用全局额外 SL 时的成功率和计算过程（按回合、条件缓存） */
    var cacheTurn = {};
    function turnDetail(t, which) {
      var key = t + ':' + JSON.stringify(which === undefined ? null : which);
      if (cacheTurn[key]) return cacheTurn[key];
      var spec = specOf(t, which), d;
      if (incomplete(spec)) d = { rate: null, spec: spec };
      else {
        var dp = runTurn(spec, new Float64Array([1]), budget)[0];
        var cf = closedForm(spec);
        var exact = noExtra(spec.extra) && Math.abs(cf.rate - dp) <= 1e-12;   // 没有额外 SL 时算式和遍历的结果相同
        d = { rate: exact ? cf.rate : dp, spec: spec, form: cf, extra: !noExtra(spec.extra), optimal: !exact };
        if (!exact) {                                      // 没有一行的公式：列出一步一步的递推
          var tr = traceTurn(spec);
          if (tr && Math.abs(tr.rate - dp) <= 1e-12) d.trace = tr;
        }
      }
      cacheTurn[key] = d;
      return d;
    }

    var describe = function (t) {                        // 一个回合放了哪些组（因子的名称）
      return [buffs[t], kills[t], ebuffs[t], sends[t]].filter(Boolean).map(function (x) { return x.name; }).join(' + ');
    };

    var blocks = [], factors = [], blockSpecs = [];
    try {
      for (t = 0; t < n;) {
        var pi = cover[t], p = pi >= 0 ? placements[pi] : null;
        var to = p ? p.at + p.shown - 1 : t, f = [];
        var mixed = false;
        for (var v = t; v <= to; v++) if (splits[v]) mixed = true;
        if (mixed) {
          var mf = mixFactor(p, t, to);
          f.push(mf);
          blockSpecs.push({ mixed: true, from: t, to: to, factor: mf, placement: p });
        } else {
          for (v = t; v <= to; v++) {
            var d = turnDetail(v);
            if (d.rate !== 1) f.push({ kind: 'turn', turn: v, name: describe(v), rate: d.rate, detail: d });
          }
          if (p && p.rate !== 1) {
            f.push({ kind: 'deal', turn: p.at, to: p.end, name: p.name, rate: p.rate === null ? null : withSL(p.rate, p.sl), single: p.rate, sl: p.sl });
          }
          blockSpecs.push({ mixed: false, from: t, to: to, placement: p });
        }
        blocks.push({ from: t, to: to, placement: pi, factors: f });
        factors = factors.concat(f);
        t = to + 1;
      }
    } catch (e) {
      if (e.message !== TOO_BIG) throw e;
      problems.push(TOO_BIG);
    }

    /** 分了条件的一轮洗牌（第 from ~ to 回合，发牌组 p）：按「恰好满足哪几种条件」分组后加权求和 */
    function mixFactor(p, from, to) {
      var f = { kind: 'mix', turn: from, to: to, name: p.name, rate: null, regions: [], total: null };
      if (p.rate === null || !p.exact) return f;
      var regionOf = function (which, count) {
        var turns = [], value = 1, ok = true;
        for (var u = from; u <= to; u++) {
          var d = splits[u] ? turnDetail(u, which) : turnDetail(u);
          if (d.rate === null) ok = false;
          else value *= d.rate;
          turns.push({ turn: u, split: !!splits[u], rate: d.rate, detail: d });
        }
        return { which: which, count: count, value: ok ? value : null, turns: turns };
      };
      var total = p.exact[0], sum = 0, ok = true;
      for (var m = 1; m < p.exact.length; m++) {
        var c = p.exact[m], set = [];
        total += c;
        if (!c) continue;
        for (var k = 0; (1 << k) <= m; k++) if ((m >> k) & 1) set.push(k);
        var reg = regionOf(set, c);
        reg.set = set;
        f.regions.push(reg);
        if (reg.value === null) ok = false; else sum += c * reg.value;
      }
      var other = regionOf('other', p.exact[0]);
      other.other = true;
      f.regions.push(other);
      if (other.value === null) ok = false; else sum += p.exact[0] * other.value;
      f.total = total;
      if (!ok) { f.regions = []; return f; }
      f.single = f.rate = sum / total;
      f.sl = p.sl;
      f.steps = [f.rate];
      for (var x = 1; x <= p.sl; x++) {                   // 发牌阶段 SL：看到牌之后可以重新发牌，取结果最好的
        var prev = f.rate, acc = 0;
        f.regions.forEach(function (reg) { acc += reg.count * Math.max(reg.value, prev); });
        f.rate = acc / total;
        f.steps.push(f.rate);
      }
      return f;
    }

    if (!problems.length && factors.some(function (x) { return x.rate === null; })) problems.push('有一轮分了条件的发牌组无法计算');
    var base = null, value = null;
    if (!problems.length) {
      base = factors.reduce(function (acc, x) { return acc * x.rate; }, 1);
      value = base;
      if (G > 0) {
        try { value = globalValue(); } catch (e) {
          if (e.message !== TOO_BIG) throw e;
          problems.push(TOO_BIG);
          value = base = null;
        }
      }
    }

    /** 有全局额外 SL：从最后一个回合往前算，W[g] = 还剩 g 次全局额外 SL 时后面的成功率 */
    function globalValue() {
      var W = new Float64Array(G + 1).fill(1);
      for (var i = blockSpecs.length - 1; i >= 0; i--) {
        var b = blockSpecs[i];
        var p = b.placement;
        if (!b.mixed) {
          for (var u = b.to; u >= b.from; u--) {
            W = runTurn(specOf(u), W, budget);
            if (u > b.from || !p || p.rate === 1) globalTable.unshift({ from: u, to: u, W: Array.from(W) });
          }
          if (p && p.rate !== 1) {
            var chain = W, D = p.rate;
            W = chain.map(function (x) { return D * x; });
            for (var r1 = 1; r1 <= p.sl; r1++) {          // 发牌阶段 SL：没发到就重新发（全局额外 SL 不能用在这里）
              var prevW = W;
              W = chain.map(function (x, g) { return D * Math.max(x, prevW[g]) + (1 - D) * prevW[g]; });
            }
            globalTable.unshift({ from: b.from, to: b.from, W: Array.from(W), deal: true });
          }
          continue;
        }
        var chains = b.factor.regions.map(function (reg) {
          var Wr = W;
          for (var u2 = b.to; u2 >= b.from; u2--) Wr = runTurn(splits[u2] ? specOf(u2, reg.which) : specOf(u2), Wr, budget);
          return Wr;
        });
        var mixOf = function (prevW) {
          var sum = new Float64Array(G + 1);
          b.factor.regions.forEach(function (reg, j) {
            for (var g = 0; g <= G; g++) sum[g] += reg.count * (prevW ? Math.max(chains[j][g], prevW[g]) : chains[j][g]);
          });
          return sum.map(function (x) { return x / b.factor.total; });
        };
        W = mixOf(null);
        for (var r2 = 1; r2 <= p.sl; r2++) W = mixOf(W);
        globalTable.unshift({ from: b.from, to: b.to, W: Array.from(W), mixed: true });
      }
      return W[G];
    }

    var weakest = null;
    factors.forEach(function (x) { if (x.rate !== null && (!weakest || x.rate < weakest.rate)) weakest = x; });
    return { turns: n, value: value, base: base, global: G, problems: problems, notes: notes, placements: placements, cover: cover,
      kills: kills, sends: sends, buffs: buffs, ebuffs: ebuffs, kfails: kfails, sfails: sfails, extras: extras, splits: splits,
      blocks: blocks, factors: factors, weakest: weakest, globalTable: globalTable };
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

  var PER_TURN = ['kill', 'split', 'send', 'buff', 'ebuff', 'kfail', 'sfail', 'extra'];

  function ensureTurns(plan, n) {
    while (plan.turns < n) {
      plan.turns++;
      PER_TURN.forEach(function (k) { if (Array.isArray(plan[k])) plan[k].push(null); });
    }
  }

  var api = { MAX_TURNS: MAX_TURNS, MAX_EXTRA: MAX_EXTRA, MAX_GLOBAL: MAX_GLOBAL, STAGES: STAGES, PER_TURN: PER_TURN,
    evaluate: evaluate, placeDeal: placeDeal, ensureTurns: ensureTurns, withSL: withSL, extraOf: extraOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Combo = api;
})(typeof self !== 'undefined' ? self : this);
