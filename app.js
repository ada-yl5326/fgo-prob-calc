// 击破概率页面：伤害组（每组 4 张卡的均伤、HP、最多 5 个 AOE 其他目标、SL 次数）→ 调用 killprob.js 计算
// → 显示击破概率、SL 表、伤害分布图和击破概率曲线
(function () {
  'use strict';

  const K = window.KillProb;
  const G = window.Groups;
  const CURVE_SEGMENTS = 120;                            // 击破概率曲线约 120 段（每个点都精确计算）
  const MAX_SL = 999;
  const SL_ROWS = 5;                                     // SL 表至少列出 0 ~ 5 次
  const MAX_AOE = 5;                                     // AOE 其他目标最多 5 个

  const $ = (id) => document.getElementById(id);
  const cardInputs = [0, 1, 2, 3].map((i) => $('card' + i));
  const hpInput = $('hp');
  const slInput = $('sl');
  const inputs = cardInputs.concat(hpInput, slInput);
  const fields = [0, 1, 2, 3, 4, 5].map((i) => $('field' + i));
  const aoeInputs = () => Array.from($('aoeList').querySelectorAll('input'));
  const orderedInputs = () => cardInputs.concat(hpInput, aoeInputs(), slInput);   // 按 Enter 跳到下一格的顺序

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

  function hintOn(field, text, invalid) {
    const hint = field.querySelector('.field-hint');
    hint.textContent = text || hint.dataset.default || '';
    field.classList.toggle('invalid', !!invalid);
  }
  const setHint = (i, text, invalid) => hintOn(fields[i], text, invalid);

  /** 一张卡的伤害范围提示，例如「65,160 ~ 79,567」 */
  function rangeText(avg) {
    const o = K.cardOutcomes(avg);
    return fmt(o[0]) + ' ~ ' + fmt(o[o.length - 1]);
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

  /** AOE 目标：一张卡（群体伤害）的 200 个随机数里，伤害 >= HP 的个数 */
  const aoeKills = (avg, hp) => K.cardOutcomes(avg).filter((x) => x >= hp).length;

  /**
   * 算一个伤害组：返回 { status: 'ok', single, final, fail, sl, kills, total, prep, hp, avgs, aoeCount, aoeFactor }
   * 或 { status: 'idle' | 'error', message, parsed }。
   * 有 AOE 其他目标时：每个目标单独抽随机数，全部击破才算，单次击破率 = 主目标 × 各 AOE 目标；SL 按单次击破率算
   */
  function evaluate(data) {
    const cards = data.cards.map(parse), hp = parse(data.hp), sl = parseSL(data.sl);
    const aoe = (data.aoe || []).map((a) => ({ dmg: parse(a.dmg), hp: parse(a.hp) }));
    const aoeParts = aoe.map((a) => (a.dmg.error || a.hp.error || a.dmg.empty || a.hp.empty ? null
      : { kills: aoeKills(a.dmg.value, a.hp.value), total: K.RAND_COUNT }));
    const parsed = { cards, hp, sl, aoe, aoeParts };
    const aoeError = aoe.some((a) => a.dmg.error || a.hp.error);
    const cardsOk = !cards.some((r) => r.error) && !cards.every((r) => r.empty);
    const avgs = cards.map((r) => r.value);
    const prep = cardsOk ? prepared(avgs) : null;      // 均伤填好了就先算总伤害范围、平均（不用等 HP）
    if (!cardsOk || hp.error || sl.error || aoeError) {
      if (cards.every((r) => r.empty) && !cards.some((r) => r.error) && !hp.error && !sl.error && !aoeError) return { status: 'idle', message: '输入均伤和 HP 后自动计算', parsed };
      return { status: 'error', message: '请检查标红的输入', parsed, prep };
    }
    if (hp.empty) return { status: 'idle', message: '再输入 HP 就能算出击破概率', parsed, prep };
    const half = aoe.findIndex((a) => a.dmg.empty !== a.hp.empty);   // 只填了一半的 AOE 目标（两格都空的不算）
    if (half >= 0) return { status: 'idle', message: 'AOE 目标 ' + (half + 1) + ' 还要填' + (aoe[half].dmg.empty ? '群体伤害' : '敌方 HP'), parsed, prep };
    const kills = K.countAtLeast(prep, hp.value);
    const others = aoeParts.filter(Boolean);
    const t = K.turnRate([{ kills, total: prep.total }].concat(others), sl.value);
    const aoeFactor = others.reduce((s, q) => s * (q.kills / q.total), 1);
    return { status: 'ok', single: t.single, final: t.final, fail: t.fail, sl: sl.value, kills, total: prep.total, prep, hp: hp.value, avgs, parsed,
      aoeCount: others.length, aoeFactor };
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
    const aoe = (Array.isArray(raw.aoe) ? raw.aoe : []).filter((a) => a && typeof a === 'object').slice(0, MAX_AOE)
      .map((a) => ({ dmg: str(a.dmg), hp: str(a.hp) }));
    return { cards, hp: str(raw.hp), sl: str(raw.sl), aoe };
  }

  const store = new G.GroupStore({
    key: 'killprob.kill.v2', label: '伤害组', idPrefix: 'k',
    naming: (n) => '伤害组' + n,
    create: () => ({ cards: ['', '', '', ''], hp: '', sl: '', aoe: [] }),
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
    renderAoe(d.aoe);
    orderedInputs().forEach(prettify);
  }

  // ---------- AOE 其他目标：每行（群体伤害，敌方 HP） ----------

  function aoeField(i, key, name, placeholder) {
    return '<label class="field" data-field="' + key + '"><span class="field-name">' + name + '</span>' +
      '<input type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-row="' + i + '" data-key="' + key + '" placeholder="' + placeholder + '">' +
      '<span class="field-hint"></span></label>';
  }

  function renderAoe(list) {
    $('aoeList').innerHTML = list.map((a, i) =>
      '<div class="aoe-row"><div class="aoe-row-head"><span class="field-name">AOE 目标 ' + (i + 1) + '</span>' +
      '<button type="button" class="aoe-remove" data-remove="' + i + '" aria-label="删除 AOE 目标 ' + (i + 1) + '">×</button></div>' +
      '<div class="cards">' + aoeField(i, 'dmg', '群体伤害', '均伤') + aoeField(i, 'hp', '敌方 HP', '击破血量') + '</div></div>').join('');
    aoeInputs().forEach((el) => { el.value = list[el.dataset.row][el.dataset.key]; });
    $('aoeAdd').disabled = list.length >= MAX_AOE;
    $('aoeAdd').textContent = list.length >= MAX_AOE ? '最多 ' + MAX_AOE + ' 个 AOE 目标' : '＋ AOE 其他目标';
  }

  /** AOE 各行的提示：群体伤害的范围、这个目标的击破率 */
  function aoeHints(parsed) {
    $('aoeList').querySelectorAll('.aoe-row').forEach((row, i) => {
      const a = parsed.aoe[i], part = parsed.aoeParts[i];
      if (!a) return;
      const fd = row.querySelector('[data-field="dmg"]'), fh = row.querySelector('[data-field="hp"]');
      if (a.dmg.error) hintOn(fd, a.dmg.error, true);
      else hintOn(fd, a.dmg.empty ? '' : rangeText(a.dmg.value));
      if (a.hp.error) hintOn(fh, a.hp.error, true);
      else hintOn(fh, part ? '击破率 ' + formatShort(part.kills / part.total) : '');
    });
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
      else setHint(i, rangeText(c.value));
    });
    setHint(4, hp.error, !!hp.error);
    setHint(5, sl.error, !!sl.error);
    aoeHints(r.parsed);
    if (r.status !== 'ok') return showIdle(r.message, r.prep);

    const { prep, kills } = r;
    $('probLabel').textContent = r.sl ? '击破概率（SL ' + r.sl + ' 次）' : '击破概率';
    $('prob').textContent = formatPct(r.final);
    $('prob').classList.remove('idle');
    $('meter').hidden = false;
    $('meterFill').style.width = r.final * 100 + '%';

    const lines = [];
    if (r.aoeCount) {                                    // 单次击破率 = 主目标 × 各 AOE 目标
      const parts = r.parsed.aoeParts.map((q, i) => (q ? ' × AOE ' + (i + 1) + ' ' + formatShort(q.kills / q.total) : '')).join('');
      lines.push((r.sl ? '单次击破率 ' + formatPct(r.single) : '击破率') + ' = 主目标 ' + formatShort(kills / prep.total) + parts);
      if (r.sl) lines.push('失败后可以重来 ' + r.sl + ' 次');
    } else if (r.sl) lines.push('单次击破率 ' + formatPct(r.single) + '，失败后可以重来 ' + r.sl + ' 次');
    const freq = frequencyText(r.final, r.fail, '击破', '失败');
    if (freq) lines.push(freq);
    const dmg = damageLines(prep, r.hp);
    if (r.aoeCount) dmg[0] = '主目标' + dmg[0];
    $('note').innerHTML = noteHtml(lines.concat(dmg));

    renderSLTable(r);

    $('legendKill').textContent = (r.aoeCount ? '主目标击破 ' : '击破 ') + formatShort(kills / prep.total);
    $('legendMiss').textContent = '未击破 ' + formatShort(1 - kills / prep.total);
    $('chartPanel').hidden = false;
    chartState = { hp: r.hp, sl: r.sl, kills, total: prep.total, min: prep.min, max: prep.max, prep, bins: null, points: null,
      aoeCount: r.aoeCount, aoe: r.aoeFactor };
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
    $('chartCaption').textContent = caption() +
      (chartMode === 'curve' && chartState && chartState.sl ? '；紫色是 SL ' + chartState.sl + ' 次后的击破率' : '');
    const box = $('chart');
    if (!chartState) { box.innerHTML = ''; return; }
    if (chartMode === 'dist') drawDistribution(box);
    else drawCurve(box);
  }

  /** 有 AOE 目标时：图表画的是主目标的总伤害；曲线高度乘上 AOE 目标的击破率，即主目标 HP 为 X 时本回合的击破率 */
  function caption() {
    const s = chartState;
    if (!s || !s.aoeCount) return CAPTIONS[chartMode];
    if (chartMode === 'dist') return CAPTIONS.dist.replace('总伤害', '主目标总伤害');
    if (s.aoe >= 1) return CAPTIONS.curve.replace('总伤害', '主目标总伤害').replace('HP 为 X', '主目标 HP 为 X');
    return '曲线高度 = 主目标 HP 为 X 时本回合的击破率（主目标的击破率 × AOE 目标的 ' + formatShort(s.aoe) + '）；虚线是现在的 HP';
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
      if (s.aoeCount && s.aoe < 1) {
        const turn = (sum / total) * s.aoe;
        readout = '主目标总伤害 ≥ ' + fmt(x) + ' 的概率：' + formatShort(sum / total) + '（主目标 HP 为 ' + fmt(x) + ' 时，本回合击破率 ' +
          formatShort(turn) + slSuffix(turn, s.sl, '，') + '）';
      } else {
        readout = (s.aoeCount ? '主目标' : '') + '总伤害 ≥ ' + fmt(x) + ' 的概率：' + formatShort(sum / total) + '（即 HP 为 ' + fmt(x) + ' 时的击破率' +
          slSuffix(sum / total, s.sl, '；') + '）';
      }
    }
    $('readout').textContent = readout;
  }

  /** 纵轴上限：不小于 v 的 1 / 2 / 2.5 / 5 × 10^k，最多 100% */
  function niceTop(v) {
    if (!(v > 0) || v >= 0.5) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    return [1, 2, 2.5, 5, 10].map((m) => m * e).find((t) => t >= v * (1 - 1e-12));
  }
  const pctLabel = (p) => Number((p * 100).toPrecision(3)) + '%';

  /** 击破概率曲线：总伤害 >= X 的概率（HP 为 X 时的击破率）；SL > 0 时加画 SL 后的曲线。点按处现场精确计算 */
  function drawCurve(box) {
    const s = chartState;
    if (!s.points) s.points = K.curve(s.prep, s.hp, CURVE_SEGMENTS);
    const { points, hp, kills, min, max, sl } = s;
    const total = s.total / s.aoe;                       // 有 AOE 目标时，高度 = 主目标击破率 × AOE 目标的击破率
    // 纵轴上限 = 曲线最高点（主目标必定击破时的本回合击破率，含 SL），取整到 1 / 2 / 2.5 / 5 × 10^k；没有 AOE 目标时就是 100%
    const top = niceTop(sl ? withSL(s.aoe, sl) : s.aoe);
    const ticks = [top, top / 2, 0].map((p) => ({ p, label: pctLabel(p) }));
    const P = Object.assign({}, PAD_CURVE, { left: Math.max(PAD_CURVE.left, 8 + 6.5 * Math.max(...ticks.map((k) => k.label.length))) });
    const { width, plotW, plotH } = chartSize(box, P);
    s.curveLeft = P.left;                                 // 点按时换算横坐标用
    const x0 = points[0].x, x1 = points[points.length - 1].x;      // 最低总伤害 ~ 最高总伤害 + 1
    const xOf = (v) => P.left + ((v - x0) / (x1 - x0)) * plotW;
    const yOf = (p) => P.top + (1 - p / top) * plotH;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + HEIGHT + '" width="' + width + '" height="' + HEIGHT + '">';
    ticks.forEach(({ p, label }) => {                    // 纵轴刻度：上限 / 一半 / 0%（通常是 100% / 50% / 0%）
      const y = num(yOf(p));
      svg += '<line class="grid" x1="' + P.left + '" x2="' + (width - P.right) + '" y1="' + y + '" y2="' + y + '"/>';
      svg += '<text x="' + (P.left - 6) + '" y="' + y + '" dy="0.35em" text-anchor="end">' + label + '</text>';
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
      const p = s.aoe > 0 ? K.countAtLeast(s.prep, active) / total : 0;
      const x = num(xOf(active));
      svg += '<line class="cursor" x1="' + x + '" x2="' + x + '" y1="' + P.top + '" y2="' + num(yOf(0)) + '"/>';
      svg += '<circle class="cursor-dot" cx="' + x + '" cy="' + num(yOf(p)) + '" r="4"/>';
      if (sl) svg += '<circle class="cursor-dot" cx="' + x + '" cy="' + num(yOf(withSL(p, sl))) + '" r="4"/>';
      readout = (s.aoeCount ? '主目标 HP 为 ' + fmt(active) + ' 时，本回合击破率 ' : 'HP 为 ' + fmt(active) + ' 时，击破率 ') +
        formatShort(p) + slSuffix(p, sl, '，');
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
      const left = chartState.curveLeft || PAD_CURVE.left;
      const t = (event.clientX - rect.left - left) / (rect.width - left - PAD_CURVE.right);
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

  /** Enter：跳到下一格（最后一格时收起键盘） */
  function enterNext(e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const list = orderedInputs(), next = list[list.indexOf(e.target) + 1];
    if (next) next.focus(); else e.target.blur();
  }

  inputs.forEach((el) => {
    el.addEventListener('input', () => { active = null; saveInputs(); schedule(); });
    el.addEventListener('blur', () => prettify(el));
    el.addEventListener('keydown', enterNext);
  });

  const aoeList = $('aoeList');
  aoeList.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset.key) return;
    store.active().data.aoe[Number(el.dataset.row)][el.dataset.key] = el.value;
    active = null;
    store.changed();
    schedule();
  });
  aoeList.addEventListener('focusout', (e) => { if (e.target.dataset.key) prettify(e.target); });
  aoeList.addEventListener('keydown', enterNext);
  aoeList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    store.active().data.aoe.splice(Number(b.dataset.remove), 1);
    renderAoe(store.active().data.aoe);
    active = null;
    store.changed();
    update();
  });
  $('aoeAdd').addEventListener('click', () => {
    const list = store.active().data.aoe;
    if (list.length >= MAX_AOE) return;
    list.push({ dmg: '', hp: '' });
    renderAoe(list);
    store.changed();
    update();
    aoeList.querySelector('.aoe-row:last-child input').focus();
  });

  $('clear').addEventListener('click', () => {
    inputs.forEach((el) => { el.value = ''; });
    store.active().data.aoe = [];
    renderAoe([]);
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
