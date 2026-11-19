// Разбирает ссылку (доска или пин), находит вкладку Pinterest, собирает в ней пины
// и передаёт результат странице загрузки. Заодно следит за новыми версиями на GitHub.

importScripts("common.js", "update.js");

const PAGE = chrome.runtime.getURL("downloader.html");

// ------------------------------------------------------------ обновления
async function refreshBadge(update) {
  const on = !!(update && update.version && compareVersions(update.version, currentVersion()) > 0);
  await chrome.action.setBadgeText({ text: on ? "↑" : "" });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
  await chrome.action.setTitle({
    title: on ? `Доступна версия ${update.version} — откройте, чтобы обновить` : "Скачать доску Pinterest",
  });
}

async function updateCheck(force) {
  const u = await checkForUpdate(force);
  await refreshBadge(u);
  return u;
}

// фоновый скрипт просыпается часто — создаём напоминание один раз, а не при каждом пробуждении
chrome.alarms.get("update-check").then((a) => {
  if (!a) chrome.alarms.create("update-check", { periodInMinutes: 12 * 60, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "update-check") updateCheck(false); // не чаще раза в 12 часов
});
chrome.runtime.onStartup.addListener(async () => {
  updateCheck(false);
  // состояния досок от прошлого запуска браузера кнопкам уже не нужны; очередь сохраняется
  const all = await chrome.storage.local.get(null);
  const { pending = [] } = all;
  const keep = new Set(pending.map((p) => p.job && "job:" + p.job));
  const old = Object.keys(all).filter((k) => k.startsWith("job:") && !keep.has(k));
  if (old.length) await chrome.storage.local.remove(old);
});
const { isPinterestHost, isBoardPath, isProfilePath, boardKey } = PBD;
const PINTEREST_TABS = chrome.runtime.getManifest().host_permissions.filter((p) => p.includes("pinterest."));
const PIN_LINKS = PINTEREST_TABS.map((p) => p.replace(/\/\*$/, "/pin/*"));

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
  if (isBoardPath(parts)) return { board: u.href };
  if (isProfilePath(parts)) return { profile: parts[0] }; // /<автор>/, /<автор>/_saved/ …
  throw new Error("Это не ссылка на пин или доску. Откройте пин или доску и скопируйте адрес из адресной строки.");
}

// ------------------------------------------------------------ вкладка Pinterest
// Если открытой вкладки Pinterest нет, открываем свою в фоне. Закрываем её не сразу, а когда
// она полминуты не нужна: при «Обновить все» доски идут одна за другой через одну и ту же вкладку.
const TEMP_IDLE_MS = 30000;
let tempCloseTimer = null;
let tabUsers = 0; // сколько сборов идёт сейчас через вкладки Pinterest
const getTempTab = async () => (await chrome.storage.session.get("tempTab")).tempTab || null;
const setTempTab = (id) => chrome.storage.session.set({ tempTab: id });

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
  clearTimeout(tempCloseTimer); // вкладка снова нужна — не закрываем
  const open = await chrome.tabs.query({ url: PINTEREST_TABS });
  const ready = open.find((t) => t.status === "complete") || open[0];
  if (ready) return ready.id;
  // открытой вкладки Pinterest нет — открываем в фоне и закроем, когда станет не нужна
  const t = await chrome.tabs.create({ url: "https://www.pinterest.com/", active: false });
  await setTempTab(t.id);
  await waitLoaded(t.id);
  return t.id;
}

const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["common.js", "content.js"] });

// Сбор пинов: ответ придёт отдельным сообщением collected или error.
async function startCollect(target, preferTabId, job) {
  const tabId = await pinterestTab(preferTabId);
  tabUsers++;
  try {
    await inject(tabId);
    await chrome.tabs.sendMessage(tabId, { cmd: "collect", ...target, job });
  } catch (e) {
    releaseTab(tabId);
    throw e;
  }
}

// Доски профиля — для выбора во вкладке загрузок
async function listBoards(user) {
  const tabId = await pinterestTab();
  tabUsers++;
  try {
    await inject(tabId);
    const r = await chrome.tabs.sendMessage(tabId, { cmd: "boards", user });
    if (!r) throw new Error("Вкладка Pinterest не ответила. Обновите её (F5) и попробуйте ещё раз.");
    return r;
  } finally {
    releaseTab(tabId);
  }
}

// ------------------------------------------------------------ состояние досок для кнопки на странице
async function setJob(job, state) {
  if (job) await chrome.storage.local.set({ ["job:" + job]: { ...state, at: Date.now() } });
}

// Пины этой доски уже собираются (сбор сообщал о себе недавно) — второй сбор не запускаем:
// иначе два сбора наперебой пишут свой счётчик, а доска встаёт в очередь дважды.
// Так бывает, если обновить вкладку загрузок посреди сбора или нажать кнопку на доске ещё раз.
const COLLECT_FRESH_MS = 4 * 60 * 1000;
async function alreadyCollecting(job) {
  if (!job) return false;
  const s = (await chrome.storage.local.get("job:" + job))["job:" + job];
  return !!(s && s.phase === "collect" && Date.now() - (s.at || 0) < COLLECT_FRESH_MS);
}

async function download(url, tabId, job, quiet = false) {
  await setStatus({ text: "Ищу пины…" });
  try {
    const target = await classify(url);
    if (target.profile) {
      throw new Error("Это ссылка на профиль. Выбрать его доски можно во вкладке загрузок — вставьте ссылку туда.");
    }
    if (target.board) job = boardKey(target.board); // по нему кнопка на странице доски видит, что происходит
    if (await alreadyCollecting(job)) return job;
    if (job) {
      const q = (await quietJobs()).filter((j) => j !== job);
      if (quiet) q.push(job);
      await chrome.storage.session.set({ quietJobs: q.slice(-500) });
      await setDropped(job, false);
    }
    await setJob(job, { phase: "collect", text: "Ищу пины…" });
    await startCollect(target, tabId, job);
  } catch (e) {
    await setStatus({ error: e.message || String(e) });
    await setJob(job, { phase: "error", text: e.message || String(e) });
  }
  return job;
}

// сбор через вкладку закончился; своя временная вкладка закрывается, когда полминуты никому не нужна
function releaseTab(tabId) {
  tabUsers = Math.max(0, tabUsers - 1);
  if (tabUsers || tabId == null) return;
  clearTimeout(tempCloseTimer);
  tempCloseTimer = setTimeout(async () => {
    const id = await getTempTab();
    if (id !== tabId || tabUsers) return;
    await setTempTab(null);
    chrome.tabs.remove(id).catch(() => {});
  }, TEMP_IDLE_MS);
}

// ------------------------------------------------------------ очередь
// Очередь (pending) меняют сообщения от разных страниц и вкладок Pinterest. Чтение и запись
// идут строго по одному, иначе одновременные изменения затирали бы друг друга.
let pendingChain = Promise.resolve();
function editPending(fn) {
  const p = pendingChain.then(async () => {
    const { pending = [] } = await chrome.storage.local.get("pending");
    const next = await fn(pending);
    await chrome.storage.local.set({ pending: next || pending });
  });
  pendingChain = p.catch(() => {});
  return p;
}

// ------------------------------------------------------------ страница загрузки
// Уже открытая вкладка загрузок (любая, если их несколько) или null.
async function findDownloader(exceptTabId = -1) {
  const usable = (t) => t && t.id !== exceptTabId;
  if (chrome.runtime.getContexts) {
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      for (const c of ctx) {
        if (!(c.tabId >= 0) || c.tabId === exceptTabId || !String(c.documentUrl || "").startsWith(PAGE)) continue;
        const t = await chrome.tabs.get(c.tabId).catch(() => null);
        if (usable(t)) return t;
      }
      return null; // список точный — запасной способ не нужен
    } catch { /* старый браузер — ниже запасной способ */ }
  }
  const { downloaderTab } = await chrome.storage.session.get("downloaderTab");
  if (downloaderTab) {
    try {
      const t = await chrome.tabs.get(downloaderTab);
      if (usable(t) && t.url && t.url.startsWith(PAGE)) return t;
    } catch { /* вкладку закрыли */ }
  }
  return null;
}

// Открывает вкладку загрузок, только если её ещё нет; focus — переключиться на неё.
async function openDownloader(focus = true, exceptTabId = -1) {
  const t = await findDownloader(exceptTabId);
  if (t) {
    if (focus) {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    }
    return;
  }
  const created = await chrome.tabs.create({ url: PAGE, active: focus });
  await chrome.storage.session.set({ downloaderTab: created.id });
}

// Ссылки, добавленные из самой вкладки загрузок: по ним не надо на неё переключать.
const quietJobs = async () => (await chrome.storage.session.get("quietJobs")).quietJobs || [];
// Доски, которые убрали из очереди, пока у них собирались пины: собранное выбрасываем.
const droppedJobs = async () => (await chrome.storage.session.get("droppedJobs")).droppedJobs || [];
async function setDropped(job, on) {
  const list = (await droppedJobs()).filter((j) => j !== job);
  if (on) list.push(job);
  await chrome.storage.session.set({ droppedJobs: list.slice(-500) });
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "download") {
      const fromPage = !!(sender.url && sender.url.startsWith(PAGE));
      // вкладка загрузок сама просит скачать — Pinterest-вкладкой будет любая, а не она
      const job = await download(msg.url, fromPage ? null : msg.tabId || (sender.tab && sender.tab.id), msg.job,
        fromPage);
      reply({ ok: true, job });
      return;
    } else if (msg.type === "inspect") {
      // что за ссылка: доска, пин или профиль — для поля ссылок во вкладке загрузок
      try {
        const t = await classify(msg.url);
        reply(t.profile ? { kind: "profile", user: t.profile } : t.board ? { kind: "board", url: t.board, job: boardKey(t.board) }
          : { kind: "pin", id: t.pins[0] });
      } catch (e) {
        reply({ error: e.message || String(e) });
      }
      return;
    } else if (msg.type === "listBoards") {
      try {
        reply(await listBoards(msg.user));
      } catch (e) {
        reply({ error: e.message || String(e) });
      }
      return;
    } else if (msg.type === "progress") {
      await setStatus({ text: msg.text });
      await setJob(msg.job, { phase: "collect", text: msg.text });
    } else if (msg.type === "error") {
      releaseTab(sender.tab && sender.tab.id);
      await setStatus({ error: msg.text });
      await setJob(msg.job, { phase: "error", text: msg.text });
    } else if (msg.type === "queueLinks") {
      // доски и пины из вкладки загрузок сразу встают в очередь, а пины у них соберутся в свой черёд
      const added = [];
      await editPending((pending) => {
        const have = new Set(pending.map((p) => p.job).filter(Boolean));
        for (const it of msg.items || []) {
          if (!it.url || (it.job && have.has(it.job))) continue;
          if (it.job) have.add(it.job);
          added.push({ key: `link-${Date.now()}-${added.length}`, link: it.url, job: it.job || null, title: it.title || it.url });
        }
        return [...pending, ...added];
      });
      for (const p of added) await setJob(p.job, { phase: "queued" });
      reply({ added: added.length, skipped: (msg.items || []).length - added.length });
      return;
    } else if (msg.type === "collected") {
      releaseTab(sender.tab && sender.tab.id);
      if (msg.job && (await droppedJobs()).includes(msg.job)) {
        await setDropped(msg.job, false);
        await setJob(msg.job, { phase: "removed" });
        reply({ ok: true });
        return;
      }
      await editPending((pending) => {
        // доска уже стоит в очереди (ждёт пинов или ещё не начала качаться) — обновляем её место,
        // а не добавляем вторую такую же в конец
        const slot = msg.job && (pending.find((p) => !p.data && p.job === msg.job)
          || pending.find((p) => p.data && p.job === msg.job));
        if (slot) {
          slot.data = msg.data;
          delete slot.link;
        } else {
          pending.push({ key: `${msg.data.id}-${Date.now()}`, data: msg.data, job: msg.job || null });
        }
      });
      await setJob(msg.job, { phase: "queued", found: msg.data.found, gated: !!msg.data.gated });
      await setStatus({ text: `${msg.data.title}: загрузка идёт во вкладке загрузок.`, done: true });
      // нажали на Pinterest — переходим во вкладку загрузок; добавили из неё самой — никуда не переключаем
      await openDownloader(!(msg.job && (await quietJobs()).includes(msg.job)));
    } else if (msg.type === "reorder") {
      // новый порядок ожидающих загрузок; то, чего нет в списке (текущая или только что
      // добавленная загрузка), остаётся после них
      await editPending((pending) => {
        const pos = new Map(msg.keys.map((k, i) => [k, i]));
        const listed = pending.filter((p) => pos.has(p.key)).sort((a, b) => pos.get(a.key) - pos.get(b.key));
        return [...listed, ...pending.filter((p) => !pos.has(p.key))];
      });
    } else if (msg.type === "taken") {
      await editPending(async (pending) => {
        const gone = pending.find((p) => p.key === msg.key);
        // убрали доску, у которой пины ещё не собраны: если сбор уже идёт, его итог не нужен
        if (gone && !gone.data && gone.job && msg.dropped) await setDropped(gone.job, true);
        return pending.filter((p) => p.key !== msg.key);
      });
    } else if (msg.type === "open") {
      // «Перейти к ней» из второй вкладки загрузок — к той, что качает, а не к себе же
      await openDownloader(true, msg.other && sender.tab ? sender.tab.id : -1);
    } else if (msg.type === "checkUpdate") {
      reply(await updateCheck(!!msg.force));
      return;
    } else if (msg.type === "installing") {
      // страница загрузок сейчас перезапустит расширение — запомним, чтобы потом сказать «Обновлено»
      await chrome.storage.local.set({ justUpdated: { from: currentVersion(), to: msg.version } });
    }
    reply({ ok: true });
  })();
  return true;
});

// ------------------------------------------------------------ меню правой кнопки
chrome.runtime.onInstalled.addListener(async (details) => {
  // после обновления в один клик открываем вкладку загрузок с сообщением «Обновлено»
  const { justUpdated } = await chrome.storage.local.get("justUpdated");
  if (details.reason === "update" && justUpdated && justUpdated.to === currentVersion()) {
    await openDownloader();
  }
  updateCheck(true);
});

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
