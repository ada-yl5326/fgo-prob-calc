// 网页界面：读取输入 → 调用 killprob.js 计算 → 显示击破概率、伤害分布图和击破概率曲线
(function () {
  'use strict';

  const K = window.KillProb;
  const STORAGE_KEY = 'killprob.inputs.v1';
  const CURVE_SEGMENTS = 120;                            // 击破概率曲线约 120 段（每个点都精确计算）

  const $ = (id) => document.getElementById(id);
  const cardInputs = [0, 1, 2, 3].map((i) => $('card' + i));
  const hpInput = $('hp');
  const inputs = cardInputs.concat(hpInput);
  const fields = [0, 1, 2, 3, 4].map((i) => $('field' + i));

  const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmt = (n) => intFormat.format(n);

  // ---------- 输入 ----------

  /** 去掉千分位逗号、空格，全角数字和小数点转半角 */
  function normalize(text) {
    return text
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[．。]/g, '.')
      .replace(/[,，\s]/g, '');
  }

  /** 返回 { empty } / { value } / { error }；和命令行版一样允许小数、千分位逗号，不允许负数 */
  function parse(text) {
    const t = normalize(text);
    if (t === '') return { empty: true, value: 0 };
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { error: '请输入数字' };
    return { value: Number(t) };
  }

  /** 离开输入框时加上千分位逗号（小数部分保持原样，不改变数值） */
  function prettify(el) {
    const r = parse(el.value);
    if (r.error || r.empty) return;
    const [intPart, frac] = normalize(el.value).split('.');
    el.value = fmt(Number(intPart || '0')) + (frac === undefined ? '' : '.' + frac);
  }

  function setHint(i, text, invalid) {
    const hint = fields[i].querySelector('.field-hint');
    hint.textContent = text || hint.dataset.default || '';
    fields[i].classList.toggle('invalid', !!invalid);
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs.map((el) => el.value))); } catch (e) { /* 无痕模式等 */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved)) saved.forEach((v, i) => { if (inputs[i] && typeof v === 'string') inputs[i].value = v; });
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 计算与显示 ----------

  let prepKey = null, prep = null;                       // 均伤不变时，改 HP 不用重新预处理
  let chartState = null;                                 // 最近一次分布图的数据（窗口大小变化时重画）

  function formatProbability(kills, total) {
    if (kills === total) return '100%';
    if (kills === 0) return '0%';
    const p = (kills / total) * 100;
    if (p >= 99.99995) return '> 99.9999%';
    if (p < 0.00005) return '< 0.0001%';
    return p.toFixed(4) + '%';
  }

  function formatShare(count, total) {
    const p = (count / total) * 100;
    if (count > 0 && p < 0.01) return '< 0.01%';
    if (count < total && p > 99.99) return '> 99.99%';
    return p.toFixed(2) + '%';
  }

  function showIdle(message) {
    $('prob').textContent = '—';
    $('prob').classList.add('idle');
    $('meter').hidden = true;
    $('note').textContent = message;
    $('chartPanel').hidden = true;
    chartState = null;
  }

  function update() {
    const cards = cardInputs.map((el) => parse(el.value));
    const hp = parse(hpInput.value);
    save();

    cards.forEach((r, i) => {
      if (r.error) setHint(i, r.error, true);
      else if (r.empty) setHint(i, '');
      else {
        const c = K.cardOutcomes(r.value);
        setHint(i, fmt(c[0]) + ' ~ ' + fmt(c[c.length - 1]));
      }
    });
    setHint(4, hp.error, !!hp.error);

    if (cards.some((r) => r.error) || hp.error) return showIdle('请检查标红的输入');
    if (cards.every((r) => r.empty)) return showIdle('输入均伤和 HP 后自动计算');
    if (hp.empty) return showIdle('再输入 HP 就能算出击破概率');

    const avgs = cards.map((r) => r.value);
    const key = avgs.join('|');
    if (key !== prepKey) { prep = K.prepare(avgs); prepKey = key; }
    const kills = K.countAtLeast(prep, hp.value);

    $('prob').textContent = formatProbability(kills, prep.total);
    $('prob').classList.remove('idle');
    $('meter').hidden = false;
    $('meterFill').style.width = (kills / prep.total) * 100 + '%';

    let lines;
    if (prep.min >= hp.value) lines = ['最低伤害 ' + fmt(prep.min) + ' ≥ HP，必定击破'];
    else if (prep.max < hp.value) lines = ['最高伤害 ' + fmt(prep.max) + ' < HP，无法击破'];
    else lines = ['总伤害 ' + fmt(prep.min) + ' ~ ' + fmt(prep.max)];
    if (hp.value > 0) lines.push('平均 ' + fmt(prep.mean) + '，是 HP 的 ' + ((prep.mean / hp.value) * 100).toFixed(2) + '%');
    $('note').innerHTML = lines.map((s) => '<div>' + s + '</div>').join('');

    $('legendKill').textContent = '击破 ' + formatShare(kills, prep.total);
    $('legendMiss').textContent = '未击破 ' + formatShare(prep.total - kills, prep.total);
    $('chartPanel').hidden = false;
    chartState = { hp: hp.value, kills: kills, total: prep.total, min: prep.min, max: prep.max, bins: null, points: null };
    drawChart();
  }

  // ---------- 图表：伤害分布 / 击破概率曲线（手动切换） ----------

  const CHART_KEY = 'killprob.chart.v1';
  const MAX_BINS = 48;                                   // 伤害分布最多约 48 根柱子
  const PAD_DIST = { left: 6, right: 6, top: 22, bottom: 22 };
  const PAD_CURVE = { left: 36, right: 10, top: 22, bottom: 22 };   // 左边留给纵轴刻度
  const HEIGHT = 180;
  const CAPTIONS = {
    dist: '柱子 = 总伤害落在这一段的概率，蓝色是能击破的部分；点按后，黄色 + 蓝色 = 总伤害 ≥ 该处的概率',
    curve: '曲线高度 = 总伤害 ≥ X 的概率，也就是 HP 为 X 时的击破率；虚线是现在的 HP',
  };
  let chartMode = 'dist';                                // dist：伤害分布；curve：击破概率曲线
  let active = null;                                     // 伤害分布：点按到的柱子序号；曲线：点按到的总伤害
  try { if (localStorage.getItem(CHART_KEY) === 'curve') chartMode = 'curve'; } catch (e) { /* 忽略 */ }

  const num = (v) => v.toFixed(2);

  function drawChart() {
    document.querySelectorAll('#chartMode button').forEach((b) => {
      const on = b.dataset.mode === chartMode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
    $('legend').hidden = chartMode !== 'dist';
    $('chartCaption').textContent = CAPTIONS[chartMode];
    const box = $('chart');
    if (!chartState) { box.innerHTML = ''; return; }
    if (chartMode === 'dist') drawDistribution(box);
    else drawCurve(box);
  }

  function chartSize(box, pad) {
    const width = Math.max(240, box.clientWidth || 320);
    return { width, plotW: width - pad.left - pad.right, plotH: HEIGHT - pad.top - pad.bottom };
  }

  function hpMarker(xPos, hp, ratio, pad, baseY) {
    const anchor = ratio < 0.2 ? 'start' : ratio > 0.8 ? 'end' : 'middle';
    return '<line class="hp-line" x1="' + xPos + '" x2="' + xPos + '" y1="' + (pad.top - 4) + '" y2="' + baseY + '"/>' +
      '<text class="hp-label" x="' + xPos + '" y="' + (pad.top - 8) + '" text-anchor="' + anchor + '">HP ' + fmt(hp) + '</text>';
  }

  /**
   * 伤害分布：柱子 = 落在这一段的概率。点按某段时显示「总伤害 >= 该段起点」的概率（HP 为该处时的击破率）：
   * 该段到 HP 之间的未击破部分标黄，HP 右边的蓝色照常显示，两者合起来就是这个概率；
   * 点在蓝色区域里时，点按处左边的蓝色变淡（不计入）
   */
  function drawDistribution(box) {
    const s = chartState;
    if (!s.bins) s.bins = K.histogram(prep, s.hp, MAX_BINS);
    const { bins, hp, total, min, max } = s;
    const P = PAD_DIST, { width, plotW, plotH } = chartSize(box, P);
    const start = bins[0].from, end = bins[bins.length - 1].to + 1;
    const peak = Math.max(...bins.map((b) => b.count));
    const killFrom = Math.ceil(hp);
    const bw = plotW / bins.length, gap = bw >= 4 ? 1 : 0;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + HEIGHT + '" width="' + width + '" height="' + HEIGHT + '">';
    bins.forEach((b, i) => {
      if (!b.count) return;
      const h = Math.max(1, (b.count / peak) * plotH);
      const kill = b.from >= killFrom, counted = active !== null && i >= active;
      const cls = kill ? (active !== null && !counted ? 'bar-kill dim' : 'bar-kill') : counted ? 'bar-sum' : 'bar-miss';
      svg += '<rect class="' + cls + '" x="' + num(P.left + i * bw + gap / 2) + '" y="' + num(P.top + plotH - h) +
        '" width="' + num(Math.max(0.5, bw - gap)) + '" height="' + num(h) + '" rx="1"/>';
    });
    const baseY = P.top + plotH + 0.5;
    svg += '<line class="baseline" x1="' + P.left + '" x2="' + (width - P.right) + '" y1="' + baseY + '" y2="' + baseY + '"/>';
    svg += '<text x="' + P.left + '" y="' + (HEIGHT - 6) + '">' + fmt(min) + '</text>';
    svg += '<text x="' + (width - P.right) + '" y="' + (HEIGHT - 6) + '" text-anchor="end">' + fmt(max) + '</text>';
    if (killFrom > start && killFrom < end) {             // HP 在图的范围内才画击破线
      const ratio = (killFrom - start) / (end - start);
      svg += hpMarker(num(P.left + ratio * plotW), hp, ratio, P, baseY);
    }
    svg += '</svg>';
    box.innerHTML = svg;

    let readout = '点按或左右滑动图表，查看总伤害 ≥ 该处的概率';
    if (active !== null) {
      const x = Math.min(Math.max(bins[active].from, min), max);
      const sum = bins.slice(active).reduce((acc, b) => acc + b.count, 0);   // = 1 − P(总伤害 ≤ x − 1)
      readout = '总伤害 ≥ ' + fmt(x) + ' 的概率：' + formatShare(sum, total) + '（即 HP 为 ' + fmt(x) + ' 时的击破率）';
    }
    $('readout').textContent = readout;
  }

  /** 击破概率曲线：总伤害 >= X 的概率（HP 为 X 时的击破率）；点按处现场精确计算，不是从曲线上读 */
  function drawCurve(box) {
    const s = chartState;
    if (!s.points) s.points = K.curve(prep, s.hp, CURVE_SEGMENTS);
    const { points, hp, kills, total, min, max } = s;
    const P = PAD_CURVE, { width, plotW, plotH } = chartSize(box, P);
    const x0 = points[0].x, x1 = points[points.length - 1].x;      // 最低总伤害 ~ 最高总伤害 + 1
    const xOf = (v) => P.left + ((v - x0) / (x1 - x0)) * plotW;
    const yOf = (count) => P.top + (1 - count / total) * plotH;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + HEIGHT + '" width="' + width + '" height="' + HEIGHT + '">';
    [1, 0.5, 0].forEach((p) => {                          // 纵轴刻度：100% / 50% / 0%
      const y = num(P.top + (1 - p) * plotH);
      svg += '<line class="grid" x1="' + P.left + '" x2="' + (width - P.right) + '" y1="' + y + '" y2="' + y + '"/>';
      svg += '<text x="' + (P.left - 6) + '" y="' + y + '" dy="0.35em" text-anchor="end">' + p * 100 + '%</text>';
    });
    const line = points.map((pt) => num(xOf(pt.x)) + ',' + num(yOf(pt.count))).join(' ');
    svg += '<polygon class="area" points="' + num(xOf(x0)) + ',' + num(yOf(0)) + ' ' + line + ' ' + num(xOf(x1)) + ',' + num(yOf(0)) + '"/>';
    svg += '<polyline class="curve" points="' + line + '"/>';
    svg += '<text x="' + P.left + '" y="' + (HEIGHT - 6) + '">' + fmt(min) + '</text>';
    svg += '<text x="' + (width - P.right) + '" y="' + (HEIGHT - 6) + '" text-anchor="end">' + fmt(max) + '</text>';
    const h = Math.ceil(hp);                              // 总伤害是整数：>= hp 等价于 >= ceil(hp)
    if (h > x0 && h < x1) {                               // HP 在伤害范围内：虚线，与曲线的交点高度 = 击破率
      const x = num(xOf(h));
      svg += hpMarker(x, hp, (h - x0) / (x1 - x0), P, num(yOf(0)));
      svg += '<circle class="dot" cx="' + x + '" cy="' + num(yOf(kills)) + '" r="4"/>';
    }
    let readout = '点按或左右滑动图表，查看不同 HP 时的击破率';
    if (active !== null) {
      const c = K.countAtLeast(prep, active);
      const x = num(xOf(active));
      svg += '<line class="cursor" x1="' + x + '" x2="' + x + '" y1="' + P.top + '" y2="' + num(yOf(0)) + '"/>';
      svg += '<circle class="cursor-dot" cx="' + x + '" cy="' + num(yOf(c)) + '" r="4"/>';
      readout = 'HP 为 ' + fmt(active) + ' 时，击破率 ' + formatShare(c, total);
    }
    svg += '</svg>';
    box.innerHTML = svg;
    $('readout').textContent = readout;
  }

  function pick(event) {
    if (!chartState) return;
    const rect = $('chart').getBoundingClientRect();
    let next;
    if (chartMode === 'dist') {
      const bins = chartState.bins;
      const i = Math.floor(((event.clientX - rect.left - PAD_DIST.left) / (rect.width - PAD_DIST.left - PAD_DIST.right)) * bins.length);
      next = i >= 0 && i < bins.length ? i : null;
    } else {
      const { points } = chartState;
      const t = (event.clientX - rect.left - PAD_CURVE.left) / (rect.width - PAD_CURVE.left - PAD_CURVE.right);
      const x0 = points[0].x, x1 = points[points.length - 1].x;
      next = t < -0.05 || t > 1.05 ? null : Math.round(x0 + Math.min(1, Math.max(0, t)) * (x1 - x0));
    }
    if (next !== active) { active = next; drawChart(); }
  }

  document.querySelectorAll('#chartMode button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.mode === chartMode) return;
      chartMode = b.dataset.mode;
      active = null;
      try { localStorage.setItem(CHART_KEY, chartMode); } catch (e) { /* 忽略 */ }
      drawChart();
    });
  });

  // ---------- 事件 ----------

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; update(); }, 0);   // 连续输入时合并成一次计算
  }

  inputs.forEach((el, i) => {
    el.addEventListener('input', () => { active = null; schedule(); });
    el.addEventListener('blur', () => prettify(el));
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (inputs[i + 1]) inputs[i + 1].focus(); else el.blur();
    });
  });

  $('clear').addEventListener('click', () => {
    inputs.forEach((el) => { el.value = ''; });
    active = null;
    update();
    cardInputs[0].focus();
  });

  const chart = $('chart');
  chart.addEventListener('pointerdown', pick);
  chart.addEventListener('pointermove', pick);
  chart.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && active !== null) { active = null; drawChart(); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 100);
  });

  restore();
  inputs.forEach(prettify);
  update();

  // ---------- 页签：击破概率 / 发牌概率 ----------

  const TAB_KEY = 'killprob.tab.v1';
  const views = { kill: $('viewKill'), deal: $('viewDeal') };

  function showTab(name, remember) {
    if (!views[name]) name = 'kill';
    Object.keys(views).forEach((key) => {
      views[key].hidden = key !== name;
      const tab = document.querySelector('[data-tab="' + key + '"]');
      tab.classList.toggle('on', key === name);
      tab.setAttribute('aria-selected', key === name);
    });
    if (name === 'kill') drawChart();                    // 隐藏时量不到图表宽度，切回来时重画
    if (!remember) return;
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 忽略 */ }
    history.replaceState(null, '', name === 'deal' ? '#deal' : location.pathname + location.search);
  }

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab, true));
  });
  let firstTab = location.hash === '#deal' ? 'deal' : location.hash === '#kill' ? 'kill' : null;
  if (!firstTab) { try { firstTab = localStorage.getItem(TAB_KEY); } catch (e) { /* 忽略 */ } }
  showTab(firstTab || 'kill', false);

  // 离线缓存：只在 https 或本机调试时可用（直接双击打开 index.html 时不启用，不影响计算）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    const hadController = !!navigator.serviceWorker.controller;   // 第一次安装时不提示
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) $('updateBar').hidden = false;
    });
    navigator.serviceWorker.register('sw.js')
      .then((reg) => reg.update())
      .catch(() => { /* 不影响使用 */ });
    $('updateBar').addEventListener('click', () => location.reload());
  }
})();
