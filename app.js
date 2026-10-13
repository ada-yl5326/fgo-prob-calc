// 网页界面：读取输入 → 调用 killprob.js 计算 → 显示击破概率和总伤害分布图
(function () {
  'use strict';

  const K = window.KillProb;
  const STORAGE_KEY = 'killprob.inputs.v1';
  const MAX_BINS = 48;                                   // 分布图最多约 48 根柱子

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
    chartState = { bins: K.histogram(prep, hp.value, MAX_BINS), hp: hp.value, total: prep.total, min: prep.min, max: prep.max };
    drawChart();
  }

  // ---------- 分布图 ----------

  const PAD = { left: 6, right: 6, top: 22, bottom: 22 };
  const HEIGHT = 170;
  let activeBin = -1;

  function drawChart() {
    const box = $('chart');
    if (!chartState) { box.innerHTML = ''; return; }
    const { bins, hp, total, min, max } = chartState;
    const width = Math.max(240, box.clientWidth || 320);
    const plotW = width - PAD.left - PAD.right, plotH = HEIGHT - PAD.top - PAD.bottom;
    const start = bins[0].from, end = bins[bins.length - 1].to + 1;
    const xOf = (v) => PAD.left + ((v - start) / (end - start)) * plotW;
    const peak = Math.max(...bins.map((b) => b.count));
    const killFrom = Math.ceil(hp);
    const bw = plotW / bins.length, gap = bw >= 4 ? 1 : 0;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + HEIGHT + '" width="' + width + '" height="' + HEIGHT + '">';
    bins.forEach((b, i) => {
      if (!b.count) return;
      const h = Math.max(1, (b.count / peak) * plotH);
      const cls = (b.from >= killFrom ? 'bar-kill' : 'bar-miss') + (i === activeBin ? ' active' : '');
      svg += '<rect class="' + cls + '" x="' + (PAD.left + i * bw + gap / 2).toFixed(2) + '" y="' + (PAD.top + plotH - h).toFixed(2) +
        '" width="' + Math.max(0.5, bw - gap).toFixed(2) + '" height="' + h.toFixed(2) + '" rx="1"/>';
    });
    const baseY = PAD.top + plotH + 0.5;
    svg += '<line class="baseline" x1="' + PAD.left + '" x2="' + (width - PAD.right) + '" y1="' + baseY + '" y2="' + baseY + '"/>';
    svg += '<text x="' + PAD.left + '" y="' + (HEIGHT - 6) + '">' + fmt(min) + '</text>';
    svg += '<text x="' + (width - PAD.right) + '" y="' + (HEIGHT - 6) + '" text-anchor="end">' + fmt(max) + '</text>';

    if (killFrom > start && killFrom < end) {             // HP 在图的范围内才画击破线
      const x = xOf(killFrom).toFixed(2);
      svg += '<line class="hp-line" x1="' + x + '" x2="' + x + '" y1="' + (PAD.top - 4) + '" y2="' + baseY + '"/>';
      const ratio = (killFrom - start) / (end - start);
      const anchor = ratio < 0.2 ? 'start' : ratio > 0.8 ? 'end' : 'middle';
      svg += '<text class="hp-label" x="' + x + '" y="' + (PAD.top - 8) + '" text-anchor="' + anchor + '">HP ' + fmt(hp) + '</text>';
    }
    svg += '</svg>';
    box.innerHTML = svg;

    const b = bins[activeBin];
    $('readout').textContent = b
      ? fmt(b.from) + (b.to > b.from ? ' ~ ' + fmt(b.to) : '') + '：' + formatShare(b.count, total) + (b.from >= killFrom ? '（击破）' : '（未击破）')
      : '点按或左右滑动图表，查看各伤害区间的概率';
  }

  function pickBin(event) {
    if (!chartState) return;
    const rect = $('chart').getBoundingClientRect();
    const plotW = rect.width - PAD.left - PAD.right;
    const i = Math.floor(((event.clientX - rect.left - PAD.left) / plotW) * chartState.bins.length);
    const next = i >= 0 && i < chartState.bins.length ? i : -1;
    if (next !== activeBin) { activeBin = next; drawChart(); }
  }

  // ---------- 事件 ----------

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; update(); }, 0);   // 连续输入时合并成一次计算
  }

  inputs.forEach((el, i) => {
    el.addEventListener('input', () => { activeBin = -1; schedule(); });
    el.addEventListener('blur', () => prettify(el));
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (inputs[i + 1]) inputs[i + 1].focus(); else el.blur();
    });
  });

  $('clear').addEventListener('click', () => {
    inputs.forEach((el) => { el.value = ''; });
    activeBin = -1;
    update();
    cardInputs[0].focus();
  });

  const chart = $('chart');
  chart.addEventListener('pointerdown', pickBin);
  chart.addEventListener('pointermove', pickBin);
  chart.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && activeBin !== -1) { activeBin = -1; drawChart(); }
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
