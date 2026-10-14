// 击破概率页面：伤害组（每组 4 张卡的均伤、HP、SL 次数）→ 调用 killprob.js 计算 → 显示击破概率、SL 表、伤害分布图和击破概率曲线
(function () {
  'use strict';

  const K = window.KillProb;
  const G = window.Groups;
  const CURVE_SEGMENTS = 120;                            // 击破概率曲线约 120 段（每个点都精确计算）
  const MAX_SL = 999;
  const SL_ROWS = 5;                                     // SL 表至少列出 0 ~ 5 次

  const $ = (id) => document.getElementById(id);
  const cardInputs = [0, 1, 2, 3].map((i) => $('card' + i));
  const hpInput = $('hp');
  const slInput = $('sl');
  const inputs = cardInputs.concat(hpInput, slInput);
  const fields = [0, 1, 2, 3, 4, 5].map((i) => $('field' + i));

  const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmt = (n) => intFormat.format(n);

  // ---------- 输入 ----------

  /** 去掉千分位逗号、空格，全角数字和小数点转半角 */
  function normalize(text) {
    return String(text)
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

  /** SL 次数：空 = 0；只能是 0 ~ 999 的整数 */
  function parseSL(text) {
    const t = normalize(text);
    if (t === '') return { empty: true, value: 0 };
    if (!/^\d+$/.test(t)) return { error: '请输入整数' };
    const v = Number(t);
    return v > MAX_SL ? { error: '最多 ' + MAX_SL + ' 次' } : { value: v };
  }

  /** 离开输入框时加上千分位逗号（小数部分保持原样，不改变数值） */
  function prettify(el) {
    if (el === slInput) return;
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

  // ---------- 计算（击破概率页和综合页共用） ----------

  const withSL = K.withSL;                               // SL n 次后的击破率 = 1 − (1 − p)^(n+1)

  const prepCache = new Map();                           // 均伤 → 预处理结果（只和均伤有关，改 HP 时不用重算）
  function prepared(avgs) {
    const key = avgs.join('|');
    let prep = prepCache.get(key);
    if (!prep) {
      prep = K.prepare(avgs);
      prepCache.set(key, prep);
      if (prepCache.size > 12) prepCache.delete(prepCache.keys().next().value);
    }
    return prep;
  }

  /**
   * 算一个伤害组：返回 { status: 'ok', single, final, sl, kills, total, prep, hp, avgs }
   * 或 { status: 'idle' | 'error', message, parsed }
   */
  function evaluate(data) {
    const cards = data.cards.map(parse), hp = parse(data.hp), sl = parseSL(data.sl);
    const parsed = { cards, hp, sl };
    const cardsOk = !cards.some((r) => r.error) && !cards.every((r) => r.empty);
    const avgs = cards.map((r) => r.value);
    const prep = cardsOk ? prepared(avgs) : null;      // 均伤填好了就先算总伤害范围、平均（不用等 HP）
    if (!cardsOk || hp.error || sl.error) {
      if (cards.every((r) => r.empty) && !cards.some((r) => r.error) && !hp.error && !sl.error) return { status: 'idle', message: '输入均伤和 HP 后自动计算', parsed };
      return { status: 'error', message: '请检查标红的输入', parsed, prep };
    }
    if (hp.empty) return { status: 'idle', message: '再输入 HP 就能算出击破概率', parsed, prep };
    const kills = K.countAtLeast(prep, hp.value);
    const single = kills / prep.total;
    const fail = Math.pow((prep.total - kills) / prep.total, sl.value + 1);   // 失败率单独算，击破率接近 100% 时不丢精度
    return { status: 'ok', single, final: kills === prep.total ? 1 : withSL(single, sl.value), fail, sl: sl.value, kills, total: prep.total, prep, hp: hp.value, avgs, parsed };
  }

  /** 百分比，保留 4 位小数；接近 0 或 100% 时不写成 0% / 100% */
  function formatPct(p) {
    if (p >= 1) return '100%';
    if (p <= 0) return '0%';
    const v = p * 100;
    if (v >= 99.99995) return '> 99.9999%';
    if (v < 0.00005) return '< 0.0001%';
    return v.toFixed(4) + '%';
  }

  /** 「约每 x 次」里的 x：小的保留小数，大的取整，特别大的用「亿」或科学计数 */
  function timesText(x) {
    if (x < 10) return x.toFixed(2);
    if (x < 100) return x.toFixed(1);
    if (x < 1e8) return fmt(Math.round(x));
    if (x < 1e16) return (x / 1e8).toPrecision(3) + ' 亿';
    const e = Math.floor(Math.log10(x));
    return (x / Math.pow(10, e)).toFixed(2) + ' × 10^' + e;
  }

  /**
   * 成功、失败两种频率：「约每 x 次击破 1 次，约每 y 次失败 1 次」（x = 1/p，y = 1/(1−p)）。
   * fail 是失败概率，另外传入是为了 p 很接近 1 时不丢精度；p 为 0 或 1 时返回 ''
   */
  function frequencyText(p, fail, yes, no) {
    if (!(p > 0) || !(fail > 0)) return '';
    const every = (x) => { const t = timesText(x); return '约每 ' + t + (t.endsWith('亿') ? '次' : ' 次'); };
    return every(1 / p) + yes + ' 1 次，' + every(1 / fail) + no + ' 1 次';
  }

  /** 百分比，保留 2 位小数（图表、简短显示） */
  function formatShort(p) {
    if (p >= 1) return '100%';
    if (p <= 0) return '0%';
    const v = p * 100;
    if (v < 0.01) return '< 0.01%';
    if (v > 99.99) return '> 99.99%';
    return v.toFixed(2) + '%';
  }

  // ---------- 伤害组 ----------

  function cleanData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const str = (v) => (typeof v === 'string' ? v : '');
    const cards = Array.isArray(raw.cards) ? raw.cards.slice(0, 4).map(str) : [];
    while (cards.length < 4) cards.push('');
    return { cards, hp: str(raw.hp), sl: str(raw.sl) };
  }

  const store = new G.GroupStore({
    key: 'killprob.kill.v2', label: '伤害组', idPrefix: 'k',
    naming: (n) => '伤害组' + n,
    create: () => ({ cards: ['', '', '', ''], hp: '', sl: '' }),
    clean: cleanData,
    legacy: () => {                                      // v0.3 只有一组：[4 张卡, HP]
      try {
        const old = JSON.parse(localStorage.getItem('killprob.inputs.v1') || 'null');
        if (Array.isArray(old)) return cleanData({ cards: old.slice(0, 4), hp: old[4] });
      } catch (e) { /* 忽略 */ }
      return null;
    },
  });

  function summary(g) {
    const r = evaluate(g.data);
    return r.status === 'ok' ? formatShort(r.final) : '未完成';
  }

  // 由 main.js 读取：综合页用
  window.KillApp = { store, evaluate, formatPct, formatShort, frequencyText, summary };

  function loadInputs() {
    const d = store.active().data;
    cardInputs.forEach((el, i) => { el.value = d.cards[i]; });
    hpInput.value = d.hp;
    slInput.value = d.sl;
    inputs.forEach(prettify);
  }

  function saveInputs() {
    const d = store.active().data;
    cardInputs.forEach((el, i) => { d.cards[i] = el.value; });
    d.hp = hpInput.value;
    d.sl = slInput.value;
    store.changed();
  }

  // ---------- 显示 ----------

  let current = null;                                    // 最近一次的计算结果（图表用）
  let chartState = null;                                 // 最近一次图表的数据（窗口大小变化时重画）

  /** 总伤害范围、平均（只和均伤有关）；有 HP 时再和 HP 比较 */
  function damageLines(prep, hp) {
    const lines = [];
    if (hp === null) lines.push('总伤害 ' + fmt(prep.min) + ' ~ ' + fmt(prep.max));
    else if (prep.min >= hp) lines.push('最低伤害 ' + fmt(prep.min) + ' ≥ HP，必定击破');
    else if (prep.max < hp) lines.push('最高伤害 ' + fmt(prep.max) + ' < HP，无法击破');
    else lines.push('总伤害 ' + fmt(prep.min) + ' ~ ' + fmt(prep.max));
    lines.push('平均 ' + fmt(prep.mean) + (hp > 0 ? '，是 HP 的 ' + ((prep.mean / hp) * 100).toFixed(2) + '%' : ''));
    return lines;
  }

  const noteHtml = (lines) => lines.map((s) => '<div>' + s + '</div>').join('');

  function showIdle(message, prep) {
    $('probLabel').textContent = '击破概率';
    $('prob').textContent = '—';
    $('prob').classList.add('idle');
    $('meter').hidden = true;
    $('note').innerHTML = noteHtml((prep ? damageLines(prep, null) : []).concat(message));
    $('chartPanel').hidden = true;
    $('slPanel').hidden = true;
    chartState = null;
  }

  function update() {
    const r = evaluate(store.active().data);
    current = r;
    const { cards, hp, sl } = r.parsed;
    cards.forEach((c, i) => {
      if (c.error) setHint(i, c.error, true);
      else if (c.empty) setHint(i, '');
      else {
        const o = K.cardOutcomes(c.value);
        setHint(i, fmt(o[0]) + ' ~ ' + fmt(o[o.length - 1]));
      }
    });
    setHint(4, hp.error, !!hp.error);
    setHint(5, sl.error, !!sl.error);
    if (r.status !== 'ok') return showIdle(r.message, r.prep);

    const { prep, kills } = r;
    $('probLabel').textContent = r.sl ? '击破概率（SL ' + r.sl + ' 次）' : '击破概率';
    $('prob').textContent = formatPct(r.final);
    $('prob').classList.remove('idle');
    $('meter').hidden = false;
    $('meterFill').style.width = r.final * 100 + '%';

    const lines = [];
    if (r.sl) lines.push('单次击破率 ' + formatPct(r.single) + '，失败后可以重来 ' + r.sl + ' 次');
    const freq = frequencyText(r.final, r.fail, '击破', '失败');
    if (freq) lines.push(freq);
    $('note').innerHTML = noteHtml(lines.concat(damageLines(prep, r.hp)));

    renderSLTable(r);

    $('legendKill').textContent = '击破 ' + formatShort(kills / prep.total);
    $('legendMiss').textContent = '未击破 ' + formatShort(1 - kills / prep.total);
    $('chartPanel').hidden = false;
    chartState = { hp: r.hp, sl: r.sl, kills, total: prep.total, min: prep.min, max: prep.max, prep, bins: null, points: null };
    drawChart();
  }

  /** SL 次数与击破率：0 ~ 5 次（SL 更多时加上当前次数） */
  function renderSLTable(r) {
    const rows = [];
    for (let n = 0; n <= SL_ROWS; n++) rows.push(n);
    if (r.sl > SL_ROWS) rows.push(r.sl);
    const p = r.single;
    $('slPanel').hidden = p <= 0 || p >= 1;
    if (p <= 0 || p >= 1) return;
    $('slTable').innerHTML = '<thead><tr><th>SL 次数</th><th>机会</th><th>击破率</th><th>比不 SL 提高</th></tr></thead><tbody>' +
      rows.map((n) => {
        const q = withSL(p, n);
        return '<tr' + (n === r.sl ? ' class="on"' : '') + '><td>' + n + (n === r.sl ? ' ←' : '') + '</td><td>' + (n + 1) + ' 次</td><td>' +
          formatPct(q) + '</td><td>' + (n ? '+' + ((q - p) * 100).toFixed(2) + ' 个百分点' : '—') + '</td></tr>';
      }).join('') + '</tbody>';
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
    $('legendCurve').hidden = chartMode !== 'curve' || !chartState || !chartState.sl;
    if (chartState && chartState.sl) $('legendSL').textContent = 'SL ' + chartState.sl + ' 次后';
    $('chartCaption').textContent = CAPTIONS[chartMode] +
      (chartMode === 'curve' && chartState && chartState.sl ? '；紫色是 SL ' + chartState.sl + ' 次后的击破率' : '');
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

  /** 「；SL n 次后 x%」：读数里附带 SL 后的击破率 */
  function slSuffix(p, sl, sep) {
    return sl ? sep + 'SL ' + sl + ' 次后 ' + formatShort(withSL(p, sl)) : '';
  }

  /**
   * 伤害分布：柱子 = 落在这一段的概率。点按某段时显示「总伤害 >= 该段起点」的概率（HP 为该处时的击破率）：
   * 该段到 HP 之间的未击破部分标黄，HP 右边的蓝色照常显示，两者合起来就是这个概率；
   * 点在蓝色区域里时，点按处左边的蓝色变淡（不计入）
   */
  function drawDistribution(box) {
    const s = chartState;
    if (!s.bins) s.bins = K.histogram(s.prep, s.hp, MAX_BINS);
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
      readout = '总伤害 ≥ ' + fmt(x) + ' 的概率：' + formatShort(sum / total) + '（即 HP 为 ' + fmt(x) + ' 时的击破率' +
        slSuffix(sum / total, s.sl, '；') + '）';
    }
    $('readout').textContent = readout;
  }

  /** 击破概率曲线：总伤害 >= X 的概率（HP 为 X 时的击破率）；SL > 0 时加画 SL 后的曲线。点按处现场精确计算 */
  function drawCurve(box) {
    const s = chartState;
    if (!s.points) s.points = K.curve(s.prep, s.hp, CURVE_SEGMENTS);
    const { points, hp, kills, total, min, max, sl } = s;
    const P = PAD_CURVE, { width, plotW, plotH } = chartSize(box, P);
    const x0 = points[0].x, x1 = points[points.length - 1].x;      // 最低总伤害 ~ 最高总伤害 + 1
    const xOf = (v) => P.left + ((v - x0) / (x1 - x0)) * plotW;
    const yOf = (p) => P.top + (1 - p) * plotH;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + HEIGHT + '" width="' + width + '" height="' + HEIGHT + '">';
    [1, 0.5, 0].forEach((p) => {                          // 纵轴刻度：100% / 50% / 0%
      const y = num(yOf(p));
      svg += '<line class="grid" x1="' + P.left + '" x2="' + (width - P.right) + '" y1="' + y + '" y2="' + y + '"/>';
      svg += '<text x="' + (P.left - 6) + '" y="' + y + '" dy="0.35em" text-anchor="end">' + p * 100 + '%</text>';
    });
    const line = points.map((pt) => num(xOf(pt.x)) + ',' + num(yOf(pt.count / total))).join(' ');
    svg += '<polygon class="area" points="' + num(xOf(x0)) + ',' + num(yOf(0)) + ' ' + line + ' ' + num(xOf(x1)) + ',' + num(yOf(0)) + '"/>';
    svg += '<polyline class="curve" points="' + line + '"/>';
    if (sl) {
      const lineSL = points.map((pt) => num(xOf(pt.x)) + ',' + num(yOf(withSL(pt.count / total, sl)))).join(' ');
      svg += '<polyline class="curve-sl" points="' + lineSL + '"/>';
    }
    svg += '<text x="' + P.left + '" y="' + (HEIGHT - 6) + '">' + fmt(min) + '</text>';
    svg += '<text x="' + (width - P.right) + '" y="' + (HEIGHT - 6) + '" text-anchor="end">' + fmt(max) + '</text>';
    const h = Math.ceil(hp);                              // 总伤害是整数：>= hp 等价于 >= ceil(hp)
    if (h > x0 && h < x1) {                               // HP 在伤害范围内：虚线，与曲线的交点高度 = 击破率
      const x = num(xOf(h));
      svg += hpMarker(x, hp, (h - x0) / (x1 - x0), P, num(yOf(0)));
      svg += '<circle class="dot" cx="' + x + '" cy="' + num(yOf(kills / total)) + '" r="4"/>';
      if (sl) svg += '<circle class="dot-sl" cx="' + x + '" cy="' + num(yOf(withSL(kills / total, sl))) + '" r="4"/>';
    }
    let readout = '点按或左右滑动图表，查看不同 HP 时的击破率';
    if (active !== null) {
      const p = K.countAtLeast(s.prep, active) / total;
      const x = num(xOf(active));
      svg += '<line class="cursor" x1="' + x + '" x2="' + x + '" y1="' + P.top + '" y2="' + num(yOf(0)) + '"/>';
      svg += '<circle class="cursor-dot" cx="' + x + '" cy="' + num(yOf(p)) + '" r="4"/>';
      if (sl) svg += '<circle class="cursor-dot" cx="' + x + '" cy="' + num(yOf(withSL(p, sl))) + '" r="4"/>';
      readout = 'HP 为 ' + fmt(active) + ' 时，击破率 ' + formatShort(p) + slSuffix(p, sl, '，');
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
    el.addEventListener('input', () => { active = null; saveInputs(); schedule(); });
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
    saveInputs();
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

  // 切换 / 新建 / 删除伤害组：把这一组的输入填回输入框
  store.onChange((reason) => {
    if (reason === 'data' || reason === 'rename') return;
    active = null;
    loadInputs();
    update();
  });
  new G.GroupBar($('killGroups'), store, { summary, onUsed: (id) => (window.ComboApp ? window.ComboApp.usage('kill', id) : 0) });

  // 页签切回来时重画（隐藏时量不到图表宽度）
  document.addEventListener('tabshow', (e) => { if (e.detail === 'kill') drawChart(); });

  loadInputs();
  update();
})();
