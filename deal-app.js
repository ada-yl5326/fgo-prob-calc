// 发牌概率页面：发牌组（场上人数、共享几个回合、最多 3 名从者的配卡 / 纹章 / 每回合要发到的牌、每格包含或仅含）
// → 调用 deal.js 计算并显示计算过程
(function () {
  'use strict';

  const D = window.Deal;
  const G = window.Groups;
  const MAX_TERMS = 40;                                  // 计算过程最多列出的项数
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
  const TURNS = [0, 1, 2];
  const CARDS = [0, 1, 2, 3, 4];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // ---------- 发牌组的数据 ----------
  //   servants: 场上人数 3 / 2；scope: 共享前几个回合（1 ~ servants）
  //   owners[o]: { deck: 配卡（从者 2、3 可以是 '' = 不指定）, marked: 纹章 × 5, picks: 每张牌要在第几回合发到（0 = 不要求）}
  //   exact[o][t]: 第 t 回合指定了牌时是否「仅含」；none[o][t]: 没指定牌时是否「一张都不能有」

  const blankOwner = (deck) => ({ deck, marked: [false, false, false, false, false], picks: [0, 0, 0, 0, 0] });
  const flags = () => TURNS.map(() => TURNS.map(() => false));

  function create() {
    return { servants: 3, scope: 1, owners: [blankOwner('BBAAQ'), blankOwner(''), blankOwner('')], exact: flags(), none: flags() };
  }

  function cleanData(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.owners)) return null;
    const d = create();
    d.servants = raw.servants === 2 ? 2 : 3;
    d.scope = Math.min(d.servants, [1, 2, 3].indexOf(raw.scope) >= 0 ? raw.scope : 1);
    raw.owners.slice(0, 3).forEach((o, i) => {
      if (!o) return;
      const deck = D.DECKS.indexOf(o.deck) >= 0 ? o.deck : i === 0 ? 'BBAAQ' : '';
      d.owners[i] = {
        deck,
        marked: CARDS.map((k) => !!(Array.isArray(o.marked) && o.marked[k])),
        picks: CARDS.map((k) => (Array.isArray(o.picks) && [1, 2, 3].indexOf(o.picks[k]) >= 0 ? o.picks[k] : 0)),
      };
    });
    ['exact', 'none'].forEach((key) => {
      if (Array.isArray(raw[key])) d[key] = TURNS.map((o) => TURNS.map((t) => !!(raw[key][o] && raw[key][o][t])));
    });
    return d;
  }

  /** v0.3 只有一组：{ servants, mode, scope, deck, marked, turn }。以前的「仅含」在没指定牌的回合表示「一张都没有」 */
  function legacy() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('killprob.deal.v1') || 'null'); } catch (e) { /* 忽略 */ }
    const d = create();
    if (!s) { d.owners[0].picks = [1, 1, 0, 0, 0]; return d; }   // 第一次打开时的示例：BBAAQ，第 1 回合要 BB
    d.servants = s.servants === 2 ? 2 : 3;
    d.scope = d.servants === 3 && s.scope === 2 ? 2 : 1;
    if (D.DECKS.indexOf(s.deck) >= 0) d.owners[0].deck = s.deck;
    if (Array.isArray(s.marked) && s.marked.length === 5) d.owners[0].marked = s.marked.map(Boolean);
    if (Array.isArray(s.turn) && s.turn.length === 5) d.owners[0].picks = s.turn.map((t) => (t === 1 || t === 2 ? t : 0));
    if (s.mode === 'exact') { d.exact[0] = [true, true, true]; d.none[0] = [true, true, true]; }
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

  /** 算一个发牌组：{ status: 'ok', r, probability, span, servants } 或 { status: 'error', message } */
  function evaluate(d) {
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
    const r = D.compute({ servants: d.servants, turns: T, owners, maxTerms: MAX_TERMS });
    return { status: 'ok', r, probability: r.probability, span: T, servants: d.servants };
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
    hints.push('每回合左边的小按钮切换：指定了牌时「包含 / 仅含」，没指定时「不限 / 一张都不能有」');
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
    const d = store.active().data;
    renderControls(d);
    renderOwners(d);
    const e = evaluate(d);
    if (e.status !== 'ok') {
      $('dealProb').textContent = '—';
      $('dealProb').classList.add('idle');
      $('dealMeter').style.width = '0';
      $('dealDesc').innerHTML = describe(d);
      $('dealFraction').innerHTML = '<span class="warn">' + e.message + '</span>';
      $('dealStepsBody').innerHTML = '';
      return;
    }
    const r = e.r;
    $('dealProb').textContent = formatProbability(r);
    $('dealProb').classList.remove('idle');
    $('dealMeter').style.width = r.probability * 100 + '%';
    $('dealDesc').innerHTML = describe(d);
    $('dealFraction').innerHTML = fractionText(r);
    $('dealStepsBody').innerHTML = stepsHtml(d, r);
  }

  function summary(g) {
    const e = evaluate(g.data);
    const span = e.span > 1 ? '1–' + e.span + ' 回合' : '单回合';
    return (e.status === 'ok' ? window.KillApp.formatShort(e.probability) : '有误') + ' · ' + span;
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
    const d = store.active().data;
    if (b.dataset.add) {                                 // 展开从者 2 / 3，选配卡
      opening.add(Number(b.dataset.add));
      update();
      refocus('[data-owner="' + b.dataset.add + '"][data-deck]', e.detail === 0);
      return;
    }
    if (b.dataset.remove) {                              // 不指定从者 2 / 3：他的牌只看张数
      const o = Number(b.dataset.remove);
      d.owners[o] = blankOwner('');
      d.exact[o] = [false, false, false];
      d.none[o] = [false, false, false];
      opening.delete(o);
      changed();
      return;
    }
    const o = Number(b.dataset.owner), own = d.owners[o];
    if (b.dataset.deck) {
      if (b.dataset.deck === own.deck) return;
      d.owners[o] = blankOwner(b.dataset.deck);          // 换配卡后牌的位置变了，清空纹章和选择
      opening.delete(o);
      changed('[data-owner="' + o + '"][data-deck="' + b.dataset.deck + '"]', e);
    } else if (b.dataset.mark !== undefined) {
      const i = Number(b.dataset.mark);
      own.marked[i] = !own.marked[i];
      changed('[data-owner="' + o + '"][data-mark="' + i + '"]', e);
    } else if (b.dataset.cell !== undefined) {
      const t = Number(b.dataset.cell);
      if (picksIn(d, o, t).length) d.exact[o][t] = !d.exact[o][t];
      else d.none[o][t] = !d.none[o][t];
      changed('[data-owner="' + o + '"][data-cell="' + t + '"]', e);
    } else if (b.dataset.card !== undefined) {
      const i = Number(b.dataset.card), t = Number(b.dataset.turn);
      own.picks[i] = own.picks[i] === t ? 0 : t;         // 再点一次取消；点另一个回合则改到那个回合
      changed('[data-owner="' + o + '"][data-turn="' + t + '"][data-card="' + i + '"]', e);
    }
  });

  $('dealClear').addEventListener('click', () => {
    const d = store.active().data;
    d.owners.forEach((own) => { own.picks = [0, 0, 0, 0, 0]; own.marked = [false, false, false, false, false]; });
    d.exact = flags();
    d.none = flags();
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
