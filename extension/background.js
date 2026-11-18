// Разбирает ссылку (доска или пин), находит вкладку Pinterest, собирает в ней пины
// и передаёт результат странице загрузки.

const PAGE = chrome.runtime.getURL("downloader.html");
const RESERVED = new Set(["pin", "search", "ideas", "today", "settings", "business", "_", "resource",
  "login", "signup", "explore", "news_hub", "notifications", "messages", "shopping"]);
const PINTEREST_TABS = chrome.runtime.getManifest().host_permissions.filter((p) => p.includes("pinterest."));
const PIN_LINKS = PINTEREST_TABS.map((p) => p.replace(/\/\*$/, "/pin/*"));

const isPinterestHost = (host) => /(^|\.)pinterest\.[a-z.]+$/.test(host);

// ------------------------------------------------------------ ссылки
async function resolveShort(url) {
  // pin.it/… — короткая ссылка из приложения, ведёт на обычную страницу пина
  const r = await fetch(url, { redirect: "follow", credentials: "omit" });
  return r.url;
}

async function classify(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("Вставьте ссылку на пин или доску.");
  if (/^\d{5,}$/.test(s)) return { pins: [s] }; // просто id пина
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Это не похоже на ссылку.");
  }
  if (u.hostname === "pin.it") {
    u = new URL(await resolveShort(u.href));
  }
  if (!isPinterestHost(u.hostname)) throw new Error("Это не ссылка на Pinterest.");
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "pin" && parts[1]) {
    // /pin/123/ или /pin/название--123/
    const m = parts[1].match(/(?:^|--)(\d+)$/);
    return { pins: [m ? m[1] : parts[1]] };
  }
  if (parts.length >= 2 && !RESERVED.has(parts[0]) && !RESERVED.has(parts[1])) return { board: u.href };
  throw new Error("Это не ссылка на пин или доску. Откройте пин или доску и скопируйте адрес из адресной строки.");
}

// ------------------------------------------------------------ вкладка Pinterest
let tempTab = null;

function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 30000);
  });
}

async function pinterestTab(preferId) {
  if (preferId) {
    try {
      const t = await chrome.tabs.get(preferId);
      if (t.url && isPinterestHost(new URL(t.url).hostname)) return t.id;
    } catch { /* вкладка закрыта */ }
  }
  const open = await chrome.tabs.query({ url: PINTEREST_TABS });
  const ready = open.find((t) => t.status === "complete") || open[0];
  if (ready) return ready.id;
  // открытой вкладки Pinterest нет — открываем в фоне и закроем после сбора
  const t = await chrome.tabs.create({ url: "https://www.pinterest.com/", active: false });
  await waitLoaded(t.id);
  tempTab = t.id;
  return t.id;
}

async function startCollect(target, preferTabId) {
  const tabId = await pinterestTab(preferTabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await chrome.tabs.sendMessage(tabId, { cmd: "collect", ...target });
}

async function download(url, tabId) {
  await setStatus({ text: "Ищу пины…" });
  try {
    await startCollect(await classify(url), tabId);
  } catch (e) {
    await setStatus({ error: e.message || String(e) });
  }
}

function closeTemp(senderTab) {
  if (tempTab && senderTab && senderTab.id === tempTab) {
    chrome.tabs.remove(tempTab).catch(() => {});
    tempTab = null;
  }
}

// ------------------------------------------------------------ страница загрузки
async function openDownloader() {
  const { downloaderTab } = await chrome.storage.session.get("downloaderTab");
  if (downloaderTab) {
    try {
      const t = await chrome.tabs.get(downloaderTab);
      if (t.url && t.url.startsWith(PAGE)) {
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
        return;
      }
    } catch { /* вкладку закрыли */ }
  }
  const t = await chrome.tabs.create({ url: PAGE });
  await chrome.storage.session.set({ downloaderTab: t.id });
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "download") {
      await download(msg.url, msg.tabId || (sender.tab && sender.tab.id));
    } else if (msg.type === "progress") {
      await setStatus({ text: msg.text });
    } else if (msg.type === "error") {
      closeTemp(sender.tab);
      await setStatus({ error: msg.text });
    } else if (msg.type === "collected") {
      closeTemp(sender.tab);
      const { pending = [] } = await chrome.storage.local.get("pending");
      pending.push({ key: `${msg.data.id}-${Date.now()}`, data: msg.data });
      await chrome.storage.local.set({ pending });
      await setStatus({ text: `${msg.data.title}: загрузка идёт во вкладке загрузок.`, done: true });
      await openDownloader();
    } else if (msg.type === "reorder") {
      // новый порядок ожидающих загрузок; то, чего нет в списке (текущая или только что
      // добавленная загрузка), остаётся после них
      const { pending = [] } = await chrome.storage.local.get("pending");
      const pos = new Map(msg.keys.map((k, i) => [k, i]));
      const listed = pending.filter((p) => pos.has(p.key)).sort((a, b) => pos.get(a.key) - pos.get(b.key));
      const rest = pending.filter((p) => !pos.has(p.key));
      await chrome.storage.local.set({ pending: [...listed, ...rest] });
    } else if (msg.type === "taken") {
      const { pending = [] } = await chrome.storage.local.get("pending");
      await chrome.storage.local.set({ pending: pending.filter((p) => p.key !== msg.key) });
    } else if (msg.type === "open") {
      await openDownloader();
    }
    reply({ ok: true });
  })();
  return true;
});

// ------------------------------------------------------------ меню правой кнопки
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pin-link",
      title: "Скачать этот пин",
      contexts: ["link"],
      targetUrlPatterns: PIN_LINKS,
    });
    chrome.contextMenus.create({
      id: "pin-page",
      title: "Скачать пин с этой страницы",
      contexts: ["page", "image", "video"],
      documentUrlPatterns: PIN_LINKS,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "pin-link" ? info.linkUrl : info.pageUrl;
  download(url, tab && tab.id);
});
