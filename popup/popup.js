/*!
 * 起点极简 · popup.js
 * 读写 chrome.storage.sync，并把状态同步给所有已打开的起点页面。
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  theme: 'auto',
  removeGames: true,
  hideAds: false,
  showToggle: true
};

const READER_HOST = /(^|\.)(read|vipreader|vip)\.qidian\.com$/i;
const QIDIAN_HOST = /(^|\.)qidian\.com$/i;

const $ = (id) => document.getElementById(id);

const sget = (keys) =>
  new Promise((resolve) => {
    try {
      chrome.storage.sync.get(keys, (res) => resolve(res || {}));
    } catch (e) {
      resolve({});
    }
  });

const sset = (obj) =>
  new Promise((resolve) => {
    try {
      chrome.storage.sync.set(obj, () => resolve());
    } catch (e) {
      resolve();
    }
  });

function classify(url) {
  if (!url) return 'other';
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return 'other';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'other';
  if (!QIDIAN_HOST.test(u.hostname)) return 'other';
  if (READER_HOST.test(u.hostname)) return 'reader';
  if (/\/chapter\//i.test(u.pathname)) return 'reader';
  if (/\/book\//i.test(u.pathname)) return 'detail';
  return 'site';
}

let settings = Object.assign({}, DEFAULTS);
let currentKind = 'other';

/* ---------------- 渲染 ---------------- */

function renderStatus() {
  const dot = $('dot');
  const txt = $('statusText');
  dot.className = 'dot';

  if (currentKind === 'reader') {
    dot.classList.add('off');
    txt.textContent = '阅读页 · 已跳过（阅读页不做任何改动）';
    return;
  }
  if (currentKind === 'detail') {
    dot.classList.add('off');
    txt.textContent = '书籍详情页 · 固定日间（站点为浅色玻璃拟态模板，不套夜间）';
    return;
  }
  if (currentKind === 'site') {
    if (settings.enabled) {
      dot.classList.add('on');
      txt.textContent = '起点页面 · 极简样式已生效';
    } else {
      dot.classList.add('off');
      txt.textContent = '起点页面 · 极简样式已关闭';
    }
    return;
  }
  dot.classList.add('off');
  txt.textContent = '非起点页面 · 等待访问 www.qidian.com';
}

function render() {
  $('enabled').checked = !!settings.enabled;
  $('removeGames').checked = !!settings.removeGames;
  $('hideAds').checked = !!settings.hideAds;
  $('showToggle').checked = !!settings.showToggle;

  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.theme === settings.theme ? 'true' : 'false');
  });

  const body = document.body;
  body.classList.toggle('disabled', !settings.enabled);
  renderStatus();
}

/* ---------------- 写入 ---------------- */

async function save(patch) {
  settings = Object.assign({}, settings, patch);
  render();
  await sset(patch);
  notifyTabs(patch);
}

function notifyTabs(patch) {
  try {
    chrome.tabs.query({ url: ['*://qidian.com/*', '*://*.qidian.com/*'] }, (tabs) => {
      (tabs || []).forEach((t) => {
        if (!t || !t.id) return;
        chrome.tabs.sendMessage(t.id, { type: 'qd:apply' }, () => void chrome.runtime.lastError);
      });
    });
  } catch (e) {
    /* 忽略 */
  }
}

/* ---------------- 事件 ---------------- */

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => save({ theme: btn.dataset.theme }));
});

['enabled', 'removeGames', 'hideAds', 'showToggle'].forEach((id) => {
  $(id).addEventListener('change', (e) => {
    const patch = {};
    patch[id] = e.target.checked;
    save(patch);
  });
});

/* 导出当前页 DOM 轮廓：拿到真实 class 才能给没被优化的页面补选择器 */
$('export').addEventListener('click', async () => {
  const btn = $('export');
  const box = $('outline');
  const hint = $('exportHint');
  btn.textContent = '导出中…';

  const tabs = await new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t || []));
    } catch (e) {
      resolve([]);
    }
  });
  const tab = tabs[0];

  if (!tab || !tab.id || currentKind === 'other') {
    btn.textContent = '导出当前页结构';
    hint.textContent = '当前不是起点页面，没有可导出的结构。';
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'qd:outline' }, async (res) => {
    void chrome.runtime.lastError;
    btn.textContent = '导出当前页结构';
    if (!res || !res.ok || !res.outline) {
      hint.textContent = currentKind === 'reader'
        ? '阅读页不注入脚本，无法导出结构（这是设计如此）。'
        : '导出失败：请刷新页面后重试。';
      return;
    }
    box.hidden = false;
    box.value = res.outline;
    box.focus();
    box.select();
    let copied = false;
    try {
      await navigator.clipboard.writeText(res.outline);
      copied = true;
    } catch (e) {
      /* 复制失败则保留文本框，用户可手动 Ctrl+C */
    }
    const lines = res.outline.split('\n').length;
    hint.textContent = copied
      ? `已复制到剪贴板（${lines} 行），直接粘贴发送即可。`
      : `已生成（${lines} 行），请按 Ctrl+C 复制上面的内容。`;
  });
});

$('reload').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    if (t && t.id) chrome.tabs.reload(t.id);
    window.close();
  });
});

$('reset').addEventListener('click', () => save(Object.assign({}, DEFAULTS)));

/* ---------------- 启动 ---------------- */

(async function init() {
  try {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    /* 忽略 */
  }

  const stored = await sget(Object.keys(DEFAULTS));
  settings = Object.assign({}, DEFAULTS, stored);

  const tabs = await new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t || []));
    } catch (e) {
      resolve([]);
    }
  });
  const tab = tabs[0];
  currentKind = classify(tab && tab.url);

  // 页面里若已有 content script，以它为准（能识别 JS 跳转后的阅读页）
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'qd:state' }, (res) => {
      void chrome.runtime.lastError;
      if (res && res.ok) {
        currentKind = res.reader ? 'reader' : 'site';
        if (res.settings) settings = Object.assign({}, DEFAULTS, res.settings);
      }
      render();
    });
  }

  render();
})();
