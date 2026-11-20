// Вкладка загрузок, вторая часть: поле ссылок «Скачать следующие пины и доски»
// и список «Мои доски» — скачанные доски в выбранной папке с кнопками «Обновить».
// Пользуется общим из downloader.js: $, root, ensureRoot, hasPermission, GALLERY_DIR, BOARD_INFO, readJson, writeText.

const { isActive, boardKey: boardKeyOf, safeName: folderNameOf } = PBD;
const SINGLES_DIR = "Отдельные пины";
const openedAt = Date.now();

const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ------------------------------------------------------------ работа с Pinterest — по одной
// Списки досок профилей идут через одну вкладку Pinterest: не запускаем их одновременно.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// Ставит доски и пины в очередь сразу все — строками, которые можно двигать и убирать.
// Пины у каждой собираются, когда до неё доходит черёд.
async function queueLinks(items) {
  const r = await chrome.runtime.sendMessage({ type: "queueLinks", items }).catch(() => null);
  return r || { added: 0, skipped: items.length };
}

const listBoards = (user) => serial(() => chrome.runtime.sendMessage({ type: "listBoards", user }));

// Что показывать о доске по её состоянию (как на кнопке «Скачать доску»)
function jobLabel(s) {
  if (!s) return null;
  switch (s.phase) {
    case "collect": return { text: s.text || "Ищу пины…" };
    case "queued": return { text: "В очереди" };
    case "folder": return { text: "Ждёт выбора папки" };
    case "sync": return { text: "Сверяю с уже скачанным…" };
    case "download": return { text: `Скачиваю ${s.done} из ${s.total}` + (s.failed ? `, ошибок: ${s.failed}` : "") };
    case "done":
      if (s.failed) return { text: `Готово, не скачалось: ${s.failed}`, tone: "warn" };
      return { text: s.fresh ? `Готово, новых файлов: ${s.fresh}` : "Новых пинов нет", tone: "ok" };
    case "cancelled": return { text: "Отменено", tone: "warn" };
    case "removed": return { text: "Убрано из очереди", tone: "warn" };
    case "failed":
    case "error": return { text: s.text || "Ошибка", tone: "warn" };
  }
  return null;
}

// ------------------------------------------------------------ вкладки «Загрузки» / «Мои доски»
function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  $("tab-loads").hidden = name !== "loads";
  $("tab-library").hidden = name !== "library";
  try { localStorage.setItem("tab", name); } catch { /* без запоминания */ }
  if (name === "library") openLibrary();
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ------------------------------------------------------------ поле ссылок
const linksBox = $("links");

function addLinkRow(value = "") {
  const row = el("div", "lrow");
  row.innerHTML = `<div class="lline"><input type="text" spellcheck="false" autocomplete="off"
    placeholder="Ссылка на доску, пин или профиль"><span class="lkind" hidden></span>
    <button class="lx" type="button" title="Убрать" aria-label="Убрать">×</button></div>
    <p class="lmsg" hidden></p><div class="lpick" hidden></div>`;
  row.info = null;
  row.seq = 0;
  const input = row.querySelector("input");
  input.value = value;
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => inspectRow(row), 500);
    row.classList.toggle("filled", !!input.value.trim());
    ensureEmptyRow();
  });
  // несколько ссылок за раз (через пробел или с новой строки) — каждая в свою строку
  input.addEventListener("paste", (e) => {
    const many = (e.clipboardData.getData("text") || "").split(/\s+/).filter(Boolean);
    if (many.length < 2) return;
    e.preventDefault();
    input.value = many[0];
    row.classList.add("filled");
    inspectRow(row);
    let after = row;
    for (const v of many.slice(1)) {
      const r = addLinkRow(v);
      after.after(r);
      after = r;
      inspectRow(r);
    }
    ensureEmptyRow();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      inspectRow(row);
    }
  });
  row.querySelector(".lx").addEventListener("click", () => {
    row.remove();
    ensureEmptyRow();
    updateSend();
  });
  row.classList.toggle("filled", !!value);
  linksBox.append(row);
  return row;
}

// внизу всегда есть пустая строка для следующей ссылки
function ensureEmptyRow() {
  const rows = [...linksBox.children];
  const last = rows[rows.length - 1];
  if (!last || last.querySelector("input").value.trim()) addLinkRow();
}

async function inspectRow(row) {
  const v = row.querySelector("input").value.trim();
  const seq = ++row.seq;
  const kind = row.querySelector(".lkind");
  const msg = row.querySelector(".lmsg");
  const pick = row.querySelector(".lpick");
  row.info = null;
  kind.hidden = !v;
  kind.textContent = "…";
  kind.className = "lkind";
  msg.hidden = true;
  pick.hidden = true;
  pick.textContent = "";
  updateSend();
  if (!v) return;
  const info = await chrome.runtime.sendMessage({ type: "inspect", url: v }).catch((e) => ({ error: String(e.message || e) }));
  if (seq !== row.seq) return; // ссылку успели поменять
  if (info.error) {
    kind.textContent = "Не подходит";
    kind.className = "lkind bad";
    msg.textContent = info.error;
    msg.hidden = false;
    return;
  }
  row.info = info;
  kind.textContent = info.kind === "board" ? "Доска" : info.kind === "pin" ? "Пин" : "Профиль";
  updateSend();
  if (info.kind === "profile") loadProfile(row, info.user, seq);
}

async function loadProfile(row, user, seq) {
  const msg = row.querySelector(".lmsg");
  const pick = row.querySelector(".lpick");
  msg.textContent = `Ищу доски профиля ${user}…`;
  msg.hidden = false;
  const r = await listBoards(user).catch((e) => ({ error: String(e.message || e) }));
  if (seq !== row.seq) return;
  if (!r || r.error || !r.boards) {
    msg.textContent = "Не удалось получить доски: " + ((r && r.error) || "нет ответа") + ". Попробуйте ещё раз — нажмите Enter в поле ссылки.";
    return;
  }
  if (!r.boards.length) {
    msg.textContent = "У этого профиля не нашлось досок (или они скрыты — войдите в аккаунт Pinterest).";
    return;
  }
  msg.hidden = true;
  pick.hidden = false;
  const head = el("label", "lall");
  const all = document.createElement("input");
  all.type = "checkbox";
  all.checked = true;
  head.append(all, ` Все доски (${r.boards.length})`);
  const list = el("div", "lopts");
  const boxes = r.boards.map((b) => {
    const opt = el("label", "lopt");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.url = b.url;
    cb.dataset.title = b.name;
    cb.addEventListener("change", () => {
      all.checked = boxes.every((x) => x.checked);
      all.indeterminate = !all.checked && boxes.some((x) => x.checked);
      updateSend();
    });
    const name = el("span", "lname", b.name);
    const meta = el("small", null, `${b.pins} ${plural(b.pins, "пин", "пина", "пинов")}` + (b.secret ? " · секретная" : ""));
    opt.append(cb, name, meta);
    list.append(opt);
    return cb;
  });
  all.addEventListener("change", () => {
    boxes.forEach((x) => { x.checked = all.checked; });
    all.indeterminate = false;
    updateSend();
  });
  pick.append(head, list);
  updateSend();
}

// что уйдёт в очередь по кнопке «Скачать»
function collectLinks() {
  const out = new Map(); // адрес -> ключ задачи
  for (const row of linksBox.children) {
    const info = row.info;
    if (!info) continue;
    if (info.kind === "board") {
      out.set(info.url, { job: info.job, title: decodeURIComponent(new URL(info.url).pathname).replace(/^\/|\/$/g, "") });
    } else if (info.kind === "pin") {
      out.set(row.querySelector("input").value.trim(), { job: null, title: `Пин ${info.id}` });
    } else if (info.kind === "profile") {
      for (const cb of row.querySelectorAll(".lopt input:checked")) {
        out.set(cb.dataset.url, { job: boardKeyOf(cb.dataset.url), title: cb.dataset.title });
      }
    }
  }
  return [...out].map(([url, v]) => ({ url, ...v }));
}

function updateSend() {
  const n = collectLinks().length;
  $("sendLinks").disabled = !n;
  $("sendLinks").textContent = n > 1 ? `Скачать (${n})` : "Скачать";
}

$("sendLinks").addEventListener("click", async () => {
  const items = collectLinks().map((it, i) => ({ ...it, job: it.job || `link:${Date.now()}-${i}` }));
  if (!items.length) return;
  linksBox.textContent = "";
  ensureEmptyRow();
  updateSend();
  const r = await queueLinks(items);
  $("linksNote").textContent = r.added
    ? `В очередь добавлено: ${r.added}` + (r.skipped ? `, уже были в очереди: ${r.skipped}` : "") + "."
    : "Всё это уже стоит в очереди.";
});

addLinkRow();
updateSend();

// ------------------------------------------------------------ «Мои доски»
let library = null;     // [{ dir, title, user, url, files, updatedAt, key }]
let libLoading = null;
let resolveTried = false;

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const opts = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("ru-RU", opts);
}

// Доски — это подпапки выбранной папки, в которых есть _галерея/pins.json.
async function scanLibrary() {
  const out = [];
  for await (const [name, h] of root.entries()) {
    if (h.kind !== "directory" || name === SINGLES_DIR || name.startsWith("_")) continue;
    let gallery;
    try { gallery = await h.getDirectoryHandle(GALLERY_DIR); } catch { continue; }
    const info = await readJson(gallery, BOARD_INFO);
    let files = info && info.files, updatedAt = info && info.updatedAt;
    if (!info) {
      try {
        const f = await (await gallery.getFileHandle("pins.json")).getFile();
        updatedAt = f.lastModified;
        const pins = JSON.parse(await f.text());
        files = pins.reduce((n, p) => n + ((p.files && p.files.length) || 0), 0);
      } catch { continue; } // это не папка доски
    }
    const m = name.match(/^(.+?) - (.+)$/);
    out.push({
      dir: name,
      gallery,
      title: (info && info.title) || (m ? m[2] : name),
      user: (info && info.user) || (m ? m[1] : ""),
      url: info && info.url,
      section: info && info.section,
      files: files || 0,
      updatedAt,
      key: info && info.url ? boardKeyOf(info.url) : null,
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title, "ru"));
  return out;
}

async function loadLibrary() {
  if (!root || !(await hasPermission(root, false))) {
    library = null;
    renderLibrary("Нет доступа к папке. Выберите папку или разрешите доступ к ней — кнопка вверху.");
    return;
  }
  if (!libLoading) {
    libLoading = scanLibrary().finally(() => { libLoading = null; });
  }
  try {
    library = await libLoading;
  } catch (e) {
    library = null;
    renderLibrary("Не удалось прочитать папку: " + (e.message || e));
    return;
  }
  await renderLibrary();
}

// выбрали другую папку или дали к ней доступ — список читаем заново
function libraryReset() {
  library = null;
  resolveTried = false;
  if (!$("tab-library").hidden) openLibrary();
  else loadLibrary();
}

let libTimer = null;
// после каждой скачанной доски список перечитывается (не чаще раза в пару секунд)
function libraryChanged() {
  clearTimeout(libTimer);
  libTimer = setTimeout(async () => {
    await loadLibrary();
    if (!$("tab-library").hidden) resolveMissing();
  }, 1500);
}

async function openLibrary() {
  if (!library) {
    if (!(await ensureRoot())) {
      renderLibrary("Нет доступа к папке. Выберите папку или разрешите доступ к ней — кнопка вверху.");
      return;
    }
    renderLibrary("Читаю папку…");
    await loadLibrary();
  }
  resolveMissing();
}

const rowsByKey = new Map(); // ключ доски -> функция, обновляющая её строку

async function renderLibrary(message) {
  const list = $("libList");
  list.textContent = "";
  rowsByKey.clear();
  const count = library ? library.length : 0;
  $("libCount").textContent = library ? String(count) : "";
  $("libSub").textContent = library
    ? (count ? `${count} ${plural(count, "доска", "доски", "досок")} в папке «${root.name}». «Обновить» докачивает новые пины, как повторное скачивание.`
      : `В папке «${root.name}» пока нет скачанных досок.`)
    : "";
  $("updateAll").disabled = !library || !library.some((b) => b.url);
  if (message) {
    list.append(el("p", "lib-empty", message));
    return;
  }
  if (!library || !count) return;
  const keys = library.filter((b) => b.key).map((b) => "job:" + b.key);
  const states = keys.length ? await chrome.storage.local.get(keys) : {};
  for (const b of library) list.append(libraryRow(b, b.key && states["job:" + b.key]));
}

function libraryRow(b, state) {
  const row = el("div", "lib-row");
  const main = el("div", "lib-main");
  main.append(el("b", null, b.title + (b.section ? " (раздел)" : "")));
  const meta = [b.user, `${b.files} ${plural(b.files, "файл", "файла", "файлов")}`];
  if (b.updatedAt) meta.push("обновлено " + fmtDate(b.updatedAt));
  main.append(el("small", null, meta.filter(Boolean).join(" · ")));
  const st = el("small", "lib-st");
  main.append(st);
  row.append(main);

  if (b.url) {
    const a = el("a", "lib-open", "Pinterest");
    a.href = b.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Открыть доску на Pinterest";
    row.append(a);
  }
  const btn = el("button", null, b.url ? "Обновить" : "Указать ссылку");
  btn.type = "button";
  row.append(btn);

  const paint = (s) => {
    const fresh = s && (isActive(s) || (!PBD.ACTIVE.has(s.phase) && (s.at || 0) >= openedAt));
    const label = fresh ? jobLabel(s) : null;
    if (!b.url) {
      st.textContent = b.resolving ? "Ищу эту доску на Pinterest…"
        : b.unresolved ? "Не нашёл эту доску на Pinterest. Вставьте ссылку на неё, чтобы её можно было обновлять." : "";
      st.className = "lib-st" + (b.unresolved ? " warn" : "");
      btn.disabled = !!b.resolving;
      return;
    }
    st.textContent = label ? label.text : "";
    st.className = "lib-st" + (label && label.tone ? " " + label.tone : "");
    btn.disabled = isActive(s);
  };
  paint(state);
  if (b.key) rowsByKey.set(b.key, paint);

  btn.addEventListener("click", async () => {
    if (!b.url) return askLink(b);
    btn.disabled = true;
    await queueLinks([{ url: b.url, job: b.key, title: b.title }]);
  });
  return row;
}

// Доски, скачанные до версии со списком, — без board.json: ищем их в профиле автора по названию папки.
async function resolveMissing() {
  if (resolveTried || !library) return;
  const missing = library.filter((b) => !b.url && b.user);
  if (!missing.length) return;
  resolveTried = true;
  missing.forEach((b) => { b.resolving = true; });
  await renderLibrary();
  const byUser = new Map();
  for (const b of missing) {
    const u = b.user.toLowerCase();
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push(b);
  }
  for (const [user, items] of byUser) {
    const r = await listBoards(user).catch(() => null);
    const boards = (r && r.boards) || [];
    for (const b of items) {
      b.resolving = false;
      const hit = boards.find((x) => folderNameOf(`${b.user} - ${x.name}`).toLowerCase() === b.dir.toLowerCase());
      if (hit) await remember(b, { url: hit.url, id: hit.id, title: hit.name });
      else b.unresolved = true;
    }
    await renderLibrary();
  }
}

// записывает ссылку в _галерея/board.json — дальше доска обновляется как обычно
async function remember(b, { url, id, title }) {
  b.url = url;
  b.key = boardKeyOf(url);
  b.title = title || b.title;
  b.unresolved = false;
  try {
    await writeText(b.gallery, BOARD_INFO, JSON.stringify({
      url, id: id || null, title: b.title, user: b.user, section: null, files: b.files, updatedAt: b.updatedAt || Date.now(),
    }, null, 1));
  } catch { /* ссылка останется до перезагрузки вкладки */ }
}

async function askLink(b) {
  const v = prompt(`Ссылка на доску «${b.title}» на Pinterest:`);
  if (!v) return;
  const info = await chrome.runtime.sendMessage({ type: "inspect", url: v.trim() }).catch(() => null);
  if (!info || info.kind !== "board") {
    alert(info && info.error ? info.error : "Это не ссылка на доску.");
    return;
  }
  await remember(b, { url: info.url });
  await renderLibrary();
}

$("updateAll").addEventListener("click", async () => {
  if (!library) return;
  const items = library.filter((b) => b.url).map((b) => ({ url: b.url, job: b.key, title: b.title }));
  if (!items.length) return;
  const r = await queueLinks(items);
  $("libNote").textContent = (r.added ? `В очередь добавлено досок: ${r.added}` : "Все доски уже стоят в очереди")
    + (r.added && r.skipped ? `, уже были в очереди: ${r.skipped}` : "")
    + ". Их можно двигать и убирать во вкладке «Загрузки».";
});

// состояние досок меняется — строки списка показывают этап и прогресс
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    if (!k.startsWith("job:")) continue;
    const paint = rowsByKey.get(k.slice(4));
    if (paint) paint(v.newValue);
  }
});

(async () => {
  let tab = "loads";
  try { tab = localStorage.getItem("tab") || "loads"; } catch { /* по умолчанию «Загрузки» */ }
  // число досок на вкладке «Мои доски» — сразу, если доступ к папке уже есть
  const saved = await loadRoot().catch(() => null);
  if (saved && (await hasPermission(saved, false))) {
    root = root || saved;
    await loadLibrary();
  }
  showTab(tab === "library" ? "library" : "loads");
})();
