// 页签切换（击破概率 / 发牌概率 / 送人概率 / 综合击破概率）和离线缓存注册；最后加载，其他页面脚本监听 tabshow 事件
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TAB_KEY = 'killprob.tab.v1';
  const views = { kill: $('viewKill'), deal: $('viewDeal'), send: $('viewSend'), combo: $('viewCombo') };

  function showTab(name, remember) {
    if (!views[name]) name = 'kill';
    Object.keys(views).forEach((key) => {
      views[key].hidden = key !== name;
      const tab = document.querySelector('[data-tab="' + key + '"]');
      tab.classList.toggle('on', key === name);
      tab.setAttribute('aria-selected', key === name);
    });
    document.dispatchEvent(new CustomEvent('tabshow', { detail: name }));   // 隐藏时量不到宽度，显示时重画
    if (!remember) return;
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 忽略 */ }
    history.replaceState(null, '', name === 'kill' ? location.pathname + location.search : '#' + name);
  }

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab, true));
  });
  let firstTab = views[location.hash.slice(1)] ? location.hash.slice(1) : null;
  if (!firstTab) { try { firstTab = localStorage.getItem(TAB_KEY); } catch (e) { /* 忽略 */ } }
  showTab(firstTab || 'kill', false);

  // 外观：自动（跟随系统）→ 浅色 → 深色，点按依次切换；选择保存在本机（index.html 开头的小脚本在页面画出来前应用）
  const THEME_KEY = 'killprob.theme.v1';
  const THEMES = {
    auto: { text: '自动', tip: '跟随系统', icon: '<circle cx="12" cy="12" r="8"/><path class="fill" d="M12 4a8 8 0 0 1 0 16z"/>' },
    light: { text: '浅色', tip: '浅色', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/>' },
    dark: { text: '深色', tip: '深色', icon: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z"/>' },
  };
  const ORDER = ['auto', 'light', 'dark'];
  const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
  const metaDefaults = metas.map((m) => m.getAttribute('content'));

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'auto') delete root.dataset.theme;
    else root.dataset.theme = mode;
    // 手机顶部状态栏的颜色：手动选择时两个 meta 都用所选外观的背景色
    metas.forEach((m, i) => m.setAttribute('content', mode === 'auto' ? metaDefaults[i] : mode === 'dark' ? '#101216' : '#f3f4f6'));
    const t = THEMES[mode], next = THEMES[ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]];
    $('themeBtn').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg><span class="theme-label">' + t.text + '</span>';
    $('themeBtn').setAttribute('aria-label', '外观：' + t.tip + '，点按切换为' + next.tip);
    $('themeBtn').title = '外观：' + t.tip + '（点按切换）';
  }

  let theme = 'auto';
  try { theme = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* 忽略 */ }
  if (!THEMES[theme]) theme = 'auto';
  applyTheme(theme);
  $('themeBtn').addEventListener('click', () => {
    theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 忽略 */ }
    applyTheme(theme);
  });

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
