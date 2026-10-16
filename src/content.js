/*!
 * 起点极简 · content.js
 * ---------------------------------------------------------------------------
 * 只在「非阅读页」被注入（manifest exclude_matches）。主要工作：
 *   1. 运行时守卫：一旦发现当前是阅读页，立刻自我卸载、抹掉所有痕迹（双保险）
 *   2. 同步配置镜像到 localStorage，供 early.js 下次首屏零闪烁使用
 *   3. 打主题 / 开关标记，注入悬浮日夜切换按钮（Shadow DOM 隔离，不受站点 CSS 影响）
 *   4. 移除页游入口（按 href 域名 + 文本精确匹配，避免误伤「游戏竞技」分类）
 *   5. 监听配置变更、DOM 动态插入、URL 变化
 * 不做任何网络请求，不读取页面文本内容。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ====================== 常量 ====================== */

  var CFG_KEY = 'qd_minimal_cfg';

  // 必须与 early.js / popup.js 中的缺省值保持一致
  var DEFAULTS = {
    enabled: true,
    theme: 'auto', // light | dark | auto
    removeGames: true,
    hideAds: false,
    showToggle: true
  };

  var THEME_ORDER = ['auto', 'light', 'dark'];

  // 页游入口的文本特征（要求整段文本就是这个，避免误伤分类名「游戏」）
  var GAME_TEXT = /^(页游|网页游戏|游戏中心|游戏大厅|游戏专区|小游戏|h5游戏|免费页游|起点游戏|游戏平台|游戏推荐)$/i;
  var GAME_WORDS = /(页游|网页游戏|游戏中心|游戏大厅|游戏专区|h5游戏)/i;
  // 已知的页游域名 / 路径
  var GAME_HOST = /(^|\.)(wan|game|games|youxi|h5|play)\.qidian\.com$/i;
  var GAME_PATH = /^\/(games?|youxi|gamecenter|game-center|webgame)(\/|$)/i;
  var QIDIAN_HOST = /(^|\.)qidian\.com$/i;
  // 可能是页游入口的容器类名（保守：必须同时命中文本特征才会隐藏）
  var GAME_BOX = /(game|youxi|webgame)/i;
  // 实抓 www.qidian.com 得到的页游入口标记，整体隐藏（不是只藏里面的链接）
  var GAME_SELECTORS = [
    '#j-topOpBox',
    '#topGameOp',
    '.top-op-box',
    '.top-game-op',
    'li#game-web',
    'li.game.web',
    '#web-dropdown',
    '.game-dropdown',
    '.web-game-list'
  ];

  var READER_HOST = /(^|\.)(read|vipreader|vip)\.qidian\.com$/i;

  /* ====================== 状态 ====================== */

  var settings = Object.assign({}, DEFAULTS);
  var hiddenNodes = []; // 被隐藏的页游节点，关闭开关时原样恢复
  var toggleHost = null;
  var observer = null;
  var sweepTimer = null;
  var adaptTimer = null;
  var coverTimer = null;
  var stopped = false;

  /* ====================== 工具 ====================== */

  function isReaderUrl(href) {
    try {
      var u = new URL(href, location.href);
      if (READER_HOST.test(u.hostname)) return true;
      if (/\/chapter\//i.test(u.pathname)) return true;
      return false;
    } catch (e) {
      return /\/(chapter)\//i.test(String(href || ''));
    }
  }

  // 书籍详情页 /book/{id}/：站点是另一套浅色玻璃拟态模板（首屏靠负层级装饰层），
  // 夜间主题在那页会露出半黑半白，所以这一页固定日间。
  // 用非锚定匹配，这样本地 file:// 回归用例（tools/book/detail-test.html）也能走同一条代码路径。
  function isHomePage() {
    return location.pathname === '/' || location.pathname === '';
  }

  function isDetailPage() {
    return /\/book\//i.test(location.pathname);
  }

  function root() {
    return document.documentElement;
  }

  function setAttr(name, on) {
    if (!root()) return;
    if (on) root().setAttribute(name, 'on');
    else root().removeAttribute(name);
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(keys, function (res) {
          resolve(res || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.set(obj, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function readSettings() {
    return storageGet(Object.keys(DEFAULTS)).then(function (res) {
      return Object.assign({}, DEFAULTS, res);
    });
  }

  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    mirrorToPage();
    applySettings();
    return storageSet(patch);
  }

  // 把配置写进页面 localStorage，early.js 下次首屏可同步读取 → 无闪烁
  function mirrorToPage() {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(settings));
    } catch (e) {
      /* localStorage 被禁用时忽略，仅退化为轻微闪烁 */
    }
  }

  function resolvedTheme() {
    if (settings.theme === 'dark' || settings.theme === 'light') return settings.theme;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  /* ====================== 页游入口清理 ====================== */

  function isGameLink(a) {
    var text = (a.textContent || '').replace(/\s+/g, '').trim();
    if (GAME_TEXT.test(text)) return true;

    var raw = a.getAttribute('href') || a.getAttribute('data-href') || '';
    if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return false;

    var u;
    try {
      u = new URL(raw, location.href);
    } catch (e) {
      return false;
    }
    if (!QIDIAN_HOST.test(u.hostname)) return false;
    if (GAME_HOST.test(u.hostname)) return true;
    if (GAME_PATH.test(u.pathname)) return true;
    // 带明显游戏意图的路径片段（如 /game/xxx、/youxi/xxx）
    if (/\/(game|games|youxi|webgame)\//i.test(u.pathname)) return true;
    return false;
  }

  // 找到「最小可隐藏容器」：优先 li，其次是明确的小型入口容器，最后才是元素自身
  function hideTarget(el) {
    var node = el;
    for (var i = 0; i < 3 && node && node !== document.body; i++) {
      var tag = node.tagName;
      if (tag === 'LI') return node;
      var cls = (node.className && typeof node.className === 'string' ? node.className : '') + ' ' +
        (node.id || '');
      if (/(entry|toolbar|tool-bar|topbar|top-bar|menu-item|nav-item|btn|button|link)/i.test(cls)) {
        // 只隐藏「文本很短」的小入口，避免整块导航被吞掉
        if ((node.textContent || '').replace(/\s+/g, '').length <= 12) return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function markHidden(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.hasAttribute('data-qd-hidden')) return;
    el.setAttribute('data-qd-hidden', '1');
    hiddenNodes.push(el);
  }

  function unhideGames() {
    for (var i = 0; i < hiddenNodes.length; i++) {
      var el = hiddenNodes[i];
      if (el && el.removeAttribute) el.removeAttribute('data-qd-hidden');
    }
    hiddenNodes = [];
    var leftovers = document.querySelectorAll('[data-qd-hidden="1"]');
    for (var j = 0; j < leftovers.length; j++) leftovers[j].removeAttribute('data-qd-hidden');
  }

  function sweepGames() {
    if (stopped || !settings.enabled || !settings.removeGames) return;

    // 0) 实抓到的页游入口：整体隐藏容器（只藏里面的链接会留下一条空白带）
    for (var s = 0; s < GAME_SELECTORS.length; s++) {
      var nodes = document.querySelectorAll(GAME_SELECTORS[s]);
      for (var n = 0; n < nodes.length; n++) markHidden(nodes[n]);
    }

    // 1) 链接型入口
    var anchors = document.querySelectorAll('a[href], a[data-href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.hasAttribute('data-qd-hidden') || a.closest('[data-qd-hidden="1"]')) continue;
      if (isGameLink(a)) markHidden(hideTarget(a));
    }

    // 2) 非链接型入口：类名/ID 带 game 且文本明确指向页游
    var boxes = document.querySelectorAll('[class*="game" i], [class*="youxi" i], [id*="game" i]');
    for (var k = 0; k < boxes.length; k++) {
      var box = boxes[k];
      if (box.hasAttribute('data-qd-hidden') || box.closest('[data-qd-hidden="1"]')) continue;
      var cls = (box.className && typeof box.className === 'string' ? box.className : '') + ' ' + (box.id || '');
      if (!GAME_BOX.test(cls)) continue;
      var t = (box.textContent || '').replace(/\s+/g, '');
      if (t.length > 0 && t.length <= 14 && GAME_WORDS.test(t)) markHidden(box);
    }

    // 记录一下规模，便于用户在控制台自检
    if (hiddenNodes.length && window.console && console.debug) {
      console.debug('[起点极简] 已隐藏页游/游戏入口节点：' + hiddenNodes.length);
    }
  }

  function scheduleSweep(delay) {
    if (stopped || !settings.enabled || !settings.removeGames) return;
    if (sweepTimer) return;
    sweepTimer = setTimeout(function () {
      sweepTimer = null;
      try {
        sweepGames();
      } catch (e) {
        /* 站点结构异常时静默失败，绝不影响页面本身 */
      }
    }, typeof delay === 'number' ? delay : 200);
  }

  function scheduleAdapt(delay) {
    if (stopped || !settings.enabled) return;
    if (adaptTimer) return;
    adaptTimer = setTimeout(function () {
      adaptTimer = null;
      try {
        adaptUnknownTemplate();
      } catch (e) {
        /* 忽略 */
      }
    }, typeof delay === 'number' ? delay : 300);
  }

  function scheduleCovers(delay) {
    if (stopped || !settings.enabled) return;
    if (coverTimer) return;
    coverTimer = setTimeout(function () {
      coverTimer = null;
      try {
        injectBookCovers();
      } catch (e) {
        /* 忽略 */
      }
    }, typeof delay === 'number' ? delay : 400);
  }

  function removeBookCovers() {
    var i;
    var boxes = document.querySelectorAll('.qd-cover-box');
    for (i = 0; i < boxes.length; i++) {
      if (boxes[i].parentNode) boxes[i].parentNode.removeChild(boxes[i]);
    }
    var rows = document.querySelectorAll('[data-qd-cover-row]');
    for (i = 0; i < rows.length; i++) rows[i].removeAttribute('data-qd-cover-row');
    var cells = document.querySelectorAll('.qd-cover-cell');
    for (i = 0; i < cells.length; i++) cells[i].classList.remove('qd-cover-cell');
    var tags = document.querySelectorAll('.qd-cover-tag');
    for (i = 0; i < tags.length; i++) tags[i].classList.remove('qd-cover-tag');
    var links = document.querySelectorAll('a[data-qd-cover]');
    for (i = 0; i < links.length; i++) links[i].removeAttribute('data-qd-cover');
    ungrowContainers();
    if (document.documentElement) document.documentElement.style.removeProperty('--qd-tag-w');
  }

  function startObserver() {
    if (observer || stopped || !document.body) return;
    observer = new MutationObserver(function (muts) {
      // 只关心「结构变化」和「class/style/hidden 变化」：
      // 后者是必需的 —— 站点很多条（底部操作条、浮层）是先渲染好、
      // 靠切 class 才显示的，只盯 childList 会永远漏掉它们。
      // 同时把自己的 data-qd-* 标记排除在外，避免自触发死循环。
      var relevant = false;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') {
          var n = m.attributeName || '';
          if (n.indexOf('data-qd-') === 0) continue;
        }
        relevant = true;
        break;
      }
      if (!relevant) return;
      scheduleSweep(300);
      scheduleAdapt(700);
      scheduleCovers(700);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
    if (adaptTimer) {
      clearTimeout(adaptTimer);
      adaptTimer = null;
    }
    if (coverTimer) {
      clearTimeout(coverTimer);
      coverTimer = null;
    }
  }

  /* ====================== 悬浮日夜切换按钮（Shadow DOM） ====================== */

  var SHADOW_CSS = [
    ':host{all:initial}',
    // 站点右下角有 .page-bottom-fixed（64px 宽，bottom:64px 起），按钮放在它正下方避让
    '.btn{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:44px;height:44px;',
    'display:flex;align-items:center;justify-content:center;cursor:pointer;',
    'border-radius:12px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);',
    'box-shadow:0 6px 20px rgba(12,14,20,.14);',
    'transition:transform .18s cubic-bezier(.2,.7,.3,1),background-color .18s,border-color .18s;}',
    '.btn:hover{transform:translateY(-2px);border-color:var(--ac);color:var(--ac)}',
    '.btn:active{transform:translateY(0) scale(.96)}',
    '.btn:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
    '.btn svg{width:20px;height:20px;display:block;pointer-events:none}',
    '.tip{position:fixed;right:72px;bottom:28px;z-index:2147483001;max-width:200px;',
    'font:500 12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;',
    'white-space:nowrap;padding:6px 10px;border-radius:8px;background:var(--bg);color:var(--fg);',
    'border:1px solid var(--bd);box-shadow:0 6px 20px rgba(12,14,20,.14);',
    'opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .16s,transform .16s}',
    '.tip.on{opacity:1;transform:translateY(0)}',
    'svg .sun{display:none}',
    ':host([data-resolved="light"]) svg .sun{display:block}',
    ':host([data-resolved="light"]) svg .moon{display:none}'
  ].join('');

  var ICON_SUN =
    '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2"/>' +
    '<path d="M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>';

  var ICON_MOON =
    '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>';

  function paintToggle(host) {
    if (!host) return;
    var dark = resolvedTheme() === 'dark';
    // 与 theme.css 的令牌保持一致：夜间框内 #171C20 / 线 #303539 / 字 #BEC8D2
    var light = { bg: '#ffffff', fg: '#15171c', bd: '#e4e7ec', ac: '#e03e52' };
    var darkT = { bg: '#171c20', fg: '#bec8d2', bd: '#303539', ac: '#ff5a76' };
    var c = dark ? darkT : light;
    host.style.setProperty('--bg', c.bg);
    host.style.setProperty('--fg', c.fg);
    host.style.setProperty('--bd', c.bd);
    host.style.setProperty('--ac', c.ac);
    host.setAttribute('data-resolved', dark ? 'dark' : 'light');
    var btn = host.shadowRoot && host.shadowRoot.querySelector('.btn');
    if (btn) {
      btn.setAttribute(
        'aria-label',
        dark ? '切换为日间模式' : '切换为夜间模式'
      );
    }
    var tip = host.shadowRoot && host.shadowRoot.querySelector('.tip');
    if (tip) {
      tip.textContent =
        (dark ? '夜间' : '日间') + ' · 点击切换日夜';
    }
  }

  function mountToggle() {
    if (stopped || toggleHost) {
      paintToggle(toggleHost);
      return;
    }
    var host = document.createElement('div');
    host.id = 'qd-minimal-toggle';
    // 防止站点脚本 / 样式干扰：宿主本身不进布局流
    host.style.cssText = 'all:initial;position:static;';
    var sr = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    sr.appendChild(style);

    var btn = document.createElement('div');
    btn.className = 'btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = ICON_SUN + ICON_MOON;
    sr.appendChild(btn);

    var tip = document.createElement('div');
    tip.className = 'tip';
    sr.appendChild(tip);

    function doToggle() {
      var next = resolvedTheme() === 'dark' ? 'light' : 'dark';
      saveSettings({ theme: next });
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      doToggle();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        doToggle();
      }
    });
    btn.addEventListener('mouseenter', function () {
      tip.classList.add('on');
    });
    btn.addEventListener('mouseleave', function () {
      tip.classList.remove('on');
    });

    (document.body || document.documentElement).appendChild(host);
    toggleHost = host;
    paintToggle(host);
  }

  function unmountToggle() {
    if (toggleHost && toggleHost.parentNode) toggleHost.parentNode.removeChild(toggleHost);
    toggleHost = null;
  }

  /* ====================== 页面结构导出（给「加选择器」用） ====================== */

  var SKIP_TAGS = /^(script|style|noscript|template|svg|path|iframe|canvas)$/;

  function buildOutline() {
    var MAX_DEPTH = 8;
    var MAX_LINES = 1200;
    var lines = [];

    function describe(el) {
      var tag = el.tagName.toLowerCase();
      var s = tag;
      if (el.id) s += '#' + el.id;
      var cls = typeof el.className === 'string' ? el.className.trim() : '';
      if (cls) s += '.' + cls.split(/\s+/).slice(0, 5).join('.');
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (!el.children.length && t && t.length <= 24) s += ' » ' + t;
      return s;
    }

    function walk(node, depth) {
      var kids = node.children;
      for (var i = 0; i < kids.length; i++) {
        if (lines.length >= MAX_LINES) {
          lines.push('…（已达 ' + MAX_LINES + ' 行上限，可提高 tools/dom-outline.mjs 的深度再看）');
          return;
        }
        var el = kids[i];
        var tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.test(tag)) continue;
        lines.push(new Array(depth + 1).join('  ') + describe(el));
        if (depth < MAX_DEPTH) walk(el, depth + 1);
      }
    }

    walk(document.body || document.documentElement, 1);

    return (
      [
        '# 起点极简 · 页面结构导出',
        '# URL: ' + location.href,
        '# 时间: ' + new Date().toISOString(),
        '# 用途：把这份内容发回给扩展作者，用于补齐 theme.css 中缺少的真实选择器',
        ''
      ].join('\n') + lines.join('\n')
    );
  }

  /* ====================== 未知模板的夜间自适应 ======================
   * my.qidian.com 个人中心那十几个页面需要登录才能拿到真实 DOM，没法逐个写选择器。
   * 这里改用运行时探测，只做两件判定很确定的事：
   *   ① 底色「近白且近灰」的块（站点写死的 #fff / #fafafa / #f7f7fc …）→ 标记后交给表面色
   *   ② 这些块内部「近黑且近灰」的文字 → 标记后交给主题文字色（保住可读性）
   * 判定同时要求「低饱和」：纯白/浅灰会命中，浅红浅蓝这类彩色底不会被误伤。
   * 只在夜间生效；切回日间会清空全部标记，日间页面一个字节都不动。
   */

  var ADAPT_SELECTOR =
    'div,section,article,aside,li,ul,ol,dl,dt,dd,table,thead,tbody,tr,td,th,form,header,footer,nav,main,' +
    'p,h1,h2,h3,h4,h5,h6,span,a,strong,em,i,b,cite,label,button';
  var ADAPT_MAX_ELEMENTS = 5000;
  // 「大面积亮色」的阈值（px²）：约 78×78。
  // 超过它的亮底一律压成表面色（不管色相），小于它的亮块（徽标/标签/小按钮）保持原样。
  var ADAPT_LIGHT_AREA = 6000;
  var ADAPT_MIN_INTERVAL = 1200;
  var adaptiveMarks = [];
  var lastAdaptAt = 0;

  function parseRGB(str) {
    var m = /rgba?\(([^)]+)\)/.exec(String(str || ''));
    if (!m) return null;
    var p = m[1].split(',');
    if (p.length < 3) return null;
    return {
      r: parseFloat(p[0]),
      g: parseFloat(p[1]),
      b: parseFloat(p[2]),
      a: p.length > 3 ? parseFloat(p[3]) : 1
    };
  }

  function inkLuminance(c) {
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  function isGrayish(c) {
    return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 24;
  }

  function isBright(c) {
    return inkLuminance(c) > 0.72;
  }

  function isDark(c) {
    return inkLuminance(c) < 0.45;
  }

  var DARK_SURFACE = { r: 23, g: 28, b: 32, a: 1 }; // #171C20，压暗后的等效底色

  /*
   * 选中行识别（普世做法）：同一父容器里，若某一行「被刷成亮色」而它的兄弟行没有，
   * 那基本就是站点的选中高亮 —— 各种命名都有（selected / current / on / check…），
   * 还有直接把背景刷在 td 上的。所以这里按「行与兄弟行对比」判定，
   * 不认识任何 class，也不需要知道它把背景刷在哪一层。
   */
  function rowPaint(row, origBg) {
    var own = origBg ? origBg.get(row) : parseRGB(getComputedStyle(row).backgroundColor);
    if (own && own.a >= 0.9) return own;
    // 背景刷在单元格上也算（站点常见做法）
    var cell = row.firstElementChild;
    if (cell && (cell.tagName === 'TD' || cell.tagName === 'TH')) {
      var c = origBg ? origBg.get(cell) : parseRGB(getComputedStyle(cell).backgroundColor);
      if (c && c.a >= 0.9) return c;
    }
    return null;
  }

  /*
   * ⚠ 必须在**主扫描过程中**把原始底色缓存下来再用（origBg）：
   *   主扫描会先给亮块打上 data-qd-light，之后 getComputedStyle 读到的就已经是
   *   被压暗后的颜色了 —— 那时再判断「这行是不是亮的」永远是 false。
   */
  function markSelectedRows(origBg) {
    var rows = document.querySelectorAll('tr, li');
    var limit = Math.min(rows.length, ADAPT_MAX_ELEMENTS);
    for (var i = 0; i < limit; i++) {
      var row = rows[i];
      if (row.hasAttribute('data-qd-sel')) continue;
      var parent = row.parentElement;
      if (!parent || parent.children.length < 2) continue;
      var mine = rowPaint(row, origBg);
      if (!mine || !isBright(mine)) continue;
      var sibs = parent.children;
      var same = 0;
      var brightSibs = 0;
      for (var k = 0; k < sibs.length; k++) {
        if (sibs[k] === row || sibs[k].tagName !== row.tagName) continue;
        same++;
        var p = rowPaint(sibs[k], origBg);
        if (p && isBright(p) && p.r === mine.r && p.g === mine.g && p.b === mine.b) brightSibs++;
      }
      // 兄弟里没有一个是同样亮色的 → 这是选中态，不是列表底色
      if (same >= 1 && brightSibs === 0) {
        row.setAttribute('data-qd-sel', '1');
        adaptiveMarks.push(row);
      }
    }
  }

  function clearAdaptive() {
    var i;
    for (i = 0; i < adaptiveMarks.length; i++) {
      var el = adaptiveMarks[i];
      if (el && el.removeAttribute) {
        el.removeAttribute('data-qd-light');
        el.removeAttribute('data-qd-text');
        el.removeAttribute('data-qd-text2');
        el.removeAttribute('data-qd-sel');
      }
    }
    adaptiveMarks = [];
    var left = document.querySelectorAll('[data-qd-light],[data-qd-text],[data-qd-text2],[data-qd-sel]');
    for (i = 0; i < left.length; i++) {
      left[i].removeAttribute('data-qd-light');
      left[i].removeAttribute('data-qd-text');
      left[i].removeAttribute('data-qd-text2');
      left[i].removeAttribute('data-qd-sel');
    }
  }

  /*
   * 未知模板的夜间自适应（横扫式）
   *   ① 大面积亮底（不论色相）→ 压成表面色，夜里不保留任何大片亮块
   *   ② 文字可读性：算出每个元素的「有效底色」（自身不透明底，否则继承最近祖先），
   *      只要底色是暗的、字也是暗的 → 提亮。
   *      这一条不限于亮块内部，所以侧栏未选中项、底部操作条、页脚链接这些
   *      「暗底暗字」都会被一起修好。
   *   小面积亮块（徽标/标签）保持原样，其上的深色文字也不会被误改。
   * 先读后写：所有几何/颜色读取在一轮里完成，标记统一在最后施加，避免反复重排。
   */
  function adaptUnknownTemplate() {
    if (stopped || !settings.enabled) return;
    if (resolvedTheme() !== 'dark') {
      clearAdaptive();
      return;
    }
    if (!document.body) return;
    var now = Date.now();
    if (now - lastAdaptAt < ADAPT_MIN_INTERVAL) {
      // ⚠ 不能直接 return：那样这次扫描就被**丢掉**了，而触发它的那次变化
      //   （例如选中后才显示的底部操作条）就永远不会被处理。
      //   正确做法是推迟到间隔满足时再跑。
      scheduleAdapt(ADAPT_MIN_INTERVAL - (now - lastAdaptAt) + 30);
      return;
    }
    lastAdaptAt = now;

    var all = document.body.querySelectorAll(ADAPT_SELECTOR);
    var limit = Math.min(all.length, ADAPT_MAX_ELEMENTS);
    var pageBg = parseRGB(getComputedStyle(document.body).backgroundColor) || { r: 11, g: 9, b: 16, a: 1 };
    var effBg = new WeakMap();
    var origBg = new WeakMap(); // 主扫描前的原始底色，选中态判定要用
    var toLight = [];
    var toText = [];
    var toText2 = [];
    var i;

    for (i = 0; i < limit; i++) {
      var el = all[i];
      if (el.hasAttribute('data-qd-light') || el.hasAttribute('data-qd-text') || el.hasAttribute('data-qd-text2')) {
        effBg.set(el, DARK_SURFACE);
        continue;
      }
      var cs = getComputedStyle(el);
      var own = parseRGB(cs.backgroundColor);
      var hasOwn = !!(own && own.a >= 0.9);
      origBg.set(el, hasOwn ? own : null);
      var parentEff = el.parentElement ? effBg.get(el.parentElement) || pageBg : pageBg;
      var eff = hasOwn ? own : parentEff;

      // ① 大面积亮底 → 压暗
      if (hasOwn && isBright(own) && el.offsetWidth * el.offsetHeight >= ADAPT_LIGHT_AREA) {
        toLight.push(el);
        eff = DARK_SURFACE;
      }
      effBg.set(el, eff);

      // ② 暗底 + 暗字 → 提亮
      var c = parseRGB(cs.color);
      if (c && c.a >= 0.9 && isDark(eff)) {
        var lum = inkLuminance(c);
        if (lum < 0.5) {
          if (isGrayish(c) && lum < 0.28) toText.push(el);
          else toText2.push(el);
        }
      }
    }

    for (i = 0; i < toLight.length; i++) {
      toLight[i].setAttribute('data-qd-light', '1');
      adaptiveMarks.push(toLight[i]);
    }
    for (i = 0; i < toText.length; i++) {
      toText[i].setAttribute('data-qd-text', '1');
      adaptiveMarks.push(toText[i]);
    }
    for (i = 0; i < toText2.length; i++) {
      toText2[i].setAttribute('data-qd-text2', '1');
      adaptiveMarks.push(toText2[i]);
    }

    // 选中行（浅色高亮）单独处理：它常常只刷在单元格上、面积不够阈值，
    // 也可能用任何 class 命名，所以靠「与兄弟行对比」来认。
    try {
      markSelectedRows(origBg);
    } catch (e) {
      /* 忽略 */
    }    // 频道页顶部横幅：启发式会误伤正文（曾把频道页书单整块隐藏），已停用。
    // 改用 theme.css 里基于实抓结构的精确规则。
  }

  /* ====================== 书架：给每本书补封面 ======================
   * 站点封面地址是有规律的（实抓验证：qdbimg/349573 为常量，20/20 一致）：
   *   https://bookcover.yuewen.com/qdbimg/349573/{书号}/150.webp
   * 书号直接从每行的 /book/{id}/ 链接里取，所以不需要知道这一页的 class。
   */
  var COVER_BASE = 'https://bookcover.yuewen.com/qdbimg/349573/';
  var COVER_WIDTH = '150';

  function isBookcasePage() {
    return /\/bookcase/i.test(location.pathname);
  }

  function bookIdFromLink(a) {
    var href = a.getAttribute('href') || '';
    var m = /\/book\/(\d{4,})/i.exec(href);
    return m ? m[1] : '';
  }

  /*
   * 标签列宽：**量出来**，不写死。
   * 书名前常有分类标签（「玄幻」「轻小说」「诸天无限」…），长度各不相同，
   * 不统一就会把书名起点挤得参差不齐。这里取所有标签里的最大自然宽度，
   * 用它当统一的 min-width —— 任何作品、任何标签长度都对齐，且不需要改代码。
   * 测量前先清掉变量，否则量到的是被撑开后的宽度（自反馈）。
   */
  function syncCoverTagWidth() {
    var root = document.documentElement;
    if (!root) return;
    var tags = document.querySelectorAll('.qd-cover-cell .qd-cover-tag');
    if (!tags.length) {
      root.style.removeProperty('--qd-tag-w');
      return;
    }
    root.style.removeProperty('--qd-tag-w');
    var max = 0;
    for (var i = 0; i < tags.length; i++) {
      var w = Math.ceil(tags[i].getBoundingClientRect().width);
      if (w > max) max = w;
    }
    // 兜底：真正的分类标签不可能这么宽。量到超宽说明标记到了容器，
    // 这时宁可放弃对齐，也不能让书名被压坏。
    if (max > 200) return;
    if (max > 0) {
      // 向上取整到 2px：字体渲染有亚像素差，不取整会导致每次测量都微调、来回抖动
      root.style.setProperty('--qd-tag-w', Math.ceil(max / 2) * 2 + 'px');
    }
  }

  /*
   * 自检并退让：封面和对齐都可能把书名挤坏 —— 窗口一变窄（非全屏），
   * 书格宽度不够，书名就会被站点的 nowrap + ellipsis 压成「…」。
   *
   * 判据刻意不用「元素盒子宽度」：书名元素是块级，盒子宽度等于整格宽度，
   * 真正被压缩的是**行盒**（浮动封面把行盒挤短），量盒子根本量不出来。
   * 改用 nowrap + ellipsis 的天然指标：scrollWidth 是完整文字宽度，
   * clientWidth 是可见宽度 —— 完整文字比可见宽度还长一大截，就是被压扁了。
   * 只要过半书名被压扁，就依次退让：
   *   ① 先放弃标签统一宽度（对齐是加分项，书名可读是底线）
   *   ② 仍不够就把封面缩小一档
   */
  function verifyCoversFit() {
    var root = document.documentElement;
    if (!root) return 'no-root';
    var links = document.querySelectorAll('a[data-qd-cover]');
    if (!links.length) return 'no-cover';
    var total = 0;
    var clipped = 0;
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!(a.textContent || '').replace(/\s+/g, '')) continue;
      total++;
      var need = a.scrollWidth || 0; // 完整文字宽度
      var have = a.clientWidth || 0; // 可见宽度
      if (need > 0 && have > 0 && need > have * 1.5) clipped++;
    }
    if (total && clipped > total / 2) {
      var cur = (root.style.getPropertyValue('--qd-tag-w') || '').trim();
      if (cur && cur !== '0px') {
        root.style.setProperty('--qd-tag-w', '0px');
        return 'backoff-tag';
      }
      if (!root.classList.contains('qd-cover-tight')) {
        root.classList.add('qd-cover-tight');
        return 'backoff-cover';
      }
    } else {
      root.classList.remove('qd-cover-tight');
    }
    return 'ok';
  }

  function injectBookCovers() {
    if (stopped || !settings.enabled || !isBookcasePage()) return;
    var anchors = document.querySelectorAll('a[href*="/book/"]');
    var added = 0;
    var touchedRows = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.getAttribute('data-qd-cover') === '1') continue;
      // 一行一本书：表格行、列表项、定义项都算，不绑定某一种模板
      var row = a.closest('tr, li, dd');
      if (!row) continue;
      // 行内已经有图（封面/头像）就跳过 —— 顶部「编辑推荐 / 游戏推荐」那种
      // 封面轮播因此天然被排除，不需要额外写死它的 class。
      if (row.querySelector('img')) continue;
      var text = (a.textContent || '').replace(/\s+/g, '');
      if (!text || text.length > 40) continue;
      var id = bookIdFromLink(a);
      if (!id) continue;
      if (row.getAttribute('data-qd-cover-row') === '1') continue;
      row.setAttribute('data-qd-cover-row', '1');

      var cell = a.closest('td') || a.parentElement;
      if (!cell) continue;

      // 用 <a> 包一层：封面可点，且语义与书名链接一致
      var box = document.createElement('a');
      box.className = 'qd-cover-box';
      box.href = a.getAttribute('href') || '#';
      box.setAttribute('tabindex', '-1');
      box.setAttribute('aria-hidden', 'true');
      var img = document.createElement('img');
      img.className = 'qd-cover';
      img.loading = 'lazy';
      img.alt = '';
      img.src = COVER_BASE + id + '/' + COVER_WIDTH + '.webp';
      img.addEventListener('error', function () {
        // 取不到封面就把占位收掉，不留破图
        var p = this.parentNode;
        if (p && p.parentNode) p.parentNode.removeChild(p);
      });
      box.appendChild(img);

      // ⚠ 插到书格**最前面**，而不是书名链接前：
      //   书格前面常有长度不一的标签，插在链接前会让每本书的封面左边缘参差不齐；
      //   放到最前面才能整列对齐。
      cell.insertBefore(box, cell.firstChild);
      cell.classList.add('qd-cover-cell');

      // 封面与书名之间的标签统一标记，宽度由 syncCoverTagWidth() 量出后统一。
      // ⚠ 从书名链接**往上**走，逐层标记「排在它前面的叶子元素」：
      //   真实 DOM 常见两种 ——  td > (em.tag + a书名)
      //                    td > div.book-info > (em.tag + h3 > a书名)
      //   第一种是兄弟，第二种标签在容器里面。只标记叶子元素、且绝不含书名链接，
      //   这样容器永远不会被当标签（一旦被当标签，整块会被折成一行压成「…」，
      //   书名就整列消失 —— 线上实测的回归）。
      var node = a;
      var guard = 0;
      while (node && node !== cell && guard < 6) {
        var prev = node.previousElementSibling;
        while (prev) {
          if (prev.children.length === 0 && !prev.contains(a)) prev.classList.add('qd-cover-tag');
          prev = prev.previousElementSibling;
        }
        node = node.parentElement;
        guard++;
      }

      a.setAttribute('data-qd-cover', '1');
      touchedRows.push(row);
      added++;
    }

    if (added) {
      syncCoverTagWidth();
      relaxRowContainers(touchedRows);
    }
    // 每次都要复核（added 为 0 时也要）：窗口变窄是「没有新增封面」的变化，
    // 但同样会把书名挤坏，必须能退让。
    if (document.querySelector('a[data-qd-cover]')) verifyCoversFit();

    if (added && window.console && console.debug) {
      console.debug('[起点极简] 已为 ' + added + ' 本书补上封面');
    }
  }

  /*
   * 封面会让每行变高，而站点常把列表容器按「原行高 × 条数」写死高度，
   * 于是行会**溢出容器边框**（最近阅读页实测：行跑到卡片外面压住页脚）。
   *
   * 这里只做一件很窄的事：从被注入的行往上找祖先，
   * 若某祖先「高度写死」且「内容确实比盒子高」且「溢出是可见的或直接被裁掉」，
   * 就把它的固定高度放开（加 .qd-grow，由 CSS 置为 height:auto）。
   *
   * 刻意**不碰** overflow 为 auto/scroll 的容器 —— 那是站点有意做的内滚动区，
   * 内容高于盒子属于正常，放开高度反而会破坏它的滚动。
   * 也不碰表格内部元素（table/tr/td 的 height 只是建议值，不会真的裁内容）。
   */
  var TABLE_TAGS = /^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|COL|COLGROUP)$/;
  var growList = [];

  function relaxRowContainers(rows) {
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i].parentElement;
      var depth = 0;
      while (el && el !== document.body && el !== document.documentElement && depth < 8) {
        if (!TABLE_TAGS.test(el.tagName) && el.classList && !el.classList.contains('qd-grow')) {
          var cs = getComputedStyle(el);
          var h = parseFloat(cs.height);
          var fixed = cs.height !== 'auto' && !isNaN(h) && h > 0;
          var oy = cs.overflowY;
          if (fixed && (oy === 'visible' || oy === 'hidden') && el.scrollHeight > el.clientHeight + 2) {
            el.classList.add('qd-grow');
            growList.push(el);
          }
        }
        el = el.parentElement;
        depth++;
      }
    }
  }

  function ungrowContainers() {
    var i;
    for (i = 0; i < growList.length; i++) {
      if (growList[i] && growList[i].classList) growList[i].classList.remove('qd-grow');
    }
    growList = [];
    var left = document.querySelectorAll('.qd-grow');
    for (i = 0; i < left.length; i++) left[i].classList.remove('qd-grow');
  }

  /* ====================== 频道页顶部横幅 ======================
   * 频道页（/xianxia/ 这类）顶部是一块巨大的装饰横幅，中间还钉着一个起点 logo，
   * 很突兀。它的 class 各频道都不一样（实抓确认：既没有 banner 类名，也没有 img），
   * 所以按「几何 + 内容特征」识别，不猜 class：
   *   ① 位于页面上部（top < 620）  ② 够大（宽 >= 视口一半、高 >= 140）
   *   ③ 有背景图 / 内含 img / 含 logo 子元素
   * 只处理最靠上的那一个，避免误伤正文里的大图。
   */
  var CHANNEL_PATH = /^\/(xianxia|xuanhuan|dushi|kehuan|lishi|wuxia|qihuan|lingyi|2cy|zhutianwuxian|youxi)\/?$/i;
  var bannerEl = null;

  function hideChannelBanner() {
    if (stopped || !settings.enabled || bannerEl) return;
    if (!CHANNEL_PATH.test(location.pathname)) return;
    var scope = document.querySelector('.wrap') || document.body;
    if (!scope) return;
    var kids = scope.querySelectorAll('div,section,a');
    var best = null;
    var limit = Math.min(kids.length, 240);
    for (var i = 0; i < limit; i++) {
      var el = kids[i];
      var r = el.getBoundingClientRect();
      if (r.top > 620 || r.height < 140 || r.width < window.innerWidth * 0.5) continue;
      var cs = getComputedStyle(el);
      var hasBg = cs.backgroundImage && cs.backgroundImage !== 'none';
      var hasImg = !!el.querySelector('img');
      var hasLogo = /logo/i.test(String(el.className || '')) || !!el.querySelector('[class*="logo" i]');
      if (!(hasBg || hasImg || hasLogo)) continue;
      if (!best || r.top < best.top) best = { el: el, top: r.top };
    }
    if (best) {
      best.el.setAttribute('data-qd-hidebanner', '1');
      bannerEl = best.el;
    }
  }

  function restoreChannelBanner() {
    if (bannerEl) {
      bannerEl.removeAttribute('data-qd-hidebanner');
      bannerEl = null;
    }
    var left = document.querySelectorAll('[data-qd-hidebanner]');
    for (var i = 0; i < left.length; i++) left[i].removeAttribute('data-qd-hidebanner');
  }
  /* ====================== 应用配置 ====================== */

  function applySettings() {
    if (stopped) return;
    var r = root();
    if (!r) return;

    var dayLock = false; // v1.7.0：详情页并入夜间，不再固定日间

    if (!settings.enabled) {
      r.removeAttribute('data-qd-minimal');
      r.removeAttribute('data-qd-theme');
      r.removeAttribute('data-qd-nogames');
      r.removeAttribute('data-qd-noads');
      r.removeAttribute('data-qd-resolved');
      r.removeAttribute('data-qd-daylock');
      unhideGames();
      clearAdaptive();
      removeBookCovers();
      restoreChannelBanner();
      stopObserver();
      unmountToggle();
      return;
    }

    r.setAttribute('data-qd-minimal', 'on');
    r.setAttribute('data-qd-theme', settings.theme);
    if (isHomePage()) r.setAttribute('data-qd-home', '1');
    else r.removeAttribute('data-qd-home');
    r.removeAttribute('data-qd-daylock');
    r.setAttribute('data-qd-resolved', resolvedTheme());
    setAttr('data-qd-nogames', !!settings.removeGames);
    setAttr('data-qd-noads', !!settings.hideAds);

    mirrorToPage();

    // 详情页固定日间：不挂悬浮按钮（点了也不会变），改由弹窗说明
    if (settings.showToggle) mountToggle();
    else unmountToggle();

    if (settings.removeGames) {
      startObserver();
      scheduleSweep(120);
    } else {
      stopObserver();
      unhideGames();
    }

    // 观察器同时负责：动态内容里的未知模板自适应、书架封面补齐
    startObserver();
    scheduleAdapt(120);
    scheduleCovers(240);
  }

  /* ====================== 自我卸载（阅读页守卫） ====================== */

  function teardown() {
    stopped = true;
    stopObserver();
    unmountToggle();
    unhideGames();
    clearAdaptive();
    removeBookCovers();
    restoreChannelBanner();
    var r = root();
    if (r) {
      r.removeAttribute('data-qd-minimal');
      r.removeAttribute('data-qd-theme');
      r.removeAttribute('data-qd-nogames');
      r.removeAttribute('data-qd-noads');
      r.removeAttribute('data-qd-resolved');
      r.removeAttribute('data-qd-daylock');
      r.style.removeProperty('background-color');
      r.style.removeProperty('color-scheme');
    }
    var link = document.getElementById('qd-minimal-css');
    if (link && link.parentNode) link.parentNode.removeChild(link);
  }

  function guardReader() {
    if (isReaderUrl(location.href)) {
      teardown();
      return true;
    }
    return false;
  }

  /* ====================== 启动 ====================== */

  function boot() {
    // 第一道防线：阅读页直接退出，什么都不做
    if (guardReader()) return;

    // 注入一份「后置」样式表，保证在同权重下覆盖站点样式（manifest 已先注入一份防闪）
    try {
      if (!document.getElementById('qd-minimal-css')) {
        var link = document.createElement('link');
        link.id = 'qd-minimal-css';
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = chrome.runtime.getURL('src/theme.css');
        link.addEventListener('load', clearAntiFlash);
        (document.head || document.documentElement).appendChild(link);
      }
    } catch (e) {
      /* 忽略 */
    }

    readSettings().then(function (s) {
      if (stopped) return;
      settings = s;
      paintToggle(null);
      applySettings();
      if (!linkStyleLoaded()) setTimeout(clearAntiFlash, 400);
    });

    // 配置变更（其他标签页 / 弹窗）
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        var patch = {};
        for (var k in changes) {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) patch[k] = changes[k].newValue;
        }
        if (!Object.keys(patch).length) return;
        settings = Object.assign({}, settings, patch);
        applySettings();
      });
    } catch (e) {
      /* 忽略 */
    }

    // 消息接口（弹窗）
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || !msg.type) return;
        if (msg.type === 'qd:state') {
          sendResponse({
            ok: true,
            reader: false,
            lockedDay: false,
            enabled: settings.enabled,
            settings: settings,
            resolved: resolvedTheme()
          });
          return true;
        }
        if (msg.type === 'qd:apply') {
          readSettings().then(function (s) {
            settings = s;
            applySettings();
            sendResponse({ ok: true, settings: settings });
          });
          return true; // 异步响应
        }
        if (msg.type === 'qd:toggle-theme') {
          
          var next = resolvedTheme() === 'dark' ? 'light' : 'dark';
          saveSettings({ theme: next });
          sendResponse({ ok: true, theme: next });
          return true;
        }
        if (msg.type === 'qd:outline') {
          var text = '';
          try {
            text = buildOutline();
          } catch (e) {
            text = '# 导出失败：' + (e && e.message);
          }
          sendResponse({ ok: true, outline: text, url: location.href });
          return true;
        }
        if (msg.type === 'qd:cycle-theme') {
          
          var idx = THEME_ORDER.indexOf(settings.theme);
          var nxt = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
          saveSettings({ theme: nxt });
          sendResponse({ ok: true, theme: nxt });
          return true;
        }
        return undefined;
      });
    } catch (e) {
      /* 忽略 */
    }

    // 跟随系统时，系统主题变化需同步按钮图标
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onMq = function () {
        if (settings.theme === 'auto' && settings.enabled && !stopped) {
          setAttr('data-qd-resolved', resolvedTheme());
          paintToggle(toggleHost);
          scheduleAdapt(60); // 跟随系统切到夜间时，未知模板也要跟着适配
        }
      };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    } catch (e) {
      /* 忽略 */
    }

    // 视口变化 / 字体加载完成都会改变标签的自然宽度与可用宽度 → 重新量一次，
    // 并复核书名是否被挤坏（非全屏变窄就是靠这里退让的）。
    try {
      var resizeTimer = null;
      window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          resizeTimer = null;
          if (!stopped && settings.enabled && isBookcasePage()) {
            syncCoverTagWidth();
            verifyCoversFit();
          }
        }, 200);
      });
      if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
        document.fonts.ready.then(function () {
          if (!stopped && settings.enabled && isBookcasePage()) {
            syncCoverTagWidth();
            verifyCoversFit();
          }
        });
      }
    } catch (e) {
      /* 忽略 */
    }

    // URL 变化（站点可能在站内跳转到阅读页）
    try {
      var last = location.href;
      var check = function () {
        if (location.href === last) return;
        last = location.href;
        if (stopped) return;
        guardReader();
      };
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (typeof orig !== 'function') return;
        history[m] = function () {
          var r = orig.apply(this, arguments);
          setTimeout(check, 0);
          return r;
        };
      });
      window.addEventListener('popstate', function () {
        setTimeout(check, 0);
      });
      window.addEventListener('hashchange', check);
    } catch (e) {
      /* 忽略 */
    }
  }

  var _cssLoaded = false;
  function clearAntiFlash() {
    _cssLoaded = true;
    var r = root();
    if (!r) return;
    r.style.removeProperty('background-color');
    r.style.removeProperty('color-scheme');
  }
  function linkStyleLoaded() {
    return _cssLoaded;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
