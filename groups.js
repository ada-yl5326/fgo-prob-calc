// 「组」的保存与切换：击破概率页的伤害组、发牌概率页的发牌组共用这一套；综合击破概率页读取两种组。
// 每种组存成 localStorage 里的一项 { active, groups: [{ id, name, data }] }；改动后通知所有监听者（综合页据此重算）。
(function () {
  'use strict';

  function GroupStore(opts) {
    // opts: { key, label: '伤害组'，idPrefix, naming(n) → 第 n 个组的默认名称, create() → 新组的数据, clean(raw) → 数据 | null, legacy() → 旧版数据 | null }
    this.opts = opts;
    this.listeners = [];
    this.load();
  }

  GroupStore.prototype.load = function () {
    const o = this.opts;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(o.key) || 'null'); } catch (e) { /* 忽略 */ }
    const groups = [];
    if (saved && Array.isArray(saved.groups)) {
      saved.groups.forEach((g) => {
        const data = g && o.clean(g.data);
        if (data && typeof g.id === 'string' && !groups.some((x) => x.id === g.id)) {
          groups.push({ id: g.id, name: String(g.name || '').slice(0, 20) || o.naming(groups.length + 1), data });
        }
      });
    }
    if (!groups.length) {
      const old = o.legacy ? o.legacy() : null;               // 以前只有一组：作为第 1 组
      groups.push({ id: o.idPrefix + '1', name: o.naming(1), data: old || o.create() });
    }
    this.groups = groups;
    this.activeId = saved && groups.some((g) => g.id === saved.active) ? saved.active : groups[0].id;
  };

  GroupStore.prototype.save = function () {
    try {
      localStorage.setItem(this.opts.key, JSON.stringify({ active: this.activeId, groups: this.groups }));
    } catch (e) { /* 无痕模式等 */ }
  };

  GroupStore.prototype.emit = function (reason) {
    this.save();
    this.listeners.forEach((fn) => fn(reason));
  };

  GroupStore.prototype.onChange = function (fn) { this.listeners.push(fn); };
  GroupStore.prototype.list = function () { return this.groups; };
  GroupStore.prototype.get = function (id) { return this.groups.find((g) => g.id === id) || null; };
  GroupStore.prototype.active = function () { return this.get(this.activeId); };

  GroupStore.prototype.select = function (id) {
    if (!this.get(id) || id === this.activeId) return;
    this.activeId = id;
    this.emit('select');
  };

  /**
   * 新组的编号：每次都不同（不重复使用删掉的组的编号），
   * 否则综合页里还没来得及移除的旧引用会错连到新组上
   */
  GroupStore.prototype.newId = function () {
    let id;
    do { id = this.opts.idPrefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); } while (this.get(id));
    return id;
  };

  /** 新组的默认名称：没被用过的最小编号 */
  GroupStore.prototype.newName = function () {
    let n = 1;
    while (this.groups.some((g) => g.name === this.opts.naming(n))) n++;
    return this.opts.naming(n);
  };

  GroupStore.prototype.add = function (data) {
    const g = { id: this.newId(), name: this.newName(), data: data || this.opts.create() };
    this.groups.push(g);
    this.activeId = g.id;
    this.emit('add');
    return g;
  };

  GroupStore.prototype.copy = function (id) {
    const src = this.get(id);
    return src ? this.add(JSON.parse(JSON.stringify(src.data))) : null;
  };

  GroupStore.prototype.remove = function (id) {
    if (this.groups.length <= 1) return;
    const i = this.groups.findIndex((g) => g.id === id);
    if (i < 0) return;
    this.groups.splice(i, 1);
    if (this.activeId === id) this.activeId = this.groups[Math.max(0, i - 1)].id;
    this.emit('remove');
  };

  /** 清空所有组：只留下一个新的空组 */
  GroupStore.prototype.clearAll = function () {
    const g = { id: this.newId(), name: this.opts.naming(1), data: this.opts.create() };
    this.groups = [g];
    this.activeId = g.id;
    this.emit('clear');
  };

  GroupStore.prototype.rename = function (id, name) {
    const g = this.get(id);
    if (!g) return;
    g.name = name.trim().slice(0, 20) || g.name;
    this.emit('rename');
  };

  /** 当前组的数据改了（调用方已直接修改 data） */
  GroupStore.prototype.changed = function () { this.emit('data'); };

  // ---------- 确认框（页面内）----------
  // 不用浏览器自带的 confirm()：有些环境（App 内置浏览器、部分网页视图）不弹出它、直接当成「取消」，按钮就像没反应

  /** 显示确认框，返回 Promise<boolean>。opts: { ok: 确认按钮文字, danger: 确认按钮标红 } */
  function confirmBox(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const last = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = '<div class="modal-box" role="alertdialog" aria-modal="true" aria-labelledby="modalText">' +
        '<div class="modal-text" id="modalText"></div><div class="modal-actions">' +
        '<button type="button" data-answer="no">取消</button>' +
        '<button type="button" data-answer="yes" class="' + (opts.danger ? 'danger' : 'primary') + '">' + escapeHtml(opts.ok || '确定') + '</button></div></div>';
      wrap.querySelector('.modal-text').textContent = message;
      function close(answer) {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        if (last && last.focus) last.focus();
        resolve(answer);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      }
      wrap.addEventListener('click', (e) => {
        const b = e.target.closest('[data-answer]');
        if (b) close(b.dataset.answer === 'yes');
        else if (e.target === wrap) close(false);                 // 点框外 = 取消
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      wrap.querySelector('[data-answer="yes"]').focus();
    });
  }

  // ---------- 组的切换条：[组1] [组2] [＋]，下面是名称、复制、删除、清空所有组 ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 在 container 里画组的切换条。summary(group) → 组名后面显示的简短结果（如「62.0%」），可省略。
   * onUsed(id) → 这个组在综合页里用了几次（删除前提示用）。
   */
  function GroupBar(container, store, opts) {
    this.el = container;
    this.store = store;
    this.opts = opts || {};
    container.classList.add('groupbar');
    container.addEventListener('click', (e) => this.click(e));
    container.addEventListener('change', (e) => {
      if (e.target.classList.contains('group-name')) store.rename(store.activeId, e.target.value);
    });
    container.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('group-name') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    store.onChange((reason) => { if (reason !== 'data') this.render(); else this.refreshSummaries(); });
    this.render();
  }

  GroupBar.prototype.chipHtml = function (g) {
    const on = g.id === this.store.activeId;
    const sub = this.opts.summary ? this.opts.summary(g) : '';
    return '<button type="button" class="group-chip' + (on ? ' on' : '') + '" data-group="' + g.id + '" aria-pressed="' + on + '">' +
      '<span class="group-chip-name">' + escapeHtml(g.name) + '</span>' +
      '<span class="group-chip-sub" data-sub="' + g.id + '">' + escapeHtml(sub) + '</span></button>';
  };

  GroupBar.prototype.render = function () {
    const store = this.store, active = store.active();
    const label = store.opts.label;
    this.el.innerHTML =
      '<div class="group-chips">' + store.list().map((g) => this.chipHtml(g)).join('') +
      '<button type="button" class="group-add" data-act="add" aria-label="新建' + label + '">＋ 新建</button></div>' +
      '<div class="group-tools">' +
      '<input class="group-name" type="text" maxlength="20" enterkeyhint="done" autocomplete="off" aria-label="' + label + '名称" value="' + escapeHtml(active.name) + '">' +
      '<button type="button" data-act="copy">复制</button>' +
      '<button type="button" data-act="remove"' + (store.list().length <= 1 ? ' disabled title="只剩一个组时不能删除"' : '') + '>删除</button></div>' +
      '<div class="group-clear"><button type="button" data-act="clear">清空所有' + label + '</button></div>';
    // 只横向滚动组的列表，让当前组露出来（不能用 scrollIntoView，它会连整页一起滚动）
    const on = this.el.querySelector('.group-chip.on'), row = this.el.querySelector('.group-chips');
    if (on && row.clientWidth) {
      if (on.offsetLeft < row.scrollLeft) row.scrollLeft = on.offsetLeft - 4;
      else if (on.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = on.offsetLeft + on.offsetWidth - row.clientWidth + 4;
    }
  };

  GroupBar.prototype.refreshSummaries = function () {
    if (!this.opts.summary) return;
    this.store.list().forEach((g) => {
      const el = this.el.querySelector('[data-sub="' + g.id + '"]');
      if (el) el.textContent = this.opts.summary(g);
    });
  };

  GroupBar.prototype.click = function (e) {
    const b = e.target.closest('button');
    if (!b) return;
    const store = this.store;
    if (b.dataset.group) { store.select(b.dataset.group); return; }
    if (b.dataset.act === 'add') store.add();
    else if (b.dataset.act === 'copy') store.copy(store.activeId);
    else if (b.dataset.act === 'remove') {
      const g = store.active(), used = this.opts.onUsed ? this.opts.onUsed(g.id) : 0;
      const msg = '删除「' + g.name + '」？' + (used ? '\n综合击破概率页里用到它的 ' + used + ' 处也会移除。' : '');
      confirmBox(msg, { ok: '删除', danger: true }).then((yes) => { if (yes) store.remove(g.id); });
    } else if (b.dataset.act === 'clear') {
      const label = store.opts.label, n = store.list().length;
      const used = this.opts.onUsed ? store.list().reduce((s, g) => s + this.opts.onUsed(g.id), 0) : 0;
      const msg = '清空全部 ' + n + ' 个' + label + '？\n所有' + label + '的输入都会删除，只留下一个空的「' + store.opts.naming(1) + '」，不能撤销。' +
        (used ? '\n综合击破概率页里用到它们的 ' + used + ' 处也会移除。' : '');
      confirmBox(msg, { ok: '全部清空', danger: true }).then((yes) => { if (yes) store.clearAll(); });
    }
  };

  window.Groups = { GroupStore, GroupBar, escapeHtml, confirmBox };
})();
