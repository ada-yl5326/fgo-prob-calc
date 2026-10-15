// 综合击破概率页面：把伤害组、发牌组、buff 组、送人组拖进各个回合（或先点组、再点格子），按世界线算出整个方案的综合击破率。
// 回合表横竖转置：每一列是一个回合，从上往下是结算顺序（发牌 → 我方 buff → 击破 → 敌方 buff → 送人），
// 一列从上往下读就是一条世界线；分了条件的回合分成几小列（回合 / 条件 1 … / 其他）。规则见《世界线规则.md》
(function () {
  'use strict';

  const C = window.Combo;
  const DealCore = window.Deal;
  const G = window.Groups;
  const Kill = window.KillApp, Deal = window.DealApp, Send = window.SendApp, Buff = window.BuffApp;
  const STORAGE_KEY = 'killprob.combo.v1';
  const $ = (id) => document.getElementById(id);
  const esc = G.escapeHtml;
  const short = Kill.formatShort;
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);

  // ---------- 方案 ----------

  // 每回合：kill 伤害组、send 送人组、buff 我方 buff 组、ebuff 敌方 buff 组、kfail / sfail 我方 / 敌方 buff 失败时的伤害组 / 送人组、
  // extra 各阶段的额外 SL { b, k, e, s }；global 全局额外 SL。
  // split[t]：按条件分配 { alts, other（伤害组）, sends, sendOther, buffs, buffOther, ebuffs, ebuffOther, kfails, kfailOther, sfails, sfailOther }
  //           送人、我方 buff、敌方 buff、失败时的送人空着 = 跟随回合；不分条件时为 null
  const TURN_FIELDS = ['kill', 'send', 'buff', 'ebuff', 'kfail', 'sfail'];
  const SPLIT_FIELDS = [['alts', 'other'], ['sends', 'sendOther'], ['buffs', 'buffOther'], ['ebuffs', 'ebuffOther'], ['kfails', 'kfailOther'], ['sfails', 'sfailOther']];
  /** 一个格子（slot + 是不是「buff 失败时」）→ [回合的字段, 条件格的字段, 其他格的字段] */
  const FIELD = {
    kill: ['kill', 'alts', 'other'], killfail: ['kfail', 'kfails', 'kfailOther'], send: ['send', 'sends', 'sendOther'],
    sendfail: ['sfail', 'sfails', 'sfailOther'], buff: ['buff', 'buffs', 'buffOther'], ebuff: ['ebuff', 'ebuffs', 'ebuffOther'],
  };
  /** 每种组能放进哪些格子 */
  const ACCEPT = { kill: ['kill'], deal: ['deal'], send: ['send'], buff: ['buff', 'ebuff'] };
  const KIND_OF = { kill: 'kill', deal: 'deal', send: 'send', buff: 'buff', ebuff: 'buff' };

  const emptyPlan = (n) => {
    const p = { turns: n, kill: [], deal: [], split: [], send: [], buff: [], ebuff: [], kfail: [], sfail: [], extra: [], global: 0 };
    for (let t = 0; t < n; t++) ['kill', 'split', 'send', 'buff', 'ebuff', 'kfail', 'sfail', 'extra'].forEach((k) => p[k].push(null));
    return p;
  };
  let plan = emptyPlan(3);
  let notice = '';                                       // 一次性的提示（例如引用的组被删除了）

  const idOf = (x) => (typeof x === 'string' ? x : null);

  function cleanSplit(sp) {
    if (!sp || typeof sp !== 'object' || !Array.isArray(sp.alts)) return null;
    const alts = sp.alts.slice(0, 5).map(idOf), out = {};
    SPLIT_FIELDS.forEach(([many, one]) => {
      out[many] = alts.map((_, a) => idOf(Array.isArray(sp[many]) ? sp[many][a] : null));
      out[one] = idOf(sp[one]);
    });
    return out;
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!s || !(s.turns >= 1)) return;
      const n = Math.min(C.MAX_TURNS, Math.floor(s.turns));
      const p = emptyPlan(n);
      for (let t = 0; t < n; t++) {
        TURN_FIELDS.forEach((k) => { p[k][t] = Array.isArray(s[k]) ? idOf(s[k][t]) : null; });
        p.split[t] = cleanSplit(Array.isArray(s.split) ? s.split[t] : null);
        const x = Array.isArray(s.extra) ? C.extraOf(s.extra[t]) : null;
        p.extra[t] = x && C.STAGES.some((k) => x[k]) ? x : null;
      }
      p.deal = (Array.isArray(s.deal) ? s.deal : [])
        .filter((d) => d && typeof d.id === 'string' && d.at >= 0 && d.at < n)
        .map((d) => ({ at: Math.floor(d.at), id: d.id }))
        .sort((a, b) => a.at - b.at);
      p.global = Number.isInteger(s.global) ? Math.min(C.MAX_GLOBAL, Math.max(0, s.global)) : 0;
      plan = p;
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

  const storeOf = { kill: Kill.store, kfail: Kill.store, send: Send.store, sfail: Send.store, buff: Buff.store, ebuff: Buff.store,
    alts: Kill.store, other: Kill.store, kfails: Kill.store, kfailOther: Kill.store, sends: Send.store, sendOther: Send.store,
    sfails: Send.store, sfailOther: Send.store, buffs: Buff.store, buffOther: Buff.store, ebuffs: Buff.store, ebuffOther: Buff.store };

  /** 去掉已经删除的组 */
  function prune() {
    let removed = 0;
    const keep = (field) => (id) => { if (id && !storeOf[field].get(id)) { removed++; return null; } return id; };
    TURN_FIELDS.forEach((k) => { plan[k] = plan[k].map(keep(k)); });
    plan.split.forEach((sp) => {
      if (!sp) return;
      SPLIT_FIELDS.forEach(([many, one]) => {
        sp[many] = sp[many].map(keep(many));
        sp[one] = keep(one)(sp[one]);
      });
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

  /** buff 组：rate = 放在我方阶段的成功率（各自 SL 后相乘），enemy = 放在敌方阶段的（单次相乘） */
  function buffInfo(id) {
    const g = Buff.store.get(id), r = Buff.resultFor(g.data);
    if (r.status === 'ok') return { name: g.name, rate: r.my, enemy: r.enemy, items: r.items };
    return { name: g.name, rate: null, enemy: null, items: null };
  }

  function dealInfo(id) {
    const g = Deal.store.get(id), r = Deal.evaluate(g.data), ok = r.status === 'ok';
    const info = {
      name: g.name, rate: ok ? r.probability : null, span: r.span, servants: r.servants, alts: g.data.alts.length,
    };
    if (ok) info.exact = DealCore.exactCounts(r.byMask, r.alts, r.total);   // 按条件分配时用
    return info;
  }

  const spanOf = (id) => dealInfo(id).span;

  /** 这个组在方案里用了几处（删除组之前提示用） */
  function usage(kind, id) {
    if (kind === 'deal') return plan.deal.filter((p) => p.id === id).length;
    const fields = { kill: [['kill', 'kfail'], ['alts', 'other', 'kfails', 'kfailOther']], send: [['send', 'sfail'], ['sends', 'sendOther', 'sfails', 'sfailOther']],
      buff: [['buff', 'ebuff'], ['buffs', 'buffOther', 'ebuffs', 'ebuffOther']] }[kind];
    if (!fields) return 0;
    let n = 0;
    fields[0].forEach((k) => { n += plan[k].filter((x) => x === id).length; });
    plan.split.forEach((sp) => {
      if (!sp) return;
      fields[1].forEach((k) => { n += Array.isArray(sp[k]) ? sp[k].filter((x) => x === id).length : sp[k] === id ? 1 : 0; });
    });
    return n;
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
        merge(t);
        msgs.push('T' + (t + 1) + ' 不再被发牌组占用，已合并成一格');
        return;
      }
      const n = r.placements[r.cover[t]].alts;
      if (sp.alts.length > n) {
        if (SPLIT_FIELDS.some(([many]) => sp[many].slice(n).some(Boolean))) msgs.push('T' + (t + 1) + ' 的发牌组现在只有 ' + n + ' 种条件，多出来的条件格已去掉');
        SPLIT_FIELDS.forEach(([many]) => { sp[many] = sp[many].slice(0, n); });
      }
      SPLIT_FIELDS.forEach(([many]) => { while (sp[many].length < n) sp[many].push(null); });
    });
    return msgs.join('；');
  }

  /** 合并分条件的回合：留下第一个放了的伤害组（和它的「buff 失败时」），其他格跟随回合的组不变 */
  function merge(t) {
    const sp = plan.split[t];
    const a = sp.alts.findIndex(Boolean);
    plan.kill[t] = a >= 0 ? sp.alts[a] : sp.other;
    plan.kfail[t] = a >= 0 ? sp.kfails[a] : sp.kfailOther;
    plan.split[t] = null;
  }

  // 工作目录用：当前方案的副本、当前方案的综合击破率（没有结果时为 null）
  // 没用到的新字段不写进去（以前保存的工作目录不会因为升级被当成有修改）
  const snapshot = () => {
    const p = JSON.parse(JSON.stringify(plan));
    ['send', 'buff', 'ebuff', 'kfail', 'sfail', 'extra'].forEach((k) => { if (!p[k].some(Boolean)) delete p[k]; });
    if (!p.global) delete p.global;
    p.split.forEach((sp) => {
      if (!sp) return;
      SPLIT_FIELDS.slice(1).forEach(([many, one]) => {
        if (!sp[many].some(Boolean) && !sp[one]) { delete sp[many]; delete sp[one]; }
      });
    });
    return p;
  };
  const evaluate = () => C.evaluate(plan, killInfo, dealInfo, sendInfo, buffInfo);
  const value = () => { try { prune(); return evaluate().value; } catch (e) { return null; } };
  const anyUsed = () => TURN_FIELDS.some((k) => plan[k].some(Boolean)) || plan.deal.length > 0 || plan.split.some(Boolean);

  /** 方案里用到的组（按种类，去掉重复），分享图片附上各组的输入时用 */
  function usedGroups() {
    const out = { kill: [], deal: [], buff: [], send: [] }, seen = {};
    const add = (kind, store, id) => { if (id && !seen[kind + id] && store.get(id)) { seen[kind + id] = 1; out[kind].push(store.get(id)); } };
    plan.deal.forEach((d) => add('deal', Deal.store, d.id));
    for (let t = 0; t < plan.turns; t++) {
      const sp = plan.split[t];
      add('buff', Buff.store, plan.buff[t]);
      add('buff', Buff.store, plan.ebuff[t]);
      add('kill', Kill.store, plan.kill[t]);
      add('kill', Kill.store, plan.kfail[t]);
      add('send', Send.store, plan.send[t]);
      add('send', Send.store, plan.sfail[t]);
      if (!sp) continue;
      sp.buffs.concat(sp.buffOther, sp.ebuffs, sp.ebuffOther).forEach((id) => add('buff', Buff.store, id));
      sp.alts.concat(sp.other, sp.kfails, sp.kfailOther).forEach((id) => add('kill', Kill.store, id));
      sp.sends.concat(sp.sendOther, sp.sfails, sp.sfailOther).forEach((id) => add('send', Send.store, id));
    }
    return out;
  }

  /**
   * 分享图片里的回合表：{ cols: 小列数, heads: [{ text, sub, span }], subs: [{ text, cards }] | null,
   *   rows: [{ label, enemy, cells: [{ span, lines, kind, empty }] }] }
   */
  function gridModel(r) {
    const n = plan.turns, anySplit = r.splits.some(Boolean), width = [], heads = [], subs = anySplit ? [] : null;
    const turnRate = {};
    r.factors.forEach((f) => { if (f.kind === 'turn') turnRate[f.turn] = f.rate; });
    for (let t = 0; t < n; t++) {
      const sp = r.splits[t];
      width[t] = sp ? 2 + sp.cells.length : 1;
      heads.push({ text: 'T' + (t + 1), sub: sp ? '按条件分配' : turnRate[t] !== undefined ? (turnRate[t] === null ? '—' : short(turnRate[t])) : '', span: width[t] });
      if (!subs) continue;
      if (!sp) { subs.push({ text: '' }); continue; }
      const shorts = Deal.altShorts(Deal.store.get(r.placements[r.cover[t]].id).data);
      subs.push({ text: '回合' });
      sp.cells.forEach((_, a) => subs.push({ text: '条件 ' + (a + 1), cards: shorts[a] || '' }));
      subs.push({ text: '其他' });
    }
    const rate = (slot, x) => (x.rate === null ? (x.pending ? '计算中' : '未完成') : short(slot === 'ebuff' ? x.enemy : slot === 'send' ? x.final : x.rate));
    const EMPTY = { buff: '不需要', kill: '不需要击破', ebuff: '不需要', send: '不需要送人' };
    /** 一格：id = 放的组；follow = 条件格空着时跟随的回合的组（undefined = 不跟随）；fail = 「没成功时用」格（undefined = 没有这一格） */
    const cellOf = (slot, id, opts) => {
      opts = opts || {};
      let lines, empty = false;
      if (id) {
        const x = infoOf(slot, id);
        lines = [x.name, rate(slot, x) + (slot === 'kill' && x.rate !== null && x.sl ? ' · 换出牌 ' + x.sl : '')];
      } else if (opts.follow !== undefined) {
        empty = true;
        const f = opts.follow ? infoOf(slot, opts.follow) : null;
        lines = f ? ['跟随回合', f.name + ' ' + rate(slot, f)] : ['跟随回合（' + EMPTY[slot] + '）'];
      } else { empty = true; lines = [opts.empty || EMPTY[slot]]; }
      if (opts.fail !== undefined) {
        const fx = opts.fail ? infoOf(slot, opts.fail) : null;
        lines.push('没成功时：' + (fx ? fx.name + ' ' + rate(slot, fx) : opts.failFollow ? '跟随回合' : '失败'));
      }
      if (opts.extra) lines.push('额外 SL ' + opts.extra);
      return { span: 1, lines, kind: slot, empty };
    };
    const rows = [];
    // 发牌行：发牌组跨它占的回合
    const deal = { label: '发牌', cells: [] };
    for (let t = 0; t < n; t++) {
      if (r.cover[t] < 0) { deal.cells.push({ span: width[t], lines: ['不要求发牌'], empty: true }); continue; }
      const p = r.placements[r.cover[t]];
      if (p.at !== t) continue;
      let span = 0;
      for (let u = p.at; u < p.at + p.shown; u++) span += width[u];
      deal.cells.push({ span, kind: 'deal', lines: [p.name, (p.rate === null ? '有误' : short(p.rate)) + (p.span > 1 ? ' · ' + rangeText(p.at, p.end) + ' 共享' : '') +
        (p.sl ? ' · 发牌 SL ' + p.sl : '')] });
    }
    rows.push(deal);
    [['buff', '我方\nbuff', 'b', false], ['kill', '击破', 'k', false], ['ebuff', '敌方\nbuff', 'e', true], ['send', '送人', 's', true]].forEach(([slot, label, k, enemy]) => {
      const row = { label, enemy, cells: [] };
      for (let t = 0; t < n; t++) {
        const sp = plan.split[t] && r.splits[t] ? plan.split[t] : null, ex = plan.extra[t] ? plan.extra[t][k] : 0;
        const turnFail = slot === 'kill' ? (plan.buff[t] ? plan.kfail[t] : undefined) : slot === 'send' ? (plan.ebuff[t] ? plan.sfail[t] : undefined) : undefined;
        if (!sp) { row.cells.push(cellOf(slot, plan[slot][t], { fail: turnFail, extra: ex })); continue; }
        if (slot === 'kill') row.cells.push({ span: 1, lines: ['按条件分配'].concat(ex ? ['额外 SL ' + ex] : []), empty: true });
        else row.cells.push(cellOf(slot, plan[slot][t], { fail: slot === 'send' ? turnFail : undefined, extra: ex }));
        const column = (alt) => {
          const o = alt === 'other', get = (key) => (o ? sp[FIELD[key][2]] : sp[FIELD[key][1]][alt]);
          const hasBuff = get('buff') || plan.buff[t], hasEbuff = get('ebuff') || plan.ebuff[t];
          if (slot === 'kill') return cellOf('kill', get('kill'), { empty: o ? '没满足 = 失败' : '不需要击破', fail: hasBuff ? get('killfail') : undefined });
          if (slot === 'send') {
            return cellOf('send', get('send'), { follow: plan.send[t], fail: hasEbuff ? get('sendfail') : undefined, failFollow: !get('sendfail') && !!(plan.ebuff[t] && plan.sfail[t]) });
          }
          return cellOf(slot, get(slot), { follow: plan[slot][t] });
        };
        sp.alts.forEach((_, a) => row.cells.push(column(a)));
        row.cells.push(column('other'));
      }
      rows.push(row);
    });
    return { cols: width.reduce((a, b) => a + b, 0), heads, subs, rows };
  }

  window.ComboApp = { usage, snapshot, value, anyUsed, usedGroups, gridModel: (r) => gridModel(r), result: () => { prune(); return evaluate(); } };

  // ---------- 结果 ----------

  const rangeText = (from, to) => (to > from ? 'T' + (from + 1) + '–T' + (to + 1) : 'T' + (from + 1));

  function factorLabel(f, r) {
    if (f.kind === 'deal') return rangeText(f.turn, f.to) + ' 发牌';
    if (f.kind === 'mix') return rangeText(f.turn, f.to) + ' 按条件分配';
    const t = f.turn, parts = [];
    if (r.buffs[t]) parts.push('我方 buff');
    if (r.kills[t]) parts.push('击破');
    if (r.ebuffs[t]) parts.push('敌方 buff');
    if (r.sends[t]) parts.push('送人');
    return 'T' + (t + 1) + ' ' + (parts.join(' + ') || '回合');
  }

  /** 一轮分了条件的发牌组：各条件的简短写法（BB、BA…） */
  let shortsNow = [];
  const condName = (k) => '条件 ' + (k + 1) + (shortsNow[k] ? '（' + shortsNow[k] + '）' : '');
  const setName = (set) => set.map(condName).join('、');
  function useShorts(f, r) {
    const p = r.placements[r.cover[f.turn]];
    shortsNow = p ? Deal.altShorts(Deal.store.get(p.id).data) : [];
  }

  /** 按条件分配的一轮：按「恰好满足哪几种条件」分组 */
  function mixDetail(f) {
    if (f.rate === null) return '';
    const rows = f.regions.filter((x) => x.count).map((x) => {
      let label;
      if (x.other) label = '一种条件都不满足（其他）';
      else {
        label = x.set.length === 1 ? '只满足' + setName(x.set) : '同时满足' + setName(x.set) + '，换出牌各试一次';
      }
      return '<div>' + label + '：' + fmt(x.count) + ' 种 × ' + short(x.value) + '</div>';
    });
    const multi = f.to > f.turn && f.regions.length > 2;
    return '<li class="mix-detail">' + rows.join('') + '<div>÷ 全部 ' + fmt(f.total) + ' 种</div>' +
      (multi ? '<div class="mix-note">占好几个回合时，相当于「看到后面的牌再决定按哪种打」，结果可能略偏高</div>' : '') + '</li>';
  }

  function renderResult(r) {
    const valueEl = $('comboProb');
    if (!anyUsed()) {
      valueEl.textContent = '—';
      valueEl.classList.add('idle');
      $('comboMeter').style.width = '0';
      $('comboNote').innerHTML = '<div>把伤害组、发牌组、buff 组、送人组放进下面的回合里</div>';
      return;
    }
    let html = '';
    if (r.value === null) {
      valueEl.textContent = '—';
      valueEl.classList.add('idle');
      $('comboMeter').style.width = '0';
      html += r.problems.map((p) => '<div class="warn">' + esc(p) + '</div>').join('');
    } else {
      valueEl.textContent = Kill.formatPct(r.value);
      valueEl.classList.remove('idle');
      $('comboMeter').style.width = r.value * 100 + '%';
      // 算式：按洗牌分组，括号里是同一轮发牌的几个回合
      const parts = r.blocks.filter((b) => b.factors.length).map((b) => {
        const s = b.factors.map((f) => short(f.rate)).join(' × ');
        return b.factors.length > 1 && r.blocks.filter((x) => x.factors.length).length > 1 ? '(' + s + ')' : s;
      });
      const formula = parts.length ? parts.join(' × ') : '100%';
      if (r.global) {
        html += '<div class="formula">不用全局额外 SL：' + formula + ' = ' + short(r.base) + '</div>' +
          '<div class="formula">全局额外 SL ' + r.global + ' 次（每一步都选最好的用法）→ ' + short(r.value) + '</div>';
      } else html += '<div class="formula">= ' + formula + '</div>';
      const freq = Kill.frequencyText(r.value, 1 - r.value, '成功', '失败');
      if (freq) html += '<div>' + freq + '</div>';
      if (r.weakest && r.factors.length > 1) {
        const w = r.weakest;
        html += '<div>拖累最大：' + factorLabel(w, r) + '「' + esc(w.name) + '」' + short(w.rate) + '</div>';
      }
    }
    html += r.notes.map((s) => '<div class="note">' + esc(s) + '</div>').join('');
    if (r.factors.length) {
      html += '<ul class="combo-factors">' + r.factors.map((f) => '<li' + (f === r.weakest && r.factors.length > 1 ? ' class="weak"' : '') + '><span>' +
        factorLabel(f, r) + ' · ' + esc(f.name) + '</span><b>' + (f.rate === null ? '—' : short(f.rate)) + '</b></li>' +
        (f.kind === 'mix' ? (useShorts(f, r), mixDetail(f)) : '')).join('') + '</ul>';
    }
    $('comboNote').innerHTML = html;
  }

  // ---------- 计算过程 ----------

  const P = Kill.formatPct;                              // 计算过程里的数都保留 4 位小数，方便核对
  const quote = (name) => '「' + esc(name) + '」';

  /** 伤害组：击破率（有 SL 时写出单次和换出牌次数） */
  function killText(k) {
    const single = k.single === undefined || k.single === null ? k.rate : k.single;
    return quote(k.name) + '击破 ' + (k.sl ? '单次 ' + P(single) + '，换出牌 ' + k.sl + ' 次 → 1 − (1 − ' + P(single) + ')^' + (k.sl + 1) + ' = ' + P(k.rate) : P(k.rate));
  }

  /** 一种出牌（从击破到送人）的算式 */
  function lineText(x) {
    const L = x.line, pl = L.play, k = L.kill;
    if (k && !L.qs.length && L.s === 1) return killText(k);
    if (!k && !pl.ebuff && !pl.send) return '不需要击破、不需要送人，100%';
    const parts = [];
    if (k) parts.push(quote(k.name) + '击破 ' + P(L.k));
    if (pl.ebuff) {
      const e = '敌方 buff' + quote(pl.ebuff.name) + ' ' + P(x.q), s = pl.send ? '送人' + quote(pl.send.name) + ' ' + P(L.s) : '不需要送人 100%';
      parts.push(L.sf === null ? e + ' × ' + s : '(' + e + ' × ' + s + ' + 敌方 buff 没成功 ' + P(1 - x.q) + ' × 没成功时用的送人' + quote(pl.sfail.name) + ' ' + P(L.sf) + ')');
    } else if (pl.send) parts.push('送人' + quote(pl.send.name) + ' ' + P(L.s));
    let h = parts.join(' × ') + (parts.length > 1 || pl.ebuff ? ' = 每条世界线 ' + P(x.A) : '');
    if (L.c) h += '；换出牌 ' + L.c + ' 次（' + (k ? '伤害组' : '送人组') + '的 SL）→ 1 − (1 − ' + P(x.A) + ')^' + (L.c + 1) + ' = ' + P(x.rate);
    return h;
  }

  const altsText = (alts) => (alts && alts.length ? alts.map((a) => (a === 'other' ? '其他' : condName(a))).join('、') +
    (alts.length > 1 ? '（同一个伤害组 = 同一种出牌，只算一次）' : '') + '：' : '');

  /** 几种出牌依次试 */
  function linesText(list, total) {
    if (!list.length) return '<div>没放伤害组 = 失败，0%</div>';
    let h = list.map((x) => '<div>' + altsText(x.line.alts) + lineText(x) + '</div>').join('');
    if (list.length > 1) h += '<div class="sum">换出牌各试一次：1 − ' + list.map((x) => '(1 − ' + P(x.rate) + ')').join('') + ' = ' + P(total) + '</div>';
    return h;
  }

  /** 一个回合（或分了条件的回合在某种情况下）的计算过程 */
  function turnText(d) {
    if (d.rate === null) return '还不能计算';
    const form = d.form;
    if (!form.clusters.length) return '其他格没放伤害组 = 失败，0%';
    let h = '';
    if (form.clusters.length > 1) h += '<div>几种打法用的 buff 组不同，技能只能放一次，选结果最好的一组：</div>';
    form.clusters.forEach((cl, i) => {
      let c = '';
      if (cl.buff) {
        c += '<div>我方 buff' + quote(cl.buff.name) + '：' + cl.items.map((it, j) => 'buff ' + (j + 1) + ' ' + P(it.p) + (it.sl ? '（SL ' + it.sl + ' 次 → ' + P(C.withSL(it.p, it.sl)) + '）' : '')).join(' × ') +
          ' = ' + P(cl.pb) + '</div>';
        c += '<div>我方 buff 全部成功时：</div><div class="steps-in">' + linesText(cl.plays, cl.succ) + '</div>';
        c += '<div>我方 buff 没成功时（用下面「我方 buff 没成功时用」格的伤害组）：</div><div class="steps-in">' + linesText(cl.failPlays, cl.fail) + '</div>';
        c += '<div class="sum">' + P(cl.pb) + ' × ' + P(cl.succ) + ' + (1 − ' + P(cl.pb) + ') × ' + P(cl.fail) + ' = ' + P(cl.rate) + '</div>';
      } else c += linesText(cl.plays, cl.succ);
      h += form.clusters.length > 1 ? '<div class="steps-in' + (i === form.best ? '' : ' dim') + '">' + c + '</div>' : c;
    });
    if (form.clusters.length > 1) h += '<div class="sum">取最好的 = ' + P(form.rate) + '</div>';
    if (d.extra) h += '<div>上面是不用额外 SL 时。有额外 SL 时，失败了可以选怎么救，没有一行的公式，按下面的递推算：</div>';
    else if (d.optimal) h += '<div>有的时候不 SL、直接改用「我方 buff 没成功时用」格的伤害组反而更好（它比 buff 成功时的打法还好），按下面的递推算：</div>';
    if (d.extra || d.optimal) {
      h += d.trace ? traceText(d.trace, d.spec.extra)
        : '<div class="sum">状态太多，不逐个列出：把每条世界线逐步走一遍、每一步选最好的用法 = ' + P(d.rate) + '</div>';
    }
    return h;
  }

  /** 递推里一个状态的写法，例如「击破〔换出牌 2 · 送人 1〕」 */
  function stateName(row, ex) {
    if (row.kind === 'buff') {
      const res = [];
      if (row.ownMax) res.push('自己的 SL ' + row.own);
      if (ex.b) res.push('额外 ' + row.xb);
      return '我方 buff ' + (row.i + 1) + (res.length ? '〔' + res.join(' · ') + '〕' : '');
    }
    const L = row.line, m = row.m;
    const pos = row.pos === 0 ? '击破' : row.pos <= m ? '敌方 buff' + (m > 1 ? ' ' + row.pos : '') : row.pos === m + 1 ? '送人' : '没成功时的送人';
    const res = [];
    if (L.c) res.push('换出牌 ' + row.c);
    if (ex.k) res.push('击破额外 ' + row.xk);
    if (ex.e) res.push('敌方 buff 额外 ' + row.xe);
    if (ex.s) res.push('送人额外 ' + row.xs);
    const who = row.many ? quote(L.kill ? L.kill.name : '不需要击破') : '';
    return (row.tag === 'fail' ? '（buff 没成功）' : '') + who + pos + (res.length ? '〔' + res.join(' · ') + '〕' : '');
  }

  /** 一步一步的递推：每个状态 = 成功率 × 下一步 + (1 − 成功率) × max{各种救法} */
  function traceText(tr, ex) {
    const ref = (row) => '[' + row.id + ']';
    const lines = tr.rows.map((row) => {
      const next = row.next ? ref(row.next) + ' ' + P(row.next.v) : '成功 100%';
      let h = '<li><b>' + ref(row) + ' ' + stateName(row, ex) + '</b> = ';
      if (row.p >= 1) h += next;
      else {
        const opts = row.opts.map((o, i) => (i === row.pick ? '<u>' : '') + o.label + ' ' + (o.row ? ref(o.row) + ' ' : '') + P(o.v) + (i === row.pick ? '</u>' : ''));
        h += P(row.p) + ' × ' + next + ' + ' + P(1 - row.p) + ' × max{' + opts.join('，') + '}';
      }
      return h + ' = ' + P(row.v) + '</li>';
    });
    return '<div class="trace"><div>一步一步的递推（[编号] 是状态；〔〕里是还剩几次；失败时取画线的那种救法，它最好）：</div><ul>' + lines.join('') + '</ul>' +
      (tr.more ? '<div>…其余 ' + tr.more + ' 个状态同理，略。</div>' : '') + '<div class="sum">这一回合 = ' + ref(tr.start) + ' = ' + P(tr.rate) + '</div></div>';
  }

  /** 按条件分配的一轮里，某一种情况下各回合怎么算 */
  function regionTurns(x) {
    return '<ul>' + x.turns.map((tt) => '<li>T' + (tt.turn + 1) + (tt.split ? (x.other ? '（其他格）' : '') : '') + '：' + turnText(tt.detail) + '</li>').join('') + '</ul>';
  }

  function factorSteps(f, r) {
    const label = factorLabel(f, r);
    if (f.rate === null) return '<li>' + label + quote(f.name) + '：还不能计算</li>';
    if (f.kind === 'deal') {
      return '<li>' + label + quote(f.name) + '：发牌概率 ' + (f.sl ? P(f.single) + '，发牌阶段 SL ' + f.sl + ' 次（重新发牌）→ 1 − (1 − ' + P(f.single) + ')^' + (f.sl + 1) + ' = ' + P(f.rate) : P(f.rate)) + '</li>';
    }
    if (f.kind === 'turn') return '<li>' + label + '：' + turnText(f.detail) + '</li>';
    // 按条件分配：按「恰好满足哪几种条件」分成几种情况，各情况的成功率按发牌组合数加权
    useShorts(f, r);
    const rows = f.regions.filter((x) => x.count).map((x) => {
      const what = x.other ? '一种条件都不满足（其他）' : (x.set.length === 1 ? '只满足' : '同时满足') + setName(x.set);
      return '<li>' + what + '：' + fmt(x.count) + ' 种，成功率 ' + P(x.value) + regionTurns(x) + '</li>';
    }).join('');
    const sum = f.regions.filter((x) => x.count).map((x) => fmt(x.count) + ' × ' + P(x.value)).join(' + ');
    let redeal = '';
    if (f.sl) {
      redeal = '<div class="sum">发牌阶段 SL ' + f.sl + ' 次：看到牌之后，某种发牌接着打的成功率比重新发牌低时就重新发。' +
        f.steps.slice(1).map((v, i) => 'SL ' + (i + 1) + ' 次 = Σ 组合数 × max(这种发牌的成功率, ' + P(f.steps[i]) + ') ÷ ' + fmt(f.total) + ' = ' + P(v)).join('；') + '</div>';
    }
    return '<li>' + label + quote(f.name) + '（发牌组共 ' + fmt(f.total) + ' 种发牌）<ol>' + rows + '</ol>' +
      '<div class="sum">(' + sum + ') ÷ ' + fmt(f.total) + ' = ' + P(f.single) + '</div>' + redeal + '</li>';
  }

  function renderSteps(r) {
    const body = $('comboStepsBody');
    if (r.value === null) { body.innerHTML = '<p>' + (r.problems.length ? '方案输入完整后显示计算过程。' : '') + '</p>'; return; }
    if (!r.factors.length) { body.innerHTML = '<p>每个回合都是 100%（没放组，或者放的组都是 100%）。</p>'; return; }
    let h = '<p>按回合顺序列出每一项（100% 的回合不列出）。每个回合按结算顺序：发牌 → 我方 buff → 击破 → 敌方 buff → 送人。' +
      '一条世界线 = 一种出牌从击破走到送人；换出牌（伤害组的 SL）就是换一条新的世界线，击破、敌方 buff、送人一起重新判定，我方 buff 保留。</p>' +
      '<ol>' + r.factors.map((f) => factorSteps(f, r)).join('') + '</ol>' +
      '<p class="sum">' + (r.global ? '不用全局额外 SL：' : '综合 = ') + (r.factors.length > 1 ? r.factors.map((f) => P(f.rate)).join(' × ') + ' = ' : '') + P(r.base) + '</p>';
    if (r.global) {
      const head = Array.from({ length: r.global + 1 }, (_, g) => '<th>还剩 ' + g + ' 次</th>').join('');
      const rows = r.globalTable.map((x) => '<tr><td>' + rangeText(x.from, x.to) + (x.deal ? '（含发牌）' : x.mixed ? '（按条件分配）' : '') + ' 往后</td>' +
        x.W.map((v) => '<td>' + P(v) + '</td>').join('') + '</tr>').join('');
      h += '<p class="sum">全局额外 SL ' + r.global + ' 次：前面的回合用掉了，后面就少了，所以不能拆开相乘。' +
        '从最后一个回合往前算「从这里往后、还剩 g 次全局额外 SL 时」的成功率（每个回合里按上面的方法，成功后接下一行同样剩余次数的值）：</p>' +
        '<table class="sl-table"><thead><tr><th></th>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="sum">综合 = 第一行「还剩 ' + r.global + ' 次」= ' + P(r.value) + '</p>';
    }
    body.innerHTML = h;
  }

  // ---------- 组列表 ----------

  function chip(kind, g, sub) {
    const on = selected && selected.kind === kind && selected.id === g.id;
    return '<button type="button" class="gchip ' + kind + (on ? ' selected' : '') + '" data-drag="' + kind + '" data-id="' + g.id + '" aria-pressed="' + on + '">' +
      '<span>' + esc(g.name) + '</span><small>' + esc(sub) + '</small></button>';
  }

  const ROW_NAME = { kill: '击破', deal: '发牌', send: '送人', buff: '我方 buff 或敌方 buff' };

  function renderPalette() {
    $('paletteKill').innerHTML = Kill.store.list().map((g) => chip('kill', g, Kill.summary(g))).join('');
    $('paletteDeal').innerHTML = Deal.store.list().map((g) => chip('deal', g, Deal.summary(g))).join('');
    $('paletteBuff').innerHTML = Buff.store.list().map((g) => chip('buff', g, Buff.summary(g))).join('');
    $('paletteSend').innerHTML = Send.store.list().map((g) => chip('send', g, Send.summary(g))).join('');
    $('paletteHint').textContent = selected
      ? '已选中，点下面「' + ROW_NAME[selected.kind] + '」一行的格子放入；再点一次取消'
      : '拖到下面的回合里，或者先点一下组、再点一下格子';
  }

  // ---------- 回合表（横竖转置：每列一个回合） ----------

  const RESHUFFLE = {
    natural: '↻ 新一轮洗牌',
    forced: (p) => '↻ 提前洗牌，需 T' + p.at + ' 有从者退场',
  };

  /** 格子的地址属性：data-slot、data-turn、data-alt（条件格）、data-fail（buff 失败时） */
  function addrAttr(slot, t, alt, fail) {
    return ' data-slot="' + slot + '" data-turn="' + t + '"' + (alt === undefined ? '' : ' data-alt="' + alt + '"') + (fail ? ' data-fail="1"' : '');
  }

  const isTarget = (slot) => selected && ACCEPT[selected.kind].indexOf(slot) >= 0;

  /** 空格子 */
  function emptySlot(slot, t, alt, fail, text, pos, small) {
    return '<button type="button" class="tl-slot' + (small ? ' small' : '') + (isTarget(slot) ? ' target' : '') + '"' + addrAttr(slot, t, alt, fail) + (pos || '') + '>' + text + '</button>';
  }

  /** 放好的组 */
  function groupItem(slot, t, alt, fail, id, name, rate, sub, bad, pos, small) {
    const kind = KIND_OF[slot];
    return '<div class="tl-item ' + kind + (slot === 'ebuff' ? ' enemy' : '') + (small ? ' small' : '') + (isTarget(slot) ? ' target' : '') + (bad ? ' bad' : '') + '"' +
      addrAttr(slot, t, alt, fail) + (pos || '') + '>' +
      '<span class="tl-grip" data-drag="' + kind + '" data-id="' + id + '" aria-hidden="true">⠿</span>' +
      '<div class="tl-body"><div class="tl-name">' + esc(name) + '</div><div class="tl-rate">' + rate + '</div>' +
      (sub ? '<div class="tl-sub">' + sub + '</div>' : '') + '</div>' +
      '<button type="button" class="tl-remove" data-remove="1" aria-label="移除">×</button></div>';
  }

  const rateText = (x, key) => (x.rate === null ? (x.pending ? '计算中' : '未完成') : short(x[key || 'rate']));

  /** 一格：slot = 'buff' | 'kill' | 'ebuff' | 'send'，id = 放的组；follow = 空着时跟随的回合的组 id（条件格） */
  function cell(slot, t, alt, fail, id, opts) {
    opts = opts || {};
    const small = !!fail;
    if (!id) {
      let text = opts.empty;
      if (opts.follow !== undefined) {                   // 条件格空着：跟随回合，写出实际用的是哪个
        const f = opts.follow ? infoOf(slot, opts.follow) : null;
        text = '跟随回合<small>' + (f ? esc(f.name) + ' ' + rateText(f, slot === 'ebuff' ? 'enemy' : slot === 'send' ? 'final' : 'rate') : opts.followEmpty) + '</small>';
      }
      return emptySlot(slot, t, alt, fail, text, opts.pos, small);
    }
    const x = infoOf(slot, id);
    let rate, sub = '';
    if (slot === 'kill') { rate = rateText(x); if (x.rate !== null && x.sl) sub = '换出牌 ' + x.sl + ' 次'; }
    else if (slot === 'send') { rate = rateText(x, 'final'); if (x.rate !== null && x.sl) sub = opts.hasKill ? '按伤害组换出牌' : 'SL ' + x.sl + ' 次'; }
    else if (slot === 'buff') rate = rateText(x);
    else { rate = x.rate === null ? '未完成' : short(x.enemy); if (x.items && x.items.some((it) => it.sl)) sub = '不单独 SL'; }
    return groupItem(slot, t, alt, fail, id, x.name, rate, sub, x.rate === null && !x.pending, opts.pos, small);
  }

  function infoOf(slot, id) {
    return slot === 'kill' ? killInfo(id) : slot === 'send' ? sendInfo(id) : buffInfo(id);
  }

  /** 条件的简短写法里的 B / A / Q 按卡色上色 */
  const colorCards = (text) => esc(text).replace(/[BAQ]/g, (c) => '<span class="c-' + c + '">' + c + '</span>');

  /** 「buff 失败时」的小格（放在击破、送人格下面） */
  function failBox(slot, t, alt, id, follow) {
    const opts = { empty: '没放 = 失败' };
    if (follow !== undefined) { opts.follow = follow; opts.followEmpty = '（没放 = 失败）'; }
    const label = slot === 'kill' ? '我方 buff 没成功时用' : '敌方 buff 没成功时用';
    return '<div class="tl-fail"><div class="tl-fail-label">' + label + '</div>' + cell(slot, t, alt, true, id, opts) + '</div>';
  }

  function renderTimeline(r) {
    const n = plan.turns, anySplit = r.splits.some(Boolean);
    let row = 1;
    const R = { head: row++ };
    if (anySplit) R.sub = row++;
    Object.assign(R, { deal: row++, buff: row++, kill: row++, ebuff: row++, send: row++ });
    const start = [], width = [];
    let col = 2;
    for (let t = 0; t < n; t++) {
      start[t] = col;
      width[t] = r.splits[t] ? 2 + r.splits[t].cells.length : 1;
      col += width[t];
    }
    const at = (rowName, c, span) => ' style="grid-row:' + R[rowName] + ';grid-column:' + c + (span > 1 ? ' / span ' + span : '') + '"';

    // 第一列：各行的名称（左右滑动时固定）
    let html = '<div class="tl-lab tl-corner"' + at('head', 1) + '>回合</div>' + (anySplit ? '<div class="tl-lab"' + at('sub', 1) + '></div>' : '') +
      [['deal', '发牌', 'my'], ['buff', '我方<br>buff', 'my'], ['kill', '击破', 'my'], ['ebuff', '敌方<br>buff', 'enemy'], ['send', '送人', 'enemy']]
        .map(([k, text, cls]) => '<div class="tl-lab ' + cls + '"' + at(k, 1) + '>' + text + '</div>').join('');

    const turnRate = {};
    r.factors.forEach((f) => { if (f.kind === 'turn') turnRate[f.turn] = f.rate; });

    for (let t = 0; t < n; t++) {
      const sp = r.splits[t], s0 = start[t], w = width[t];
      const sub = sp ? '按条件' : turnRate[t] !== undefined ? (turnRate[t] === null ? '—' : short(turnRate[t])) : '';
      html += '<div class="tl-head" data-head-turn="' + t + '"' + at('head', s0, w) + '>T' + (t + 1) + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
      if (r.cover[t] < 0) html += emptySlot('deal', t, undefined, false, '不要求发牌', at('deal', s0, w));
      // 每个阶段的格子下面：这一回合这个阶段的额外 SL
      const stage = (row, k, inner) => '<div class="tl-cell"' + at(row, s0) + '>' + inner + xslChip(t, k) + '</div>';
      if (!sp) {
        html += stage('buff', 'b', cell('buff', t, undefined, false, plan.buff[t], { empty: '不需要' }));
        html += stage('kill', 'k', cell('kill', t, undefined, false, plan.kill[t], { empty: '不需要击破' }) +
          (plan.buff[t] ? failBox('kill', t, undefined, plan.kfail[t]) : '') +
          (r.cover[t] >= 0 ? '<button type="button" class="tl-split-btn" data-split="' + t + '">按条件分配</button>' : ''));
        html += stage('ebuff', 'e', cell('ebuff', t, undefined, false, plan.ebuff[t], { empty: '不需要' }));
        html += stage('send', 's', cell('send', t, undefined, false, plan.send[t], { empty: '不需要送人', hasKill: !!plan.kill[t] }) +
          (plan.ebuff[t] ? failBox('send', t, undefined, plan.sfail[t]) : ''));
        continue;
      }
      // 分了条件：小列「回合」放跟随用的组，然后各条件、其他
      const dealData = Deal.store.get(r.placements[r.cover[t]].id).data, raw = plan.split[t];
      const texts = Deal.altTexts(dealData), shorts = Deal.altShorts(dealData);
      html += '<div class="tl-subhead"' + at('sub', s0) + '>回合<small>空格跟随它</small></div>';
      html += stage('buff', 'b', cell('buff', t, undefined, false, plan.buff[t], { empty: '不需要' }));
      html += stage('kill', 'k', '<div class="tl-merge-cell"><span>按条件<br>分配</span><button type="button" class="tl-merge" data-merge="' + t + '">合并</button></div>');
      html += stage('ebuff', 'e', cell('ebuff', t, undefined, false, plan.ebuff[t], { empty: '不需要' }));
      html += stage('send', 's', cell('send', t, undefined, false, plan.send[t], { empty: '不需要送人' }) +
        (plan.ebuff[t] ? failBox('send', t, undefined, plan.sfail[t]) : ''));
      const column = (alt, c, label, title) => {
        const o = alt === 'other', get = (k) => (o ? raw[FIELD[k][2]] : raw[FIELD[k][1]][alt]);
        const tag = o ? '' : shorts[alt] || '';
        let h = '<div class="tl-subhead"' + (title ? ' title="' + esc(title) + '"' : '') + at('sub', c) + '>' + label +
          (tag ? '<span class="tl-tagline">' + colorCards(tag) + '</span>' : '<small>' + esc(title) + '</small>') + '</div>';
        h += cell('buff', t, alt, false, get('buff'), { follow: plan.buff[t], followEmpty: '（不需要）', pos: at('buff', c) });
        const hasBuff = get('buff') || plan.buff[t], hasEbuff = get('ebuff') || plan.ebuff[t];
        h += '<div class="tl-cell"' + at('kill', c) + '>' + cell('kill', t, alt, false, get('kill'), { empty: o ? '没满足 = 失败' : '不需要击破' }) +
          (hasBuff ? failBox('kill', t, alt, get('killfail')) : '') + '</div>';
        h += cell('ebuff', t, alt, false, get('ebuff'), { follow: plan.ebuff[t], followEmpty: '（不需要）', pos: at('ebuff', c) });
        h += '<div class="tl-cell"' + at('send', c) + '>' + cell('send', t, alt, false, get('send'), { follow: plan.send[t], followEmpty: '（不需要送人）', hasKill: !!get('kill') }) +
          (hasEbuff ? failBox('send', t, alt, get('sendfail'), plan.ebuff[t] ? plan.sfail[t] : null) : '') + '</div>';
        return h;
      };
      sp.cells.forEach((_, a) => { html += column(a, s0 + 1 + a, '条件 ' + (a + 1), texts[a] || ''); });
      html += column('other', s0 + w - 1, '其他', '一种条件都不满足');
    }
    r.placements.forEach((p, i) => {
      if (p.at >= n) return;
      const note = p.conflict ? '<div class="tl-warn">' + esc(p.conflict) + '</div>'
        : p.reshuffle === 'natural' ? '<div class="tl-tag">' + RESHUFFLE.natural + '</div>'
          : p.reshuffle === 'forced' ? '<div class="tl-tag warn">' + RESHUFFLE.forced(p) + '</div>' : '';
      const end = p.at + p.shown - 1, span = start[end] + width[end] - start[p.at];
      html += '<div class="tl-item deal' + (isTarget('deal') ? ' target' : '') + (p.conflict ? ' bad' : '') + '" data-slot="deal" data-turn="' + p.at +
        '" data-span="' + p.shown + '" data-from="' + i + '"' + at('deal', start[p.at], span) + '>' +
        '<span class="tl-grip" data-drag="deal" data-id="' + p.id + '" aria-hidden="true">⠿</span>' +
        '<div class="tl-body"><div class="tl-name">' + esc(p.name) + '</div><div class="tl-rate">' +
        (p.rate === null ? '有误' : short(p.rate)) + '</div><div class="tl-sub">' + (p.span > 1 ? rangeText(p.at, p.end) + ' 共享' : '单回合') + '</div>' + note +
        '<div class="tl-deal-xsl">' + xslChip(p.at, 'd') + '</div></div>' +
        '<button type="button" class="tl-remove" data-remove-deal="' + i + '" aria-label="移除' + esc(p.name) + '">×</button></div>';
    });
    const tl = $('timeline');
    tl.style.gridTemplateColumns = '3em repeat(' + (col - 2) + ', minmax(80px, 1fr))';
    tl.style.gridTemplateRows = 'auto' + (anySplit ? ' auto' : '') + ' repeat(5, minmax(52px, auto))';
    tl.innerHTML = html;
    $('turnMinus').disabled = n <= 1;
    $('turnPlus').disabled = n >= C.MAX_TURNS;
    $('turnCount').textContent = n + ' 个回合';
    renderExtra();
  }

  // ---------- 额外 SL ----------

  const STAGE_NAME = { d: '发牌', b: '我方 buff', k: '击破', e: '敌方 buff', s: '送人' };
  let extraSel = null;                                   // 正在设置额外 SL 的阶段 { t: 第几回合, k: 'b' | 'k' | 'e' | 's' }

  /** 阶段格子下面的「额外 SL」小按钮：没设时「＋额外 SL」，设了显示次数 */
  function xslChip(t, k) {
    const n = plan.extra[t] ? plan.extra[t][k] : 0, on = extraSel && extraSel.t === t && extraSel.k === k;
    return '<button type="button" class="tl-xsl' + (n ? ' set' : '') + (on ? ' on' : '') + '" data-xsl="' + t + ':' + k + '" aria-label="T' + (t + 1) + ' ' + STAGE_NAME[k] + '阶段的额外 SL">' +
      (n ? '额外 SL ' + n + ' 次' : '＋额外 SL') + '</button>';
  }

  function stepper(attr, n, max, label) {
    return '<span class="dims"><span class="dims-label">' + label + '</span>' +
      '<button type="button" class="dims-step" ' + attr + ' data-delta="-1" aria-label="' + label + '减 1"' + (n <= 0 ? ' disabled' : '') + '>−</button>' +
      '<span class="dims-count">' + n + '</span>' +
      '<button type="button" class="dims-step" ' + attr + ' data-delta="1" aria-label="' + label + '加 1"' + (n >= max ? ' disabled' : '') + '>＋</button></span>';
  }

  const STAGE_TIP = {
    d: '看到发到的牌之后可以重新发牌（这一轮洗牌从头再来），没发到想要的牌、或者发到了但打法不好时都可以重发。发牌只能用这里的次数，全局额外 SL 不能用来重新发牌。',
    b: '我方 buff 没成功时可以多重抽几次（先用 buff 自己的 SL 次数，再用这里的）。',
    k: '击破失败时可以多换几次出牌（先用伤害组的 SL 次数，再用这里的）。',
    e: '敌方 buff 没成功时只重抽敌方 buff，击破的结果保留。',
    s: '送人失败时只重抽送人，击破、敌方 buff 的结果保留。',
  };

  function renderExtra() {
    const box = $('extraBox');
    if (!extraSel || extraSel.t >= plan.turns) { extraSel = null; box.hidden = true; }
    else {
      const t = extraSel.t, k = extraSel.k, ex = plan.extra[t] || C.extraOf(null);
      box.hidden = false;
      box.innerHTML = '<div class="extra-head"><b>T' + (t + 1) + ' · ' + STAGE_NAME[k] + '阶段的额外 SL</b><button type="button" class="tl-merge" data-extra-close="1">完成</button></div>' +
        '<div class="extra-tip">只能在这一回合的' + STAGE_NAME[k] + '阶段用。' + STAGE_TIP[k] + '</div>' +
        '<div class="extra-rows">' + stepper('data-xstep="' + k + '"', ex[k], C.MAX_EXTRA, '次数') + '</div>';
    }
    $('globalSl').innerHTML = stepper('data-gstep="1"', plan.global, C.MAX_GLOBAL, '全局额外 SL');
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

  /** 格子的地址：{ slot, turn, alt, fail } */
  const addrOf = (el) => ({ slot: el.dataset.slot, turn: Number(el.dataset.turn), alt: el.dataset.alt, fail: el.dataset.fail === '1' });

  function setCell(a, id) {
    const [turnField, many, one] = FIELD[a.slot + (a.fail ? 'fail' : '')];
    const sp = plan.split[a.turn];
    if (a.alt === undefined || !sp) {
      plan[turnField][a.turn] = id;
      if (!id && a.slot === 'buff' && !a.fail) plan.kfail[a.turn] = null;     // 没有 buff 组就没有「buff 失败时」
      if (!id && a.slot === 'ebuff' && !a.fail) plan.sfail[a.turn] = null;
    } else if (a.alt === 'other') sp[one] = id;
    else sp[many][Number(a.alt)] = id;
  }

  /** 放一个组：to = 目标格子的地址；from = 从方案里拖过来的格子（移动时先清掉原来的） */
  function place(kind, id, to, from) {
    if (kind === 'deal') {
      const before = plan.deal.filter((p, i) => i !== from).length;
      C.placeDeal(plan, id, to.turn, spanOf, from);
      const dropped = before + 1 - plan.deal.length;
      commit(dropped ? '新放的发牌组占了 ' + rangeText(to.turn, to.turn + spanOf(id) - 1) + '，原来在这几个回合的 ' + dropped + ' 个发牌组已移除' : '');
      return;
    }
    if (from && !(from.slot === to.slot && from.turn === to.turn && from.alt === to.alt && from.fail === to.fail)) setCell(from, null);
    setCell(to, id);
    commit();
  }

  /** 发牌行里某个位置对应第几回合（占好几列的发牌组按横向位置算） */
  function slotTurn(slot, clientX) {
    const at = Number(slot.dataset.turn), span = Number(slot.dataset.span || 1);
    if (span <= 1 || clientX === undefined) return at;
    for (let t = at; t < at + span; t++) {
      const head = document.querySelector('#timeline [data-head-turn="' + t + '"]');
      if (!head) continue;
      const rc = head.getBoundingClientRect();
      if (clientX >= rc.left && clientX < rc.right + 6) return t;
    }
    return at;
  }

  $('viewCombo').addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const b = e.target.closest('button, .tl-item');
    if (!b) return;
    if (b.dataset.remove !== undefined) { setCell(addrOf(b.closest('[data-slot]')), null); commit(); return; }
    if (b.dataset.removeDeal !== undefined) { plan.deal.splice(Number(b.dataset.removeDeal), 1); commit(); return; }
    if (b.dataset.split !== undefined) {                 // 按条件分配：每个条件格先放原来的伤害组，其他格跟随回合
      const t = Number(b.dataset.split), r0 = evaluate(), n = r0.placements[r0.cover[t]].alts;
      const sp = { alts: [], other: null };
      SPLIT_FIELDS.forEach(([many, one]) => { sp[many] = Array.from({ length: n }, () => null); sp[one] = null; });
      sp.alts = sp.alts.map(() => plan.kill[t]);
      sp.kfails = sp.kfails.map(() => plan.kfail[t]);
      plan.split[t] = sp;
      plan.kill[t] = null;
      plan.kfail[t] = null;
      commit();
      return;
    }
    if (b.dataset.merge !== undefined) { merge(Number(b.dataset.merge)); commit(); return; }
    if (b.dataset.xsl !== undefined) {
      const [t, k] = b.dataset.xsl.split(':');
      extraSel = extraSel && extraSel.t === Number(t) && extraSel.k === k ? null : { t: Number(t), k };
      render();
      return;
    }
    if (b.dataset.extraClose !== undefined) { extraSel = null; render(); return; }
    if (b.dataset.xstep !== undefined) {
      const ex = plan.extra[extraSel.t] || C.extraOf(null), k = b.dataset.xstep;
      ex[k] = Math.min(C.MAX_EXTRA, Math.max(0, ex[k] + Number(b.dataset.delta)));
      plan.extra[extraSel.t] = C.STAGES.some((s) => ex[s]) ? ex : null;
      commit();
      const f = document.querySelector('[data-xstep="' + k + '"][data-delta="' + b.dataset.delta + '"]');
      if (f && !f.disabled) f.focus();
      return;
    }
    if (b.dataset.gstep !== undefined) {
      plan.global = Math.min(C.MAX_GLOBAL, Math.max(0, plan.global + Number(b.dataset.delta)));
      commit();
      const f = document.querySelector('[data-gstep][data-delta="' + b.dataset.delta + '"]');
      if (f && !f.disabled) f.focus();
      return;
    }
    if (b.classList.contains('gchip')) {
      const kind = b.dataset.drag, id = b.dataset.id;
      selected = selected && selected.kind === kind && selected.id === id ? null : { kind, id };
      render();
      return;
    }
    if (b.dataset.slot && selected && ACCEPT[selected.kind].indexOf(b.dataset.slot) >= 0) {
      const { kind, id } = selected;
      selected = null;
      const to = addrOf(b);
      if (kind === 'deal') to.turn = slotTurn(b, e.clientX);
      place(kind, id, to);
    }
  });

  $('turnPlus').addEventListener('click', () => { C.ensureTurns(plan, plan.turns + 1); commit(); });
  $('turnMinus').addEventListener('click', () => {
    if (plan.turns <= 1) return;
    plan.turns--;
    C.PER_TURN.forEach((k) => { if (Array.isArray(plan[k])) plan[k].pop(); });
    plan.deal = plan.deal.filter((p) => p.at < plan.turns);
    commit();
  });
  $('comboClear').addEventListener('click', () => {
    if (!anyUsed() && !plan.global && !plan.extra.some(Boolean)) return;
    G.confirmBox('清空方案里放好的组和额外 SL？\n伤害组、发牌组、buff 组、送人组本身不会删除。', { ok: '清空方案', danger: true }).then((yes) => {
      if (!yes) return;
      plan = emptyPlan(plan.turns);
      selected = null;
      extraSel = null;
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
    return slot && ACCEPT[drag.kind].indexOf(slot.dataset.slot) >= 0 ? slot : null;
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
    if (dy) window.scrollBy(0, dy);
    const box = $('timelineBox'), rc = box.getBoundingClientRect(), x = drag.x;   // 回合表左右滑动
    const dx = y > rc.top && y < rc.bottom ? (x < rc.left + 40 ? -8 : x > rc.right - 40 ? 8 : 0) : 0;
    if (dx) box.scrollLeft += dx;
    if (dy || dx) setHover(hitSlot(drag.x, drag.y));
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
    $('timeline').classList.remove('drop-kill', 'drop-deal', 'drop-send', 'drop-buff');
    if (d.hover) d.hover.classList.remove('drop-hover');
    if (drop && d.hover) {
      selected = null;
      const to = addrOf(d.hover);
      if (d.kind === 'deal') to.turn = slotTurn(d.hover, d.x);
      place(d.kind, d.id, to, d.from);
    }
  }

  $('viewCombo').addEventListener('pointerdown', (e) => {
    const src = e.target.closest('[data-drag]');
    if (!src || e.button > 0) return;
    const item = src.closest('.tl-item');
    let from;
    if (item) from = item.classList.contains('deal') ? Number(item.dataset.from) : addrOf(item);
    drag = { src, kind: src.dataset.drag, id: src.dataset.id, pointerId: e.pointerId, from, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, hover: null };
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
  Buff.store.onChange(refresh);
  document.addEventListener('sendresult', refresh);    // 送人组在后台算完了
  document.addEventListener('tabshow', (e) => { if (e.detail === 'combo') render(); });

  load();
  render();
})();
