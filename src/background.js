/*!
 * 起点极简 · background.js (MV3 Service Worker)
 * 职责：
 *   1) 在非起点页 / 阅读页上给出角标提示，让用户随时知道「这一页会不会被改」。
 *   2) 让工具栏角标跟随当前主题（ON）。
 *   快捷键已移除（v1.8.0）：统一用页内悬浮按钮或工具栏弹窗切换。
 *   不读写页面内容，不改动任何请求。
 */
'use strict';

const READER_HOST = /(^|\.)(read|vipreader|vip)\.qidian\.com$/i;
const QIDIAN_HOST = /(^|\.)qidian\.com$/i;

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
  // 书籍详情页：单独归类只为角标文案，日夜切换与站点页一致

  if (/\/book\//i.test(u.pathname)) return 'detail';
  return 'site';
}

async function refreshBadge(tabId, url) {
  const kind = classify(url);
  try {
    if (kind === 'reader') {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#8a94a6' });
      await chrome.action.setBadgeText({ tabId, text: '跳过' });
      await chrome.action.setTitle({ tabId, title: '起点极简：当前是阅读页，已跳过（阅读页不做任何改动）' });
    } else if (kind === 'detail') {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#8a94a6' });
      await chrome.action.setBadgeText({ tabId, text: 'ON' });
      await chrome.action.setTitle({ tabId, title: '起点极简：已启用（书籍详情页）' });
    } else if (kind === 'site') {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e03e52' });
      await chrome.action.setBadgeText({ tabId, text: 'ON' });
      await chrome.action.setTitle({ tabId, title: '起点极简：已启用（点扩展图标或页内按钮切换日间/夜间）' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: '起点极简' });
    }
  } catch (e) {
    /* 标签页可能已关闭，忽略 */
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' || info.url) refreshBadge(tabId, tab && tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    refreshBadge(tabId, tab && tab.url);
  } catch (e) {
    /* ignore */
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id) refreshBadge(t.id, t.url);
  } catch (e) {
    /* ignore */
  }
});
