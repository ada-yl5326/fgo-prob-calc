// 分享图片：把当前页面的主要信息重新排成一张紧凑的图片（不是截原网页），方便发给别人。
// 每个页面的结果下面有「生成分享图片」按钮 → 预览 → 保存图片 / 复制图片。颜色跟随当前的浅色 / 深色外观。
// 内容先整理成「块」（标题、大结果、键值、表格、回合表），再统一画到画布上。
(function () {
  'use strict';

  const G = window.Groups;
  const Kill = window.KillApp, Deal = window.DealApp, Buff = window.BuffApp, Send = window.SendApp, Combo = window.ComboApp;
  const pct = Kill.formatPct, short = Kill.formatShort;
  const SCALE = 2;                                       // 输出 2 倍像素，手机上看得清楚
  const BASE_W = 560;                                    // 图片的逻辑宽度（回合多时会加宽）

  // ==================== 各页面要画的内容 ====================

  const CARD_NAMES = ['First', 'Second', 'Third', 'EX'];
  const dimName = (i) => CARD_NAMES[i] || '伤害 ' + (i + 1);
  const num = (s) => String(s || '').trim();
  const blank = (s) => (num(s) === '' ? '—' : num(s));

  /** 击破概率：伤害组 */
  function killBlocks(g, compact) {
    const d = g.data, r = Kill.evaluate(d), out = [];
    if (!compact) out.push({ t: 'head', title: '击破概率', sub: g.name });
    else out.push({ t: 'section', text: '伤害组「' + g.name + '」' });
    if (r.status === 'ok' && !compact) {
      const notes = [];
      if (r.sl) notes.push('单次击破率 ' + pct(r.single) + '，SL ' + r.sl + ' 次');
      const f = Kill.frequencyText(r.final, r.fail, '击破', '失败');
      if (f) notes.push(f);
      out.push({ t: 'big', label: r.sl ? '击破率（SL ' + r.sl + ' 次）' : '击破率', value: pct(r.final), notes });
    }
    const rows = [['主目标均伤', d.cards.map((c, i) => dimName(i) + ' ' + blank(c)).join('　')], ['HP', blank(d.hp)]];
    if (num(d.sl)) rows.push(['SL 次数', num(d.sl)]);
    d.aoe.forEach((a, i) => rows.push(['AOE 目标 ' + (i + 1), '伤害 ' + a.cards.map(blank).join(' / ') + '，HP ' + blank(a.hp)]));
    if (compact) rows.push(['击破率', r.status === 'ok' ? pct(r.final) + (r.sl ? '（单次 ' + pct(r.single) + '）' : '') : r.message]);
    out.push({ t: 'kv', rows });
    if (r.status !== 'ok' && !compact) out.push({ t: 'note', text: r.message });
    if (r.status === 'ok' && !compact && r.single > 0 && r.single < 1) {
      const sls = [0, 1, 2, 3, 5];
      out.push({ t: 'table', head: ['SL 次数'].concat(sls.map(String)), rows: [['击破率'].concat(sls.map((n) => short(1 - Math.pow(1 - r.single, n + 1))))] });
    }
    return out;
  }

  /** 发牌概率：发牌组 */
  function dealBlocks(g, compact) {
    const d = g.data, e = Deal.evaluate(d), out = [];
    if (!compact) out.push({ t: 'head', title: '发牌概率', sub: g.name });
    else out.push({ t: 'section', text: '发牌组「' + g.name + '」' });
    const res = e.status === 'ok' ? (e.union || e.r) : null;
    if (res && !compact) {
      out.push({ t: 'big', label: d.alts.length > 1 ? '发牌概率（满足任意一种条件）' : '发牌概率', value: pct(res.probability),
        notes: [res.favorable.toLocaleString('en-US') + ' / ' + res.total.toLocaleString('en-US')] });
    }
    const T = Math.min(d.scope, d.servants);
    const rows = [['场上人数', d.servants + ' 人'], ['共享回合', T > 1 ? '前 ' + T + ' 回合共享发牌' : '第 1 回合']];
    d.owners.forEach((o, i) => {
      if (i >= d.servants || !o.deck) return;
      const marks = o.marked.map((m, k) => (m ? k + 1 : 0)).filter(Boolean);
      rows.push(['从者 ' + (i + 1), { text: o.deck + (marks.length ? '（纹章：第 ' + marks.join('、') + ' 张）' : ''), cards: true }]);
    });
    const shorts = Deal.altShorts(d), texts = Deal.altTexts(d);
    shorts.forEach((s, k) => rows.push([d.alts.length > 1 ? '条件 ' + (k + 1) : '条件', { text: s + '　' + texts[k], cards: true }]));
    if (compact) rows.push(['发牌概率', res ? pct(res.probability) : e.message]);
    out.push({ t: 'kv', rows });
    if (!res && !compact) out.push({ t: 'note', text: e.message });
    return out;
  }

  const MODE = { atLeast: '至少', exactly: '恰好', atMost: '至多' };

  /** buff 成功率：buff 组 */
  function buffBlocks(g, compact) {
    const d = g.data, r = Buff.resultFor(d), out = [];
    if (!compact) out.push({ t: 'head', title: 'buff 成功率', sub: g.name });
    else out.push({ t: 'section', text: 'buff 组「' + g.name + '」' });
    if (r.status === 'ok' && !compact) {
      out.push({ t: 'big', label: 'buff 成功率（放在我方行动阶段）', value: pct(r.my), notes: ['放在敌方行动阶段：' + pct(r.enemy) + '（单次相乘）'] });
    }
    const rows = d.items.map((it, i) => {
      const x = r.status === 'ok' ? r.items[i] : null;
      const what = it.type === 'binom'
        ? '判定 ' + it.n + ' 次，' + (it.each ? '每次 ' + it.ps.slice(0, it.n).map((p) => blank(p) + '%').join(' / ') : '每次 ' + blank(it.p) + '%') +
          '，命中' + MODE[it.mode] + ' ' + blank(it.x) + ' 次'
        : '成功率 ' + blank(it.p) + '%';
      return [(i + 1) + (num(it.name) ? ' ' + num(it.name) : ''), what, num(it.sl) || '0', x ? short(x.single) : '—', x ? short(x.final) : '—'];
    });
    out.push({ t: 'table', head: ['buff', '内容', 'SL', '单次', 'SL 后'], rows });
    if (compact) out.push({ t: 'kv', rows: [['成功率', r.status === 'ok' ? '我方 ' + pct(r.my) + '　敌方 ' + pct(r.enemy) : r.message]] });
    else if (r.status !== 'ok') out.push({ t: 'note', text: r.message });
    return out;
  }

  const ROLE = { must: '要退场', may: '可以退场', keep: '不能退场', immortal: '不会死' };

  /** 送人概率：送人组（还在后台计算时先等一等） */
  async function sendBlocks(g, compact) {
    const d = g.data;
    let r = Send.resultFor(d);
    for (let i = 0; i < 60 && r.status === 'pending'; i++) {
      await new Promise((ok) => setTimeout(ok, 250));
      r = Send.resultFor(d);
    }
    const out = [];
    if (!compact) out.push({ t: 'head', title: '送人概率', sub: g.name });
    else out.push({ t: 'section', text: '送人组「' + g.name + '」' });
    const label = Send.resultLabel(d);
    if (r.status === 'ok' && !compact) {
      const notes = [];
      if (r.sl) notes.push('单次 ' + pct(r.single) + '，SL ' + r.sl + ' 次');
      if (!r.result.exact) notes.push('模拟值（设置太复杂，改为模拟 ' + r.result.runs.toLocaleString('en-US') + ' 次）');
      out.push({ t: 'big', label, value: pct(r.final), notes });
    }
    const enemies = d.enemies.map((e, j) => {
      const extra = [];
      if (e.crit.on) extra.push('暴击 ' + blank(e.crit.dmg) + '（' + blank(e.crit.rate) + '%）' + (e.crit.aoe ? '全体' : ''));
      if (e.deck.on) extra.push({ text: '牌型 ' + e.deck.value, cards: true });
      if (e.np.on) extra.push('宝具 第 ' + e.np.at.join('、') + ' 次' + (num(e.np.dmg) ? ' ' + num(e.np.dmg) : '（无伤害）') + (e.np.aoe ? '全体' : ''));
      if (e.skill.on) extra.push('开技能 ' + blank(e.skill.rate) + '%');
      if (e.mult.on) extra.push('倍率 ' + e.mult.values.slice(0, d.servants.length).map((v) => blank(v) || '100').join(' / ') + '%');
      return [String(j + 1), String(e.actions), blank(e.normal.dmg) + (e.normal.aoe ? ' 全体' : ''),
        { text: extra.map((x) => (typeof x === 'string' ? x : x.text)).join('；') || '—', cards: extra.some((x) => typeof x !== 'string') }];
    });
    out.push({ t: 'table', title: '敌方（按行动顺序）', head: ['敌人', '行动', '普通攻击', '其他'], rows: enemies });
    const servants = d.servants.map((s, i) => {
      const extra = [];
      if (s.taunt) extra.push('嘲讽');
      if (s.role !== 'immortal' && s.inv) extra.push('无敌 ' + s.inv);
      if (s.role !== 'immortal' && s.guts) extra.push('战续 ' + s.guts + '（' + (s.gutsEach ? s.gutsHp.map(blank).join(' / ') : blank(s.gutsHp[0])) + '）');
      if (s.hits.on) extra.push('受击：' + s.hits.rows.map(Send.hitText).join('，'));
      return [String(i + 1), ROLE[s.role], s.role === 'immortal' ? '—' : blank(s.hp), num(s.weight) || '1', extra.join('；') || '—'];
    });
    out.push({ t: 'table', title: '我方（' + (d.backup ? '有' : '没有') + '后备队友）', head: ['从者', '角色', 'HP', '权重', '其他'], rows: servants });
    if (compact) out.push({ t: 'kv', rows: [[label, r.status === 'ok' ? pct(r.single) + '（不含 SL）' : r.message || '计算中']] });
    else if (r.status !== 'ok') out.push({ t: 'note', text: r.message || '还在计算' });
    return out;
  }

  /** 综合击破概率：缩小版的回合表 + 结果；withGroups = 附上用到的各组的主要输入 */
  async function comboBlocks(withGroups) {
    const r = Combo.result(), out = [{ t: 'head', title: '综合击破概率', sub: '' }];
    if (r.value === null) out.push({ t: 'big', label: '综合击破概率', value: '—', notes: r.problems });
    else {
      const parts = r.blocks.filter((b) => b.factors.length).map((b) => {
        const s = b.factors.map((f) => short(f.rate)).join(' × ');
        return b.factors.length > 1 && r.blocks.filter((x) => x.factors.length).length > 1 ? '(' + s + ')' : s;
      });
      const notes = [(r.global ? '不用全局额外 SL：' : '= ') + (parts.join(' × ') || '100%') + (r.global ? ' = ' + short(r.base) : '')];
      if (r.global) notes.push('全局额外 SL ' + r.global + ' 次（每一步选最好的用法）→ ' + short(r.value));
      const f = Kill.frequencyText(r.value, 1 - r.value, '成功', '失败');
      if (f) notes.push(f);
      out.push({ t: 'big', label: '综合击破概率', value: pct(r.value), notes });
    }
    out.push({ t: 'grid', model: Combo.gridModel(r) });
    r.notes.forEach((n) => out.push({ t: 'note', text: n }));
    if (withGroups) {
      const used = Combo.usedGroups();
      for (const g of used.deal) out.push(...dealBlocks(g, true));
      for (const g of used.buff) out.push(...buffBlocks(g, true));
      for (const g of used.kill) out.push(...killBlocks(g, true));
      for (const g of used.send) out.push(...await sendBlocks(g, true));
    }
    return out;
  }

  const PAGES = {
    kill: { name: '击破概率', blocks: () => killBlocks(Kill.store.active()), group: () => Kill.store.active().name },
    deal: { name: '发牌概率', blocks: () => dealBlocks(Deal.store.active()), group: () => Deal.store.active().name },
    buff: { name: 'buff成功率', blocks: () => buffBlocks(Buff.store.active()), group: () => Buff.store.active().name },
    send: { name: '送人概率', blocks: () => sendBlocks(Send.store.active()), group: () => Send.store.active().name },
    combo: { name: '综合击破概率', blocks: (opt) => comboBlocks(opt), group: () => '方案', option: '附上方案里用到的各组的主要输入' },
  };

  // ==================== 画图 ====================

  function colors() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    return { bg: v('--bg'), surface: v('--surface'), text: v('--text'), muted: v('--muted'), border: v('--border'), accent: v('--accent'),
      soft: v('--accent-soft'), sl: v('--sl'), gold: v('--gold'), quick: v('--quick'), danger: v('--danger'), B: v('--buster'), A: v('--arts'), Q: v('--quick') };
  }

  const FONT = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const font = (size, weight) => (weight || 400) + ' ' + size + 'px ' + FONT;

  /** 按宽度折行（逐字，中文和英文都适用） */
  function wrap(ctx, text, maxW) {
    const out = [];
    String(text).split('\n').forEach((para) => {
      let line = '';
      for (const ch of para) {
        if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch.trim() ? ch : ''; }
        else line += ch;
      }
      out.push(line);
    });
    return out;
  }

  /** 写一行字；cards = B / A / Q 按卡色上色 */
  function drawText(ctx, text, x, y, color, C, cards) {
    if (!cards) { ctx.fillStyle = color; ctx.fillText(text, x, y); return; }
    for (const ch of text) {
      ctx.fillStyle = C[ch] && /[BAQ]/.test(ch) ? C[ch] : color;
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width;
    }
  }

  const cellText = (v) => (v && typeof v === 'object' ? v : { text: String(v === undefined || v === null ? '' : v), cards: false });

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Laplace NS 标志（圆环 + 横条，同页面左上角） */
  function drawLogo(ctx, x, y, s, C) {
    const cx = x + 39 * s, cy = y + 36 * s;
    ctx.lineWidth = 6.75 * s;
    ctx.strokeStyle = C.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 23.6 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C.text;
    roundRect(ctx, x + 1 * s, y + 29.6 * s, 76 * s, 12.8 * s, 1.3 * s);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(10 * s, 700);
    ctx.fillStyle = C.surface;
    ctx.fillText('Laplace', cx, y + 36.4 * s);
    ctx.font = font(15 * s, 800);
    [['N', 13.2, C.gold], ['S', 60.4, C.B]].forEach(([ch, yy, col]) => {
      ctx.lineWidth = 4 * s;
      ctx.strokeStyle = C.surface;
      ctx.strokeText(ch, cx, y + yy * s);
      ctx.fillStyle = col;
      ctx.fillText(ch, cx, y + yy * s);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * 排版并画出所有块。draw = false 时只量高度。返回内容的总高度
   */
  function layout(ctx, blocks, W, C, draw, meta) {
    const P = 22, inner = W - P * 2;
    let y = P;
    blocks.forEach((b) => {
      if (b.t === 'head') {
        if (draw) {
          drawLogo(ctx, P, y, 0.62, C);
          ctx.font = font(13, 700);
          ctx.fillStyle = C.muted;
          ctx.fillText('Laplace NS', P + 58, y + 18);
          ctx.font = font(21, 800);
          drawText(ctx, b.title + (meta.group ? ' · ' + meta.group : ''), P + 58, y + 42, C.text, C);
        }
        y += 58;
      } else if (b.t === 'big') {
        ctx.font = font(13);
        const notes = [];
        (b.notes || []).forEach((n) => notes.push(...wrap(ctx, n, inner - 24)));
        const h = 34 + 40 + notes.length * 19 + 12;
        if (draw) {
          ctx.fillStyle = C.surface;
          roundRect(ctx, P, y, inner, h, 14);
          ctx.fill();
          ctx.strokeStyle = C.border;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.textAlign = 'center';
          ctx.font = font(13, 600);
          ctx.fillStyle = C.muted;
          ctx.fillText(b.label, W / 2, y + 24);
          ctx.font = font(34, 800);
          ctx.fillStyle = b.value === '—' ? C.muted : C.text;
          ctx.fillText(b.value, W / 2, y + 66);
          ctx.font = font(13);
          ctx.fillStyle = C.muted;
          notes.forEach((n, i) => ctx.fillText(n, W / 2, y + 90 + i * 19));
          ctx.textAlign = 'left';
        }
        y += h + 12;
      } else if (b.t === 'section') {
        y += 6;
        if (draw) {
          ctx.font = font(15, 700);
          ctx.fillStyle = C.accent;
          ctx.fillText(b.text, P, y + 15);
        }
        y += 24;
      } else if (b.t === 'note') {
        ctx.font = font(13);
        const lines = wrap(ctx, b.text, inner);
        if (draw) lines.forEach((l, i) => { ctx.fillStyle = C.gold; ctx.fillText(l, P, y + 15 + i * 19); });
        y += lines.length * 19 + 8;
      } else if (b.t === 'kv') {
        ctx.font = font(13, 600);
        const kw = Math.min(110, Math.max(...b.rows.map((r) => ctx.measureText(r[0]).width)) + 14);
        b.rows.forEach((r) => {
          const v = cellText(r[1]);
          ctx.font = font(14);
          const lines = wrap(ctx, v.text, inner - kw);
          if (draw) {
            ctx.font = font(13, 600);
            ctx.fillStyle = C.muted;
            ctx.fillText(r[0], P, y + 16);
            ctx.font = font(14);
            lines.forEach((l, i) => drawText(ctx, l, P + kw, y + 16 + i * 20, C.text, C, v.cards));
          }
          y += lines.length * 20 + 6;
        });
        y += 6;
      } else if (b.t === 'table') y = drawTable(ctx, b, P, y, inner, C, draw);
      else if (b.t === 'grid') y = drawGrid(ctx, b.model, P, y, inner, C, draw);
    });
    // 页脚：版本、网址、时间
    y += 4;
    if (draw) {
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P, y);
      ctx.lineTo(W - P, y);
      ctx.stroke();
      ctx.font = font(11);
      ctx.fillStyle = C.muted;
      ctx.fillText('Laplace NS ' + meta.version + ' · ada-yl5326.github.io/fgo-prob-calc · ' + meta.time, P, y + 18);
    }
    return y + 28;
  }

  function drawTable(ctx, b, x, y, w, C, draw) {
    if (b.title) {
      if (draw) { ctx.font = font(13, 700); ctx.fillStyle = C.muted; ctx.fillText(b.title, x, y + 14); }
      y += 22;
    }
    const n = b.head.length, pad = 8, lh = 18;
    ctx.font = font(13);
    // 列宽：按内容的最长宽度分配，最后一列占剩下的
    const want = b.head.map((h, i) => Math.max(ctx.measureText(h).width, ...b.rows.map((r) => ctx.measureText(cellText(r[i]).text).width)) + pad * 2);
    const total = want.reduce((a, c) => a + c, 0);
    let widths = want.slice();
    if (total > w) {                                     // 太宽：长的列按比例缩小
      const fixed = want.map((v) => Math.min(v, w / n));
      const spare = w - fixed.reduce((a, c) => a + c, 0), over = want.map((v, i) => v - fixed[i]), sumOver = over.reduce((a, c) => a + c, 0);
      widths = fixed.map((v, i) => v + (sumOver ? spare * over[i] / sumOver : 0));
    } else widths[n - 1] += w - total;
    const rows = [b.head].concat(b.rows).map((r, ri) => {
      const cells = r.map((c, i) => { const t = cellText(c); return { lines: wrap(ctx, t.text, widths[i] - pad * 2), cards: t.cards }; });
      return { cells, h: Math.max(...cells.map((c) => c.lines.length)) * lh + 10, head: ri === 0 };
    });
    const H = rows.reduce((a, r) => a + r.h, 0);
    if (draw) {
      ctx.fillStyle = C.surface;
      roundRect(ctx, x, y, w, H, 10);
      ctx.fill();
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      ctx.stroke();
      let yy = y;
      rows.forEach((r, ri) => {
        if (ri > 0) { ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
        let xx = x;
        r.cells.forEach((c, i) => {
          ctx.font = r.head ? font(12, 700) : font(13);
          c.lines.forEach((l, k) => drawText(ctx, l, xx + pad, yy + 18 + k * lh, r.head ? C.muted : C.text, C, c.cards));
          xx += widths[i];
        });
        yy += r.h;
      });
    }
    return y + H + 12;
  }

  const KIND_COLOR = (C) => ({ deal: C.gold, buff: C.quick, ebuff: C.sl, kill: C.accent, send: C.sl });

  /** 回合表：每列一个回合（分了条件的回合分小列），每行一个阶段 */
  function drawGrid(ctx, m, x, y, w, C, draw) {
    const labelW = 52, cols = m.cols, colW = (w - labelW) / cols, lh = 16, gap = 4;
    const K = KIND_COLOR(C);
    // 表头：回合（跨小列）+ 小列标题
    let hy = y;
    if (draw) {
      ctx.font = font(12, 700);
      ctx.fillStyle = C.muted;
      ctx.fillText('回合', x, hy + 16);
    }
    let cx = x + labelW;
    m.heads.forEach((h) => {
      if (draw) {
        ctx.textAlign = 'center';
        ctx.font = font(14, 800);
        ctx.fillStyle = C.text;
        ctx.fillText(h.text, cx + h.span * colW / 2, hy + 15);
        if (h.sub) { ctx.font = font(11, 600); ctx.fillStyle = C.muted; ctx.fillText(h.sub, cx + h.span * colW / 2, hy + 30); }
        ctx.textAlign = 'left';
      }
      cx += h.span * colW;
    });
    hy += 36;
    if (m.subs) {
      ctx.font = font(12, 800);
      const fit = (t) => (ctx.measureText(t).width > colW - 8 ? t.split('，').join('\n') : t);   // 太长时在逗号处换行
      const cardLines = m.subs.map((s) => (s.cards ? wrap(ctx, fit(s.cards), colW - 8) : []));
      const subH = 18 + Math.max(0, ...cardLines.map((l) => l.length)) * 15 + 4;
      cx = x + labelW;
      m.subs.forEach((s, i) => {
        if (draw) {
          ctx.textAlign = 'center';
          ctx.font = font(11, 700);
          ctx.fillStyle = C.muted;
          ctx.fillText(s.text, cx + colW / 2, hy + 12);
          ctx.textAlign = 'left';
          ctx.font = font(12, 800);
          cardLines[i].forEach((l, k) => {
            const tw = ctx.measureText(l).width;
            drawText(ctx, l, cx + colW / 2 - tw / 2, hy + 28 + k * 15, C.text, C, true);
          });
        }
        cx += colW;
      });
      hy += subH;
    }
    // 各行
    m.rows.forEach((row) => {
      ctx.font = font(12);
      const cellLines = row.cells.map((c) => {
        const width = c.span * colW - gap - 10;
        const lines = [];
        c.lines.forEach((l, i) => { ctx.font = i === 0 && !c.empty ? font(12, 700) : font(11); lines.push(...wrap(ctx, l, width).map((t) => ({ t, first: i === 0 && !c.empty }))); });
        return lines;
      });
      const h = Math.max(30, ...cellLines.map((ls) => ls.length * lh + 10));
      if (draw) {
        ctx.fillStyle = row.enemy ? C.sl : C.accent;
        ctx.fillRect(x, hy + 2, 3, h - 4);
        ctx.font = font(12, 700);
        ctx.fillStyle = C.muted;
        row.label.split('\n').forEach((l, i, a) => ctx.fillText(l, x + 8, hy + h / 2 + 4 + (i - (a.length - 1) / 2) * 15));
        let xx = x + labelW;
        row.cells.forEach((c, ci) => {
          const cw = c.span * colW - gap;
          roundRect(ctx, xx, hy, cw, h - gap, 7);
          if (c.empty) {
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = C.border;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = C.bg;
            ctx.fill();
            ctx.strokeStyle = C.border;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = K[c.kind] || C.accent;
            ctx.fillRect(xx, hy + 3, 3, h - gap - 6);
          }
          cellLines[ci].forEach((l, k) => {
            ctx.font = l.first ? font(12, 700) : font(11);
            drawText(ctx, l.t, xx + 7, hy + 15 + k * lh, c.empty ? C.muted : l.first ? C.text : C.muted, C, false);
          });
          xx += c.span * colW;
        });
      }
      hy += h;
    });
    return hy + 10;
  }

  /** 生成图片：返回 canvas */
  async function render(page, option) {
    const def = PAGES[page], blocks = await def.blocks(option), C = colors();
    const grid = blocks.find((b) => b.t === 'grid');
    const W = Math.max(BASE_W, grid ? 52 + 44 + grid.model.cols * 92 : 0);
    const meta = {
      group: def.group(), time: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-').slice(0, 16),
      version: ((document.querySelector('footer div') || {}).textContent || '').split('·')[0].trim(),
    };
    if (page === 'combo') meta.group = '';
    const probe = document.createElement('canvas').getContext('2d');
    const H = layout(probe, blocks, W, C, false, meta);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    layout(ctx, blocks, W, C, true, meta);
    return canvas;
  }

  // ==================== 预览、保存、复制 ====================

  const toBlob = (canvas) => new Promise((ok) => canvas.toBlob(ok, 'image/png'));

  function fileName(page) {
    const d = new Date(), two = (n) => String(n).padStart(2, '0');
    const name = String(PAGES[page].group()).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20);
    return 'LaplaceNS_' + PAGES[page].name + (page === 'combo' ? '' : '_' + name) + '_' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
      '-' + two(d.getHours()) + two(d.getMinutes()) + '.png';
  }

  async function save(blob, name) {
    try {                                                // 手机：系统分享菜单（可以直接发 QQ / 微信、存到相册）
      const f = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [f] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        await navigator.share({ files: [f], title: name });
        return '';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return '';
    }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return '已保存（下载）';
  }

  const canCopy = () => !!(navigator.clipboard && window.ClipboardItem);

  async function open(page) {
    const def = PAGES[page];
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = '<div class="modal-box snap-box" role="dialog" aria-modal="true" aria-label="分享图片">' +
      '<div class="modal-text">分享图片 · ' + G.escapeHtml(def.name) + '</div>' +
      (def.option ? '<label class="modal-check"><input type="checkbox" data-snap-opt><span>' + def.option + '</span></label>' : '') +
      '<div class="snap-view"><div class="snap-wait">正在生成…</div></div>' +
      '<div class="modal-status" aria-live="polite"></div>' +
      '<div class="modal-actions"><button type="button" data-snap="close">关闭</button>' +
      (canCopy() ? '<button type="button" data-snap="copy">复制图片</button>' : '') +
      '<button type="button" class="primary" data-snap="save">保存图片</button></div></div>';
    document.body.appendChild(wrap);
    const status = wrap.querySelector('.modal-status'), view = wrap.querySelector('.snap-view');
    let blob = null, url = null;
    const build = async () => {
      blob = null;
      status.textContent = '';
      const opt = !!(wrap.querySelector('[data-snap-opt]') || {}).checked;
      const canvas = await render(page, opt);
      blob = await toBlob(canvas);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      view.innerHTML = '<img class="snap-img" alt="分享图片预览">';
      view.querySelector('img').src = url;
    };
    const close = () => { wrap.remove(); if (url) URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('change', (e) => { if (e.target.dataset.snapOpt !== undefined) build(); });
    wrap.addEventListener('click', async (e) => {
      if (e.target === wrap) { close(); return; }
      const b = e.target.closest('[data-snap]');
      if (!b) return;
      if (b.dataset.snap === 'close') { close(); return; }
      if (!blob) return;
      if (b.dataset.snap === 'save') status.textContent = await save(blob, fileName(page));
      else {
        try {
          await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
          status.textContent = '已复制，可以直接粘贴到聊天里';
        } catch (err) { status.textContent = '这个浏览器不能复制图片，请用「保存图片」'; }
      }
    });
    try { await build(); } catch (err) { view.innerHTML = '<div class="snap-wait">生成失败：' + G.escapeHtml(err.message) + '</div>'; }
  }

  // 每个页面的结果下面放一个按钮
  [['kill', 'viewKill'], ['deal', 'viewDeal'], ['buff', 'viewBuff'], ['send', 'viewSend'], ['combo', 'viewCombo']].forEach(([page, id]) => {
    const result = document.querySelector('#' + id + ' .result');
    if (!result) return;
    const row = document.createElement('div');
    row.className = 'snap-row';
    row.innerHTML = '<button type="button" class="snap-btn">生成分享图片</button>';
    row.querySelector('button').addEventListener('click', () => open(page));
    result.after(row);
  });

  window.SummaryApp = { open, render, PAGES };
})();
