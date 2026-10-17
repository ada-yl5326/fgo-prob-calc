// 击破概率页「从 Laplace 截图导入」：选战斗记录截图 → 在本机识别（Tesseract.js，第一次用时下载）→ 预览每回合的伤害组
// → 勾选的回合各生成一个伤害组。读图、拼组的规则在 laplace-shot.js。
(function () {
  'use strict';

  const G = window.Groups, LS = window.LaplaceShot;
  const VENDOR = 'vendor/tesseract/';
  const MAX_PIXELS = 16e6;                               // iPhone 上 canvas 最多约 1600 万像素，再大就缩小
  const TEXT_WIDTH = 1206;                               // 截图宽度小于约 1000 时放大后再识别（按 1206 宽的字号调好的）
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const esc = G.escapeHtml;

  // ---------- 文字识别引擎（只加载一次） ----------

  let engine = null;                                     // Promise<Tesseract worker>
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('文字识别组件下载失败，请检查网络后重试'));
      document.head.appendChild(s);
    });
  }
  function getEngine() {
    if (!engine) {
      const base = new URL(VENDOR, location.href).href;
      engine = (window.Tesseract ? Promise.resolve() : loadScript(VENDOR + 'tesseract.min.js'))
        .then(() => window.Tesseract.createWorker('eng', 1, {
          workerPath: base + 'worker.min.js', corePath: base, langPath: base.replace(/\/$/, ''),
          workerBlobURL: false, cacheMethod: 'none', gzip: true,
        }))
        .then((w) => w.setParameters({ tessedit_pageseg_mode: '6', user_defined_dpi: '300' }).then(() => w))
        .catch((e) => { engine = null; throw e; });
    }
    return engine;
  }

  // ---------- 读图 ----------

  /** 图片文件 → { width, height, data: RGBA }（太大时等比缩小） */
  function decode(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const k = Math.min(1, Math.sqrt(MAX_PIXELS / (img.naturalWidth * img.naturalHeight)), 32000 / img.naturalHeight);
        const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        try { resolve(ctx.getImageData(0, 0, w, h)); } catch (e) { reject(new Error('读不了这张图片')); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('「' + file.name + '」不是能打开的图片')); };
      img.src = url;
    });
  }

  /** 一个敌人栏（白底黑字）→ canvas；截图窄时放大 */
  function cellCanvas(cell, scale) {
    const c = document.createElement('canvas');
    c.width = cell.width; c.height = cell.height;
    c.getContext('2d').putImageData(new ImageData(cell.data, cell.width, cell.height), 0, 0);
    if (scale <= 1) return c;
    const big = document.createElement('canvas');
    big.width = Math.round(cell.width * scale); big.height = Math.round(cell.height * scale);
    const ctx = big.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, big.width, big.height);
    ctx.drawImage(c, 0, 0, big.width, big.height);
    return big;
  }

  // ---------- 对话框 ----------

  function isBlank(d) {
    return !d.hp && d.cards.every((v) => !v) && !d.sl && !d.aoe.length;
  }

  function turnHtml(t, i) {
    const bad = t.problems.length > 0;
    const row = (label, e) => '<div class="lp-row"><b>' + label + '</b> HP ' + fmt(e.hp) + '，均伤 ' +
      e.dims.map((d) => fmt(d.avg) + (d.random !== 0.9 ? '（RNG ' + d.random + '）' : '')).join(' / ') + '</div>';
    return '<label class="lp-turn' + (bad ? ' bad' : '') + '"><div class="lp-head">' +
      '<input type="checkbox" data-turn="' + i + '"' + (bad || !t.data ? '' : ' checked') + (t.data ? '' : ' disabled') + '>' +
      '<span>' + esc(t.name) + '</span><span class="lp-ok">' + (bad ? '需要检查' : '血量核对无误') + '</span></div>' +
      t.targets.map((e, k) => row(k ? 'AOE' : '主目标', e)).join('') +
      t.problems.map((p) => '<div class="lp-problem">' + esc(p) + '</div>').join('') + '</label>';
  }

  function open() {
    const store = window.KillApp.store;
    const last = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = '<div class="modal-box lp-box" role="dialog" aria-modal="true" aria-labelledby="lpTitle">' +
      '<div class="modal-text" id="lpTitle">从 Laplace 截图导入</div>' +
      '<div class="lp-tip">在 Laplace 的战斗记录里点截图，选「完整截图」：单栏、打开显示详情。每个回合生成一个伤害组，' +
      '挨卡最多的敌人作主目标，其他被打到的敌人作 AOE 目标；均伤 = 伤害 ÷ 随机数（默认 0.9）。' +
      '截图里分不出固伤，固伤会被多算约 11%。图片只在本机识别，不会上传。</div>' +
      '<div class="modal-files"><label class="modal-file"><input type="file" hidden accept="image/*" multiple><span>选择截图</span></label></div>' +
      '<div class="modal-status" aria-live="polite"></div>' +
      '<div class="lp-list"></div>' +
      '<div class="modal-actions"><button type="button" data-act="cancel">取消</button>' +
      '<button type="button" data-act="import" class="primary" disabled>导入</button></div></div>';
    const status = wrap.querySelector('.modal-status'), list = wrap.querySelector('.lp-list');
    const fileInput = wrap.querySelector('input[type=file]'), importBtn = wrap.querySelector('[data-act=import]');
    let turns = [], busy = false, closed = false;

    const say = (text, bad) => { status.textContent = text; status.classList.toggle('bad', !!bad); };
    function refreshButton() {
      const n = list.querySelectorAll('[data-turn]:checked').length;
      importBtn.disabled = busy || !n;
      importBtn.textContent = n ? '导入 ' + n + ' 个伤害组' : '导入';
    }

    async function read(files) {
      busy = true;
      turns = [];
      list.innerHTML = '';
      refreshButton();
      const errors = [];
      try {
        say('正在准备文字识别（第一次使用要下载约 7 MB）…');
        const worker = await getEngine();
        for (let f = 0; f < files.length && !closed; f++) {
          const prefix = files.length > 1 ? '图 ' + (f + 1) + ' ' : '';
          try {
            say('正在读取' + (files.length > 1 ? '第 ' + (f + 1) + ' 张' : '') + '截图…');
            const img = await decode(files[f]);
            const scale = img.width < 1000 ? TEXT_WIDTH / img.width : 1;
            const shot = await LS.readShot(img, (cell) => worker.recognize(cellCanvas(cell, scale)).then((r) => r.data.text),
              (done, total) => say('正在识别' + (files.length > 1 ? '第 ' + (f + 1) + ' 张' : '') + '：' + done + ' / ' + total + ' 格'));
            const found = LS.buildTurns(shot.records, img.width);
            if (!found.length) throw new Error('没有找到伤害记录：请打开 Laplace 截图设置里的「显示详情」');
            found.forEach((t) => { t.name = prefix + '回合 ' + t.turn; turns.push(t); });
          } catch (e) {
            errors.push(prefix + ((e && e.message) || '读取失败'));
          }
        }
      } catch (e) {
        errors.push((e && e.message) || '文字识别加载失败');
      }
      busy = false;
      if (closed) return;
      list.innerHTML = turns.map(turnHtml).join('');
      const bad = turns.filter((t) => t.problems.length).length;
      say(errors.length ? errors.join('\n') : turns.length + ' 个回合' + (bad ? '，其中 ' + bad + ' 个需要检查（默认不导入）' : '，血量全部核对无误'), errors.length > 0);
      refreshButton();
    }

    function doImport() {
      const chosen = Array.from(list.querySelectorAll('[data-turn]:checked')).map((el) => turns[Number(el.dataset.turn)]);
      if (!chosen.length) return;
      const only = store.list().length === 1 && isBlank(store.list()[0].data) ? store.list()[0] : null;   // 只有一个空组：导入后删掉它
      const added = chosen.map((t) => {
        const g = store.add(JSON.parse(JSON.stringify(t.data)));
        store.rename(g.id, t.name);
        return g;
      });
      if (only) store.remove(only.id);
      store.select(added[0].id);
      close();
    }

    function close() {
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (last && last.focus) last.focus();
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (files.length && !busy) read(files);
    });
    list.addEventListener('change', refreshButton);
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && b.dataset.act === 'cancel') close();
      else if (b && b.dataset.act === 'import') doImport();
      else if (e.target === wrap) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-act=cancel]').focus();
  }

  window.LaplaceApp = { open };
})();
