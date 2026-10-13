// 发牌概率页面：选择场上人数、打手配卡、纹章和每个回合要发到的牌 → 调用 deal.js 计算并显示计算过程
(function () {
  'use strict';

  const D = window.Deal;
  const STORAGE_KEY = 'killprob.deal.v1';
  const MAX_TERMS = 40;                                  // 计算过程最多列出的项数
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);

  // turn[i]：打手第 i 张牌要求在第几回合发到（0 = 不指定）。第一次打开时的示例：BBAAQ，第 1 回合要 BB
  const state = { servants: 3, mode: 'include', scope: 1, deck: 'BBAAQ', marked: [false, false, false, false, false], turn: [1, 1, 0, 0, 0] };

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!s) return;
      if (s.servants === 2 || s.servants === 3) state.servants = s.servants;
      if (s.mode === 'include' || s.mode === 'exact') state.mode = s.mode;
      if (s.scope === 1 || s.scope === 2) state.scope = s.scope;
      if (D.DECKS.indexOf(s.deck) >= 0) state.deck = s.deck;
      if (Array.isArray(s.marked) && s.marked.length === 5) state.marked = s.marked.map(Boolean);
      if (Array.isArray(s.turn) && s.turn.length === 5) state.turn = s.turn.map((t) => (t === 1 || t === 2 ? t : 0));
    } catch (e) { /* 忽略 */ }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 无痕模式等 */ }
  }

  /** 实际参与计算的回合数：2 人时第 2 回合就是剩下的 5 张，只算第 1 回合 */
  const turnCount = () => (state.servants === 3 ? state.scope : 1);

  // ---------- 文字 ----------

  const letter = (color) => '<b class="c-' + color + '">' + color + '</b>';
  const CIRCLED = ['①', '②', '③', '④', '⑤'];

  /** 同色有两张以上开了纹章时按顺序编号 ①②③：每张的纹章不同，各自独立成一类，互不替代 */
  function markSuffix(i) {
    if (!state.marked[i]) return '';
    const same = [0, 1, 2, 3, 4].filter((j) => state.marked[j] && state.deck[j] === state.deck[i]);
    return same.length > 1 ? CIRCLED[same.indexOf(i)] : '';
  }

  /** 打手第 i 张牌的名称，例如「B」「纹章B」「纹章B②」 */
  const cardName = (i) => (state.marked[i] ? '纹章' : '') + letter(state.deck[i]) + markSuffix(i);
  const typeName = (type) => (type.marked ? cardName(type.members[0]) : letter(type.color));

  /** 选中的几张牌，例如「B、B、纹章A」 */
  function cardList(indices) {
    return indices.map(cardName).join('、');
  }

  function describe(turns) {
    const lines = turns.map((indices, t) => {
      const name = '第 ' + (t + 1) + ' 回合';
      if (state.mode === 'include') return indices.length ? name + '至少发到打手的 ' + cardList(indices) : name + '不限';
      return indices.length ? name + '发到的打手的牌恰好是 ' + cardList(indices) : name + '一张打手的牌都没有';
    });
    const chosen = turns.reduce((s, indices) => s + indices.length, 0);
    if (state.mode === 'exact' && chosen < 5) {
      const last = turns.length + 1;
      if (last <= state.servants) lines.push('打手其余的牌都在第 ' + last + (last < state.servants ? ' 回合及以后' : ' 回合') + '发出');
    }
    return lines.join('；');
  }

  function oneIn(x) {
    return x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : fmt(Math.round(x));
  }

  function fractionText(r) {
    if (r.favorable === 0) return '不可能出现';
    if (r.favorable === r.total) return '必定出现';
    const g = D.gcd(r.favorable, r.total);
    let s = fmt(r.favorable) + ' / ' + fmt(r.total);
    if (g > 1) s += ' = ' + fmt(r.favorable / g) + ' / ' + fmt(r.total / g);
    return s + ' · 约每 ' + oneIn(r.total / r.favorable) + ' 次出现 1 次';
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
  const counts = (r, y) => r.types.map((type, j) => typeName(type) + '×' + y[j]).join(' ');

  function turnTerm(r, part) {
    return counts(r, part.y) + ' + 其他' + part.others + '：' + part.factors.map(C).join('×') + ' = ' + fmt(part.ways);
  }

  function stepsHtml(r, turns) {
    const N = 5 * r.servants, T = turns.length;
    const out = [];
    out.push('<p>牌库 ' + N + ' 张：打手 5 张 + 其他从者 ' + (N - 5) + ' 张。打手的牌分为 ' +
      r.types.map((type) => typeName(type) + '×' + type.size).join('、') +
      (r.types.some((type) => type.marked) ? '（开了纹章的牌单独算一种）' : '') + '。</p>');
    out.push('<p>第 1 回合从 ' + N + ' 张里发 5 张：C(' + N + ',5) = ' + fmt(r.turnTotals[0]) + ' 种' +
      (T === 2 ? '；第 2 回合从剩下的 ' + (N - 5) + ' 张里发 5 张：C(' + (N - 5) + ',5) = ' + fmt(r.turnTotals[1]) +
        ' 种；两回合共 ' + fmt(r.turnTotals[0]) + ' × ' + fmt(r.turnTotals[1]) + ' = ' + fmt(r.total) + ' 种' : '') +
      '，每种的可能性相同。</p>');
    if (state.mode === 'include' && turns.every((indices) => !indices.length)) {
      out.push('<p class="sum">没有指定任何牌，必定满足。</p>');
      return out.join('');
    }
    out.push('<p>满足条件的发牌（打手每种牌各发几张 + 其他从者的牌几张）：</p><ol>');
    if (T === 1) {
      r.terms.slice(0, MAX_TERMS).forEach((term) => out.push('<li>' + turnTerm(r, term.turns[0]) + '</li>'));
    } else {
      // 按第 1 回合的发牌分组：第 1 回合的组合数 × 第 2 回合各种情况的组合数之和
      const groups = [];
      r.terms.forEach((term) => {
        const last = groups[groups.length - 1];
        if (last && last.first === term.turns[0]) last.seconds.push(term.turns[1]);
        else groups.push({ first: term.turns[0], seconds: [term.turns[1]] });
      });
      let shown = 0;
      groups.forEach((g) => {
        if (shown >= MAX_TERMS) return;
        const a = g.first.ways, sub = g.seconds.reduce((s, p) => s + p.ways, 0);
        let li = '<li>第 1 回合 ' + turnTerm(r, g.first) + '<br>第 2 回合' + (g.seconds.length > 1 ? '可以是：' : ' ');
        li += g.seconds.length > 1
          ? '<ul>' + g.seconds.map((p) => '<li>' + turnTerm(r, p) + '</li>').join('') + '</ul>小计 ' + fmt(a) + ' × (' +
            g.seconds.map((p) => fmt(p.ways)).join(' + ') + ') = ' + fmt(a) + ' × ' + fmt(sub) + ' = ' + fmt(a * sub)
          : turnTerm(r, g.seconds[0]) + '<br>两回合：' + fmt(a) + ' × ' + fmt(sub) + ' = ' + fmt(a * sub);
        out.push(li + '</li>');
        shown += g.seconds.length;
      });
    }
    out.push('</ol>');
    if (r.terms.length > MAX_TERMS) out.push('<p>……项数太多，只列出前一部分（共 ' + r.terms.length + ' 种情况）</p>');
    if (!r.terms.length) out.push('<p>（没有满足条件的发牌）</p>');
    out.push('<p class="sum">合计 ' + fmt(r.favorable) + ' 种 → ' + fmt(r.favorable) + ' / ' + fmt(r.total) + ' = ' +
      (r.probability * 100).toFixed(4) + '%</p>');
    return out.join('');
  }

  // ---------- 界面 ----------

  function renderControls() {
    document.querySelectorAll('#viewDeal .seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => {
        const on = String(state[seg.dataset.key]) === b.dataset.value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on);
      });
    });
    $('scopeRow').hidden = state.servants !== 3;
    const hints = [state.mode === 'include'
      ? '包含：至少发到选中的牌，同时发到打手的其他牌也算'
      : '仅含：发到的打手的牌恰好是选中的这些，不能有打手的其他牌'];
    if (state.servants === 2) hints.push('2 人上场：牌库 10 张，第 1 回合发 5 张，第 2 回合发出剩下的 5 张');
    else if (state.scope === 2) hints.push('共享发牌：第 1 回合从 15 张里发 5 张，第 2 回合从剩下的 10 张里发 5 张');
    $('dealHint').textContent = hints.join('。');

    $('decks').innerHTML = D.DECKS.map((deck) =>
      '<button type="button" data-deck="' + deck + '" class="' + (deck === state.deck ? 'on' : '') + '" aria-pressed="' + (deck === state.deck) + '">' +
      deck.split('').map(letter).join('') + '</button>').join('');
  }

  function renderGrid() {
    const T = turnCount();
    let html = '<div class="g-label"></div>';
    state.deck.split('').forEach((color, i) => {
      const badge = state.marked[i] ? ' marked" data-badge="纹' + markSuffix(i) : '';
      html += '<div class="chip ' + color + badge + '">' + color + '</div>';
    });
    html += '<div class="g-label">纹章</div>';
    state.marked.forEach((on, i) => {
      html += '<button type="button" class="mark' + (on ? ' on' : '') + '" data-mark="' + i + '" aria-pressed="' + on + '">纹章</button>';
    });
    for (let t = 1; t <= T; t++) {
      html += '<div class="g-label">第 ' + t + ' 回合</div>';
      state.deck.split('').forEach((color, i) => {
        const on = state.turn[i] === t;
        html += '<button type="button" class="pick' + (on ? ' on' : '') + '" data-turn="' + t + '" data-card="' + i + '" aria-pressed="' + on +
          '" aria-label="第 ' + t + ' 回合要发到第 ' + (i + 1) + ' 张牌 ' + color + '">' + (on ? '✓' : '') + '</button>';
      });
    }
    $('dealGrid').innerHTML = html;
  }

  function update() {
    save();
    renderControls();
    renderGrid();
    const T = turnCount();
    const turns = [];
    for (let t = 1; t <= T; t++) turns.push([0, 1, 2, 3, 4].filter((i) => state.turn[i] === t));
    const r = D.dealProbability({ servants: state.servants, cards: D.deckCards(state.deck, state.marked), turns: turns, mode: state.mode });
    $('dealProb').textContent = formatProbability(r);
    $('dealMeter').style.width = r.probability * 100 + '%';
    $('dealDesc').innerHTML = describe(turns);
    $('dealFraction').textContent = fractionText(r);
    $('dealStepsBody').innerHTML = stepsHtml(r, turns);
  }

  // ---------- 事件 ----------

  /** 重画后把键盘焦点放回同一个按钮 */
  function refocus(selector, byKeyboard) {
    if (!byKeyboard) return;
    const el = document.querySelector(selector);
    if (el) el.focus();
  }

  document.querySelectorAll('#viewDeal .seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const key = seg.dataset.key;
      state[key] = key === 'mode' ? b.dataset.value : Number(b.dataset.value);
      update();
    });
  });

  $('decks').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-deck]');
    if (!b || b.dataset.deck === state.deck) return;
    state.deck = b.dataset.deck;                         // 换配卡后牌的位置变了，清空纹章和选择
    state.marked = [false, false, false, false, false];
    state.turn = [0, 0, 0, 0, 0];
    update();
    refocus('[data-deck="' + state.deck + '"]', e.detail === 0);
  });

  $('dealGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    let selector;
    if (b.dataset.mark !== undefined) {
      const i = Number(b.dataset.mark);
      state.marked[i] = !state.marked[i];
      selector = '[data-mark="' + i + '"]';
    } else {
      const i = Number(b.dataset.card), t = Number(b.dataset.turn);
      state.turn[i] = state.turn[i] === t ? 0 : t;       // 再点一次取消；点另一个回合则改到那个回合
      selector = '[data-turn="' + t + '"][data-card="' + i + '"]';
    }
    update();
    refocus(selector, e.detail === 0);
  });

  $('dealClear').addEventListener('click', () => {
    state.turn = [0, 0, 0, 0, 0];
    state.marked = [false, false, false, false, false];
    update();
  });

  load();
  update();
})();
