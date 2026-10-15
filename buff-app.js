// buff 成功率页面：buff 组（好几个 buff，各自的成功率、SL 次数）→ 用 buff.js 计算 → 显示两个阶段的成功率和计算过程。
// 规则见《世界线规则.md》
(function () {
  'use strict';

  const B = window.Buff;
  const G = window.Groups;
  const KA = window.KillApp;
  const esc = G.escapeHtml;
  const $ = (id) => document.getElementById(id);

  const MAX_SL = 999;
  const MODE_NAME = { atLeast: '至少', exactly: '恰好', atMost: '至多' };

  // ---------- 输入（和其他页面相同：全角数字转半角，允许小数；百分比可以带 %） ----------

  function normalize(text) {
    return String(text)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[．。]/g, '.')
      .replace(/[,，\s]/g, '');
  }

  function parsePct(text) {
    const t = normalize(String(text).replace(/[%％]\s*$/, ''));
    if (t === '') return { empty: true };
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { error: '请输入数字' };
    const v = Number(t);
    return v > 100 ? { error: '最多 100%' } : { value: v / 100 };
  }

  function parseInt0(text, max, unit) {
    const t = normalize(text);
    if (t === '') return { empty: true, value: 0 };
    if (!/^\d+$/.test(t)) return { error: '请输入整数' };
    const v = Number(t);
    return v > max ? { error: '最多 ' + max + (unit || '') } : { value: v };
  }

  // ---------- buff 组的数据 ----------

  function newItem() {
    return { name: '', type: 'plain', p: '', sl: '', n: 3, x: '', mode: 'atLeast', each: false, ps: ['', '', ''] };
  }

  function create() {
    return { items: [newItem()] };
  }

  function cleanData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, B.MAX_ITEMS).map((it) => {
      it = it && typeof it === 'object' ? it : {};
      const each = it.each === true;
      const n = Number.isInteger(it.n) && it.n >= 1 && it.n <= (each ? B.MAX_EACH : B.MAX_N) ? it.n : 3;
      const ps = (Array.isArray(it.ps) ? it.ps : []).slice(0, B.MAX_EACH).map(str);
      while (ps.length < n && ps.length < B.MAX_EACH) ps.push('');
      return {
        name: str(it.name).slice(0, 20), type: it.type === 'binom' ? 'binom' : 'plain', p: str(it.p), sl: str(it.sl),
        n, x: str(it.x), mode: B.MODES.indexOf(it.mode) >= 0 ? it.mode : 'atLeast', each, ps,
      };
    });
    if (!items.length) return null;
    return { items };
  }

  const store = new G.GroupStore({
    key: 'killprob.buff.v1', label: 'buff 组', idPrefix: 'b',
    naming: (n) => 'buff组' + n,
    create, clean: cleanData,
  });

  /** buff 的称呼：「buff 1」或「buff 1「魅惑」」 */
  const itemLabel = (it, i) => 'buff ' + (i + 1) + (it.name.trim() ? '「' + esc(it.name.trim()) + '」' : '');

  /**
   * buff 组 → 计算用的输入。返回 { status: 'ok', items } 或 { status: 'idle' | 'error', message }，
   * 另有 errors（输入框的 data-path → 错误说明）
   */
  function build(d) {
    const errors = {};
    let typed = false, missing = null;
    const need = (label) => { if (!missing) missing = label; };
    function pct(path, text, label) {
      const r = parsePct(text);
      if (r.error) { errors[path] = r.error; return null; }
      if (r.empty) { need(label); return null; }
      typed = true;
      return r.value;
    }
    const items = d.items.map((it, i) => {
      const p = 'items.' + i + '.', name = 'buff ' + (i + 1);
      const sl = parseInt0(it.sl, MAX_SL, ' 次');
      if (sl.error) errors[p + 'sl'] = sl.error;
      else if (!sl.empty) typed = true;
      if (it.type !== 'binom') return { type: 'plain', p: pct(p + 'p', it.p, name + '的成功率'), sl: sl.value || 0 };
      const ps = it.each ? it.ps.slice(0, it.n).map((v, k) => pct(p + 'ps.' + k, v, name + '第 ' + (k + 1) + ' 次的成功率'))
        : new Array(it.n).fill(pct(p + 'p', it.p, name + '的成功率'));
      const x = parseInt0(it.x, it.n, ' 次（判定 ' + it.n + ' 次）');
      if (x.error) errors[p + 'x'] = x.error;
      else if (x.empty) need(name + '的命中次数');
      else typed = true;
      return { type: 'binom', ps, x: x.value, mode: it.mode, sl: sl.value || 0 };
    });
    const res = { errors };
    if (Object.keys(errors).length) return Object.assign(res, { status: 'error', message: '请检查标红的输入' });
    if (!typed) return Object.assign(res, { status: 'idle', message: '输入每个 buff 的成功率后自动计算' });
    if (missing) return Object.assign(res, { status: 'idle', message: '还要填：' + missing });
    return Object.assign(res, { status: 'ok', items });
  }

  /**
   * 一个 buff 组的结果（综合页、组列表用）：{ status: 'ok', my, enemy, items: [{ single, final, sl }] } / { status: 'idle' | 'error', message }
   */
  function resultFor(data) {
    const b = build(data);
    if (b.status !== 'ok') return b;
    const r = B.evaluate(b.items);
    return { status: 'ok', my: r.my, enemy: r.enemy, items: r.items };
  }

  function summary(g) {
    const r = resultFor(g.data);
    return r.status === 'ok' ? KA.formatShort(r.my) : '未完成';
  }

  // ---------- 画输入区 ----------

  const box = $('buffItems');

  function field(path, name, value, placeholder, mode) {
    return '<label class="field" data-field="' + path + '"><span class="field-name">' + name + '</span>' +
      '<input type="text" inputmode="' + (mode || 'decimal') + '" enterkeyhint="next" autocomplete="off" data-path="' + path +
      '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '"' + (mode === 'text' ? ' maxlength="20"' : '') + '>' +
      '<span class="field-hint"></span></label>';
  }

  function seg(path, value, options) {
    return '<div class="seg">' + options.map(([v, t]) =>
      '<button type="button" data-act="set" data-path="' + path + '" data-value="' + v + '" class="' + (value === v ? 'on' : '') + '" aria-pressed="' + (value === v) + '">' + t + '</button>').join('') + '</div>';
  }

  function stepper(path, n, min, max, label) {
    return '<span class="dims"><span class="dims-label">' + label + '</span>' +
      '<button type="button" class="dims-step" data-act="step" data-path="' + path + '" data-delta="-1" data-min="' + min + '" data-max="' + max + '" aria-label="' + label + '减 1"' + (n <= min ? ' disabled' : '') + '>−</button>' +
      '<span class="dims-count">' + n + '</span>' +
      '<button type="button" class="dims-step" data-act="step" data-path="' + path + '" data-delta="1" data-min="' + min + '" data-max="' + max + '" aria-label="' + label + '加 1"' + (n >= max ? ' disabled' : '') + '>＋</button></span>';
  }

  function itemHtml(it, i, count) {
    const p = 'items.' + i + '.';
    let h = '<div class="sd-card" data-item="' + i + '">' +
      '<div class="sd-head"><span class="sd-title">buff ' + (i + 1) + '</span>' +
      (count > 1 ? '<span class="sd-tools"><button type="button" class="aoe-remove" data-act="remove" data-i="' + i + '" aria-label="删除 buff ' + (i + 1) + '">×</button></span>' : '') + '</div>' +
      '<div class="bf-top">' + field(p + 'name', '名称', it.name, '可以不填', 'text') +
      seg(p + 'type', it.type, [['plain', '普通'], ['binom', '二项分布']]) + '</div>';
    if (it.type !== 'binom') {
      h += '<div class="cards">' + field(p + 'p', '成功率 %', it.p, '例如 80') + field(p + 'sl', 'SL 次数', it.sl, '0', 'numeric') + '</div>';
    } else {
      const max = it.each ? B.MAX_EACH : B.MAX_N;
      h += '<div class="sd-row">' + stepper(p + 'n', it.n, 1, max, '判定次数') + '</div>' +
        '<div class="sd-attack">' + field(p + 'x', '命中次数', it.x, '例如 2', 'numeric') +
        seg(p + 'mode', it.mode, [['atLeast', '至少'], ['exactly', '恰好'], ['atMost', '至多']]) + '</div>' +
        '<label class="sd-check"><input type="checkbox" data-act="each" data-i="' + i + '"' + (it.each ? ' checked' : '') + '>每次的成功率分别填（例如几个目标的弱体耐性不同）</label>';
      if (it.each) {
        h += '<div class="sd-mults bf-ps">' + it.ps.slice(0, it.n).map((v, k) => field(p + 'ps.' + k, '第 ' + (k + 1) + ' 次 %', v, '例如 80')).join('') + '</div>';
        h += '<div class="cards">' + field(p + 'sl', 'SL 次数', it.sl, '0', 'numeric') + '</div>';
      } else {
        h += '<div class="cards">' + field(p + 'p', '每次的成功率 %', it.p, '例如 80') + field(p + 'sl', 'SL 次数', it.sl, '0', 'numeric') + '</div>';
      }
    }
    return h + '<div class="bf-res" data-res="' + i + '"></div></div>';
  }

  function renderForm() {
    const d = store.active().data;
    box.innerHTML = d.items.map((it, i) => itemHtml(it, i, d.items.length)).join('');
    $('buffAdd').disabled = d.items.length >= B.MAX_ITEMS;
    $('buffAdd').textContent = d.items.length >= B.MAX_ITEMS ? '最多 ' + B.MAX_ITEMS + ' 个 buff' : '＋ buff';
  }

  // ---------- 路径：data-path = "items.0.p" ----------

  function walk(data, path) {
    const keys = path.split('.'), last = keys.pop();
    let o = data;
    keys.forEach((k) => { o = o[k]; });
    return { o, k: last };
  }
  const getPath = (data, path) => { const w = walk(data, path); return w.o[w.k]; };
  const setPath = (data, path, v) => { const w = walk(data, path); w.o[w.k] = v; };

  // ---------- 计算与显示 ----------

  const pct = KA.formatPct, short = KA.formatShort;

  function setHint(el, text, bad) {
    if (!el) return;
    const hint = el.querySelector('.field-hint');
    if (hint) hint.textContent = text || '';
    el.classList.toggle('invalid', !!bad);
  }

  function update() {
    const d = store.active().data, b = build(d);
    document.querySelectorAll('#viewBuff [data-field]').forEach((el) => setHint(el, b.errors[el.dataset.field], !!b.errors[el.dataset.field]));
    document.querySelectorAll('#viewBuff [data-res]').forEach((el) => { el.textContent = ''; });
    if (b.status !== 'ok') { showIdle(b.message); return; }
    const r = B.evaluate(b.items);
    r.items.forEach((x, i) => {
      const el = document.querySelector('#viewBuff [data-res="' + i + '"]');
      if (el) el.textContent = '这个 buff：单次 ' + short(x.single) + (x.sl ? '，SL ' + x.sl + ' 次后 ' + short(x.final) : '');
    });
    $('buffProb').textContent = pct(r.my);
    $('buffProb').classList.remove('idle');
    $('buffMeterBox').hidden = false;
    $('buffMeter').style.width = r.my * 100 + '%';
    const lines = [];
    const anySL = r.items.some((x) => x.sl);
    lines.push('放在敌方行动阶段：' + pct(r.enemy) + (anySL ? '（敌方阶段不能单独 SL，按单次成功率）' : ''));
    const freq = KA.frequencyText(r.my, 1 - r.my, '成功', '失败');
    if (freq) lines.push(freq);
    $('buffNote').innerHTML = lines.map((s) => '<div>' + s + '</div>').join('');
    renderSteps(d, b, r);
  }

  function showIdle(message) {
    $('buffProb').textContent = '—';
    $('buffProb').classList.add('idle');
    $('buffMeterBox').hidden = true;
    $('buffNote').innerHTML = '<div>' + esc(message) + '</div>';
    $('buffStepsPanel').hidden = true;
  }

  /** 组合数 C(n, k)（n ≤ 100 时用浮点数足够精确地显示） */
  function choose(n, k) {
    let c = 1;
    for (let j = 1; j <= k; j++) c = (c * (n - k + j)) / j;
    return Math.round(c);
  }

  /** 计算过程：每个 buff 的算式，最后相乘 */
  function renderSteps(d, b, r) {
    const rows = b.items.map((it, i) => {
      const x = r.items[i], label = itemLabel(d.items[i], i);
      let h = '<li>' + label + '：';
      if (it.type === 'plain') h += '成功率 ' + pct(x.single);
      else {
        const same = !d.items[i].each, n = it.ps.length, mode = MODE_NAME[it.mode];
        const hit = (k) => (it.mode === 'exactly' ? k === it.x : it.mode === 'atMost' ? k <= it.x : k >= it.x);
        h += '判定 ' + n + ' 次，' + (same ? '每次 ' + pct(it.ps[0]) : '每次分别 ' + it.ps.map(pct).join('、')) + '，命中' + mode + ' ' + it.x + ' 次';
        const ks = [];
        for (let k = 0; k <= n; k++) if (hit(k)) ks.push(k);
        if (n <= 12) {
          h += '<ul>' + ks.map((k) => '<li>命中 ' + k + ' 次：' + (same ? 'C(' + n + ',' + k + ') × ' + pct(it.ps[0]) + '^' + k + ' × ' + pct(1 - it.ps[0]) + '^' + (n - k) + ' = ' : '') +
            pct(x.dist[k]) + (same ? '（C(' + n + ',' + k + ') = ' + choose(n, k) + '）' : '') + '</li>').join('') + '</ul>';
          if (ks.length > 1) h += '<div class="sum">相加 = ' + pct(x.single) + '</div>';
          else if (!ks.length) h += '<div class="sum">不可能 = 0%</div>';
        } else h += '：把命中 ' + (ks.length ? ks[0] + ' ~ ' + ks[ks.length - 1] : '') + ' 次的概率加起来 = ' + pct(x.single);
      }
      if (x.sl) h += '<div class="sum">SL ' + x.sl + ' 次 → 1 − (1 − ' + pct(x.single) + ')^' + (x.sl + 1) + ' = ' + pct(x.final) + '</div>';
      return h + '</li>';
    }).join('');
    const prod = (key) => (r.items.length > 1 ? r.items.map((x) => pct(x[key])).join(' × ') + ' = ' : '');
    $('buffSteps').innerHTML = '<ol>' + rows + '</ol>' +
      '<p class="sum">放在我方行动阶段（各自 SL 后相乘）= ' + prod('final') + pct(r.my) + '</p>' +
      '<p class="sum">放在敌方行动阶段（单次相乘）= ' + prod('single') + pct(r.enemy) + '</p>';
    $('buffStepsPanel').hidden = false;
  }

  // ---------- 事件 ----------

  let pending = null;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(() => { pending = null; update(); }, 60);
  }

  function changedStructure() {
    const d = store.active().data;
    d.items.forEach((it) => {
      if (it.each) it.n = Math.min(it.n, B.MAX_EACH);
      while (it.ps.length < Math.min(it.n, B.MAX_EACH)) it.ps.push('');
    });
    store.changed();
    renderForm();
    update();
  }

  const view = $('viewBuff');

  view.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset.path) return;
    setPath(store.active().data, el.dataset.path, el.value);
    store.changed();
    schedule();
  });
  view.addEventListener('keydown', (e) => {                // Enter：跳到下一格
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
    e.preventDefault();
    const list = Array.from(view.querySelectorAll('input[type="text"]')), next = list[list.indexOf(e.target) + 1];
    if (next && !next.closest('.groupbar')) next.focus(); else e.target.blur();
  });
  view.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act !== 'each') return;
    const it = store.active().data.items[Number(el.dataset.i)];
    it.each = el.checked;
    if (it.each) {                                       // 分别填时先都填上原来的成功率
      it.n = Math.min(it.n, B.MAX_EACH);
      it.ps = Array.from({ length: it.n }, (_, k) => it.ps[k] || it.p);
    }
    changedStructure();
  });

  view.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !view.contains(b) || b.closest('.groupbar')) return;
    const d = store.active().data, act = b.dataset.act, path = b.dataset.path;
    if (act === 'set') setPath(d, path, b.dataset.value);
    else if (act === 'step') {
      const lo = Number(b.dataset.min), hi = Number(b.dataset.max);
      setPath(d, path, Math.min(hi, Math.max(lo, getPath(d, path) + Number(b.dataset.delta))));
    } else if (act === 'remove') {
      if (d.items.length <= 1) return;
      d.items.splice(Number(b.dataset.i), 1);
    } else if (act === 'add') {
      if (d.items.length >= B.MAX_ITEMS) return;
      d.items.push(newItem());
    } else if (act === 'clear-inputs') d.items = create().items;
    else return;
    changedStructure();
    if (act === 'step') {
      const f = view.querySelector('[data-act="step"][data-path="' + path + '"][data-delta="' + b.dataset.delta + '"]');
      if (f && !f.disabled) f.focus();
    }
    if (act === 'add') view.querySelector('[data-item="' + (d.items.length - 1) + '"] input').focus();
  });

  store.onChange((reason) => {
    if (reason === 'data' || reason === 'rename') return;
    renderForm();
    update();
  });
  new G.GroupBar($('buffGroups'), store, { summary, onUsed: (id) => (window.ComboApp && window.ComboApp.usage ? window.ComboApp.usage('buff', id) : 0) });

  window.BuffApp = { store, build, resultFor, summary, cleanData };

  renderForm();
  update();
})();
