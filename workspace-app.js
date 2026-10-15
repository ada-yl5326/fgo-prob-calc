// 工作目录：左上角按钮打开侧边栏。每个工作目录 = 一整套伤害组、发牌组、buff 组、送人组和综合页的方案。
// 页面上正在编辑的内容照旧随时自动保留（刷新也在）；「保存」把它存进当前工作目录，和上次保存的不一样时显示「未保存」。
// 切换 / 新建 / 作为新的工作目录导入前，有未保存的修改会先询问。导出：文件、分享码、分享链接（share.js）、二维码（qr.js）。
// 切换时把目标内容写进各页面的存储，再刷新页面，由各页面按平时的方式读取和检查。
(function () {
  'use strict';

  const G = window.Groups, S = window.Share;
  const Kill = window.KillApp, Deal = window.DealApp, Send = window.SendApp, Buff = window.BuffApp, Combo = window.ComboApp;
  const KEY = 'killprob.workspaces.v1';
  const SYNC = 'killprob.workspaces.sync';               // 刷新后把当前工作目录的记录换成页面检查过的内容
  const LIVE = { kill: 'killprob.kill.v2', deal: 'killprob.deal.v2', send: 'killprob.send.v1', buff: 'killprob.buff.v1', combo: 'killprob.combo.v1' };
  const MAX_ITEMS = 100;
  const $ = (id) => document.getElementById(id);
  const esc = G.escapeHtml;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pct = (p) => (p === null || p === undefined ? '' : window.KillApp.formatShort(p));

  // ---------- 工作目录的记录：{ current: 当前工作目录的 id | null（还没保存过）, items: [{ id, name, savedAt, rate, data }] } ----------

  function loadWs() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* 忽略 */ }
    const items = (s && Array.isArray(s.items) ? s.items : []).filter((it) =>
      it && typeof it.id === 'string' && it.data && typeof it.data === 'object').slice(0, MAX_ITEMS);
    const current = s && items.some((it) => it.id === s.current) ? s.current : null;
    return { current, items };
  }

  let ws = loadWs();

  function saveWs() {
    try {
      localStorage.setItem(KEY, JSON.stringify(ws));
      return true;
    } catch (e) {
      G.confirmBox('保存失败：浏览器的存储空间不够了。可以删掉一些不用的工作目录，或者先导出成文件备份。', { ok: '知道了' });
      return false;
    }
  }

  const currentItem = () => ws.items.find((it) => it.id === ws.current) || null;
  const newId = () => 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

  /** 页面上正在编辑的内容 */
  function live() {
    return { kill: { groups: clone(Kill.store.list()) }, deal: { groups: clone(Deal.store.list()) }, send: { groups: clone(Send.store.list()) },
      buff: { groups: clone(Buff.store.list()) }, combo: Combo.snapshot() };
  }

  /** 新的空白工作目录 */
  function blank() {
    const one = (store) => ({ groups: [{ id: store.opts.idPrefix + '1', name: store.opts.naming(1), data: store.opts.create() }] });
    return { kill: one(Kill.store), deal: one(Deal.store), send: one(Send.store), buff: one(Buff.store),
      combo: { turns: 3, kill: [null, null, null], deal: [], split: [null, null, null] } };
  }

  /** 方案里有没有放任何组（或设了额外 SL） */
  function comboUsed(c) {
    c = c || {};
    const any = (a) => Array.isArray(a) && a.some(Boolean);
    return ['kill', 'split', 'send', 'buff', 'ebuff', 'kfail', 'sfail', 'extra'].some((k) => any(c[k])) || (c.deal || []).length > 0 || !!c.global;
  }

  /** 比较用：以前保存的工作目录没有送人组（v0.8 以前）、buff 组（v0.9 以前），当作只有一个空白的组；各项按固定顺序排列 */
  const canon = (d) => ({ kill: d.kill, deal: d.deal, send: d.send || blank().send, buff: d.buff || blank().buff, combo: d.combo });

  /** 和新的空白工作目录一样（没有任何输入）；第一次打开网页时发牌页自带的示例（BBAAQ 第 1 回合要 BB）也算空白 */
  function isBlank(d) {
    const only = (x, data) => x.groups.length === 1 && JSON.stringify(x.groups[0].data) === JSON.stringify(data);
    const empty = (x, store) => only(x, store.opts.create()) ||
      (store === Deal.store && localStorage.getItem('killprob.deal.v1') === null && only(x, store.opts.legacy()));
    return empty(d.kill, Kill.store) && empty(d.deal, Deal.store) && (!d.send || empty(d.send, Send.store)) && (!d.buff || empty(d.buff, Buff.store)) &&
      !comboUsed(d.combo);
  }

  /** 有没有未保存的修改 */
  function dirty() {
    const it = currentItem(), d = live();
    return it ? JSON.stringify(canon(it.data)) !== JSON.stringify(canon(d)) : !isBlank(d);
  }

  // ---------- 保存、切换、新建 ----------

  /** 把一个工作目录的内容写进页面，再刷新页面 */
  function apply(data, currentId) {
    try {
      localStorage.setItem(LIVE.kill, JSON.stringify({ active: null, groups: data.kill.groups }));
      localStorage.setItem(LIVE.deal, JSON.stringify({ active: null, groups: data.deal.groups }));
      localStorage.setItem(LIVE.send, JSON.stringify({ active: null, groups: (data.send || blank().send).groups }));
      localStorage.setItem(LIVE.buff, JSON.stringify({ active: null, groups: (data.buff || blank().buff).groups }));
      if (data.combo) localStorage.setItem(LIVE.combo, JSON.stringify(data.combo));
      else localStorage.removeItem(LIVE.combo);
    } catch (e) {
      G.confirmBox('打开失败：浏览器的存储空间不够了。', { ok: '知道了' });
      return;
    }
    ws.current = currentId;
    if (!saveWs()) return;
    try { sessionStorage.setItem(SYNC, '1'); } catch (e) { /* 忽略 */ }
    location.replace(location.pathname + location.search);
  }

  async function askName(message, value) {
    const r = await G.dialogBox({
      message, input: { value, maxlength: 30 },
      buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', kind: 'primary' }],
    });
    return r.value === 'ok' ? r.text.trim() || value : null;
  }

  const taken = (except) => ws.items.filter((it) => it.id !== except).map((it) => it.name);

  /** 保存当前内容：asNew = 另存为新的工作目录（没有当前工作目录时也是另存为） */
  async function saveCurrent(asNew) {
    let it = asNew ? null : currentItem();
    if (!it) {
      if (ws.items.length >= MAX_ITEMS) {
        await G.confirmBox('工作目录最多 ' + MAX_ITEMS + ' 个，请先删掉一些不用的。', { ok: '知道了' });
        return false;
      }
      const cur = currentItem();
      const name = await askName('工作目录的名称', cur ? S.uniqueName(cur.name + ' 副本', taken()) : S.uniqueName('工作目录 ' + (ws.items.length + 1), taken()));
      if (name === null) return false;
      it = { id: newId(), name: S.uniqueName(name, taken()), savedAt: 0, rate: null, data: null };
      ws.items.unshift(it);
    }
    it.data = live();
    it.savedAt = Date.now();
    it.rate = comboUsed(it.data.combo) ? Combo.value() : null;   // 方案里放了组时才记下综合击破率
    ws.current = it.id;
    const ok = saveWs();
    render();
    return ok;
  }

  /** 离开当前内容前（切换、新建、导入）：有未保存的修改时询问；返回 true = 可以继续 */
  async function leaveCurrent() {
    if (!dirty()) return true;
    const it = currentItem();
    const r = await G.dialogBox({
      message: (it ? '「' + it.name + '」' : '当前内容') + '有未保存的修改，要先保存吗？',
      buttons: [{ label: '取消', value: null }, { label: '不保存', value: 'drop', kind: 'danger' }, { label: '保存', value: 'save', kind: 'primary' }],
    });
    if (r.value === 'save') return saveCurrent(false);
    return r.value === 'drop';
  }

  async function switchTo(id) {
    const it = ws.items.find((x) => x.id === id);
    if (!it || id === ws.current) return;
    if (await leaveCurrent()) apply(it.data, it.id);
  }

  async function newWorkspace() {
    if (await leaveCurrent()) apply(blank(), null);
  }

  async function renameItem(id) {
    const it = ws.items.find((x) => x.id === id);
    if (!it) return;
    const name = await askName('新的名称', it.name);
    if (name === null) return;
    it.name = S.uniqueName(name, taken(it.id));
    saveWs();
    render();
  }

  async function removeItem(id) {
    const it = ws.items.find((x) => x.id === id);
    if (!it) return;
    const cur = id === ws.current;
    const yes = await G.confirmBox('删除工作目录「' + it.name + '」？不能撤销。' + (cur ? '\n页面上正在编辑的内容不会消失，但会变成「未保存」。' : ''), { ok: '删除', danger: true });
    if (!yes) return;
    ws.items = ws.items.filter((x) => x.id !== id);
    if (cur) ws.current = null;
    saveWs();
    render();
  }

  // ---------- 导出 ----------

  function fileName(name) {
    const d = new Date(), two = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
    return 'LaplaceNS_' + String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) + '_' + stamp + '.json';
  }

  /** 保存文件：手机上优先弹出系统的分享菜单（可以直接发到 QQ / 微信 / 存到文件、相册），否则下载 */
  async function saveBlob(blob, name, title) {
    try {
      const f = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [f] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        await navigator.share({ files: [f], title });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;          // 用户关掉了分享菜单
    }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** 分享链接的二维码：白底黑块，四周留 4 格空白 */
  function qrCanvas(text) {
    const q = window.QR.encode(text, { level: 'M' });
    const quiet = 4, n = q.size + quiet * 2, scale = Math.max(4, Math.floor(640 / n));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    q.modules.forEach((row, r) => row.forEach((on, c) => { if (on) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale); }));
    return { canvas, version: q.version };
  }

  async function showQR(link, name) {
    let qr;
    try {
      qr = qrCanvas(link);
    } catch (e) {
      await G.confirmBox('内容太多，放不进二维码。请改用分享码或文件。', { ok: '知道了' });
      return;
    }
    const r = await G.dialogBox({
      message: '「' + name + '」的二维码（长按图片可以保存，截图也可以）\n' +
        '对方在本网页「工作目录 → 导入 → 从图片读取二维码」里选这张图即可；也可以用手机相机扫码打开。\n' +
        '用微信 / QQ 扫码会在它们自带的浏览器里打开，数据和手机浏览器不互通，不建议。' +
        (qr.version > 20 ? '\n内容比较多，二维码很密；扫不出来时请改用分享码或文件。' : ''),
      image: { src: qr.canvas.toDataURL('image/png'), alt: '「' + name + '」的分享二维码' },
      buttons: [{ label: '保存图片', value: 'save' }, { label: '完成', value: 'ok', kind: 'primary' }],
    });
    if (r.value === 'save') {
      const blob = await new Promise((resolve) => qr.canvas.toBlob(resolve, 'image/png'));
      if (blob) await saveBlob(blob, fileName(name).replace(/\.json$/, '_二维码.png'), name);
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  /** 导出一个工作目录（it = null 时导出页面上正在编辑的内容） */
  async function exportItem(it) {
    const name = it ? it.name : (currentItem() || {}).name || '未命名';
    const data = it ? it.data : live();
    const r = await G.dialogBox({
      message: '导出「' + name + '」\n文件适合备份；分享码、分享链接可以直接粘贴到 QQ 群、评论区；二维码扫一下就能打开导入。',
      check: { label: '只包含综合页方案里用到的组', checked: false },
      buttons: [{ label: '取消', value: null }, { label: '二维码', value: 'qr' }, { label: '分享链接', value: 'link' }, { label: '分享码', value: 'code' },
        { label: '文件', value: 'file', kind: 'primary' }],
    });
    if (!r.value) return;
    const file = S.pack(name, r.checked ? S.usedOnly(data) : data);
    if (r.value === 'file') {
      await saveBlob(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }), fileName(name), name);
      return;
    }
    const code = await S.encode(file);
    const link = location.origin + location.pathname + '#i=' + code;
    if (r.value === 'qr') { await showQR(link, name); return; }
    const text = r.value === 'link' ? link : code;
    const copied = await copyText(text);
    await G.dialogBox({
      message: (r.value === 'link' ? '分享链接' : '分享码') + '（' + text.length + ' 字）' + (copied ? '已复制。' : '：请长按下面的文字全选、复制。') +
        '\n对方在「工作目录」→「导入」里粘贴' + (r.value === 'link' ? '，或者直接点开链接' : '') + '即可。',
      textarea: { value: text, readonly: true },
      buttons: [{ label: '完成', value: 'ok', kind: 'primary' }],
    });
  }

  // ---------- 导入 ----------

  function summaryOf(data) {
    return '伤害组 ' + data.kill.groups.length + ' 个、发牌组 ' + data.deal.groups.length + ' 个、buff 组 ' + data.buff.groups.length + ' 个、送人组 ' +
      data.send.groups.length + ' 个、综合方案' + (comboUsed(data.combo) ? '已放好' : '为空');
  }

  /**
   * 从图片读取二维码：用系统的图片选择器选一张（不需要相册权限，网页只能读到选中的这一张），
   * 画到画布上（最长边不超过 2000 像素），再用 qr-read.js 识别
   */
  async function readQrImage(file) {
    let source;
    try {
      source = window.createImageBitmap ? await createImageBitmap(file) : await new Promise((resolve, reject) => {
        const img = new Image(), url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error()); };
        img.src = url;
      });
    } catch (e) {
      throw new Error('打不开这张图片，请换一张（支持截图、PNG、JPG）');
    }
    const w0 = source.width, h0 = source.height, k = Math.min(1, 2000 / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * k));
    canvas.height = Math.max(1, Math.round(h0 * k));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';                              // 透明的地方当作白色
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    const text = window.QRRead.decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (!/#(i|import)=|^LN|^LNS/.test(text)) throw new Error('读到了二维码，但不是 Laplace NS 的分享二维码');
    return text;
  }

  async function importFlow(prefill) {
    let text = prefill;
    if (!text) {
      const r = await G.dialogBox({
        message: '粘贴分享码或分享链接；也可以选择工作文件（.json），或者从相册里选一张分享二维码的图片（截图也可以）。',
        textarea: { value: '', placeholder: 'LN2z.… 或 https://…#i=…' },
        files: [
          { accept: '.json,application/json,text/plain', label: '选择工作文件…', read: (f) => f.text() },
          { accept: 'image/*', label: '从图片读取二维码…', read: readQrImage, submit: 'next' },
        ],
        buttons: [{ label: '取消', value: null }, { label: '下一步', value: 'next', kind: 'primary' }],
      });
      if (r.value !== 'next') return;
      text = r.text;
    }
    let got;
    try {
      got = await S.decode(text);
    } catch (e) {
      await G.confirmBox(e.message, { ok: '知道了' });
      return;
    }
    const clean = (groups, store) => groups.filter((g) => g && store.opts.clean(g.data));
    const data = { kill: { groups: clean(got.data.kill.groups, Kill.store) }, deal: { groups: clean(got.data.deal.groups, Deal.store) },
      send: { groups: clean((got.data.send || { groups: [] }).groups, Send.store) },
      buff: { groups: clean((got.data.buff || { groups: [] }).groups, Buff.store) }, combo: got.data.combo };
    if (!data.kill.groups.length && !data.deal.groups.length && !data.send.groups.length && !data.buff.groups.length) {
      await G.confirmBox('「' + got.name + '」里没有可以导入的组。', { ok: '知道了' });
      return;
    }
    const r = await G.dialogBox({
      message: '导入「' + got.name + '」\n' + summaryOf(data) +
        '\n\n作为新的工作目录打开：导入全部内容（包括方案）。\n合并到当前：只把这些组加到当前工作目录，方案不变。',
      buttons: [{ label: '取消', value: null }, { label: '合并到当前', value: 'merge' }, { label: '作为新的工作目录打开', value: 'new', kind: 'primary' }],
    });
    if (r.value === 'merge') mergeIntoCurrent(data);
    else if (r.value === 'new') {
      if (!(await leaveCurrent())) return;
      if (ws.items.length >= MAX_ITEMS) {
        await G.confirmBox('工作目录最多 ' + MAX_ITEMS + ' 个，请先删掉一些不用的。', { ok: '知道了' });
        return;
      }
      if (!data.kill.groups.length) data.kill = blank().kill;
      if (!data.deal.groups.length) data.deal = blank().deal;
      if (!data.send.groups.length) data.send = blank().send;
      if (!data.buff.groups.length) data.buff = blank().buff;
      const it = { id: newId(), name: S.uniqueName(got.name, taken()), savedAt: Date.now(), rate: null, data };
      ws.items.unshift(it);
      apply(data, it.id);
    }
  }

  /** 合并：导入的组加到现有的组后面（重名的加上「（导入）」），方案不变 */
  function mergeIntoCurrent(data) {
    const add = (groups, store) => groups.forEach((g) => {
      const d = store.opts.clean(g.data);
      if (!d) return;
      const name = S.uniqueName(String(g.name || '') + (store.list().some((x) => x.name === g.name) ? '（导入）' : ''), store.list().map((x) => x.name), 20);
      const ng = store.add(d);
      store.rename(ng.id, name);
    });
    add(data.kill.groups, Kill.store);
    add(data.deal.groups, Deal.store);
    add(data.send.groups, Send.store);
    add(data.buff.groups, Buff.store);
    message = '已合并：伤害组 ' + data.kill.groups.length + ' 个、发牌组 ' + data.deal.groups.length + ' 个、buff 组 ' + data.buff.groups.length +
      ' 个、送人组 ' + data.send.groups.length + ' 个（还没保存）';
    render();
  }

  // ---------- 侧边栏 ----------

  let message = '';                                      // 侧边栏顶部的一次性提示
  let expanded = null;                                   // 展开了「⋯」的工作目录

  function timeText(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date(), two = (n) => String(n).padStart(2, '0');
    const hm = two(d.getHours()) + ':' + two(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    const md = (d.getMonth() + 1) + '-' + d.getDate();
    return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md) + ' ' + hm;
  }

  function render() {
    updateDot();
    const panel = $('wsPanel');
    if (panel.hidden) return;
    const it = currentItem(), isDirty = dirty();
    let html = '<div class="ws-head"><b>工作目录</b><button type="button" class="ws-close" data-ws="close" aria-label="关闭">×</button></div>';
    if (message) html += '<div class="ws-msg">' + esc(message) + '</div>';
    html += '<div class="ws-current"><div class="ws-cur-label">当前</div>' +
      '<div class="ws-cur-name">' + (it ? esc(it.name) : '新的工作目录（还没保存）') + '</div>' +
      '<div class="ws-cur-state' + (isDirty ? ' dirty' : '') + '">' + (isDirty ? '● 有未保存的修改' : it ? '已保存 · ' + timeText(it.savedAt) : '还没有任何输入') + '</div>' +
      '<div class="ws-actions"><button type="button" class="primary" data-ws="save"' + (it && !isDirty ? ' disabled' : '') + '>保存</button>' +
      '<button type="button" data-ws="saveas">另存为</button><button type="button" data-ws="export-live">导出 / 分享</button></div></div>';
    html += '<div class="ws-actions ws-main"><button type="button" data-ws="new">＋ 新建工作目录</button><button type="button" data-ws="import">导入</button></div>';
    html += '<div class="ws-list-title">全部工作目录（' + ws.items.length + '）</div>';
    if (!ws.items.length) html += '<div class="ws-empty">还没有保存过工作目录。点上面的「保存」，把当前内容存成第一个。</div>';
    html += '<ul class="ws-list">' + ws.items.map((x) => {
      const d = x.data || {}, k = ((d.kill || {}).groups || []).length, g = ((d.deal || {}).groups || []).length, sd = ((d.send || {}).groups || []).length;
      const bf = ((d.buff || {}).groups || []).length;
      const sub = timeText(x.savedAt) + ' · 伤害组 ' + k + ' · 发牌组 ' + g + (bf ? ' · buff 组 ' + bf : '') + (sd ? ' · 送人组 ' + sd : '') +
        (x.rate !== null && x.rate !== undefined ? ' · 综合 ' + pct(x.rate) : '');
      return '<li class="ws-item' + (x.id === ws.current ? ' on' : '') + '">' +
        '<button type="button" class="ws-open" data-open="' + x.id + '"><span class="ws-name">' + esc(x.name) + (x.id === ws.current ? '<em>当前</em>' : '') +
        '</span><small>' + esc(sub) + '</small></button>' +
        '<button type="button" class="ws-more" data-more="' + x.id + '" aria-label="更多操作">⋯</button>' +
        (expanded === x.id ? '<div class="ws-item-actions"><button type="button" data-rename="' + x.id + '">重命名</button>' +
          '<button type="button" data-export="' + x.id + '">导出 / 分享</button><button type="button" class="danger" data-delete="' + x.id + '">删除</button></div>' : '') +
        '</li>';
    }).join('') + '</ul>';
    html += '<p class="ws-tip">工作目录保存在这台设备的浏览器里；换手机、换浏览器或清除网站数据后就没有了。重要的工作目录请导出成文件备份。</p>';
    $('wsBody').innerHTML = html;
  }

  function updateDot() {
    const d = dirty();
    $('wsDot').hidden = !d;
    $('wsBtn').setAttribute('aria-label', '工作目录' + (d ? '（有未保存的修改）' : ''));
  }

  function open() {
    const panel = $('wsPanel');
    panel.hidden = false;
    $('wsBackdrop').hidden = false;
    render();
    requestAnimationFrame(() => { panel.classList.add('open'); $('wsBackdrop').classList.add('open'); });
  }

  function close() {
    const panel = $('wsPanel');
    panel.classList.remove('open');
    $('wsBackdrop').classList.remove('open');
    message = '';
    expanded = null;
    setTimeout(() => { if (!panel.classList.contains('open')) { panel.hidden = true; $('wsBackdrop').hidden = true; } }, 250);
  }

  $('wsBtn').addEventListener('click', open);
  $('wsBackdrop').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('wsPanel').hidden && !document.querySelector('.modal')) close();
  });

  $('wsPanel').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    message = '';
    const act = b.dataset.ws;
    if (act === 'close') return close();
    if (act === 'save') await saveCurrent(false);
    else if (act === 'saveas') await saveCurrent(true);
    else if (act === 'export-live') await exportItem(null);
    else if (act === 'new') await newWorkspace();
    else if (act === 'import') await importFlow('');
    else if (b.dataset.open) await switchTo(b.dataset.open);
    else if (b.dataset.more) { expanded = expanded === b.dataset.more ? null : b.dataset.more; render(); }
    else if (b.dataset.rename) await renameItem(b.dataset.rename);
    else if (b.dataset.export) await exportItem(ws.items.find((x) => x.id === b.dataset.export));
    else if (b.dataset.delete) await removeItem(b.dataset.delete);
  });

  // 内容改了：更新左上角的「未保存」小圆点（连续改动合并成一次）
  let dotTimer = null;
  const changed = () => { clearTimeout(dotTimer); dotTimer = setTimeout(render, 150); };
  Kill.store.onChange(changed);
  Deal.store.onChange(changed);
  Send.store.onChange(changed);
  Buff.store.onChange(changed);
  document.addEventListener('combochange', changed);

  // 刚切换过来：把记录换成页面检查过的内容（例如引用了不存在的组的部分已经去掉），这样刚打开时不会显示「未保存」
  let sync = false;
  try { sync = sessionStorage.getItem(SYNC) === '1'; sessionStorage.removeItem(SYNC); } catch (e) { /* 忽略 */ }
  if (sync && currentItem()) {
    currentItem().data = live();
    saveWs();
  }
  updateDot();

  // 打开分享链接（#i=…；以前是 #import=…）：直接进入导入
  if (/^#(i|import)=/.test(location.hash)) {
    const code = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    open();
    importFlow(code);
  }
})();
