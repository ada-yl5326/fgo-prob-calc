// 综合击破概率页面：把伤害组、发牌组拖进各个回合（或先点组、再点回合），算出整个方案的综合击破率
(function () {
  'use strict';

  const C = window.Combo;
  const G = window.Groups;
  const Kill = window.KillApp, Deal = window.DealApp;
  const STORAGE_KEY = 'killprob.combo.v1';
  const $ = (id) => document.getElementById(id);
  const esc = G.escapeHtml;
  const short = Kill.formatShort;

  // ---------- 方案 ----------

  let plan = { turns: 3, kill: [null, null, null], deal: [] };
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
      };
    } catch (e) { /* 忽略 */ }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plan)); } catch (e) { /* 无痕模式等 */ }
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
    const before = plan.deal.length;
    plan.deal = plan.deal.filter((p) => Deal.store.get(p.id));
    removed += before - plan.deal.length;
    if (removed) { notice = '有 ' + removed + ' 处用到的组已被删除，已从方案里移除'; save(); }
  }

  function killInfo(id) {
    const g = Kill.store.get(id), r = Kill.evaluate(g.data);
    return { name: g.name, rate: r.status === 'ok' ? r.final : null, sl: r.status === 'ok' ? r.sl : 0 };
  }

  function dealInfo(id) {
    const g = Deal.store.get(id), r = Deal.evaluate(g.data);
    return { name: g.name, rate: r.status === 'ok' ? r.probability : null, span: r.span, servants: r.servants };
  }

  const spanOf = (id) => dealInfo(id).span;

  function usage(kind, id) {
    return kind === 'kill' ? plan.kill.filter((x) => x === id).length : plan.deal.filter((p) => p.id === id).length;
  }

  window.ComboApp = { usage };

  // ---------- 显示 ----------

  const rangeText = (from, to) => (to > from ? 'T' + (from + 1) + '–T' + (to + 1) : 'T' + (from + 1));

  function renderResult(r) {
    const used = plan.kill.some(Boolean) || plan.deal.length;
    const value = $('comboProb');
    if (!used) {
      value.textContent = '—';
      value.classList.add('idle');
      $('comboMeter').style.width = '0';
      $('comboNote').innerHTML = '<div>把伤害组、发牌组放进下面的回合里</div>';
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
      if (r.weakest && r.factors.length > 1) {
        const w = r.weakest;
        html += '<div>拖累最大：' + (w.kind === 'deal' ? rangeText(w.turn, w.to) + ' 发牌「' : 'T' + (w.turn + 1) + ' 击破「') +
          esc(w.name) + '」' + short(w.rate) + '</div>';
      }
    }
    if (r.factors.length) {
      html += '<ul class="combo-factors">' + r.factors.map((f) => '<li' + (f === r.weakest && r.factors.length > 1 ? ' class="weak"' : '') + '><span>' +
        (f.kind === 'deal' ? rangeText(f.turn, f.to) + ' 发牌' : 'T' + (f.turn + 1) + ' 击破') + ' · ' + esc(f.name) + '</span><b>' +
        (f.rate === null ? '—' : short(f.rate)) + '</b></li>').join('') + '</ul>';
    }
    $('comboNote').innerHTML = html;
  }

  function chip(kind, g, sub) {
    const on = selected && selected.kind === kind && selected.id === g.id;
    return '<button type="button" class="gchip ' + kind + (on ? ' selected' : '') + '" data-drag="' + kind + '" data-id="' + g.id + '" aria-pressed="' + on + '">' +
      '<span>' + esc(g.name) + '</span><small>' + esc(sub) + '</small></button>';
  }

  function renderPalette() {
    $('paletteKill').innerHTML = Kill.store.list().map((g) => chip('kill', g, Kill.summary(g))).join('');
    $('paletteDeal').innerHTML = Deal.store.list().map((g) => chip('deal', g, Deal.summary(g))).join('');
    $('paletteHint').textContent = selected
      ? '已选中，点下面「' + (selected.kind === 'kill' ? '击破' : '发牌') + '」一栏的格子放入；再点一次取消'
      : '拖到下面的回合里，或者先点一下组、再点一下回合';
  }

  const RESHUFFLE = {
    natural: '↻ 新一轮洗牌',
    forced: (p) => '↻ 提前洗牌，需 T' + p.at + ' 有从者退场',
  };

  function renderTimeline(r) {
    const n = plan.turns, target = selected ? selected.kind : null;
    let html = '<div class="tl-h">回合</div><div class="tl-h">发牌</div><div class="tl-h">击破</div>';
    for (let t = 0; t < n; t++) {
      html += '<div class="tl-turn" style="grid-row:' + (t + 2) + '">T' + (t + 1) + '</div>';
      if (r.cover[t] < 0) {
        html += '<button type="button" class="tl-slot' + (target === 'deal' ? ' target' : '') + '" data-slot="deal" data-turn="' + t +
          '" style="grid-row:' + (t + 2) + ';grid-column:2">不要求发牌</button>';
      }
      const k = r.kills[t];
      if (!k) {
        html += '<button type="button" class="tl-slot' + (target === 'kill' ? ' target' : '') + '" data-slot="kill" data-turn="' + t +
          '" style="grid-row:' + (t + 2) + ';grid-column:3">不需要击破</button>';
      } else {
        const info = killInfo(k.id);
        html += '<div class="tl-item kill' + (target === 'kill' ? ' target' : '') + (k.rate === null ? ' bad' : '') + '" data-slot="kill" data-turn="' + t +
          '" style="grid-row:' + (t + 2) + ';grid-column:3">' +
          '<span class="tl-grip" data-drag="kill" data-id="' + k.id + '" data-from="' + t + '" aria-hidden="true">⠿</span>' +
          '<div class="tl-body"><div class="tl-name">' + esc(k.name) + '</div><div class="tl-rate">' +
          (k.rate === null ? '未完成' : short(k.rate)) + '</div>' + (info.sl ? '<div class="tl-sub">SL ' + info.sl + ' 次</div>' : '') + '</div>' +
          '<button type="button" class="tl-remove" data-remove-kill="' + t + '" aria-label="从 T' + (t + 1) + ' 移除">×</button></div>';
      }
    }
    r.placements.forEach((p, i) => {
      if (p.at >= n) return;
      const note = p.conflict ? '<div class="tl-warn">' + esc(p.conflict) + '</div>'
        : p.reshuffle === 'natural' ? '<div class="tl-tag">' + RESHUFFLE.natural + '</div>'
          : p.reshuffle === 'forced' ? '<div class="tl-tag warn">' + RESHUFFLE.forced(p) + '</div>' : '';
      html += '<div class="tl-item deal' + (target === 'deal' ? ' target' : '') + (p.conflict ? ' bad' : '') + '" data-slot="deal" data-turn="' + p.at +
        '" data-span="' + p.shown + '" style="grid-row:' + (p.at + 2) + ' / span ' + p.shown + ';grid-column:2">' +
        '<span class="tl-grip" data-drag="deal" data-id="' + p.id + '" data-from="' + i + '" aria-hidden="true">⠿</span>' +
        '<div class="tl-body"><div class="tl-name">' + esc(p.name) + '</div><div class="tl-rate">' +
        (p.rate === null ? '有误' : short(p.rate)) + '</div><div class="tl-sub">' + (p.span > 1 ? rangeText(p.at, p.end) + ' 共享' : '单回合') + '</div>' + note + '</div>' +
        '<button type="button" class="tl-remove" data-remove-deal="' + i + '" aria-label="移除' + esc(p.name) + '">×</button></div>';
    });
    const tl = $('timeline');
    tl.style.gridTemplateRows = 'auto repeat(' + n + ', minmax(58px, auto))';
    tl.innerHTML = html;
    $('turnMinus').disabled = n <= 1;
    $('turnPlus').disabled = n >= C.MAX_TURNS;
    $('turnCount').textContent = n + ' 个回合';
  }

  function render() {
    prune();
    const r = C.evaluate(plan, killInfo, dealInfo);
    renderResult(r);
    renderPalette();
    renderTimeline(r);
    $('comboNotice').hidden = !notice;
    $('comboNotice').textContent = notice;
  }

  // ---------- 放入 / 移除 ----------

  let selected = null;                                   // 点选模式：{ kind, id }

  function place(kind, id, turn, from) {
    if (kind === 'kill') {
      if (from !== undefined && from !== turn) plan.kill[from] = null;
      plan.kill[turn] = id;
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
      place(kind, id, slotTurn(b, e.clientY));
    }
  });

  $('turnPlus').addEventListener('click', () => { C.ensureTurns(plan, plan.turns + 1); commit(); });
  $('turnMinus').addEventListener('click', () => {
    if (plan.turns <= 1) return;
    plan.turns--;
    plan.kill.pop();
    plan.deal = plan.deal.filter((p) => p.at < plan.turns);
    commit();
  });
  $('comboClear').addEventListener('click', () => {
    if (!plan.kill.some(Boolean) && !plan.deal.length) return;
    G.confirmBox('清空方案里放好的组？\n伤害组、发牌组本身不会删除。', { ok: '清空方案', danger: true }).then((yes) => {
      if (!yes) return;
      plan.kill = plan.kill.map(() => null);
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
    $('timeline').classList.remove('drop-kill', 'drop-deal');
    if (d.hover) d.hover.classList.remove('drop-hover');
    if (drop && d.hover) {
      selected = null;
      place(d.kind, d.id, slotTurn(d.hover, d.y), d.from);
    }
  }

  $('viewCombo').addEventListener('pointerdown', (e) => {
    const src = e.target.closest('[data-drag]');
    if (!src || e.button > 0) return;
    drag = {
      src, kind: src.dataset.drag, id: src.dataset.id, pointerId: e.pointerId,
      from: src.dataset.from === undefined ? undefined : Number(src.dataset.from),
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
  document.addEventListener('tabshow', (e) => { if (e.detail === 'combo') render(); });

  load();
  render();
})();
