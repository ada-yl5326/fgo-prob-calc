// 发牌概率页面：发牌组（场上人数、共享几个回合、最多 3 名从者的配卡 / 纹章 / 每回合要发到的牌、每格包含或仅含，
// 以及最多 5 种「或者」条件）
// → 调用 deal.js 计算并显示计算过程
(function () {
  'use strict';

  const D = window.Deal;
  const G = window.Groups;
  const MAX_TERMS = 40;                                  // 计算过程最多列出的项数
  const MAX_ALTS = 5;                                    // 「或者」最多 5 种条件
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
  const TURNS = [0, 1, 2];
  const CARDS = [0, 1, 2, 3, 4];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // ---------- 发牌组的数据 ----------
  //   servants: 场上人数 3 / 2；scope: 共享前几个回合（1 ~ servants）
  //   owners[o]: { deck: 配卡（从者 2、3 可以是 '' = 不指定）, marked: 纹章 × 5 }（各种条件共用）
  //   alts[k]: 第 k 种条件（「或者」，满足任意一种即可）：
  //     picks[o]: 从者 o 的每张牌要在第几回合发到（0 = 不要求）
  //     exact[o][t]: 第 t 回合指定了牌时是否「仅含」；none[o][t]: 没指定牌时是否「一张都不能有」
  //   alt: 正在编辑第几种条件
  // 页面上的函数都用 view(d) 得到的「当前条件」：{ servants, scope, owners: [{ deck, marked, picks }], exact, none }，
  // 其中的数组就是 alts[k] 里的数组，改它就是改这种条件

  const blankOwner = (deck) => ({ deck, marked: [false, false, false, false, false] });
  const flags = () => TURNS.map(() => TURNS.map(() => false));
  const blankAlt = () => ({ picks: TURNS.map(() => [0, 0, 0, 0, 0]), exact: flags(), none: flags() });

  function create() {
    return { servants: 3, scope: 1, owners: [blankOwner('BBAAQ'), blankOwner(''), blankOwner('')], alts: [blankAlt()], alt: 0 };
  }

  /** 第 k 种条件（默认当前条件）的视图 */
  function view(d, k) {
    const a = d.alts[k === undefined ? d.alt : k];
    return {
      servants: d.servants, scope: d.scope, exact: a.exact, none: a.none,
      owners: d.owners.map((o, i) => ({ deck: o.deck, marked: o.marked, picks: a.picks[i] })),
    };
  }

  /** 一种条件：picks[o] 来自 pickOf(o)，exact / none 来自 src（v0.4 的发牌组整组只有一种条件，存在 owners[o].picks 和 d.exact / d.none） */
  function cleanAlt(src, pickOf) {
    const a = blankAlt();
    TURNS.forEach((o) => {
      const picks = pickOf(o);
      a.picks[o] = CARDS.map((k) => (Array.isArray(picks) && [1, 2, 3].indexOf(picks[k]) >= 0 ? picks[k] : 0));
    });
    ['exact', 'none'].forEach((key) => {
      if (src && Array.isArray(src[key])) a[key] = TURNS.map((o) => TURNS.map((t) => !!(src[key][o] && src[key][o][t])));
    });
    return a;
  }

  function cleanData(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.owners)) return null;
    const d = create();
    d.servants = raw.servants === 2 ? 2 : 3;
    d.scope = Math.min(d.servants, [1, 2, 3].indexOf(raw.scope) >= 0 ? raw.scope : 1);
    raw.owners.slice(0, 3).forEach((o, i) => {
      if (!o) return;
      const deck = D.DECKS.indexOf(o.deck) >= 0 ? o.deck : i === 0 ? 'BBAAQ' : '';
      d.owners[i] = { deck, marked: CARDS.map((k) => !!(Array.isArray(o.marked) && o.marked[k])) };
    });
    if (Array.isArray(raw.alts) && raw.alts.length) {
      d.alts = raw.alts.slice(0, MAX_ALTS).map((a) => cleanAlt(a, (o) => a && Array.isArray(a.picks) && a.picks[o]));
    } else {
      d.alts = [cleanAlt(raw, (o) => raw.owners[o] && raw.owners[o].picks)];
    }
    d.alt = Math.min(d.alts.length - 1, Math.max(0, Math.floor(Number(raw.alt)) || 0));
    // 没有配卡的从者不能有选牌
    d.owners.forEach((o, i) => { if (!o.deck) d.alts.forEach((a) => { a.picks[i] = [0, 0, 0, 0, 0]; }); });
    return d;
  }

  /** v0.3 只有一组：{ servants, mode, scope, deck, marked, turn }。以前的「仅含」在没指定牌的回合表示「一张都没有」 */
  function legacy() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('killprob.deal.v1') || 'null'); } catch (e) { /* 忽略 */ }
    const d = create(), a = d.alts[0];
    if (!s) { a.picks[0] = [1, 1, 0, 0, 0]; return d; }   // 第一次打开时的示例：BBAAQ，第 1 回合要 BB
    d.servants = s.servants === 2 ? 2 : 3;
    d.scope = d.servants === 3 && s.scope === 2 ? 2 : 1;
    if (D.DECKS.indexOf(s.deck) >= 0) d.owners[0].deck = s.deck;
    if (Array.isArray(s.marked) && s.marked.length === 5) d.owners[0].marked = s.marked.map(Boolean);
    if (Array.isArray(s.turn) && s.turn.length === 5) a.picks[0] = s.turn.map((t) => (t === 1 || t === 2 ? t : 0));
    if (s.mode === 'exact') { a.exact[0] = [true, true, true]; a.none[0] = [true, true, true]; }
    return d;
  }

  const store = new G.GroupStore({
    key: 'killprob.deal.v2', label: '发牌组', idPrefix: 'd',
    naming: (n) => '发牌组' + (n <= LETTERS.length ? LETTERS[n - 1] : n),
    create, clean: cleanData, legacy,
  });

  // ---------- 计算 ----------

  const turnCount = (d) => Math.min(d.scope, d.servants);
  const ownerOn = (d, o) => o < d.servants && !!d.owners[o].deck;
  const picksIn = (d, o, t) => CARDS.filter((i) => d.owners[o].picks[i] === t + 1);   // t 从 0 开始

  /** 这一格实际的条件：'include'（至少有）/ 'exact'（恰好是）/ 'free'（不限）/ 'none'（一张都不能有） */
  function cellMode(d, o, t) {
    if (picksIn(d, o, t).length) return d.exact[o][t] ? 'exact' : 'include';
    return d.none[o][t] ? 'none' : 'free';
  }

  /** 算一种条件（v = view(d, k)）：{ status: 'ok', r, opts, probability, span, servants } 或 { status: 'error', message } */
  function evaluateOne(d) {
    const T = turnCount(d);
    for (let t = 0; t < T; t++) {
      const n = TURNS.reduce((s, o) => s + (ownerOn(d, o) ? picksIn(d, o, t).length : 0), 0);
      if (n > 5) return { status: 'error', message: '第 ' + (t + 1) + ' 回合指定了 ' + n + ' 张牌，超过 5 张', span: T, servants: d.servants };
    }
    const owners = [];
    for (let o = 0; o < d.servants; o++) {
      if (!ownerOn(d, o)) { owners.push(null); continue; }
      const own = d.owners[o], ex = [];
      for (let t = 0; t < T; t++) { const m = cellMode(d, o, t); ex.push(m === 'exact' || m === 'none'); }
      owners.push({ cards: D.deckCards(own.deck, own.marked), picks: own.picks.map((p) => (p <= T ? p : 0)), exact: ex });
    }
    const opts = { servants: d.servants, turns: T, owners };
    const r = D.compute({ servants: d.servants, turns: T, owners, maxTerms: MAX_TERMS });
    return { status: 'ok', r, opts, probability: r.probability, span: T, servants: d.servants };
  }

  /**
   * 算一个发牌组：{ status: 'ok', r: 当前条件的结果, union: 「或者」的结果（只有一种条件时没有）, probability, span, servants }
   * 或 { status: 'error', message }。几种条件满足任意一种：deal.js 的 computeAny() 用容斥原理计算
   */
  function evaluate(d) {
    const T = turnCount(d);
    const ones = d.alts.map((a, k) => evaluateOne(view(d, k)));
    const bad = ones.findIndex((e) => e.status !== 'ok');
    if (bad >= 0) return { status: 'error', message: (ones.length > 1 ? '条件 ' + (bad + 1) + '：' : '') + ones[bad].message, span: T, servants: d.servants };
    if (ones.length === 1) return ones[0];
    const union = D.computeAny(ones.map((e) => e.opts), MAX_TERMS);
    return { status: 'ok', r: ones[d.alt].r, union, probability: union.probability, span: T, servants: d.servants };
  }

  // ---------- 文字 ----------

  const letter = (color) => '<b class="c-' + color + '">' + color + '</b>';
  const CIRCLED = ['①', '②', '③', '④', '⑤'];
  const ownerName = (o) => '从者' + (o + 1);

  /** 同色有两张以上开了纹章时按顺序编号 ①②③：每张的纹章不同，各自独立成一类，互不替代 */
  function markSuffix(own, i) {
    if (!own.marked[i]) return '';
    const same = CARDS.filter((j) => own.marked[j] && own.deck[j] === own.deck[i]);
    return same.length > 1 ? CIRCLED[same.indexOf(i)] : '';
  }

  /** 第 i 张牌的名称，例如「B」「纹章B」「纹章B②」 */
  const cardName = (own, i) => (own.marked[i] ? '纹章' : '') + letter(own.deck[i]) + markSuffix(own, i);
  const cardList = (own, indices) => indices.map((i) => cardName(own, i)).join('、');

  function describe(d) {
    const T = turnCount(d);
    const lines = [];
    for (let t = 0; t < T; t++) {
      const parts = [];
      for (let o = 0; o < d.servants; o++) {
        if (!ownerOn(d, o)) continue;
        const m = cellMode(d, o, t), own = d.owners[o];
        if (m === 'include') parts.push(ownerName(o) + '至少有 ' + cardList(own, picksIn(d, o, t)));
        else if (m === 'exact') parts.push(ownerName(o) + '恰好是 ' + cardList(own, picksIn(d, o, t)));
        else if (m === 'none') parts.push(ownerName(o) + '一张都不能有');
      }
      lines.push('第 ' + (t + 1) + ' 回合' + (parts.length ? '：' + parts.join('，') : '不限'));
    }
    return lines.join('<br>');
  }

  /** 几种条件时：每种条件一行 */
  function describeAll(d) {
    if (d.alts.length === 1) return describe(view(d));
    return '<div>满足任意一种：</div>' + d.alts.map((a, k) =>
      '<div' + (k === d.alt ? ' class="alt-on"' : '') + '>条件 ' + (k + 1) + '：' + describe(view(d, k)).replace(/<br>/g, '；') + '</div>').join('');
  }

  /** 由 deal.js 的 intersect() 结果（几种条件同时满足）得到可以用 describe() 显示的视图 */
  function optsView(d, opts) {
    const v = { servants: d.servants, scope: d.scope, exact: flags(), none: flags(),
      owners: d.owners.map((o, i) => ({ deck: o.deck, marked: o.marked, picks: opts.owners[i] ? opts.owners[i].picks : [0, 0, 0, 0, 0] })) };
    opts.owners.forEach((o, i) => {
      if (!o) return;
      o.exact.forEach((ex, t) => {
        if (!ex) return;
        if (o.picks.some((p) => p === t + 1)) v.exact[i][t] = true;
        else v.none[i][t] = true;
      });
    });
    return v;
  }

  function fractionText(r) {
    if (r.favorable === 0) return '不可能出现';
    if (r.favorable === r.total) return '必定出现';
    const g = D.gcd(r.favorable, r.total);
    let s = fmt(r.favorable) + ' / ' + fmt(r.total);
    if (g > 1) s += ' = ' + fmt(r.favorable / g) + ' / ' + fmt(r.total / g);
    return '<div>' + s + '</div><div>' +
      window.KillApp.frequencyText(r.favorable / r.total, (r.total - r.favorable) / r.total, '出现', '不出现') + '</div>';
  }

  function formatProbability(r) {
    if (r.favorable === r.total) return '100%';
    if (r.favorable === 0) return '0%';
    const p = r.probability * 100;
    if (p >= 99.99995) return '> 99.9999%';
    if (p < 0.00005) return '< 0.0001%';
    return p.toFixed(4) + '%';
  }

  // ---------- 计算过程 ----------

  const C = (f) => 'C(' + f.n + ',' + f.k + ')';

  function typeName(d, type) {
    const own = d.owners[type.owner];
    return type.marked ? cardName(own, type.members[0]) : letter(type.color);
  }

  /** 只有从者1 时不写「从者1」，和以前一样简洁 */
  const prefixOwners = (r) => r.owners.length > 1 || r.owners[0] !== 0;

  function counts(d, r, y) {
    return r.owners.map((o) => {
      const items = r.types.map((type, j) => (type.owner === o ? typeName(d, type) + '×' + y[j] : null)).filter(Boolean);
      return (prefixOwners(r) ? ownerName(o) + ' ' : '') + items.join(' ');
    }).join('，');
  }

  function turnTerm(d, r, part) {
    return (r.types.length ? counts(d, r, part.y) + ' + ' : '') + '其他' + part.others + '：' +
      part.factors.map(C).join('×') + ' = ' + fmt(part.ways);
  }

  /** 计算过程按回合分层：第 1 回合的每种发法下面列出后面回合的各种发法 */
  function treeHtml(d, r, leaves, t) {
    const groups = [];
    leaves.forEach((leaf) => {
      const last = groups[groups.length - 1];
      if (last && last.part === leaf.turns[t]) last.leaves.push(leaf);
      else groups.push({ part: leaf.turns[t], leaves: [leaf] });
    });
    return groups.map((g) => {
      const label = '第 ' + (t + 1) + ' 回合 ' + turnTerm(d, r, g.part);
      if (t === r.turns - 1) return { html: label, value: g.part.ways };
      const kids = treeHtml(d, r, g.leaves, t + 1);
      const sub = kids.reduce((s, k) => s + k.value, 0), value = g.part.ways * sub;
      let html = label;
      if (kids.length === 1) html += '<br>' + kids[0].html;
      else html += '<br>第 ' + (t + 2) + ' 回合可以是：<ul>' + kids.map((k) => '<li>' + k.html.replace(/^第 \d+ 回合 /, '') + '</li>').join('') + '</ul>';
      if (kids.length === 1 && sub === 1) return { html, value };   // 后面只有一种发法（例如最后一回合发出剩下的牌）：不用再写小计
      html += (kids.length === 1 ? '<br>' : '') + '小计 ' + fmt(g.part.ways) + ' × ' +
        (kids.length > 1 ? '(' + kids.map((k) => fmt(k.value)).join(' + ') + ') = ' + fmt(g.part.ways) + ' × ' + fmt(sub) : fmt(sub)) +
        ' = ' + fmt(value);
      return { html, value };
    });
  }

  /** 「或者」的计算过程：容斥原理的每一项 */
  function unionHtml(d, u) {
    const shown = u.parts.filter((x) => x.set.length === 1 || x.favorable);
    const skipped = u.parts.length - shown.length;
    const label = (x) => '条件 ' + x.set.map((i) => i + 1).join('、') + (x.set.length > 1 ? ' 同时满足（' + describe(optsView(d, x.opts)).replace(/<br>/g, '；') + '）' : '');
    const items = shown.map((x, i) => '<li>' + (i ? (x.sign > 0 ? '＋ ' : '− ') : '') + label(x) + '：' + fmt(x.favorable) + ' 种</li>');
    const expr = shown.map((x, i) => (i ? (x.sign > 0 ? ' + ' : ' − ') : '') + fmt(x.favorable)).join('');
    return '<p>满足任意一种条件即可。有的发牌同时满足好几种条件，把各条件的种数直接相加会重复计算（甚至超过 100%），' +
      '所以用容斥原理：各条件相加，减去两两同时满足的，加上三个同时满足的……</p>' +
      '<ul class="union">' + items.join('') + '</ul>' +
      (skipped ? '<p>另有 ' + skipped + ' 组条件不可能同时满足（0 种），省略。</p>' : '') +
      '<p class="sum">' + expr + ' = ' + fmt(u.favorable) + ' 种 → ' + fmt(u.favorable) + ' / ' + fmt(u.total) + ' = ' +
      (u.probability * 100).toFixed(4) + '%</p>' +
      '<p class="union-sub">下面是条件 ' + (d.alt + 1) + ' 的计算过程（点上面的「条件 n」查看其他条件）：</p>';
  }

  function stepsHtml(d, r) {
    const N = r.N, T = r.turns, out = [];
    const parts = r.owners.map((o) => (prefixOwners(r) ? ownerName(o) + ' 的 ' : '') +
      r.types.filter((type) => type.owner === o).map((type) => typeName(d, type) + '×' + type.size).join('、'));
    out.push('<p>牌库 ' + N + ' 张。' + (r.types.length
      ? (prefixOwners(r) ? '参与计算的牌：' + parts.join('；') : '从者1 的牌分为 ' + parts[0]) +
        (r.types.some((type) => type.marked) ? '（开了纹章的牌单独算一种）' : '') + '；其他牌 ' + r.others + ' 张（只看张数）。'
      : '没有给任何从者指定条件。') + '</p>');
    const totals = r.turnTotals.map((n, t) => (t === 0 ? '第 1 回合从 ' + N + ' 张里发 5 张' : '第 ' + (t + 1) + ' 回合从剩下的 ' + (N - 5 * t) + ' 张里发 5 张') +
      '：C(' + (N - 5 * t) + ',5) = ' + fmt(n) + ' 种');
    out.push('<p>' + totals.join('；') + (T > 1 ? '；共 ' + r.turnTotals.map(fmt).join(' × ') + ' = ' + fmt(r.total) + ' 种' : '') + '，每种的可能性相同。</p>');
    if (!r.types.length) {
      out.push('<p class="sum">没有指定任何牌，必定满足。</p>');
      return out.join('');
    }
    out.push('<p>满足条件的发牌（每种牌各发几张 + 其他牌几张）：</p>');
    if (r.terms.length) {
      out.push('<ol>' + treeHtml(d, r, r.terms, 0).map((k) => '<li>' + k.html.replace(/^第 1 回合 /, T > 1 ? '第 1 回合 ' : '') + '</li>').join('') + '</ol>');
    } else out.push('<p>（没有满足条件的发牌）</p>');
    if (r.truncated) out.push('<p>……项数太多，只列出前 ' + r.terms.length + ' 种情况（共 ' + fmt(r.termCount) + ' 种）</p>');
    out.push('<p class="sum">合计 ' + fmt(r.favorable) + ' 种 → ' + fmt(r.favorable) + ' / ' + fmt(r.total) + ' = ' +
      (r.probability * 100).toFixed(4) + '%</p>');
    return out.join('');
  }

  // ---------- 界面 ----------

  const opening = new Set();                             // 正在选配卡、还没选好的从者 2 / 3

  function renderControls(d) {
    document.querySelectorAll('#viewDeal .seg[data-key="servants"] button').forEach((b) => {
      const on = String(d.servants) === b.dataset.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
    const scopes = d.servants === 3 ? ['第 1 回合', '1–2 回合', '1–3 回合'] : ['第 1 回合', '1–2 回合'];
    $('scopeSeg').innerHTML = scopes.map((label, i) => {
      const on = d.scope === i + 1;
      return '<button type="button" data-value="' + (i + 1) + '" class="' + (on ? 'on' : '') + '" aria-pressed="' + on + '">' + label + '</button>';
    }).join('');
    const T = turnCount(d), hints = [];
    if (T === 1) hints.push('第 1 回合从 ' + 5 * d.servants + ' 张里发 5 张');
    else hints.push('共享发牌：同一轮洗牌的前 ' + T + ' 个回合，前面发出的牌后面不会再发');
    if (T === d.servants) hints.push('第 ' + T + ' 回合发出的就是前面剩下的 5 张');
    hints.push('「第 n 回合」下面的小按钮切换条件：选了牌时「包含 / 仅含」，没选牌时「不限 / 不能有」');
    $('dealHint').textContent = hints.join('。') + '。';
  }

  function deckButtons(o, current) {
    return D.DECKS.map((deck) =>
      '<button type="button" data-owner="' + o + '" data-deck="' + deck + '" class="' + (deck === current ? 'on' : '') + '" aria-pressed="' + (deck === current) + '">' +
      deck.split('').map(letter).join('') + '</button>').join('');
  }

  const MODE_TEXT = { include: '包含', exact: '仅含', free: '不限', none: '不能有' };
  const MODE_TIP = { include: '至少发到选中的牌', exact: '发到的这名从者的牌恰好是选中的这些', free: '这名从者的牌不限', none: '这一回合一张这名从者的牌都不能有' };

  function ownerGrid(d, o) {
    const own = d.owners[o], T = turnCount(d);
    let html = '<div class="g-label"></div>';
    own.deck.split('').forEach((color, i) => {
      const badge = own.marked[i] ? ' marked" data-badge="纹' + markSuffix(own, i) : '';
      html += '<div class="chip ' + color + badge + '">' + color + '</div>';
    });
    html += '<div class="g-label">纹章</div>';
    own.marked.forEach((on, i) => {
      html += '<button type="button" class="mark' + (on ? ' on' : '') + '" data-owner="' + o + '" data-mark="' + i + '" aria-pressed="' + on + '">纹章</button>';
    });
    for (let t = 1; t <= T; t++) {
      const m = cellMode(d, o, t - 1), strong = m === 'exact' || m === 'none';
      html += '<div class="g-label g-turn">第 ' + t + ' 回合<button type="button" class="cell-mode' + (strong ? ' on' : '') + '" data-owner="' + o +
        '" data-cell="' + (t - 1) + '" aria-pressed="' + strong + '" title="' + MODE_TIP[m] + '" aria-label="第 ' + t + ' 回合' + ownerName(o) + '：' + MODE_TIP[m] + '，点按切换">' +
        MODE_TEXT[m] + '</button></div>';
      own.deck.split('').forEach((color, i) => {
        const on = own.picks[i] === t;
        html += '<button type="button" class="pick' + (on ? ' on' : '') + '" data-owner="' + o + '" data-turn="' + t + '" data-card="' + i + '" aria-pressed="' + on +
          '" aria-label="第 ' + t + ' 回合要发到' + ownerName(o) + '的第 ' + (i + 1) + ' 张牌 ' + color + '">' + (on ? '✓' : '') + '</button>';
      });
    }
    return '<div class="deal-grid">' + html + '</div>';
  }

  function renderAlts(d) {
    const n = d.alts.length;
    let html;
    if (n === 1) {
      html = '<button type="button" class="owner-add" data-alt-add="1">＋ 或者：再加一种也可以接受的发牌</button>';
    } else {
      html = '<div class="alt-bar"><div class="seg alt-seg">' + d.alts.map((a, k) =>
        '<button type="button" data-alt="' + k + '" class="' + (k === d.alt ? 'on' : '') + '" aria-pressed="' + (k === d.alt) + '">条件 ' + (k + 1) + '</button>').join('') +
        '</div>' + (n < MAX_ALTS ? '<button type="button" class="alt-add" data-alt-add="1">＋ 或者</button>' : '') + '</div>' +
        '<div class="option-hint">满足任意一种即可（最多 ' + MAX_ALTS + ' 种）。下面编辑的是条件 ' + (d.alt + 1) + '。' +
        '<button type="button" class="alt-remove" data-alt-remove="' + d.alt + '">删除条件 ' + (d.alt + 1) + '</button></div>';
    }
    $('dealAlts').innerHTML = '<section class="panel alts">' + html + '</section>';
  }

  function renderOwners(d) {
    let html = '';
    for (let o = 0; o < d.servants; o++) {
      const own = d.owners[o];
      if (o > 0 && !own.deck && !opening.has(o)) {
        html += '<section class="panel owner owner-empty"><button type="button" class="owner-add" data-add="' + o + '">＋ 指定' + ownerName(o) + '的牌</button>' +
          '<div class="panel-sub">不指定时，' + ownerName(o) + '的牌只看张数，结果和以前一样</div></section>';
        continue;
      }
      html += '<section class="panel owner"><div class="owner-head"><span class="panel-title">' + ownerName(o) + (o === 0 ? '' : '') + ' 配卡</span>' +
        (o > 0 ? '<button type="button" class="owner-remove" data-remove="' + o + '">不指定</button>' : '') + '</div>' +
        '<div class="decks">' + deckButtons(o, own.deck) + '</div>' +
        (own.deck ? '<div class="panel-title">要发到的牌 <span class="panel-sub">点格子选择；同一张牌只能选一个回合</span></div>' + ownerGrid(d, o)
          : '<div class="panel-sub">先选' + ownerName(o) + '的配卡</div>') + '</section>';
    }
    $('dealOwners').innerHTML = html;
  }

  function update() {
    const d = store.active().data, v = view(d);
    renderControls(d);
    renderAlts(d);
    renderOwners(v);
    const e = evaluate(d);
    $('dealDesc').innerHTML = describeAll(d);
    if (e.status !== 'ok') {
      $('dealProb').textContent = '—';
      $('dealProb').classList.add('idle');
      $('dealMeter').style.width = '0';
      $('dealFraction').innerHTML = '<span class="warn">' + e.message + '</span>';
      $('dealStepsBody').innerHTML = '';
      return;
    }
    const res = e.union || e.r;                          // 几种条件时显示「满足任意一种」的结果
    $('dealProb').textContent = formatProbability(res);
    $('dealProb').classList.remove('idle');
    $('dealMeter').style.width = res.probability * 100 + '%';
    $('dealFraction').innerHTML = fractionText(res);
    $('dealStepsBody').innerHTML = (e.union ? unionHtml(d, e.union) : '') + stepsHtml(v, e.r);
  }

  function summary(g) {
    const e = evaluate(g.data);
    const span = e.span > 1 ? '1–' + e.span + ' 回合' : '单回合';
    const alts = g.data.alts.length > 1 ? ' · ' + g.data.alts.length + ' 种之一' : '';
    return (e.status === 'ok' ? window.KillApp.formatShort(e.probability) : '有误') + ' · ' + span + alts;
  }

  window.DealApp = { store, evaluate, summary };

  // ---------- 事件 ----------

  /** 重画后把键盘焦点放回同一个按钮 */
  function refocus(selector, byKeyboard) {
    if (!byKeyboard) return;
    const el = document.querySelector(selector);
    if (el) el.focus();
  }

  function changed(selector, e) {
    store.changed();
    update();
    if (selector) refocus(selector, e && e.detail === 0);
  }

  document.querySelector('#viewDeal .seg[data-key="servants"]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = store.active().data;
    d.servants = Number(b.dataset.value);
    d.scope = Math.min(d.scope, d.servants);
    changed();
  });

  $('scopeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    store.active().data.scope = Number(b.dataset.value);
    changed('#scopeSeg [data-value="' + b.dataset.value + '"]', e);
  });

  $('dealOwners').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = store.active().data, v = view(d);
    /** 换配卡、不指定某名从者：清空他在所有条件里的选牌和包含 / 仅含 */
    const resetOwner = (o) => d.alts.forEach((a) => {
      a.picks[o] = [0, 0, 0, 0, 0];
      a.exact[o] = [false, false, false];
      a.none[o] = [false, false, false];
    });
    if (b.dataset.add) {                                 // 展开从者 2 / 3，选配卡
      opening.add(Number(b.dataset.add));
      update();
      refocus('[data-owner="' + b.dataset.add + '"][data-deck]', e.detail === 0);
      return;
    }
    if (b.dataset.remove) {                              // 不指定从者 2 / 3：他的牌只看张数
      const o = Number(b.dataset.remove);
      d.owners[o] = blankOwner('');
      resetOwner(o);
      opening.delete(o);
      changed();
      return;
    }
    const o = Number(b.dataset.owner), own = v.owners[o];
    if (b.dataset.deck) {
      if (b.dataset.deck === own.deck) return;
      d.owners[o] = blankOwner(b.dataset.deck);          // 换配卡后牌的位置变了，清空纹章和所有条件里的选择
      resetOwner(o);
      opening.delete(o);
      changed('[data-owner="' + o + '"][data-deck="' + b.dataset.deck + '"]', e);
    } else if (b.dataset.mark !== undefined) {
      const i = Number(b.dataset.mark);
      own.marked[i] = !own.marked[i];
      changed('[data-owner="' + o + '"][data-mark="' + i + '"]', e);
    } else if (b.dataset.cell !== undefined) {
      const t = Number(b.dataset.cell);
      if (picksIn(v, o, t).length) v.exact[o][t] = !v.exact[o][t];
      else v.none[o][t] = !v.none[o][t];
      changed('[data-owner="' + o + '"][data-cell="' + t + '"]', e);
    } else if (b.dataset.card !== undefined) {
      const i = Number(b.dataset.card), t = Number(b.dataset.turn);
      own.picks[i] = own.picks[i] === t ? 0 : t;         // 再点一次取消；点另一个回合则改到那个回合
      changed('[data-owner="' + o + '"][data-turn="' + t + '"][data-card="' + i + '"]', e);
    }
  });

  $('dealAlts').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = store.active().data;
    if (b.dataset.alt !== undefined) {
      d.alt = Number(b.dataset.alt);
      changed('[data-alt="' + d.alt + '"]', e);
    } else if (b.dataset.altAdd) {
      if (d.alts.length >= MAX_ALTS) return;
      d.alts.push(blankAlt());
      d.alt = d.alts.length - 1;
      changed('[data-alt="' + d.alt + '"]', e);
    } else if (b.dataset.altRemove !== undefined) {
      const k = Number(b.dataset.altRemove);
      G.confirmBox('删除条件 ' + (k + 1) + '？', { ok: '删除', danger: true }).then((yes) => {
        if (!yes || d.alts.length <= 1) return;
        d.alts.splice(k, 1);
        d.alt = Math.min(k, d.alts.length - 1);
        changed();
      });
    }
  });

  $('dealClear').addEventListener('click', () => {
    const d = store.active().data;
    d.owners.forEach((own) => { own.marked = [false, false, false, false, false]; });
    d.alts = [blankAlt()];                               // 「或者」的条件也一起清空
    d.alt = 0;
    changed();
  });

  store.onChange((reason) => {
    if (reason === 'data' || reason === 'rename') return;
    opening.clear();
    update();
  });
  new G.GroupBar($('dealGroups'), store, { summary, onUsed: (id) => (window.ComboApp ? window.ComboApp.usage('deal', id) : 0) });

  update();
})();
