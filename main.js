// 页签切换（击破概率 / 发牌概率 / 综合击破概率）和离线缓存注册；最后加载，其他页面脚本监听 tabshow 事件
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TAB_KEY = 'killprob.tab.v1';
  const views = { kill: $('viewKill'), deal: $('viewDeal'), combo: $('viewCombo') };

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
