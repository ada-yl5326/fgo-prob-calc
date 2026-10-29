// 送人概率页面：送人组（敌人、我方从者、SL 次数）→ 在后台用 send.js 计算（send-worker.js）→ 显示送人成功率、SL 表、各从者的结果。
// 规则见《送人概率规则.md》
(function () {
  'use strict';

  const S = window.Send;
  const G = window.Groups;
  const KA = window.KillApp;
  const esc = G.escapeHtml;
  const $ = (id) => document.getElementById(id);

  const MAX_SL = 999;
  const SL_ROWS = 5;
  const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const ROLES = [['must', '要退场'], ['may', '可以退场'], ['keep', '不能退场'], ['immortal', '不会死']];
  const ROLE_NAME = Object.fromEntries(ROLES);
  const HIT_TYPES = [['B', 'B'], ['A', 'A'], ['Q', 'Q'], ['N', '普通'], ['NP', '宝具']];
  const HIT_CRIT = [['any', '不限'], ['yes', '暴击'], ['no', '不暴击']];
  const HIT_CMP = [['ge', '至少'], ['eq', '恰好'], ['le', '至多']];
  const HIT_NAME = Object.fromEntries(HIT_TYPES), CRIT_NAME = Object.fromEntries(HIT_CRIT), CMP_NAME = Object.fromEntries(HIT_CMP);
  const AIM_NAMES = ['任意目标'].concat(Array.from({ length: S.MAX_TRAITS }, (_, k) => '特性' + (k + 1)));   // 目标权重的各项
  const SLOW_MS = 150;                                   // 超过这么久还没算完才显示「计算中」

  const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmt = (n) => intFormat.format(n);

  // ---------- 输入（规则与击破概率页相同：允许小数、千分位逗号，全角数字转半角） ----------

  function normalize(text) {
    return String(text)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[．。]/g, '.')
      .replace(/[,，\s]/g, '');
  }

  function parse(text) {
    const t = normalize(text);
    if (t === '') return { empty: true };
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { error: '请输入数字' };
    return { value: Number(t) };
  }

  /** 百分比：「25」或「25%」→ 0.25 */
  function parsePct(text) {
    const r = parse(String(text).replace(/[%％]\s*$/, ''));
    if (r.error || r.empty) return r;
    return r.value > 100 ? { error: '最多 100%' } : { value: r.value / 100 };
  }

  function parseSL(text) {
    const t = normalize(text);
    if (t === '') return { empty: true, value: 0 };
    if (!/^\d+$/.test(t)) return { error: '请输入整数' };
    const v = Number(t);
    return v > MAX_SL ? { error: '最多 ' + MAX_SL + ' 次' } : { value: v };
  }

  // ---------- 送人组的数据 ----------

  function newEnemy() {
    return {
      actions: 3,
      normal: { dmg: '', aoe: false },
      crit: { on: false, dmg: '', rate: '', aoe: false },
      deck: { on: false, value: 'BBAAQ' },
      np: { on: false, at: [1], dmg: '', aoe: false },
      skill: { on: false, rate: '' },
      mult: { on: false, values: ['', '', ''] },
      aim: { on: false, values: AIM_NAMES.map(() => '') },
    };
  }

  function newHitRow() {
    return { type: 'N', crit: 'any', cmp: 'ge', n: '' };
  }

  function newServant(role) {
    return { role, hp: '', traits: AIM_NAMES.slice(1).map(() => false), taunt: false, inv: 0, guts: 0, gutsHp: [''], gutsEach: false, hits: { on: false, rows: [newHitRow()] } };
  }

  function create() {
    return { enemies: [newEnemy()], servants: [newServant('must'), newServant('immortal'), newServant('immortal')], backup: true, minOut: 0, sl: '' };
  }

  function cleanData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
    const obj = (v) => (v && typeof v === 'object' ? v : {});
    const enemies = (Array.isArray(raw.enemies) ? raw.enemies : []).slice(0, S.MAX_ENEMIES).map((e) => {
      e = obj(e);
      const n = int(e.actions, 1, S.MAX_ACTIONS, 3);
      const nm = obj(e.normal), cr = obj(e.crit), dk = obj(e.deck), np = obj(e.np), sk = obj(e.skill), mu = obj(e.mult), am = obj(e.aim);
      const at = (Array.isArray(np.at) ? np.at : [1]).filter((a) => Number.isInteger(a) && a >= 1 && a <= n);
      const mv = Array.isArray(mu.values) ? mu.values : [], av = Array.isArray(am.values) ? am.values : [];
      return {
        actions: n,
        normal: { dmg: str(nm.dmg), aoe: bool(nm.aoe, false) },
        crit: { on: bool(cr.on, false), dmg: str(cr.dmg), rate: str(cr.rate), aoe: bool(cr.aoe, false) },
        deck: { on: bool(dk.on, false), value: S.DECKS.indexOf(dk.value) >= 0 ? dk.value : 'BBAAQ' },
        np: { on: bool(np.on, false), at: Array.from(new Set(at)).sort((a, b) => a - b), dmg: str(np.dmg), aoe: bool(np.aoe, false) },
        skill: { on: bool(sk.on, false), rate: str(sk.rate) },
        mult: { on: bool(mu.on, false), values: [0, 1, 2].map((i) => str(mv[i])) },
        aim: { on: bool(am.on, false), values: AIM_NAMES.map((_, i) => str(av[i])) },
      };
    });
    const servants = (Array.isArray(raw.servants) ? raw.servants : []).slice(0, S.MAX_SERVANTS).map((s) => {
      s = obj(s);
      const guts = int(s.guts, 0, S.MAX_GUTS, 0);
      const hps = (Array.isArray(s.gutsHp) ? s.gutsHp : []).map(str);
      while (hps.length < Math.max(1, guts)) hps.push('');
      const hi = obj(s.hits), pick = (v, list, d) => (list.some(([k]) => k === v) ? v : d);
      const rows = (Array.isArray(hi.rows) ? hi.rows : []).slice(0, S.MAX_HIT_ROWS).map((r) => {
        r = obj(r);
        return { type: pick(r.type, HIT_TYPES, 'N'), crit: pick(r.crit, HIT_CRIT, 'any'), cmp: pick(r.cmp, HIT_CMP, 'ge'), n: str(r.n) };
      });
      return {
        role: ROLE_NAME[s.role] ? s.role : 'must', hp: str(s.hp), traits: AIM_NAMES.slice(1).map((_, k) => Array.isArray(s.traits) && s.traits[k] === true),
        taunt: bool(s.taunt, false),
        inv: int(s.inv, 0, S.MAX_INV, 0), guts, gutsHp: hps.slice(0, Math.max(1, guts)), gutsEach: bool(s.gutsEach, false),
        hits: { on: bool(hi.on, false), rows: rows.length ? rows : [newHitRow()] },
      };
    });
    if (!enemies.length || !servants.length) return null;
    // v1.3 以前每名从者有「被攻击权重」（按权重选目标）：权重不全相同时换成每人一个特性、每个敌人按这些特性设目标权重
    // （一开始被选中的概率不变；有人退场、战续以后按新规则改为随机目标，和以前略有不同）
    const old = (Array.isArray(raw.servants) ? raw.servants : []).slice(0, servants.length).map((s) => {
      const r = parse(str(obj(s).weight));
      return r.empty || r.error || !(r.value > 0) ? 1 : r.value;
    });
    if (old.some((w) => w !== old[0]) && !servants.some((s) => s.traits.some(Boolean)) && !enemies.some((e) => e.aim.on)) {
      servants.forEach((s, i) => { s.traits = s.traits.map((_, k) => k === i); });
      enemies.forEach((e) => { e.aim = { on: true, values: AIM_NAMES.map((_, k) => (k && k <= old.length ? String(old[k - 1]) : '')) }; });
    }
    return { enemies, servants, backup: bool(raw.backup, true), minOut: int(raw.minOut, 0, S.MAX_SERVANTS, 0), sl: str(raw.sl) };
  }

  const store = new G.GroupStore({
    key: 'killprob.send.v1', label: '送人组', idPrefix: 's',
    naming: (n) => '送人组' + n,
    create, clean: cleanData,
  });

  /** 「可以退场」的人数；他们里至少退场几人（0 = 不要求；超过「可以退场」的人数时按全部算） */
  const mayCount = (d) => d.servants.filter((s) => s.role === 'may').length;
  const minOutOf = (d) => Math.min(d.minOut || 0, mayCount(d));
  /** 有敌人设了目标权重（这时从者的特性才有用） */
  const anyAim = (d) => d.enemies.some((e) => e.aim.on);

  /** 只看受击要求：有从者开了受击要求，并且没有「要退场」「不能退场」的从者，也没有设至少退场。这时敌方均伤、我方 HP 可以不填 */
  const hitOnly = (d) => d.servants.some((s) => s.hits.on) && !d.servants.some((s) => s.role === 'must' || s.role === 'keep') && !minOutOf(d);

  /**
   * 送人组 → 计算核心的输入。只看受击要求时：均伤不填 = 0（没有伤害），「可以退场」的从者 HP 不填 = 不会退场。返回 { status: 'ok', cfg, sl } 或 { status: 'idle' | 'error', message }，
   * 另有 errors（输入框的 data-path → 错误说明）。
   */
  function build(d) {
    const errors = {};
    let typed = false, missing = null;
    const need = (label) => { if (!missing) missing = label; };
    /** 数字格：required 时空着算没填完；返回数值或 null */
    function num(path, text, label, opts) {
      opts = opts || {};
      const r = (opts.pct ? parsePct : parse)(text);
      if (r.error) { errors[path] = r.error; return null; }
      if (r.empty) {
        if (opts.required) need(label);
        return opts.def === undefined ? null : opts.def;
      }
      typed = true;
      if (opts.min !== undefined && r.value < opts.min) { errors[path] = opts.minText || '太小了'; return null; }
      return r.value;
    }
    const anyDeck = d.enemies.some((e) => e.deck.on), only = hitOnly(d), aim = anyAim(d);
    const servants = d.servants.map((s, i) => {
      const p = 'servants.' + i + '.', name = '从者 ' + (i + 1);
      const out = { role: s.role, taunt: s.taunt };
      const traits = [];
      if (aim) s.traits.forEach((on, k) => { if (on) traits.push(k + 1); });
      if (traits.length) out.traits = traits;             // 只在有用时写进去：没设时和以前的输入一样（缓存、综合页的结果照旧）
      if (s.hits.on) {
        out.hits = s.hits.rows.map((r, k) => {
          const path = p + 'hits.rows.' + k + '.n';
          if (!anyDeck && 'BAQ'.indexOf(r.type) >= 0) { errors[path] = '没有敌人开牌型，请改选普通或宝具'; return null; }
          const t = normalize(r.n);
          if (t === '') { need(name + '的受击次数'); return null; }
          typed = true;
          if (!/^\d+$/.test(t)) { errors[path] = '请输入整数'; return null; }
          if (Number(t) > S.MAX_HITS) { errors[path] = '最多 ' + S.MAX_HITS + ' 次'; return null; }
          return { type: r.type, crit: r.type === 'NP' ? 'any' : r.crit, cmp: r.cmp, n: Number(t) };
        });
      }
      if (only && s.role === 'may' && parse(s.hp).empty) out.role = 'immortal';
      else if (s.role !== 'immortal') {
        out.hp = num(p + 'hp', s.hp, name + '的 HP', { required: true, min: 1, minText: '至少 1' });
        out.inv = s.inv;
        out.guts = [];
        for (let k = 0; k < s.guts; k++) {
          const idx = s.gutsEach ? k : 0;
          out.guts.push(num(p + 'gutsHp.' + idx, s.gutsHp[idx], name + '的战续血量', { required: true, min: 1, minText: '至少 1' }));
        }
      }
      return out;
    });
    const enemies = d.enemies.map((e, j) => {
      const p = 'enemies.' + j + '.', name = '敌人 ' + (j + 1);
      const out = {
        actions: e.actions,
        normal: { dmg: num(p + 'normal.dmg', e.normal.dmg, name + '的普通攻击均伤', only ? { def: 0 } : { required: true }), aoe: e.normal.aoe },
        crit: null, np: null, deck: e.deck.on ? e.deck.value : null, skill: 0,
        mult: d.servants.map((s, i) => (e.mult.on ? num(p + 'mult.values.' + i, e.mult.values[i], '', { def: 100, pct: false }) : 100)),
      };
      if (e.crit.on) {
        out.crit = { dmg: num(p + 'crit.dmg', e.crit.dmg, name + '的暴击均伤', only ? { def: 0 } : { required: true }),
          rate: num(p + 'crit.rate', e.crit.rate, name + '的暴击率', { required: true, pct: true }), aoe: e.crit.aoe };
      }
      if (e.np.on) {
        out.np = { at: e.np.at.slice(), dmg: num(p + 'np.dmg', e.np.dmg, '', { def: 0 }), aoe: e.np.aoe };
        if (!out.np.at.length) errors[p + 'np.at'] = '选第几次行动放宝具';
      }
      if (e.skill.on) out.skill = num(p + 'skill.rate', e.skill.rate, name + '的开技能概率', { required: true, pct: true });
      if (e.aim.on) {                                    // 目标权重：空着 = 0，至少一项大于 0
        out.aim = e.aim.values.map((v, k) => num(p + 'aim.values.' + k, v, '', { def: 0 }));
        if (e.aim.values.every((v) => parse(v).empty)) need(name + '的目标权重');
        else if (out.aim.every((w) => w === 0)) errors[p + 'aim.values.0'] = '至少一项要大于 0';
      }
      return out;
    });
    const sl = parseSL(d.sl);
    if (sl.error) errors.sl = sl.error;
    const res = { errors };
    if (Object.keys(errors).length) return Object.assign(res, { status: 'error', message: '请检查标红的输入' });
    if (!typed) return Object.assign(res, { status: 'idle', message: '输入敌方均伤和我方 HP 后自动计算' });
    if (missing) return Object.assign(res, { status: 'idle', message: '还要填：' + missing });
    if (!minOutOf(d) && !d.servants.some((s) => s.role === 'must' || s.role === 'keep' || s.hits.on)) {
      return Object.assign(res, { status: 'idle', message: '至少要有一名「要退场」或「不能退场」的从者，或者设置至少退场的人数、受击要求' });
    }
    const cfg = { enemies, servants, backup: d.backup };
    if (minOutOf(d)) cfg.minOut = minOutOf(d);              // 只在生效时写进去：没设时和以前的输入完全一样（缓存、综合页的结果照旧）
    try { S.model(cfg); } catch (e) { return Object.assign(res, { status: 'error', message: e.message }); }
    return Object.assign(res, { status: 'ok', cfg, sl: sl.value });
  }

  // ---------- 后台计算 ----------
  // 页面上的计算：新的输入来了就停掉还没算完的那次。送人组列表、综合页要的结果：排队在另一个后台线程里算。
  // 结果按输入缓存（同样的输入不重算）。不支持后台线程时（例如直接双击打开网页）在页面里直接算。

  const cache = new Map();                               // JSON(cfg) → 结果
  const CACHE_SIZE = 60;

  function remember(key, result) {
    cache.set(key, result);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  }

  function makeWorker() {
    try { return new Worker('send-worker.js'); } catch (e) { return null; }
  }

  /** 一个后台线程：run(cfg) → Promise<结果>；stop() 停掉正在算的 */
  function Runner() {
    this.worker = null;
    this.seq = 0;
    this.waiting = null;
    this.broken = false;
  }
  Runner.prototype.run = function (cfg) {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const direct = () => setTimeout(() => {
        let r;
        try { r = S.run(cfg); } catch (e) { r = { error: e.message }; }
        resolve(r);
      }, 0);
      if (this.broken) { direct(); return; }
      if (!this.worker) this.worker = makeWorker();
      if (!this.worker) { this.broken = true; direct(); return; }
      this.waiting = { id, resolve, cfg };
      this.worker.onmessage = (e) => {
        if (!this.waiting || e.data.id !== this.waiting.id) return;
        const w = this.waiting;
        this.waiting = null;
        w.resolve(e.data.error ? { error: e.data.error } : e.data.result);
      };
      this.worker.onerror = (e) => {                     // 后台线程用不了：改在页面里算
        if (e && e.preventDefault) e.preventDefault();
        this.broken = true;
        this.worker = null;
        const w = this.waiting;
        this.waiting = null;
        if (w) { const c = w.cfg; setTimeout(() => { let r; try { r = S.run(c); } catch (x) { r = { error: x.message }; } w.resolve(r); }, 0); }
      };
      this.worker.postMessage({ id, cfg });
    });
  };
  Runner.prototype.stop = function () {
    if (this.waiting && this.worker) { this.worker.terminate(); this.worker = null; }
    this.waiting = null;
  };

  const pageRunner = new Runner();
  const bgRunner = new Runner();
  const queue = [];                                      // 后台排队：[{ key, cfg }]
  let bgBusy = false;

  function pump() {
    if (bgBusy || !queue.length) return;
    const job = queue.shift();
    if (cache.has(job.key)) { pump(); return; }
    bgBusy = true;
    bgRunner.run(job.cfg).then((r) => {
      remember(job.key, r);
      bgBusy = false;
      document.dispatchEvent(new CustomEvent('sendresult'));
      pump();
    });
  }

  /**
   * 一个送人组的结果（送人组列表、综合页用）：{ status: 'ok', single, final, fail, sl, result } / { status: 'pending' } /
   * { status: 'idle' | 'error', message }。还没算过时排队在后台算，算完发出 'sendresult' 事件
   */
  function resultFor(data) {
    const b = build(data);
    if (b.status !== 'ok') return b;
    const key = JSON.stringify(b.cfg), r = cache.get(key);
    if (!r) {
      if (!queue.some((q) => q.key === key)) { queue.push({ key, cfg: b.cfg }); pump(); }
      return { status: 'pending' };
    }
    return finish(r, b.sl);
  }

  /** 加上 SL：SL n 次后 = 1 − (1 − 单次)^(n+1)；失败率单独算，接近 100% 时不丢精度 */
  function finish(r, sl) {
    if (r.error) return { status: 'error', message: r.error };
    return { status: 'ok', single: r.success, final: S.withSL(r.success, sl), fail: Math.pow(r.fail, sl + 1), sl, result: r };
  }

  function summary(g) {
    const r = resultFor(g.data);
    return r.status === 'ok' ? KA.formatShort(r.final) : r.status === 'pending' ? '计算中' : '未完成';
  }

  // ---------- 画输入区 ----------

  const enemyBox = $('sendEnemies'), servantBox = $('sendServants');

  function input(path, value, placeholder, mode) {
    return '<input type="text" inputmode="' + (mode || 'decimal') + '" enterkeyhint="next" autocomplete="off" data-path="' + path +
      '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '">';
  }

  function field(path, name, value, placeholder, cls) {
    return '<label class="field' + (cls ? ' ' + cls : '') + '" data-field="' + path + '"><span class="field-name">' + name + '</span>' +
      input(path, value, placeholder) + '<span class="field-hint"></span></label>';
  }

  /** 「− n ＋」 */
  function stepper(path, n, min, max, label) {
    return '<span class="dims"><span class="dims-label">' + label + '</span>' +
      '<button type="button" class="dims-step" data-act="step" data-path="' + path + '" data-delta="-1" data-min="' + min + '" data-max="' + max + '" aria-label="' + label + '减 1"' + (n <= min ? ' disabled' : '') + '>−</button>' +
      '<span class="dims-count">' + n + '</span>' +
      '<button type="button" class="dims-step" data-act="step" data-path="' + path + '" data-delta="1" data-min="' + min + '" data-max="' + max + '" aria-label="' + label + '加 1"' + (n >= max ? ' disabled' : '') + '>＋</button></span>';
  }

  /** 单体 / 全体 */
  function aoeSeg(path, aoe) {
    return '<div class="seg sd-aoe">' + [[false, '单体'], [true, '全体']].map(([v, t]) =>
      '<button type="button" data-act="set" data-path="' + path + '" data-value="' + v + '" class="' + (aoe === v ? 'on' : '') + '" aria-pressed="' + (aoe === v) + '">' + t + '</button>').join('') + '</div>';
  }

  function toggle(path, on, text) {
    return '<button type="button" class="sd-toggle' + (on ? ' on' : '') + '" data-act="toggle" data-path="' + path + '" aria-pressed="' + on + '">' + text + '</button>';
  }

  const letter = (c) => '<span class="c-' + c + '">' + c + '</span>';

  function enemyHtml(e, j, n, servants) {
    const p = 'enemies.' + j + '.';
    let h = '<div class="sd-card" data-enemy="' + j + '">' +
      '<div class="sd-head"><span class="sd-title">敌人 ' + (j + 1) + ' <small>' + ORDINAL[j] + '</small></span>' +
      '<span class="sd-tools">' +
      (n > 1 ? '<button type="button" data-act="move" data-i="' + j + '" data-delta="-1" aria-label="行动顺序提前"' + (j === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" data-act="move" data-i="' + j + '" data-delta="1" aria-label="行动顺序推后"' + (j === n - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="aoe-remove" data-act="enemy-remove" data-i="' + j + '" aria-label="删除敌人 ' + (j + 1) + '">×</button>' : '') +
      '</span></div>' +
      '<div class="sd-row">' + stepper(p + 'actions', e.actions, 1, S.MAX_ACTIONS, '行动次数') + '</div>' +
      '<div class="sd-attack">' + field(p + 'normal.dmg', '普通攻击均伤', e.normal.dmg, '均伤') + aoeSeg(p + 'normal.aoe', e.normal.aoe) + '</div>' +
      '<div class="sd-toggles">' + toggle(p + 'crit.on', e.crit.on, '暴击') + toggle(p + 'deck.on', e.deck.on, '牌型') +
      toggle(p + 'np.on', e.np.on, '宝具') + toggle(p + 'skill.on', e.skill.on, '开技能') + toggle(p + 'mult.on', e.mult.on, '伤害倍率') +
      toggle(p + 'aim.on', e.aim.on, '目标权重') + '</div>';
    if (e.crit.on) {
      h += '<div class="sd-sub"><div class="sd-sub-title">暴击</div><div class="sd-attack">' +
        field(p + 'crit.dmg', '暴击均伤', e.crit.dmg, '均伤') + aoeSeg(p + 'crit.aoe', e.crit.aoe) + '</div>' +
        '<div class="cards">' + field(p + 'crit.rate', '暴击率 %', e.crit.rate, '例如 25') + '</div></div>';
    }
    if (e.deck.on) {
      h += '<div class="sd-sub"><div class="sd-sub-title">牌型 <span class="panel-sub">每次攻击按张数抽颜色：B ×1.5、A ×1、Q ×0.8</span></div>' +
        '<div class="decks sd-decks">' + S.DECKS.map((deck) =>
          '<button type="button" data-act="set" data-path="' + p + 'deck.value" data-value="' + deck + '" class="' + (deck === e.deck.value ? 'on' : '') +
          '" aria-pressed="' + (deck === e.deck.value) + '">' + deck.split('').map(letter).join('') + '</button>').join('') + '</div></div>';
    }
    if (e.np.on) {
      const at = [];
      for (let k = 1; k <= e.actions; k++) {
        const on = e.np.at.indexOf(k) >= 0;
        at.push('<button type="button" class="sd-at' + (on ? ' on' : '') + '" data-act="np-at" data-i="' + j + '" data-k="' + k + '" aria-pressed="' + on + '">第 ' + k + ' 次</button>');
      }
      h += '<div class="sd-sub"><div class="sd-sub-title">宝具 <span class="panel-sub">预设在第几次行动放（可多选）</span></div>' +
        '<div class="sd-ats" data-field="' + p + 'np.at">' + at.join('') + '<span class="field-hint"></span></div>' +
        '<div class="sd-attack">' + field(p + 'np.dmg', '宝具均伤', e.np.dmg, '不填 = 无伤害宝具') + aoeSeg(p + 'np.aoe', e.np.aoe) + '</div></div>';
    }
    if (e.skill.on) {
      h += '<div class="sd-sub"><div class="sd-sub-title">开技能 <span class="panel-sub">只在这个敌人的第 1 次行动判定</span></div>' +
        '<div class="cards">' + field(p + 'skill.rate', '开技能概率 %', e.skill.rate, '例如 20') + '</div></div>';
    }
    if (e.mult.on) {
      h += '<div class="sd-sub"><div class="sd-sub-title">伤害倍率 <span class="panel-sub">对每名从者，空着 = 100%</span></div><div class="sd-mults">' +
        servants.map((s, i) => field(p + 'mult.values.' + i, '对从者 ' + (i + 1) + ' %', e.mult.values[i], '100')).join('') + '</div></div>';
    }
    if (e.aim.on) {
      h += '<div class="sd-sub"><div class="sd-sub-title">目标权重 <span class="panel-sub">单体攻击先按权重选一项，再在有这个特性的从者里随机挑；' +
        '一个都不能选时改为随机目标；有人嘲讽时只打嘲讽；空着 = 0</span></div><div class="cards">' +
        AIM_NAMES.map((t, k) => field(p + 'aim.values.' + k, t, e.aim.values[k], '0')).join('') + '</div>' +
        '<div class="sd-aim-odds" data-aim-odds="' + j + '"></div></div>';
    }
    return h + '</div>';
  }

  /** 一排选项按钮（value → 文字） */
  function seg(path, cur, list, cls) {
    return '<div class="seg ' + cls + '">' + list.map(([v, t]) =>
      '<button type="button" data-act="set" data-path="' + path + '" data-value="' + v + '" class="' + (cur === v ? 'on' : '') + '" aria-pressed="' + (cur === v) + '">' +
      ('BAQ'.indexOf(v) >= 0 && v.length === 1 ? letter(v) : t) + '</button>').join('') + '</div>';
  }

  /** 受击要求：每条 = 类型 + 暴击（宝具没有）+ 至少 / 恰好 / 至多 + 次数 */
  function hitsHtml(s, i, anyDeck) {
    const p = 'servants.' + i + '.hits.', rows = s.hits.rows;
    // 没有敌人开牌型时只显示普通、宝具（这一条已经选了 B / A / Q 时也显示它，并提示改选）
    const types = (r) => (anyDeck ? HIT_TYPES : HIT_TYPES.filter(([v]) => 'BAQ'.indexOf(v) < 0 || r.type === v));
    return '<div class="sd-sub"><div class="sd-sub-title">受击要求 <span class="panel-sub">每条都要满足才算成功；被无敌挡掉、全体攻击打到也算一次；' +
      '先满足 B / A / Q 条目，满足以后多出来的也计入「普通」' + (anyDeck ? '' : '；没有敌人开牌型时只能选普通、宝具') + '</span></div>' +
      rows.map((r, k) => {
        const q = p + 'rows.' + k + '.';
        return '<div class="sd-hit">' + seg(q + 'type', r.type, types(r), 'sd-hit-type') +
          (r.type === 'NP' ? '' : seg(q + 'crit', r.crit, HIT_CRIT, 'sd-hit-crit')) +
          '<div class="sd-hit-n">' + seg(q + 'cmp', r.cmp, HIT_CMP, 'sd-hit-cmp') +
          '<label class="field" data-field="' + q + 'n"><span class="field-name">次数</span>' + input(q + 'n', r.n, '次数', 'numeric') + '<span class="field-hint"></span></label>' +
          (rows.length > 1 ? '<button type="button" class="aoe-remove" data-act="hit-remove" data-i="' + i + '" data-k="' + k + '" aria-label="删除这条受击要求">×</button>' : '') +
          '</div></div>';
      }).join('') +
      (rows.length < S.MAX_HIT_ROWS ? '<button type="button" class="sd-hit-add" data-act="hit-add" data-i="' + i + '">＋ 受击要求</button>' : '') + '</div>';
  }

  function servantHtml(s, i, anyDeck, aim) {
    const p = 'servants.' + i + '.', mortal = s.role !== 'immortal';
    let h = '<div class="sd-card" data-servant="' + i + '">' +
      '<div class="sd-head"><span class="sd-title">从者 ' + (i + 1) + '</span><span class="sd-head-toggles">' + toggle(p + 'hits.on', s.hits.on, '受击要求') +
      toggle(p + 'taunt', s.taunt, '嘲讽') + '</span></div>' +
      '<div class="seg sd-roles">' + ROLES.map(([v, t]) =>
        '<button type="button" data-act="set" data-path="' + p + 'role" data-value="' + v + '" class="' + (s.role === v ? 'on' : '') + '" aria-pressed="' + (s.role === v) + '">' + t + '</button>').join('') + '</div>' +
      (mortal ? '<div class="cards">' + field(p + 'hp', 'HP', s.hp, '剩余血量') + '</div>' : '') +
      (aim ? '<div class="sd-traits"><span class="sd-traits-name">特性</span>' +
        s.traits.map((on, k) => toggle(p + 'traits.' + k, on, AIM_NAMES[k + 1])).join('') + '</div>' : '');
    if (mortal) {
      h += '<div class="sd-row sd-counts">' + stepper(p + 'inv', s.inv, 0, S.MAX_INV, '无敌次数') + stepper(p + 'guts', s.guts, 0, S.MAX_GUTS, '战续次数') + '</div>';
      if (s.guts > 0) {
        const each = s.gutsEach && s.guts > 1;
        h += '<div class="sd-sub"><div class="cards">' + (each ? s.gutsHp.map((v, k) => field(p + 'gutsHp.' + k, '第 ' + (k + 1) + ' 次战续血量', v, '复活后的 HP')).join('')
          : field(p + 'gutsHp.0', '战续血量', s.gutsHp[0], '复活后的 HP')) + '</div>' +
          (s.guts > 1 ? '<label class="sd-check"><input type="checkbox" data-act="guts-each" data-i="' + i + '"' + (s.gutsEach ? ' checked' : '') + '>每次战续的血量分别填</label>' : '') + '</div>';
      }
    }
    if (s.hits.on) h += hitsHtml(s, i, anyDeck);
    return h + '</div>';
  }

  function renderForm() {
    const d = store.active().data;
    enemyBox.innerHTML = d.enemies.map((e, j) => enemyHtml(e, j, d.enemies.length, d.servants)).join('');
    $('sendEnemyAdd').disabled = d.enemies.length >= S.MAX_ENEMIES;
    $('sendEnemyAdd').textContent = d.enemies.length >= S.MAX_ENEMIES ? '最多 ' + S.MAX_ENEMIES + ' 个敌人' : '＋ 敌人';
    $('sendFieldCount').innerHTML = stepper('field', d.servants.length, 1, S.MAX_SERVANTS, '');
    document.querySelectorAll('#sendBackup button').forEach((b) => {
      const on = (b.dataset.value === 'true') === d.backup;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
    const anyDeck = d.enemies.some((e) => e.deck.on);
    servantBox.innerHTML = d.servants.map((s, i) => servantHtml(s, i, anyDeck, anyAim(d))).join('');
    const may = mayCount(d), n = minOutOf(d);              // 有「可以退场」的从者时才显示「至少退场」
    $('sendMinOutRow').hidden = !may;
    if (may) {
      $('sendMinOut').innerHTML = stepper('minOut', n, 0, may, '人数');
      $('sendMinOutHint').textContent = !n ? '可以退场的从者退不退场都可以' : n < may ? '可以退场的 ' + may + ' 人里至少退场 ' + n + ' 人'
        : (may > 1 ? '可以退场的 ' + may + ' 人都要退场' : '可以退场的从者要退场') + '（和选「要退场」一样）';
    }
    $('sendSl').value = d.sl;
    document.querySelectorAll('#viewSend input[data-path]').forEach(prettify);
  }

  // ---------- 路径：data-path = "enemies.0.normal.dmg" ----------

  function walk(data, path) {
    const keys = path.split('.'), last = keys.pop();
    let o = data;
    keys.forEach((k) => { o = o[k]; });
    return { o, k: last };
  }
  const getPath = (data, path) => { const w = walk(data, path); return w.o[w.k]; };
  const setPath = (data, path, v) => { const w = walk(data, path); w.o[w.k] = v; };

  const PLAIN = /(rate|aim\.values\.\d|mult\.values\.\d|hits\.rows\.\d\.n)$/;   // 百分比、权重、受击次数：不加千分位逗号

  function prettify(el) {
    if (!el.dataset.path || PLAIN.test(el.dataset.path) || el.id === 'sendSl') return;
    const r = parse(el.value);
    if (r.error || r.empty) return;
    const [intPart, frac] = normalize(el.value).split('.');
    el.value = fmt(Number(intPart || '0')) + (frac === undefined ? '' : '.' + frac);
  }

  // ---------- 提示 ----------

  function setHint(box, text, bad) {
    if (!box) return;
    const hint = box.querySelector('.field-hint');
    if (hint) hint.textContent = text || '';
    box.classList.toggle('invalid', !!bad);
  }

  /** 各格的提示：错误、伤害范围（倍率 100% 时）、目标权重换算成的被选中概率 */
  function hints(d, b) {
    document.querySelectorAll('#viewSend [data-field]').forEach((box) => {
      const path = box.dataset.field, err = b.errors[path];
      if (err) { setHint(box, err, true); return; }
      let text = '';
      if (/(normal|crit|np)\.dmg$/.test(path)) {
        const r = parse(getPath(d, path));
        if (!r.empty && !r.error && r.value > 0) {
          const o = window.KillProb.cardOutcomes(r.value);
          text = fmt(o[0]) + ' ~ ' + fmt(o[o.length - 1]);
        }
      }
      setHint(box, text, false);
    });
    if (hitOnly(d)) {                                    // 只看受击要求：均伤、HP 可以不填
      document.querySelectorAll('#viewSend [data-field]').forEach((box) => {
        const path = box.dataset.field;
        if (b.errors[path] || !parse(getPath(d, path)).empty) return;
        if (/(normal|crit)\.dmg$/.test(path)) setHint(box, '只看受击要求时可以不填（= 没有伤害）', false);
        else if (/^servants\.\d\.hp$/.test(path)) setHint(box, '只看受击要求时可以不填（= 不会退场）', false);
      });
    }
    d.enemies.forEach((e, j) => {                        // 第 1 次行动是宝具时不会开技能
      const box = document.querySelector('#viewSend [data-field="enemies.' + j + '.skill.rate"]');
      if (box && !b.errors['enemies.' + j + '.skill.rate'] && e.np.on && e.np.at.indexOf(1) >= 0) setHint(box, '第 1 次行动是宝具，不会开技能', false);
    });
    d.enemies.forEach((e, j) => {                        // 目标权重 → 一开始被单体攻击选中的概率
      const box = document.querySelector('#viewSend [data-aim-odds="' + j + '"]');
      if (box) box.textContent = aimText(d, e);
    });
    setHint($('sendSlField'), b.errors.sl || $('sendSlField').querySelector('.field-hint').dataset.default, !!b.errors.sl);
    const sl = parseSL(d.sl);
    document.querySelector('#viewSend .sl-step[data-step="-1"]').disabled = !sl.error && sl.value <= 0;
    document.querySelector('#viewSend .sl-step[data-step="1"]').disabled = !sl.error && sl.value >= MAX_SL;
  }

  /** 一开始（大家都在场）被敌人 e 的单体攻击选中的概率；规则同 send.js 的 aimOdds */
  function aimText(d, e) {
    if (d.servants.some((s) => s.taunt)) return '有人嘲讽：单体攻击只打嘲讽的从者，不看目标权重';
    const ws = e.aim.values.map((v) => { const r = parse(v); return r.empty ? 0 : r.error ? NaN : r.value; });
    const total = ws.reduce((a, w) => a + w, 0);
    if (!(total > 0)) return '';
    const odds = d.servants.map(() => 0), all = d.servants.map((_, i) => i);
    ws.forEach((w, t) => {
      if (!w) return;
      const fit = t ? all.filter((i) => d.servants[i].traits[t - 1]) : all;
      const pool = fit.length ? fit : all;
      pool.forEach((i) => { odds[i] += w / total / pool.length; });
    });
    const none = d.servants.some((s) => s.traits.some(Boolean)) ? '' : '（我方从者还没有选特性：在下面的从者卡片上选）';
    return '一开始被选中：' + odds.map((p, i) => '从者 ' + (i + 1) + ' ' + (100 * p).toFixed(1) + '%').join('，') + none;
  }

  // ---------- 计算与显示 ----------

  let shownKey = null, slowTimer = null;

  function update() {
    const d = store.active().data, b = build(d);
    hints(d, b);
    clearTimeout(slowTimer);
    if (b.status !== 'ok') { pageRunner.stop(); shownKey = null; showIdle(b.message); return; }
    const key = JSON.stringify(b.cfg), hit = cache.get(key);
    if (hit) { pageRunner.stop(); shownKey = key; show(finish(hit, b.sl), b); return; }
    pageRunner.stop();
    slowTimer = setTimeout(() => { if (shownKey !== key) showBusy(); }, SLOW_MS);
    pageRunner.run(b.cfg).then((r) => {
      remember(key, r);
      bar.refreshSummaries();
      document.dispatchEvent(new CustomEvent('sendresult'));
      const now = build(store.active().data);           // 算完时输入可能又变了：只显示和现在的输入一致的结果
      if (now.status === 'ok' && JSON.stringify(now.cfg) === key) { clearTimeout(slowTimer); shownKey = key; show(finish(r, now.sl), now); }
    });
  }

  function showIdle(message) {
    $('sendLabel').textContent = '送人成功率';
    $('sendProb').textContent = '—';
    $('sendProb').classList.add('idle');
    $('sendMeterBox').hidden = true;
    $('sendNote').innerHTML = '<div>' + esc(message) + '</div>';
    $('sendSlPanel').hidden = true;
    $('sendDetailPanel').hidden = true;
  }

  function showBusy() {
    $('sendProb').classList.add('idle');
    $('sendNote').innerHTML = '<div>计算中…（设置比较复杂）</div>';
  }

  const pct = KA.formatPct, short = KA.formatShort;

  /** 结果的名称：有要退场的 = 送人成功率；只设了「不能退场」= 不退场的概率；只有受击要求 = 满足受击要求的概率 */
  function resultLabel(d) {
    if (d.servants.some((s) => s.role === 'must') || minOutOf(d)) return '送人成功率';
    if (d.servants.some((s) => s.hits.on)) return d.servants.some((s) => s.role === 'keep') ? '成功率' : '满足受击要求的概率';
    return '不退场的概率';
  }

  /** 一条受击要求的文字：「暴击 B 至少 2 次」「宝具 恰好 1 次」 */
  function hitText(r) {
    return (r.type === 'NP' || r.crit === 'any' ? '' : CRIT_NAME[r.crit] + ' ') + HIT_NAME[r.type] + ' ' + CMP_NAME[r.cmp] + ' ' + (r.n === '' ? '?' : normalize(r.n)) + ' 次';
  }

  function show(r, b) {
    if (r.status !== 'ok') { showIdle(r.message); return; }
    const res = r.result, d = store.active().data;
    const label = resultLabel(d);
    $('sendLabel').textContent = r.sl ? label + '（SL ' + r.sl + ' 次）' : label;
    $('sendProb').textContent = pct(r.final);
    $('sendProb').classList.remove('idle');
    $('sendMeterBox').hidden = false;
    $('sendMeter').style.width = r.final * 100 + '%';
    const lines = [];
    if (r.sl) lines.push('单次成功率 ' + pct(r.single) + '，失败后可以重来 ' + r.sl + ' 次');
    const freq = KA.frequencyText(r.final, r.fail, '成功', '失败');
    if (freq) lines.push(freq);
    else if (res.exact) lines.push(r.final >= 1 ? '这样设置一定成功' : '这样设置不可能成功，失败原因见下面的详细结果');
    if (!res.exact) {
      const e = 1.96 * Math.sqrt(Math.max(res.success * (1 - res.success), 1e-12) / res.runs) * 100;
      lines.push('<span class="sd-sim">模拟值：设置太复杂，精确计算量太大，改为模拟 ' + fmt(res.runs) + ' 次（误差约 ±' + e.toFixed(2) + ' 个百分点）</span>');
    }
    $('sendNote').innerHTML = lines.map((s) => '<div>' + s + '</div>').join('');
    renderSLTable(r);
    renderDetail(res, d, b);
  }

  function renderSLTable(r) {
    const p = r.single;
    $('sendSlPanel').hidden = p <= 0 || p >= 1;
    if (p <= 0 || p >= 1) return;
    const rows = [];
    for (let n = 0; n <= SL_ROWS; n++) rows.push(n);
    if (r.sl > SL_ROWS) rows.push(r.sl);
    $('sendSlTable').innerHTML = '<thead><tr><th>SL 次数</th><th>机会</th><th>成功率</th><th>比不 SL 提高</th></tr></thead><tbody>' +
      rows.map((n) => {
        const q = S.withSL(p, n);
        return '<tr' + (n === r.sl ? ' class="on"' : '') + '><td>' + n + (n === r.sl ? ' ←' : '') + '</td><td>' + (n + 1) + ' 次</td><td>' +
          pct(q) + '</td><td>' + (n ? '+' + ((q - p) * 100).toFixed(2) + ' 个百分点' : '—') + '</td></tr>';
      }).join('') + '</tbody>';
  }

  /** 单次（不含 SL）的详细结果：各从者退场、触发战续的概率，失败原因，中断 */
  function renderDetail(res, d, b) {
    const anyGuts = d.servants.some((s) => s.role !== 'immortal' && s.guts > 0), anyHits = d.servants.some((s) => s.hits.on);
    let h = '<table class="sl-table sd-table"><thead><tr><th>从者</th><th>角色</th><th>退场</th>' + (anyGuts ? '<th>触发过战续</th>' : '') +
      (anyHits ? '<th>受击符合</th>' : '') + '</tr></thead><tbody>';
    d.servants.forEach((s, i) => {
      const x = res.servants[i], mortal = b.cfg.servants[i].role !== 'immortal';
      h += '<tr><td>从者 ' + (i + 1) + (s.taunt ? '（嘲讽）' : '') + '</td><td>' + ROLE_NAME[s.role] + '</td><td>' + (mortal ? short(x.out) : '—') + '</td>' +
        (anyGuts ? '<td>' + (mortal && s.guts ? short(x.guts) : '—') + '</td>' : '') + (anyHits ? '<td>' + (s.hits.on ? short(x.hitOk) : '—') + '</td>' : '') + '</tr>';
    });
    h += '</tbody></table><ul class="sd-facts">';
    if (res.fail > 0) {
      const hasMust = d.servants.some((s) => s.role === 'must'), hasKeep = d.servants.some((s) => s.role === 'keep');
      const why = [];
      if (hasMust) why.push('要退场的没有全部退场 ' + short(res.mustAlive));
      if (b.cfg.minOut) why.push('可以退场的退场不到 ' + b.cfg.minOut + ' 人 ' + short(res.fewOut));
      if (hasKeep) why.push('不能退场的退场了 ' + short(res.keepDead));
      if (anyHits) why.push('受击次数不符 ' + short(res.hitBad));
      h += '<li>失败 ' + short(res.fail) + '：' + why.join('，') + (why.length > 1 ? '（可能同时发生）' : '') + '</li>';
    }
    if (res.endGuts > 0) h += '<li>没有后备队友、只剩一人时被打出战续，回合中断：' + short(res.endGuts) + '</li>';
    if (res.endTaunt > 0) h += '<li>嘲讽的从者全部退场，回合中断：' + short(res.endTaunt) + '</li>';
    h += '</ul>';
    $('sendDetail').innerHTML = h;
    $('sendDetailPanel').hidden = false;
  }

  // ---------- 事件 ----------

  let pending = null;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(() => { pending = null; update(); }, 60);   // 连续输入时合并成一次计算
  }

  /** 结构改动之后：整理数据（宝具的预设次数不超过行动次数等），重画、重算 */
  function changedStructure() {
    const d = store.active().data;
    d.enemies.forEach((e) => { e.np.at = e.np.at.filter((k) => k <= e.actions); });
    d.servants.forEach((s) => { while (s.gutsHp.length < Math.max(1, s.guts)) s.gutsHp.push(''); s.gutsHp.length = Math.max(1, s.guts); });
    d.minOut = minOutOf(d);                              // 「可以退场」的人变少时跟着减少，不留下看不见的设置
    store.changed();
    renderForm();
    update();
  }

  const view = $('viewSend');

  view.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'sendSl') { store.active().data.sl = el.value; store.changed(); schedule(); return; }
    if (!el.dataset.path) return;
    setPath(store.active().data, el.dataset.path, el.value);
    store.changed();
    schedule();
  });
  view.addEventListener('focusout', (e) => { if (e.target.dataset && e.target.dataset.path) prettify(e.target); });
  view.addEventListener('keydown', (e) => {                // Enter：跳到下一格
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
    e.preventDefault();
    const list = Array.from(view.querySelectorAll('input[type="text"]')), next = list[list.indexOf(e.target) + 1];
    if (next && !next.closest('.groupbar')) next.focus(); else e.target.blur();
  });

  view.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act !== 'guts-each') return;
    const s = store.active().data.servants[Number(el.dataset.i)];
    s.gutsEach = el.checked;
    if (s.gutsEach) s.gutsHp = s.gutsHp.map(() => s.gutsHp[0]);   // 分别填时先都填上原来的血量
    changedStructure();
  });

  view.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !view.contains(b) || b.closest('.groupbar')) return;   // 送人组切换条的按钮由 GroupBar 处理
    const d = store.active().data, act = b.dataset.act, path = b.dataset.path;
    if (act === 'toggle') setPath(d, path, !getPath(d, path));
    else if (act === 'set') {
      const v = b.dataset.value;
      setPath(d, path, v === 'true' ? true : v === 'false' ? false : v);
    } else if (act === 'step') {
      const lo = Number(b.dataset.min), hi = Number(b.dataset.max);
      if (path === 'minOut') {                           // 「可以退场」的人数变少时按现在的人数算
        d.minOut = Math.min(hi, Math.max(lo, minOutOf(d) + Number(b.dataset.delta)));
      } else if (path === 'field') {
        const n = Math.min(hi, Math.max(lo, d.servants.length + Number(b.dataset.delta)));
        while (d.servants.length < n) d.servants.push(newServant('immortal'));
        d.servants.length = n;
      } else setPath(d, path, Math.min(hi, Math.max(lo, getPath(d, path) + Number(b.dataset.delta))));
    } else if (act === 'np-at') {
      const np = d.enemies[Number(b.dataset.i)].np, k = Number(b.dataset.k), at = np.at.indexOf(k);
      if (at >= 0) np.at.splice(at, 1); else np.at.push(k);
      np.at.sort((x, y) => x - y);
    } else if (act === 'move') {
      const i = Number(b.dataset.i), j = i + Number(b.dataset.delta);
      if (j < 0 || j >= d.enemies.length) return;
      [d.enemies[i], d.enemies[j]] = [d.enemies[j], d.enemies[i]];
    } else if (act === 'enemy-remove') {
      if (d.enemies.length <= 1) return;
      d.enemies.splice(Number(b.dataset.i), 1);
    } else if (act === 'hit-add') {
      const rows = d.servants[Number(b.dataset.i)].hits.rows;
      if (rows.length >= S.MAX_HIT_ROWS) return;
      rows.push(newHitRow());
    } else if (act === 'hit-remove') {
      const rows = d.servants[Number(b.dataset.i)].hits.rows;
      if (rows.length <= 1) return;
      rows.splice(Number(b.dataset.k), 1);
    } else if (act === 'enemy-add') {
      if (d.enemies.length >= S.MAX_ENEMIES) return;
      d.enemies.push(newEnemy());
    } else if (act === 'backup') d.backup = b.dataset.value === 'true';
    else if (act === 'sl') {
      const cur = parseSL(d.sl), base = cur.error ? 0 : cur.value;
      const next = Math.min(MAX_SL, Math.max(0, base + Number(b.dataset.step)));
      d.sl = next ? String(next) : '';
    } else if (act === 'clear-inputs') {
      const fresh = create();
      d.enemies = fresh.enemies;
      d.servants = fresh.servants;
      d.backup = true;
      d.minOut = 0;
      d.sl = '';
    } else return;
    changedStructure();
    const focus = act === 'move' ? view.querySelector('[data-enemy="' + (Number(b.dataset.i) + Number(b.dataset.delta)) + '"] [data-act="move"][data-delta="' + b.dataset.delta + '"]')
      : act === 'step' ? view.querySelector('[data-act="step"][data-path="' + path + '"][data-delta="' + b.dataset.delta + '"]') : null;
    if (focus && !focus.disabled) focus.focus();
    if (act === 'enemy-add') view.querySelector('[data-enemy="' + (d.enemies.length - 1) + '"] input').focus();
  });

  // 切换 / 新建 / 删除送人组：重画输入区
  store.onChange((reason) => {
    if (reason === 'data' || reason === 'rename') return;
    renderForm();
    update();
  });
  const bar = new G.GroupBar($('sendGroups'), store, { summary, onUsed: (id) => (window.ComboApp && window.ComboApp.usage ? window.ComboApp.usage('send', id) : 0) });
  document.addEventListener('sendresult', () => bar.refreshSummaries());

  window.SendApp = { store, build, resultFor, summary, cleanData, resultLabel, hitText, minOutOf, anyAim, AIM_NAMES };

  renderForm();
  update();
})();
