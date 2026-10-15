// 综合击破概率页面：把伤害组、发牌组、送人组拖进各个回合（或先点组、再点回合），算出整个方案的综合击破率。
// 每个回合 = 我方行动阶段（发牌、击破）+ 敌方行动阶段（送人）
(function () {
  'use strict';

  const C = window.Combo;
  const DealCore = window.Deal;
  const G = window.Groups;
  const Kill = window.KillApp, Deal = window.DealApp, Send = window.SendApp;
  const STORAGE_KEY = 'killprob.combo.v1';
  const $ = (id) => document.getElementById(id);
  const esc = G.escapeHtml;
  const short = Kill.formatShort;
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);

  // ---------- 方案 ----------

  // split[t]：第 t 回合按条件分配 { alts: [伤害组 id | null] × 条件数, other: 伤害组 id | null,
  //                                 sends: [送人组 id | null（跟随回合）] × 条件数, sendOther: 送人组 id | null }，不分条件时为 null
  // send[t]：第 t 回合敌方行动阶段的送人组
  let plan = { turns: 3, kill: [null, null, null], deal: [], split: [null, null, null], send: [null, null, null] };
  let notice = '';                                       // 一次性的提示（例如引用的组被删除了）

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!s || !(s.turns >= 1)) return;
      const n = Math.min(C.MAX_TURNS, Math.floor(s.turns));
      plan = {
        turns: n,
        kill: Array.from({ length: n }, (_, t) => (Array.isArray(s.kill) && typeof s.kill[t] === 'string' ? s.kill[t] : null)),
        deal: (Array.isArray(s.deal) ? s.deal : [])
          .filter((p) => p && typeof p.id === 'string' && p.at >= 0 && p.at < n)
          .map((p) => ({ at: Math.floor(p.at), id: p.id }))
          .sort((a, b) => a.at - b.at),
        split: Array.from({ length: n }, (_, t) => {
          const sp = Array.isArray(s.split) ? s.split[t] : null;
          if (!sp || typeof sp !== 'object' || !Array.isArray(sp.alts)) return null;
          const id = (x) => (typeof x === 'string' ? x : null);
          const alts = sp.alts.slice(0, 5).map(id);
          const sends = alts.map((_, a) => id(Array.isArray(sp.sends) ? sp.sends[a] : null));
          return { alts, other: id(sp.other), sends, sendOther: id(sp.sendOther) };
        }),
        send: Array.from({ length: n }, (_, t) => (Array.isArray(s.send) && typeof s.send[t] === 'string' ? s.send[t] : null)),
      };
    } catch (e) { /* 忽略 */ }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plan)); } catch (e) { /* 无痕模式等 */ }
    document.dispatchEvent(new CustomEvent('combochange'));   // 工作目录据此判断有没有未保存的修改
  }

  /** 方案改动后：保存、重画；message = 改动附带的提示（没有时清掉上一次的提示） */
  function commit(message) {
    notice = message || '';
    save();
    render();
  }

  /** 去掉已经删除的组 */
  function prune() {
    let removed = 0;
    plan.kill = plan.kill.map((id) => {
      if (id && !Kill.store.get(id)) { removed++; return null; }
      return id;
    });
    const gone = (id) => id && !Kill.store.get(id);
    plan.split.forEach((sp) => {
      if (!sp) return;
      sp.alts = sp.alts.map((id) => { if (gone(id)) { removed++; return null; } return id; });
      if (gone(sp.other)) { removed++; sp.other = null; }
    });
    const sendGone = (id) => id && !Send.store.get(id);
    plan.send = plan.send.map((id) => { if (sendGone(id)) { removed++; return null; } return id; });
    plan.split.forEach((sp) => {
      if (!sp) return;
      sp.sends = sp.sends.map((id) => { if (sendGone(id)) { removed++; return null; } return id; });
      if (sendGone(sp.sendOther)) { removed++; sp.sendOther = null; }
    });
    const before = plan.deal.length;
    plan.deal = plan.deal.filter((p) => Deal.store.get(p.id));
    removed += before - plan.deal.length;
    if (removed) { notice = '有 ' + removed + ' 处用到的组已被删除，已从方案里移除'; save(); }
  }

  function killInfo(id) {
    const g = Kill.store.get(id), r = Kill.evaluate(g.data), ok = r.status === 'ok';
    return { name: g.name, rate: ok ? r.final : null, single: ok ? r.single : null, sl: ok ? r.sl : 0 };
  }

  /** 送人组：rate = 不含 SL 的成功率（还在后台计算时为 null，算完后重画） */
  function sendInfo(id) {
    const g = Send.store.get(id), r = Send.resultFor(g.data);
    if (r.status === 'ok') return { name: g.name, rate: r.single, sl: r.sl, final: r.final };
    return { name: g.name, rate: null, sl: 0, pending: r.status === 'pending' };
  }

  function dealInfo(id) {
    const g = Deal.store.get(id), r = Deal.evaluate(g.data), ok = r.status === 'ok';
    const info = {
      name: g.name, rate: ok ? r.probability : null, span: r.span, servants: r.servants, alts: g.data.alts.length,
    };
    if (ok) {                                            // 按条件分配伤害时用
      info.exact = DealCore.exactCounts(r.byMask, r.alts, r.total);
    }
    return info;
  }

  const spanOf = (id) => dealInfo(id).span;

  function usage(kind, id) {
    if (kind === 'send') {
      const inSplit = plan.split.reduce((s, sp) => s + (sp ? sp.sends.filter((x) => x === id).length + (sp.sendOther === id ? 1 : 0) : 0), 0);
      return plan.send.filter((x) => x === id).length + inSplit;
    }
    if (kind !== 'kill') return plan.deal.filter((p) => p.id === id).length;
    const inSplit = plan.split.reduce((s, sp) => s + (sp ? sp.alts.filter((x) => x === id).length + (sp.other === id ? 1 : 0) : 0), 0);
    return plan.kill.filter((x) => x === id).length + inSplit;
  }

  /**
   * 分条件的回合跟着发牌组调整：不再被发牌组占用 → 合并回一格；条件数变了 → 补空格或去掉多出来的格。
   * 返回提示文字（没有变化时为 ''）
   */
  function normalizeSplits(r) {
    const msgs = [];
    plan.split.forEach((sp, t) => {
      if (!sp) return;
      if (r.cover[t] < 0) {
        plan.kill[t] = sp.alts.find(Boolean) || sp.other || null;
        plan.split[t] = null;
        msgs.push('T' + (t + 1) + ' 不再被发牌组占用，已合并成一格');
        return;
      }
      const n = r.placements[r.cover[t]].alts;
      if (sp.alts.length > n) {
        if (sp.alts.slice(n).some(Boolean) || sp.sends.slice(n).some(Boolean)) msgs.push('T' + (t + 1) + ' 的发牌组现在只有 ' + n + ' 种条件，多出来的条件格已去掉');
        sp.alts = sp.alts.slice(0, n);
        sp.sends = sp.sends.slice(0, n);
      }
      while (sp.alts.length < n) sp.alts.push(null);
      while (sp.sends.length < n) sp.sends.push(null);
    });
    return msgs.join('；');
  }

  // 工作目录用：当前方案的副本、当前方案的综合击破率（没有结果时为 null）
  // 没放任何送人格时写成和 v0.8 一样（以前保存的工作目录不会因为升级被当成有修改）
  const snapshot = () => {
    const p = JSON.parse(JSON.stringify(plan));
    if (!p.send.some(Boolean)) delete p.send;
    p.split.forEach((sp) => {
      if (sp && !sp.sends.some(Boolean) && !sp.sendOther) { delete sp.sends; delete sp.sendOther; }
    });
    return p;
  };
  const evaluate = () => C.evaluate(plan, killInfo, dealInfo, sendInfo);
  const value = () => { try { prune(); return evaluate().value; } catch (e) { return null; } };

  window.ComboApp = { usage, snapshot, value };

  // ---------- 显示 ----------

  const rangeText = (from, to) => (to > from ? 'T' + (from + 1) + '–T' + (to + 1) : 'T' + (from + 1));

  function factorLabel(f) {
    if (f.kind === 'deal') return rangeText(f.turn, f.to) + ' 发牌';
    if (f.kind === 'mix') return rangeText(f.turn, f.to) + ' 按条件分配';
    if (f.kind === 'send') return 'T' + (f.turn + 1) + ' 送人';
    if (f.kind === 'turn') return 'T' + (f.turn + 1) + ' 击破 + 送人';
    return 'T' + (f.turn + 1) + ' 击破';
  }

  /** 击破 + 送人的回合：每次尝试 = 击破 × 送人（都不含 SL），按伤害组的 SL 次数重来 */
  function turnDetail(f) {
    const k = f.kill, s = f.send, one = k.single * s.rate;
    return '<li class="mix-detail"><div>每次尝试 = 击破 ' + short(k.single) + ' × 送人 ' + short(s.rate) + ' = ' + short(one) +
      (k.sl ? '，SL ' + k.sl + ' 次（按伤害组的 SL）' : '') + '</div></li>';
  }

  /** 按条件分配伤害的一轮：按「恰好满足哪几种条件」分组 */
  function mixDetail(f) {
    if (f.rate === null) return '';
    const rows = f.regions.filter((x) => x.count).map((x) => {
      let label;
      if (x.other) label = '一种条件都不满足（其他）';
      else {
        const names = x.set.map((k) => k + 1).join('、');
        label = x.set.length === 1 ? '只满足条件 ' + names : '同时满足条件 ' + names + '（各打一次，SL 换打法）';
      }
      return '<div>' + label + '：' + fmt(x.count) + ' 种 × ' + short(x.value) + '</div>';
    });
    const multi = f.to > f.turn && f.regions.length > 2;
    return '<li class="mix-detail">' + rows.join('') + '<div>÷ 全部 ' + fmt(f.total) + ' 种</div>' +
      (multi ? '<div class="mix-note">占好几个回合时，相当于「看到后面的牌再决定按哪种打」，结果可能略偏高</div>' : '') + '</li>';
  }

  function renderResult(r) {
    const used = plan.kill.some(Boolean) || plan.deal.length || plan.send.some(Boolean) || plan.split.some(Boolean);
    const value = $('comboProb');
    if (!used) {
      value.textContent = '—';
      value.classList.add('idle');
      $('comboMeter').style.width = '0';
      $('comboNote').innerHTML = '<div>把伤害组、发牌组、送人组放进下面的回合里</div>';
      return;
    }
    let html = '';
    if (r.value === null) {
      value.textContent = '—';
      value.classList.add('idle');
      $('comboMeter').style.width = '0';
      html += r.problems.map((p) => '<div class="warn">' + esc(p) + '</div>').join('');
    } else {
      value.textContent = Kill.formatPct(r.value);
      value.classList.remove('idle');
      $('comboMeter').style.width = r.value * 100 + '%';
      // 算式：按洗牌分组，括号里是同一轮发牌的几个回合
      const parts = r.blocks.filter((b) => b.factors.length).map((b) => {
        const s = b.factors.map((f) => short(f.rate)).join(' × ');
        return b.factors.length > 1 && r.blocks.filter((x) => x.factors.length).length > 1 ? '(' + s + ')' : s;
      });
      html += '<div class="formula">= ' + (parts.length ? parts.join(' × ') : '100%') + '</div>';
      const freq = Kill.frequencyText(r.value, 1 - r.value, '成功', '失败');
      if (freq) html += '<div>' + freq + '</div>';
      if (r.weakest && r.factors.length > 1) {
        const w = r.weakest;
        html += '<div>拖累最大：' + factorLabel(w) + '「' + esc(w.name) + '」' + short(w.rate) + '</div>';
      }
    }
    if (r.factors.length) {
      html += '<ul class="combo-factors">' + r.factors.map((f) => '<li' + (f === r.weakest && r.factors.length > 1 ? ' class="weak"' : '') + '><span>' +
        factorLabel(f) + ' · ' + esc(f.name) + '</span><b>' + (f.rate === null ? '—' : short(f.rate)) + '</b></li>' +
        (f.kind === 'mix' ? mixDetail(f) : f.kind === 'turn' && f.rate !== null ? turnDetail(f) : '')).join('') + '</ul>';
    }
    $('comboNote').innerHTML = html;
  }

  // ---------- 计算过程 ----------

  const P = Kill.formatPct;                              // 计算过程里的数都保留 4 位小数，方便核对
  const quote = (name) => '「' + esc(name) + '」';

  /** 伤害组：击破率（有 SL 时写出单次和 SL 次数） */
  function killText(k) {
    const single = k.single === undefined || k.single === null ? k.rate : k.single;
    return quote(k.name) + '击破 ' + (k.sl ? '单次 ' + P(single) + '，SL ' + k.sl + ' 次 → 1 − (1 − ' + P(single) + ')^' + (k.sl + 1) + ' = ' + P(k.rate) : P(k.rate));
  }

  /** 一种打法（伤害组 + 送人组）怎么算 */
  function playText(pl) {
    if (pl.fail) return '没放伤害组 = 失败，0%';
    const k = pl.kill, s = pl.send;
    if (!k && !s) return '不需要击破、不需要送人，100%';
    if (!s) return killText(k);
    if (!k) {
      return quote(s.name) + '送人 ' + (s.sl ? '单次 ' + P(s.rate) + '，SL ' + s.sl + ' 次 → 1 − (1 − ' + P(s.rate) + ')^' + (s.sl + 1) + ' = ' + P(pl.rate) : P(s.rate));
    }
    const plain = k.single === undefined || k.single === null;
    const single = plain ? k.rate : k.single, sl = plain ? 0 : k.sl || 0, one = single * s.rate;
    return quote(k.name) + '击破 ' + P(single) + ' × ' + quote(s.name) + '送人 ' + P(s.rate) + ' = 每次 ' + P(one) +
      (sl ? '；按伤害组的 SL ' + sl + ' 次重来 → 1 − (1 − ' + P(one) + ')^' + (sl + 1) + ' = ' + P(pl.rate) : '');
  }

  /** 按条件分配的一轮里，某一种情况下各回合怎么算 */
  function regionTurns(x) {
    return '<ul>' + x.turns.map((tt) => {
      const head = 'T' + (tt.turn + 1) + '：';
      if (!tt.split) return '<li>' + head + playText(tt.plays[0]) + '</li>';
      if (x.other) return '<li>' + head + '其他格：' + playText(tt.plays[0]) + '</li>';
      const lines = tt.plays.map((pl) => {
        const who = '条件 ' + pl.alts.map((k) => k + 1).join('、') + (pl.alts.length > 1 ? '（打法相同，只算一次）' : '');
        return '<div>' + who + '：' + playText(pl) + '</div>';
      }).join('');
      const combine = tt.plays.length > 1
        ? '<div class="sum">各打一次（SL 换打法）：1 − ' + tt.plays.map((pl) => '(1 − ' + P(pl.rate) + ')').join('') + ' = ' + P(tt.rate) + '</div>' : '';
      return '<li>' + head + lines + combine + '</li>';
    }).join('') + '</ul>';
  }

  function factorSteps(f) {
    const label = factorLabel(f);
    if (f.rate === null) return '<li>' + label + quote(f.name) + '：还不能计算</li>';
    if (f.kind === 'deal') return '<li>' + label + quote(f.name) + '：发牌概率 ' + P(f.rate) + '</li>';
    if (f.kind === 'kill') return '<li>' + label + '：' + killText(f.kill) + '</li>';
    if (f.kind === 'send') return '<li>' + label + '：' + playText({ send: f.send, rate: f.rate }) + '</li>';
    if (f.kind === 'turn') return '<li>' + label + '：' + playText({ kill: f.kill, send: f.send, rate: f.rate }) + '</li>';
    // 按条件分配：按「恰好满足哪几种条件」分成几种情况，各情况的成功率按发牌组合数加权
    const rows = f.regions.filter((x) => x.count).map((x) => {
      const what = x.other ? '一种条件都不满足（其他）' : (x.set.length === 1 ? '只满足条件 ' : '同时满足条件 ') + x.set.map((k) => k + 1).join('、');
      return '<li>' + what + '：' + fmt(x.count) + ' 种，成功率 ' + P(x.value) + regionTurns(x) + '</li>';
    }).join('');
    const sum = f.regions.filter((x) => x.count).map((x) => fmt(x.count) + ' × ' + P(x.value)).join(' + ');
    return '<li>' + label + quote(f.name) + '（发牌组共 ' + fmt(f.total) + ' 种发牌）<ol>' + rows + '</ol>' +
      '<div class="sum">(' + sum + ') ÷ ' + fmt(f.total) + ' = ' + P(f.rate) + '</div></li>';
  }

  function renderSteps(r) {
    const body = $('comboStepsBody');
    if (r.value === null) { body.innerHTML = '<p>' + (r.problems.length ? '方案输入完整后显示计算过程。' : '') + '</p>'; return; }
    if (!r.factors.length) { body.innerHTML = '<p>每个回合都是 100%（没放组，或者放的组都是 100%）。</p>'; return; }
    body.innerHTML = '<p>按回合顺序，列出每一项（100% 的回合不列出）。每个回合 = 我方行动阶段 × 敌方行动阶段；同一回合既有伤害组又有送人组时，' +
      'SL 或换打法会把两个阶段一起重来，所以按「每次尝试 = 击破 × 送人」计算。</p>' +
      '<ol>' + r.factors.map(factorSteps).join('') + '</ol>' +
      '<p class="sum">综合 = ' + (r.factors.length > 1 ? r.factors.map((f) => P(f.rate)).join(' × ') + ' = ' : '') + P(r.value) + '</p>';
  }

  function chip(kind, g, sub) {
    const on = selected && selected.kind === kind && selected.id === g.id;
    return '<button type="button" class="gchip ' + kind + (on ? ' selected' : '') + '" data-drag="' + kind + '" data-id="' + g.id + '" aria-pressed="' + on + '">' +
      '<span>' + esc(g.name) + '</span><small>' + esc(sub) + '</small></button>';
  }

  const COLUMN = { kill: '击破', deal: '发牌', send: '送人' };

  function renderPalette() {
    $('paletteKill').innerHTML = Kill.store.list().map((g) => chip('kill', g, Kill.summary(g))).join('');
    $('paletteDeal').innerHTML = Deal.store.list().map((g) => chip('deal', g, Deal.summary(g))).join('');
    $('paletteSend').innerHTML = Send.store.list().map((g) => chip('send', g, Send.summary(g))).join('');
    $('paletteHint').textContent = selected
      ? '已选中，点下面「' + COLUMN[selected.kind] + '」一栏的格子放入；再点一次取消'
      : '拖到下面的回合里，或者先点一下组、再点一下回合';
  }

  const RESHUFFLE = {
    natural: '↻ 新一轮洗牌',
    forced: (p) => '↻ 提前洗牌，需 T' + p.at + ' 有从者退场',
  };

  /** 击破栏的一格：已放伤害组或空格。alt = 条件序号 / 'other'（分条件时），style = 网格位置 */
  function killCell(k, t, alt, style, target) {
    const altAttr = alt === undefined ? '' : ' data-alt="' + alt + '"';
    const pos = style ? ' style="' + style + '"' : '';
    if (!k) {
      const empty = alt === 'other' ? '没满足 = 失败' : '不需要击破';
      return '<button type="button" class="tl-slot' + (target === 'kill' ? ' target' : '') + '" data-slot="kill" data-turn="' + t + '"' + altAttr + pos + '>' + empty + '</button>';
    }
    const info = killInfo(k.id);
    const remove = alt === undefined ? 'data-remove-kill="' + t + '"' : 'data-remove-split="' + t + ':' + alt + '"';
    return '<div class="tl-item kill' + (target === 'kill' ? ' target' : '') + (k.rate === null ? ' bad' : '') + '" data-slot="kill" data-turn="' + t + '"' + altAttr + pos + '>' +
      '<span class="tl-grip" data-drag="kill" data-id="' + k.id + '" data-from="' + t + '"' + (alt === undefined ? '' : ' data-from-alt="' + alt + '"') + ' aria-hidden="true">⠿</span>' +
      '<div class="tl-body"><div class="tl-name">' + esc(k.name) + '</div><div class="tl-rate">' +
      (k.rate === null ? '未完成' : short(k.rate)) + '</div>' + (info.sl ? '<div class="tl-sub">SL ' + info.sl + ' 次</div>' : '') + '</div>' +
      '<button type="button" class="tl-remove" ' + remove + ' aria-label="移除">×</button></div>';
  }

  /**
   * 送人栏的一格（敌方行动阶段）。alt = 条件序号 / 'other'（分条件时；空着 = 跟随回合的送人组）。
   * 放了伤害组的回合按伤害组的 SL 次数重来，送人组自己的 SL 不参与（hasKill 时提示）
   */
  function sendCell(s, t, alt, style, target, hasKill, follow) {
    const altAttr = alt === undefined ? '' : ' data-alt="' + alt + '"';
    const pos = style ? ' style="' + style + '"' : '';
    if (!s) {
      let empty = '不需要送人';
      if (alt !== undefined) {                           // 条件格空着：用回合的送人组，写出实际用的是哪个
        const f = follow && sendInfo(follow.id);
        empty = !f ? '跟随回合<small>（不需要送人）</small>'
          : '跟随回合<small>' + esc(f.name) + ' ' + (f.rate === null ? (f.pending ? '计算中' : '未完成') : short(f.final)) + '</small>';
      }
      return '<button type="button" class="tl-slot' + (target === 'send' ? ' target' : '') + '" data-slot="send" data-turn="' + t + '"' + altAttr + pos + '>' + empty + '</button>';
    }
    const info = sendInfo(s.id);
    const remove = alt === undefined ? 'data-remove-send="' + t + '"' : 'data-remove-send="' + t + ':' + alt + '"';
    const rate = info.rate === null ? (info.pending ? '计算中' : '未完成') : short(info.final);
    const sub = info.rate === null || !info.sl ? '' : hasKill ? '按伤害组的 SL' : 'SL ' + info.sl + ' 次';
    return '<div class="tl-item send' + (target === 'send' ? ' target' : '') + (info.rate === null && !info.pending ? ' bad' : '') + '" data-slot="send" data-turn="' + t + '"' + altAttr + pos + '>' +
      '<span class="tl-grip" data-drag="send" data-id="' + s.id + '" data-from="' + t + '"' + (alt === undefined ? '' : ' data-from-alt="' + alt + '"') + ' aria-hidden="true">⠿</span>' +
      '<div class="tl-body"><div class="tl-name">' + esc(info.name) + '</div><div class="tl-rate">' + rate + '</div>' +
      (sub ? '<div class="tl-sub">' + sub + '</div>' : '') + '</div>' +
      '<button type="button" class="tl-remove" ' + remove + ' aria-label="移除">×</button></div>';
  }

  /** 按条件分配：条件 1 … n 和「其他」，每格放一个伤害组（我方）和一个送人组（敌方，空着 = 跟随回合） */
  function splitCell(r, t, style, target) {
    const sp = r.splits[t], p = r.placements[r.cover[t]];
    const texts = Deal.altTexts(Deal.store.get(p.id).data);
    let html = '<div class="tl-split" style="' + style + '"><div class="tl-split-head"><span>按条件分配</span>' +
      '<button type="button" class="tl-merge" data-merge="' + t + '">合并</button></div>' +
      '<div class="tl-split-row"><div class="tl-split-label">回合的送人组<span>条件格的送人空着时用它</span></div>' +
      '<div class="tl-pair"><span></span>' + sendCell(r.sends[t], t, undefined, '', target, false) + '</div></div>';
    const row = (label, sub, title, k, s, alt) => '<div class="tl-split-row"><div class="tl-split-label"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label +
      '<span>' + esc(sub) + '</span></div><div class="tl-pair">' + killCell(k, t, alt, '', target) + sendCell(s, t, alt, '', target, !!k, r.sends[t]) + '</div></div>';
    sp.alts.forEach((k, a) => { html += row('条件 ' + (a + 1), texts[a] || '', texts[a] || '', k, sp.sends[a], a); });
    html += row('其他', '一种条件都不满足', '', sp.other, sp.sendOther, 'other');
    return html + '</div>';
  }

  function renderTimeline(r) {
    const n = plan.turns, target = selected ? selected.kind : null, R = 3;   // 前两行是表头
    let html = '<div class="tl-phase" style="grid-row:1;grid-column:2 / span 2">我方行动阶段</div>' +
      '<div class="tl-phase enemy" style="grid-row:1;grid-column:4">敌方行动阶段</div>' +
      '<div class="tl-h" style="grid-row:2;grid-column:1">回合</div><div class="tl-h" style="grid-row:2;grid-column:2">发牌</div>' +
      '<div class="tl-h" style="grid-row:2;grid-column:3">击破</div><div class="tl-h" style="grid-row:2;grid-column:4">送人</div>';
    for (let t = 0; t < n; t++) {
      html += '<div class="tl-turn" style="grid-row:' + (t + R) + '">T' + (t + 1) + '</div>';
      if (r.cover[t] < 0) {
        html += '<button type="button" class="tl-slot' + (target === 'deal' ? ' target' : '') + '" data-slot="deal" data-turn="' + t +
          '" style="grid-row:' + (t + R) + ';grid-column:2">不要求发牌</button>';
      }
      const cell = 'grid-row:' + (t + R) + ';grid-column:3', sendPos = 'grid-row:' + (t + R) + ';grid-column:4';
      if (r.splits[t]) html += splitCell(r, t, 'grid-row:' + (t + R) + ';grid-column:3 / span 2', target);
      else {
        if (r.cover[t] >= 0) {                           // 被发牌组占用：可以按条件分配
          html += '<div class="tl-cell" style="' + cell + '">' + killCell(r.kills[t], t, undefined, '', target) +
            '<button type="button" class="tl-split-btn" data-split="' + t + '">按条件分配</button></div>';
        } else html += killCell(r.kills[t], t, undefined, cell, target);
        html += sendCell(r.sends[t], t, undefined, sendPos, target, !!r.kills[t]);
      }
    }
    r.placements.forEach((p, i) => {
      if (p.at >= n) return;
      const note = p.conflict ? '<div class="tl-warn">' + esc(p.conflict) + '</div>'
        : p.reshuffle === 'natural' ? '<div class="tl-tag">' + RESHUFFLE.natural + '</div>'
          : p.reshuffle === 'forced' ? '<div class="tl-tag warn">' + RESHUFFLE.forced(p) + '</div>' : '';
      html += '<div class="tl-item deal' + (target === 'deal' ? ' target' : '') + (p.conflict ? ' bad' : '') + '" data-slot="deal" data-turn="' + p.at +
        '" data-span="' + p.shown + '" style="grid-row:' + (p.at + 3) + ' / span ' + p.shown + ';grid-column:2">' +
        '<span class="tl-grip" data-drag="deal" data-id="' + p.id + '" data-from="' + i + '" aria-hidden="true">⠿</span>' +
        '<div class="tl-body"><div class="tl-name">' + esc(p.name) + '</div><div class="tl-rate">' +
        (p.rate === null ? '有误' : short(p.rate)) + '</div><div class="tl-sub">' + (p.span > 1 ? rangeText(p.at, p.end) + ' 共享' : '单回合') + '</div>' + note + '</div>' +
        '<button type="button" class="tl-remove" data-remove-deal="' + i + '" aria-label="移除' + esc(p.name) + '">×</button></div>';
    });
    const tl = $('timeline');
    tl.style.gridTemplateRows = 'auto auto repeat(' + n + ', minmax(58px, auto))';
    tl.innerHTML = html;
    $('turnMinus').disabled = n <= 1;
    $('turnPlus').disabled = n >= C.MAX_TURNS;
    $('turnCount').textContent = n + ' 个回合';
  }

  function render() {
    prune();
    let r = evaluate();
    const changed = normalizeSplits(r);
    if (changed) {
      notice = changed;
      save();
      r = evaluate();
    }
    renderResult(r);
    renderSteps(r);
    renderPalette();
    renderTimeline(r);
    $('comboNotice').hidden = !notice;
    $('comboNotice').textContent = notice;
  }

  // ---------- 放入 / 移除 ----------

  let selected = null;                                   // 点选模式：{ kind, id }

  /** alt：放进分条件的哪一格（条件序号 / 'other'）；fromAlt：从分条件的哪一格拖过来 */
  function place(kind, id, turn, from, alt, fromAlt) {
    if (kind === 'kill' || kind === 'send') {
      const cells = kind === 'kill' ? { turn: plan.kill, alts: 'alts', other: 'other' } : { turn: plan.send, alts: 'sends', other: 'sendOther' };
      const setAt = (t, a, value) => {
        if (a === undefined || !plan.split[t]) cells.turn[t] = value;
        else if (a === 'other') plan.split[t][cells.other] = value;
        else plan.split[t][cells.alts][Number(a)] = value;
      };
      if (from !== undefined && !(from === turn && fromAlt === alt)) setAt(from, fromAlt, null);
      setAt(turn, alt, id);
    } else {
      const before = plan.deal.filter((p, i) => i !== from).length;
      C.placeDeal(plan, id, turn, spanOf, from);
      const dropped = before + 1 - plan.deal.length;
      commit(dropped ? '新放的发牌组占了 ' + rangeText(turn, turn + spanOf(id) - 1) + '，原来在这几个回合的 ' + dropped + ' 个发牌组已移除' : '');
      return;
    }
    commit();
  }

  /** 发牌栏里某个格子对应第几回合（占好几格的发牌组按点到的位置算） */
  function slotTurn(slot, clientY) {
    const at = Number(slot.dataset.turn), span = Number(slot.dataset.span || 1);
    if (span <= 1 || clientY === undefined) return at;
    const rect = slot.getBoundingClientRect();
    return at + Math.min(span - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * span)));
  }

  $('viewCombo').addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const b = e.target.closest('button, .tl-item');
    if (!b) return;
    if (b.dataset.removeKill !== undefined) { plan.kill[Number(b.dataset.removeKill)] = null; commit(); return; }
    if (b.dataset.removeSend !== undefined) {
      const [t, a] = b.dataset.removeSend.split(':');
      if (a === undefined) plan.send[Number(t)] = null;
      else if (a === 'other') plan.split[Number(t)].sendOther = null;
      else plan.split[Number(t)].sends[Number(a)] = null;
      commit();
      return;
    }
    if (b.dataset.removeSplit !== undefined) {
      const [t, a] = b.dataset.removeSplit.split(':');
      if (a === 'other') plan.split[Number(t)].other = null;
      else plan.split[Number(t)].alts[Number(a)] = null;
      commit();
      return;
    }
    if (b.dataset.split !== undefined) {                 // 按条件分配：每个条件格先放原来的伤害组，送人格跟随回合
      const t = Number(b.dataset.split), r0 = evaluate(), n = r0.placements[r0.cover[t]].alts;
      plan.split[t] = { alts: Array.from({ length: n }, () => plan.kill[t]), other: null, sends: Array.from({ length: n }, () => null), sendOther: null };
      plan.kill[t] = null;
      commit();
      return;
    }
    if (b.dataset.merge !== undefined) {                 // 合并：留下条件 1 的伤害组和回合的送人组
      const t = Number(b.dataset.merge), sp = plan.split[t];
      plan.kill[t] = sp.alts.find(Boolean) || sp.other || null;
      plan.split[t] = null;
      commit();
      return;
    }
    if (b.dataset.removeDeal !== undefined) { plan.deal.splice(Number(b.dataset.removeDeal), 1); commit(); return; }
    if (b.classList.contains('gchip')) {
      const kind = b.dataset.drag, id = b.dataset.id;
      selected = selected && selected.kind === kind && selected.id === id ? null : { kind, id };
      render();
      return;
    }
    if (b.dataset.slot && selected && selected.kind === b.dataset.slot) {
      const { kind, id } = selected;
      selected = null;
      place(kind, id, slotTurn(b, e.clientY), undefined, b.dataset.alt);
    }
  });

  $('turnPlus').addEventListener('click', () => { C.ensureTurns(plan, plan.turns + 1); commit(); });
  $('turnMinus').addEventListener('click', () => {
    if (plan.turns <= 1) return;
    plan.turns--;
    plan.kill.pop();
    plan.split.pop();
    plan.send.pop();
    plan.deal = plan.deal.filter((p) => p.at < plan.turns);
    commit();
  });
  $('comboClear').addEventListener('click', () => {
    if (!plan.kill.some(Boolean) && !plan.deal.length && !plan.send.some(Boolean) && !plan.split.some(Boolean)) return;
    G.confirmBox('清空方案里放好的组？\n伤害组、发牌组、送人组本身不会删除。', { ok: '清空方案', danger: true }).then((yes) => {
      if (!yes) return;
      plan.kill = plan.kill.map(() => null);
      plan.split = plan.split.map(() => null);
      plan.send = plan.send.map(() => null);
      plan.deal = [];
      selected = null;
      commit();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) { selected = null; render(); }
  });

  // ---------- 拖动（手指和鼠标都用 Pointer Events；iPhone Safari 不支持网页原生的拖放） ----------

  let drag = null, suppressClick = false, scrollTimer = null;

  function hitSlot(x, y) {
    const el = document.elementFromPoint(x, y);
    const slot = el && el.closest('#timeline [data-slot]');
    return slot && slot.dataset.slot === drag.kind ? slot : null;
  }

  function setHover(slot) {
    if (drag.hover === slot) return;
    if (drag.hover) drag.hover.classList.remove('drop-hover');
    drag.hover = slot;
    if (slot) slot.classList.add('drop-hover');
  }

  function autoScroll() {
    if (!drag || !drag.started) return;
    const edge = 70, y = drag.y, h = window.innerHeight;
    const dy = y < edge ? -Math.ceil((edge - y) / 5) : y > h - edge ? Math.ceil((y - (h - edge)) / 5) : 0;
    if (dy) {
      window.scrollBy(0, dy);
      setHover(hitSlot(drag.x, drag.y));
    }
    scrollTimer = requestAnimationFrame(autoScroll);
  }

  function startDrag() {
    drag.started = true;
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost ' + drag.kind;
    const name = drag.src.closest('.gchip, .tl-item').querySelector('span:not(.tl-grip), .tl-name');
    ghost.textContent = name ? name.textContent : '';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    document.body.classList.add('dragging');
    $('timeline').classList.add('drop-' + drag.kind);
    scrollTimer = requestAnimationFrame(autoScroll);
  }

  function endDrag(drop) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(scrollTimer);
    if (!d.started) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    d.ghost.remove();
    document.body.classList.remove('dragging');
    $('timeline').classList.remove('drop-kill', 'drop-deal', 'drop-send');
    if (d.hover) d.hover.classList.remove('drop-hover');
    if (drop && d.hover) {
      selected = null;
      place(d.kind, d.id, slotTurn(d.hover, d.y), d.from, d.hover.dataset.alt, d.fromAlt);
    }
  }

  $('viewCombo').addEventListener('pointerdown', (e) => {
    const src = e.target.closest('[data-drag]');
    if (!src || e.button > 0) return;
    drag = {
      src, kind: src.dataset.drag, id: src.dataset.id, pointerId: e.pointerId,
      from: src.dataset.from === undefined ? undefined : Number(src.dataset.from), fromAlt: src.dataset.fromAlt,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, hover: null,
    };
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      startDrag();
    }
    e.preventDefault();
    drag.ghost.style.transform = 'translate(' + (e.clientX + 10) + 'px,' + (e.clientY - 34) + 'px)';
    setHover(hitSlot(e.clientX, e.clientY));
  }, { passive: false });

  window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
  window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });

  // ---------- 联动 ----------

  // 别的页签里改了组：这一页显示着就马上重算，否则切过来时再算
  function refresh() { if (!$('viewCombo').hidden) render(); }
  Kill.store.onChange(refresh);
  Deal.store.onChange(refresh);
  Send.store.onChange(refresh);
  document.addEventListener('sendresult', refresh);    // 送人组在后台算完了
  document.addEventListener('tabshow', (e) => { if (e.detail === 'combo') render(); });

  load();
  render();
})();
