/*!
 * 起点极简 · early.js
 * 运行时机：document_start（在页面首屏渲染之前，且在站点自身样式生效之前）
 * 唯一职责：同步读取「本地镜像配置」，立刻给 <html> 打上主题标记，消除切换时的白屏/闪烁。
 * 注意：这里不能用 chrome.storage（异步），配置镜像由 content.js 写入 localStorage。
 * 本脚本只在非阅读页被注入（manifest exclude_matches + 下方运行时守卫双重保险）。
 */
(function () {
  'use strict';

  var KEY = 'qd_minimal_cfg';

  function isReaderUrl(href) {
    try {
      var u = new URL(href, location.href);
      var host = u.hostname.toLowerCase();
      if (/(^|\.)(read|vipreader|vip)\.qidian\.com$/.test(host)) return true;
      if (/\/chapter\//i.test(u.pathname)) return true;
      return false;
    } catch (e) {
      return /\/(chapter|read)\//i.test(href);
    }
  }

  // 阅读页：不碰，直接退出（兜底，正常情况下 content script 不会被注入）
  if (isReaderUrl(location.href)) return;

  // 书籍详情页（/book/{id}/）：站点是另一套浅色玻璃拟态模板，固定日间
  var dayLock = false; // 详情页已并入夜间（v1.7.0）
  // 首页标记：有几条「整行铺满」的品牌行规则只适用于首页，
  // 频道页的 .logo-wrap 在图片横幅内部，套上去会把横幅盖成一条纯色带。
  var isHome = location.pathname === '/' || location.pathname === '';

  var cfg = null;
  try {
    cfg = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch (e) {
    cfg = null;
  }

  // 缺省值必须与 content.js 的 DEFAULTS 保持一致
  var enabled = cfg && typeof cfg.enabled === 'boolean' ? cfg.enabled : true;
  var theme = cfg && typeof cfg.theme === 'string' ? cfg.theme : 'auto';
  if (theme !== 'light' && theme !== 'dark' && theme !== 'auto') theme = 'auto';

  var root = document.documentElement;
  if (!root) return; // 极端情况下 <html> 尚未建立

  if (enabled) {
    root.setAttribute('data-qd-minimal', 'on');
    root.setAttribute('data-qd-theme', theme);
    if (isHome) root.setAttribute('data-qd-home', '1');


    // 首屏防闪：theme.css 在 document_end 才注入，这里先用内联底色把 <html> 铺上，
    // content.js 在样式表加载完成后会移除这两个内联样式。
    // 注意：只给 <html> 设底色是临时的；正式样式只设在 body（见 theme.css 第 4 节，
    // 给 html 设背景会禁用 body 背景的「画布传播」，从而盖住负层级装饰层）。
    var wantsDark =
      !dayLock &&
      (theme === 'dark' ||
        (theme === 'auto' &&
          window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches));
    try {
      root.style.setProperty('background-color', wantsDark ? '#0e1014' : '#f4f5f7', 'important');
      root.style.setProperty('color-scheme', wantsDark ? 'dark' : 'light');
    } catch (e) {
      /* 忽略 */
    }

    if (cfg && cfg.removeGames === false) root.removeAttribute('data-qd-nogames');
    else root.setAttribute('data-qd-nogames', 'on');
    // 隐藏推广位默认关闭，必须是显式 true 才生效
    if (cfg && cfg.hideAds === true) root.setAttribute('data-qd-noads', 'on');
    else root.removeAttribute('data-qd-noads');
  }
})();
