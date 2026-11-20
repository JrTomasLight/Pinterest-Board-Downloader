// Страница загрузки: пишет файлы досок прямо в выбранную папку
// (без окна «Сохранить как» на каждый файл).

// Сколько файлов доски качать одновременно — в настройках (по умолчанию 6: pinimg.com такую нагрузку держит).
// найдено меньше этой доли пинов доски — считаем, что Pinterest показал не все, и ничего не убираем
const PARTIAL_SHARE = 0.8;
const FILE_OPS_PARALLEL = 8; // одновременных переименований и переносов при сверке

// выполняет fn для каждого элемента, не больше limit одновременно
async function pool(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
const $ = (id) => document.getElementById(id);

// Настройки со вкладки «Настройки». Доска берёт их, когда начинает качаться.
let settings = { ...PBD.DEFAULTS };
PBD.getSettings().then((s) => { settings = s; });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) settings = { ...PBD.DEFAULTS, ...(ch.settings.newValue || {}) };
});
PBD.watchTheme();

// ------------------------------------------------------------ версия и ссылки
const REPO = "https://github.com/JrTomasLight/Pinterest-Board-Downloader";
const BOOSTY = "https://boosty.to/jrtomaslight";
const VERSION = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "";
if ($("ver")) {
  $("ver").textContent = VERSION ? "v" + VERSION : "";
  $("verFoot").textContent = VERSION ? `Версия ${VERSION}` : "";
  $("repo").href = REPO;
  $("boosty").href = BOOSTY;
  $("issues").href = REPO + "/issues";
}

// заголовок «Загрузки» над очередью и досками — только когда там что-то есть
function updateEmpty() {
  $("loadsTitle").hidden = $("boards").children.length === 0 && $("queue").hidden;
}

// ------------------------------------------------------------ папка (хранится в IndexedDB)
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pinboard-dl", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const loadRoot = () => idb("readonly", (s) => s.get("root"));
const saveRoot = (h) => idb("readwrite", (s) => s.put(h, "root"));

let root = null;

async function hasPermission(h, ask) {
  const opts = { mode: "readwrite" };
  if ((await h.queryPermission(opts)) === "granted") return true;
  return ask && (await h.requestPermission(opts)) === "granted";
}

function showNeed(text) {
  $("need").hidden = !text;
  $("needText").textContent = text || "";
}

async function pickFolder() {
  try {
    const h = await window.showDirectoryPicker({ id: "pinboard-dl", mode: "readwrite", startIn: "downloads" });
    await saveRoot(h);
    root = h;
    $("folderName").textContent = h.name;
    showNeed("");
    if (typeof libraryReset === "function") libraryReset();
    run();
  } catch (e) {
    if (e.name !== "AbortError") alert("Не удалось выбрать папку: " + e.message);
  }
}

async function ensureRoot() {
  if (root && (await hasPermission(root, false))) return true;
  const saved = await loadRoot().catch(() => null);
  if (saved) {
    $("folderName").textContent = saved.name;
    if (await hasPermission(saved, false)) {
      root = saved;
      return true;
    }
    showNeed(`Разрешите расширению сохранять файлы в папку «${saved.name}».`);
    $("grant").onclick = async () => {
      if (await hasPermission(saved, true)) {
        root = saved;
        showNeed("");
        if (typeof libraryReset === "function") libraryReset();
        run();
      }
    };
    $("grant").textContent = "Продолжить";
  } else {
    showNeed("Выберите папку, куда сохранять доски и пины. Это нужно сделать один раз.");
    $("grant").onclick = pickFolder;
    $("grant").textContent = "Выбрать папку";
  }
  return false;
}

// ------------------------------------------------------------ файлы
const dirCache = new Map();
function getDir(path) {
  if (!dirCache.has(path)) {
    dirCache.set(path, (async () => {
      let d = root;
      for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
      return d;
    })());
  }
  return dirCache.get(path);
}

const REMOVED_DIR = "_убраны с доски";
const GALLERY_DIR = "_галерея"; // index.html, pins.json и board.json

// Пояснения внутри служебных папок: что это за папка и откуда в ней файлы.
// В начале — метка UTF-8 (BOM), чтобы старый Блокнот Windows не показал кириллицу кракозябрами.
const README_TXT = "readme.txt";
const GALLERY_README = `ПАПКА «${GALLERY_DIR}»

Служебная папка расширения Pinterest Board Downloader. Она обновляется при каждом скачивании доски.


ЧТО ВНУТРИ

  index.html   Доска сеткой, как на Pinterest, вместе с видео.
               Откройте двойным щелчком — она откроется в браузере, интернет не нужен.
               Если галерея выключена в настройках расширения, этого файла нет.

  pins.json    Список пинов по порядку: номер, id, название, ссылка на пин и имена файлов.

  board.json   Ссылка на доску. По ней доска видна во вкладке «Мои доски» и обновляется кнопкой «Обновить».


ВАЖНО

  - Не переименовывайте и не перемещайте файлы доски. По id в имени файла расширение узнаёт
    уже скачанные пины, а index.html находит по имени картинки.
  - Эту папку можно удалить: при следующем скачивании доски она появится снова.
    До тех пор доски не будет в списке «Мои доски».
`;
const REMOVED_README = `ПАПКА «${REMOVED_DIR}»

Сюда расширение Pinterest Board Downloader переносит файлы, которых больше нет на доске.
Само оно отсюда ничего не удаляет: что делать с этими файлами, решаете вы.
Папка создаётся вместе с доской, поэтому может быть пустой — это нормально.


КАК СЮДА ПОПАДАЮТ ФАЙЛЫ

  - Пин убрали с доски — вы сами или его удалил автор.
    При следующем скачивании доски его файл переезжает сюда.
  - У одного пина в папке доски оказалось несколько разных файлов.
    Остаётся файл с правильным номером, лишний переезжает сюда. Точные копии расширение удаляет само.


ЕСЛИ ЗДЕСЬ ПИН, КОТОРЫЙ НА ДОСКЕ ЕСТЬ

  - Скорее всего, это лишняя копия. Такие появлялись в версиях до 1.4.0 из-за ошибок при обновлении доски.
    Сам пин лежит в папке доски под своим номером — найдите файл с тем же id. Копию можно удалить.
  - Или Pinterest тогда показал не все пины: вы не вошли в аккаунт или мешал VPN.
    Начиная с версии 1.4.1 в таком случае файлы остаются на месте.
    Войдите в аккаунт и скачайте доску ещё раз — недостающие пины скачаются заново.


КАК УЗНАТЬ, ЧТО ЭТО ЗА ПИН

  Имя файла:          <номер на доске в момент переноса>_<id пина>.jpg
                      (или просто <id пина>.jpg, если нумерация выключена в настройках)
  Пин на Pinterest:   https://www.pinterest.com/pin/<id пина>/
`;
const writeReadme = (dir, text) => writeText(dir, README_TXT, "\uFEFF" + text.replace(/\n/g, "\r\n"));
const restOf = (stem) => stem.replace(/^\d+_/, ""); // id пина (+ _01 для карусели) без номера позиции
const VIDEO_EXT = /\.(mp4|ts)$/i;

// Ключ пина по имени файла — id пина (+ _01 для карусели), с номером позиции в начале или без него
// (настройка «Нумерация файлов»): 0001_<id>, 0001_<id>_01, <id>, <id>_01. У других файлов — null.
// Без номера id должен быть длинным, чтобы не принять за пин, например, 20240512.jpg.
function pinKey(stem) {
  const p = stem.split("_");
  if (!p.every((x) => /^\d+$/.test(x))) return null;
  if (p.length === 3) return p[2].length === 2 ? `${p[1]}_${p[2]}` : null;
  if (p.length === 2) return p[1].length !== 2 ? p[1] : p[0].length >= 9 ? stem : null;
  return p.length === 1 && p[0].length >= 9 ? stem : null;
}

// Файлы пинов в папке, сгруппированные по ключу пина: так скачанный пин узнаётся,
// даже если на доске он сдвинулся, а номер в имени поменялся или пропал.
async function existingPinFiles(dir, step) {
  const map = new Map(); // ключ -> [имена файлов]
  let seenFiles = 0;
  for await (const [name, h] of dir.entries()) {
    if (++seenFiles % 200 === 0) step(`Сверяю с уже скачанным… просмотрено файлов: ${seenFiles}`);
    if (h.kind !== "file" || name.endsWith(".crswap")) continue;
    const key = pinKey(name.replace(/\.[^.]+$/, ""));
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(name);
  }
  return map;
}

async function hasDir(parent, name) {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

// Переименование/перенос файла. move() есть не во всех версиях браузера — тогда копируем.
// Если move() не сработал несколько раз подряд, дальше сразу копируем, не тратя на него время.
let moveFails = 0;
async function moveFile(dir, name, targetDir, newName) {
  const h = await dir.getFileHandle(name);
  if (h.move && moveFails < 3) {
    try {
      await (targetDir === dir ? h.move(newName) : h.move(targetDir, newName));
      moveFails = 0;
      return;
    } catch {
      moveFails++; // пробуем копированием
    }
  }
  const file = await h.getFile();
  const nh = await targetDir.getFileHandle(newName, { create: true });
  const w = await nh.createWritable();
  await w.write(file);
  await w.close();
  await dir.removeEntry(name);
}

async function moveDir(parent, oldName, newName) {
  const h = await parent.getDirectoryHandle(oldName);
  if (h.move) {
    try {
      await h.move(newName);
      return;
    } catch { /* пробуем копированием */ }
  }
  const target = await parent.getDirectoryHandle(newName, { create: true });
  async function copyInto(src, dst) {
    for await (const [name, e] of src.entries()) {
      if (e.kind === "directory") await copyInto(e, await dst.getDirectoryHandle(name, { create: true }));
      else await moveFile(src, name, dst, name);
    }
  }
  await copyInto(h, target);
  await parent.removeEntry(oldName, { recursive: true });
}

// Разделы тоже нумеруются: если раздел сдвинулся, переименовываем его папку.
async function renumberSections(rootFolder, step = () => {}) {
  if (!rootFolder.subfolders.length) return 0;
  const rootDir = await getDir(rootFolder.path);
  const dirs = [];
  for await (const [name, h] of rootDir.entries()) if (h.kind === "directory") dirs.push(name);
  const wanted = new Set(rootFolder.subfolders.map((s) => s.dir));
  const title = (d) => d.replace(/^\d+ /, "");
  let moved = 0;
  for (const s of rootFolder.subfolders) {
    if (dirs.includes(s.dir)) continue;
    // s.alt — то же название с другой заменой спецсимволов (поменяли настройку)
    const old = dirs.find((d) => !wanted.has(d) && /^\d+ /.test(d) &&
      (title(d) === title(s.dir) || (s.alt && title(d) === title(s.alt))));
    if (!old) continue;
    step(`Переименовываю папку раздела «${old}» → «${s.dir}»…`);
    await moveDir(rootDir, old, s.dir);
    dirs.splice(dirs.indexOf(old), 1, s.dir);
    moved++;
  }
  return moved;
}

// Сверяет папку с текущей доской: переименовывает сдвинувшиеся файлы,
// убирает в отдельную папку файлы пинов, которых на доске больше нет,
// и возвращает список того, что нужно скачать.
// Папка «Отдельные пины»: только пропускаем уже скачанное (узнаём по id в конце имени),
// ничего не переименовываем и не убираем — там копятся пины с разных досок.
async function syncSingles(folder, dir, stats) {
  const have = new Map(); // id (+ _01) -> имя файла
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file" || name.endsWith(".crswap")) continue;
    const m = name.replace(/\.[^.]+$/, "").match(/(\d+(?:_\d{2})?)$/);
    if (m) have.set(m[1], name);
  }
  const jobs = [];
  for (const pin of folder.pins) {
    pin.files = pin.media.map(() => null);
    pin.media.forEach((m, k) => {
      stats.total++;
      const key = (m.stem.match(/(\d+(?:_\d{2})?)$/) || [])[1];
      if (key && have.has(key)) {
        pin.files[k] = have.get(key);
        stats.done++;
      } else {
        jobs.push({ dir, pin, k, m });
      }
    });
  }
  return jobs;
}

// Сверяет папки доски с текущей доской и возвращает список того, что нужно скачать.
// Файлы пина ищутся во всех папках доски: в корне и в папках разделов (если качается вся доска,
// то и в папках прежних разделов). Так пин, перешедший в другой раздел, и файлы после смены настроек
// «Разделы доски» и «Нумерация файлов» переезжают и переименовываются, а не скачиваются заново.
// Файлы пинов, которых на доске больше нет, уходят в «_убраны с доски» той папки, где лежали.
// keepMissing — Pinterest показал не все пины доски: такие файлы оставляем на месте
// (скорее всего, пины с доски никуда не делись).
async function syncBoard(board, stats, step = () => {}, keepMissing = false) {
  const folders = board.folders.filter((f) => !f.skip);
  if (!folders.length) return [];
  if (folders[0].single) return syncSingles(folders[0], await getDir(folders[0].path), stats);

  const places = new Map(); // путь -> папка
  for (const f of folders) places.set(f.path, await getDir(f.path));
  if (!board.folders[0].skip) {
    const rootDir = await getDir(board.root);
    for await (const [name, h] of rootDir.entries()) {
      const path = `${board.root}/${name}`;
      if (h.kind === "directory" && /^\d+ /.test(name) && !places.has(path)) places.set(path, h);
    }
  }
  board.leftovers = [...places.keys()].filter((p) => !folders.some((f) => f.path === p));

  const have = new Map(); // ключ пина -> [{ dir, name }]
  for (const dir of places.values()) {
    for (const [key, names] of await existingPinFiles(dir, step)) {
      if (!have.has(key)) have.set(key, []);
      for (const name of names) have.get(key).push({ dir, name });
    }
  }

  const jobs = [];
  const renames = [];
  for (const folder of folders) {
    const dir = places.get(folder.path);
    for (const pin of folder.pins) {
      pin.files = pin.media.map(() => null);
      pin.media.forEach((m, k) => {
        const key = m.key || restOf(m.stem);
        const found = have.get(key);
        have.delete(key);
        if (m.skip && !found) return; // видео не качаются (настройка «Видео»)
        stats.total++;
        if (!found) {
          jobs.push({ dir, pin, k, m });
          return;
        }
        const here = found.filter((f) => f.dir === dir);
        const keep = here.find((f) => f.name.startsWith(m.stem + ".")) || here[0] || found[0];
        const ext = keep.name.slice(keep.name.lastIndexOf("."));
        // раньше вместо видео сохранили обложку, а теперь нужно видео: качаем, обложку потом удаляем
        if ((m.kind === "video" || m.kind === "hls") && !VIDEO_EXT.test(ext)) {
          jobs.push({ dir, pin, k, m, replace: found });
          return;
        }
        const target = m.stem + ext;
        renames.push({ keep, dir, target, extra: found.filter((f) => f !== keep) });
        pin.files[k] = target;
        stats.done++;
      });
    }
  }

  // своя «_убраны с доски» у каждой папки; создаётся один раз, даже если в неё переносят сразу несколько файлов
  const removedDirs = new Map();
  const openRemoved = (dir) => {
    if (!removedDirs.has(dir)) {
      removedDirs.set(dir, (async () => {
        const d = await dir.getDirectoryHandle(REMOVED_DIR, { create: true });
        await writeReadme(d, REMOVED_README);
        return d;
      })());
    }
    return removedDirs.get(dir);
  };

  // Каждый перенос и переименование виден в прогрессе — на большой доске их могут быть тысячи.
  // Делаем их по несколько сразу: файлы разных пинов друг другу не мешают.
  // Лишние файлы того же пина (например, после двух сверок наперегонки): точная копия оставленного
  // файла удаляется, а отличающийся файл убирается вместе с пинами, которых больше нет на доске.
  const missing = [...have.values()].flat();
  const away = keepMissing ? [] : missing;
  if (keepMissing) stats.kept += missing.length;
  const sizeOf = async (f) => (await (await f.dir.getFileHandle(f.name)).getFile()).size;
  await pool(renames.filter((r) => r.extra.length), FILE_OPS_PARALLEL, async (r) => {
    const keepSize = await sizeOf(r.keep);
    for (const extra of r.extra) {
      if ((await sizeOf(extra)) === keepSize) {
        await extra.dir.removeEntry(extra.name);
        stats.dupes++;
      } else {
        away.push(extra);
      }
    }
    step(`Убираю повторяющиеся файлы пинов: удалено ${stats.dupes}`);
  });
  let n = 0;
  await pool(away, FILE_OPS_PARALLEL, async (f) => {
    await moveFile(f.dir, f.name, await openRemoved(f.dir), f.name);
    stats.removed++;
    step(`Убираю файлы пинов, которых больше нет на доске: ${++n} из ${away.length}`);
  });
  // в имени есть id пина, поэтому новое имя не может быть занято другим пином
  const moves = renames.filter((r) => r.keep.dir !== r.dir || r.keep.name !== r.target);
  let m = 0;
  await pool(moves, FILE_OPS_PARALLEL, async (r) => {
    await moveFile(r.keep.dir, r.keep.name, r.dir, r.target);
    stats.renamed++;
    step(`Переименовываю и переношу файлы: ${++m} из ${moves.length}`);
  });
  return jobs;
}

// Папка прежнего раздела, из которой всё разъехалось по другим папкам: если в ней остались только
// служебные файлы расширения, она больше не нужна. Всё остальное (ваши файлы, убранные пины) не трогаем.
async function removeLeftover(path) {
  const i = path.lastIndexOf("/");
  const parent = await getDir(path.slice(0, i));
  const name = path.slice(i + 1);
  const dir = await parent.getDirectoryHandle(name);
  const service = { [GALLERY_DIR]: [README_TXT, "index.html", "pins.json", BOARD_INFO], [REMOVED_DIR]: [README_TXT] };
  for await (const [n, h] of dir.entries()) {
    if (h.kind === "file" || !service[n]) return;
    for await (const [n2, h2] of h.entries()) if (h2.kind !== "file" || !service[n].includes(n2)) return;
  }
  await parent.removeEntry(name, { recursive: true });
  dirCache.delete(path);
}

// Без ограничений по времени один зависший ответ сервера останавливает всю очередь.
const CONNECT_TIMEOUT = 30000; // ждём начала ответа
const STALL_TIMEOUT = 45000;   // ждём следующего куска данных
const HEAD_TIMEOUT = 15000;
const ATTEMPTS = 3;

class Stalled extends Error {}
class Cancelled extends Error {}

// Сигнал отмены текущей доски: доски качаются по одной, поэтому хватает одного.
let activeSignal = null;
const checkCancel = () => {
  if (activeSignal && activeSignal.aborted) throw new Cancelled("отменено");
};
const withCancel = (signal) => (activeSignal ? AbortSignal.any([signal, activeSignal]) : signal);

const sleep = async (ms) => {
  await new Promise((r) => {
    const t = setTimeout(r, ms);
    if (activeSignal) activeSignal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });
  checkCancel();
};

// Читает тело ответа по кускам; если данные перестали идти — обрывает запрос.
async function readBody(resp, onChunk) {
  const reader = resp.body.getReader();
  let timer;
  try {
    while (true) {
      const stall = new Promise((_, reject) => {
        timer = setTimeout(() => {
          resp._ctrl.abort();
          reject(new Stalled("сервер перестал отвечать"));
        }, STALL_TIMEOUT);
      });
      let res;
      try {
        res = await Promise.race([reader.read(), stall]);
      } catch (e) {
        checkCancel();
        throw e;
      }
      const { done, value } = res;
      clearTimeout(timer);
      if (done) return;
      await onChunk(value);
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* поток уже закрыт */ }
  }
}

async function readAll(resp) {
  const parts = [];
  await readBody(resp, (c) => parts.push(c));
  return new Blob(parts);
}

async function writeResponse(dir, name, resp) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await readBody(resp, (chunk) => w.write(chunk));
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* уже закрыт */ }
    try { await dir.removeEntry(name); } catch { /* нет файла */ }
    throw e;
  }
}

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

class HttpError extends Error {}

async function get(url) {
  let last;
  for (let i = 0; i < ATTEMPTS; i++) {
    checkCancel();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT);
    if (activeSignal) activeSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        r._ctrl = ctrl; // чтобы оборвать загрузку, если данные перестанут идти
        return r;
      }
      last = new HttpError(`HTTP ${r.status}`);
      if (r.status === 403 || r.status === 404) break;
    } catch (e) {
      clearTimeout(timer);
      checkCancel();
      last = e.name === "AbortError" ? new Stalled("сервер не отвечает") : e;
    }
    await sleep(1500 * (i + 1));
  }
  throw last;
}

async function head(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT);
  try {
    return (await fetch(url, { method: "HEAD", signal: withCancel(ctrl.signal) })).ok;
  } catch {
    checkCancel();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function extOf(url, kind) {
  const m = new URL(url).pathname.toLowerCase().match(/\.(jpe?g|png|gif|webp|mp4)$/);
  return m ? "." + m[1] : kind === "image" ? ".jpg" : ".mp4";
}

async function saveHls(dir, m) {
  const stem = m.stem;
  let url = m.url;
  const base = url.split("?")[0];
  for (const guess of [
    base.replace("/hls/", "/expMp4/").replace(".m3u8", "_720w.mp4"),
    base.replace("/hls/", "/720p/").replace(".m3u8", ".mp4"),
  ]) {
    if (guess !== base && (await head(guess))) {
      await writeResponse(dir, stem + ".mp4", await get(guess));
      return stem + ".mp4";
    }
  }
  // склейка в .ts выключена в настройках — сохраняем обложку видео
  if (m.noTs) {
    if (!m.cover) throw new Error("у видео есть только поток HLS, а склейка в .ts выключена в настройках");
    const name = stem + extOf(m.cover, "image");
    await writeResponse(dir, name, await get(m.cover));
    return name;
  }
  // запасной вариант — склеиваем поток в .ts (открывается в VLC и большинстве плееров)
  const text =async (u) => (await readAll(await get(u))).text();
  let playlist = await text(url);
  if (playlist.includes("#EXT-X-STREAM-INF")) {
    let best = null, bw = -1;
    const lines = playlist.split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = l.match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
      if (m && lines[i + 1] && +m[1] > bw) { bw = +m[1]; best = new URL(lines[i + 1], url).href; }
    });
    url = best;
    playlist = await text(url);
  }
  const segs = playlist.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, url).href);
  const name = stem + ".ts";
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    for (const s of segs) {
      checkCancel();
      await w.write(await readAll(await get(s)));
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* */ }
    try { await dir.removeEntry(name); } catch { /* нет файла */ }
    throw e;
  }
  return name;
}

async function saveMedia(dir, m) {
  if (m.kind === "hls") return saveHls(dir, m);
  let resp;
  try {
    resp = await get(m.url);
  } catch (e) {
    // оригинала картинки иногда нет — берём 736px
    if (e instanceof HttpError && m.kind === "image" && m.url.includes("/originals/")) {
      resp = await get(m.url.replace("/originals/", "/736x/"));
    } else {
      throw e;
    }
  }
  const name = m.stem + extOf(m.url, m.kind);
  await writeResponse(dir, name, resp);
  return name;
}

// Если загрузка оборвалась посередине (сервер замолчал, пропала сеть) — начинаем файл заново.
// На 403/404 повторять бессмысленно: файла на сервере нет.
async function saveWithRetry(dir, m) {
  for (let i = 1; ; i++) {
    try {
      return await saveMedia(dir, m);
    } catch (e) {
      if (e instanceof HttpError || e instanceof Cancelled || i >= ATTEMPTS) throw e;
      await sleep(3000 * i);
    }
  }
}

// ------------------------------------------------------------ index.html
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function indexHtml(folder) {
  const cards = [];
  for (const pin of folder.pins) {
    for (const f of pin.files) {
      if (!f) continue;
      const src = esc("../" + encodeURI(f)); // страница лежит в подпапке _галерея
      const media = /\.(mp4|ts)$/i.test(f)
        ? `<video src="${src}" controls loop muted preload="metadata"></video>`
        : `<img src="${src}" loading="lazy">`;
      cards.push(`<a class="c" href="${esc(pin.link)}" target="_blank" title="${esc(pin.title)}">${media}<span>${pin.n}</span></a>`);
    }
  }
  const secs = folder.subfolders.map((s) => `<li><a href="../${esc(encodeURI(s.dir))}/${GALLERY_DIR}/index.html">${esc(s.name)}</a></li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>${esc(folder.title)}</title>
<style>
body{margin:0;padding:16px;font:14px system-ui,sans-serif;background:#fff;color:#111}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#9cf}}
h1{font-size:22px;margin:0 0 12px} ul{padding-left:18px}
.g{columns:236px;column-gap:12px}
.c{display:block;break-inside:avoid;margin:0 0 12px;position:relative;border-radius:14px;overflow:hidden}
.c img,.c video{width:100%;display:block}
.c span{position:absolute;left:6px;top:6px;background:#0009;color:#fff;font-size:11px;padding:1px 6px;border-radius:8px}
</style><h1>${esc(folder.title)}</h1>${secs ? `<ul>${secs}</ul>` : ""}<div class="g">${cards.join("")}</div>`;
}

// ------------------------------------------------------------ интерфейс доски
function boardView(board, onCancel) {
  const el = document.createElement("section");
  el.className = "card board";
  el.innerHTML = `<div class="head"><h2></h2><span class="kind"></span><button class="cancel" type="button">Отменить</button></div>` +
    `<div class="bar"><i></i></div><div class="row"><span class="st"></span><span class="er"></span></div>`;
  el.querySelector("h2").textContent = board.title;
  const single = board.folders[0] && board.folders[0].single;
  const sections = board.folders.length - 1;
  el.querySelector(".kind").textContent = single ? (board.found > 1 ? "Пины" : "Пин")
    : sections > 0 ? `Доска · разделов: ${sections}` : "Доска";
  const cancelBtn = el.querySelector(".cancel");
  cancelBtn.addEventListener("click", () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Отменяю…";
    onCancel();
  });
  if (board.expected && board.found < board.expected * PARTIAL_SHARE) {
    const w = document.createElement("p");
    w.className = "warn";
    w.textContent = `Найдено только ${board.found} из ${board.expected} пинов — ` +
      (board.gated ? "похоже, вы не вошли в аккаунт Pinterest. " : "возможно, мешал VPN или Pinterest отвечал с ошибками. ") +
      `Уже скачанные файлы остальных пинов остаются на месте, а не переносятся в «${REMOVED_DIR}». ` +
      "Войдите в аккаунт и скачайте доску ещё раз.";
    el.append(w);
  }
  const noteEl = document.createElement("p");
  noteEl.className = "note";
  el.append(noteEl);
  const details = document.createElement("details");
  details.hidden = true;
  details.innerHTML = "<summary>Что не скачалось</summary>";
  const hint = document.createElement("p");
  hint.className = "note";
  hint.textContent = "Если не скачалось много файлов, мешать может VPN, прокси или другой способ обхода блокировок — " +
    "попробуйте отключить его или добавить Pinterest в исключения и скачать доску ещё раз: уже скачанное пропустится.";
  details.append(hint);
  el.append(details);
  $("boards").prepend(el);
  updateEmpty();
  const st = el.querySelector(".st");
  return {
    status(text) {
      st.textContent = text;
    },
    note(text) {
      noteEl.textContent = text;
    },
    update(done, total, failed) {
      el.querySelector(".bar i").style.width = (total ? ((done + failed) / total) * 100 : 100) + "%";
      st.textContent = `Скачиваю… ${done} из ${total}`;
      el.querySelector(".er").textContent = failed ? `ошибок: ${failed}` : "";
    },
    finish(text, cls) {
      cancelBtn.remove();
      st.textContent = text;
      st.className = "st " + cls;
      el.classList.add("is-" + cls);
    },
    error(text) {
      details.hidden = false;
      const row = document.createElement("div");
      row.textContent = text;
      details.append(row);
    },
  };
}

// Применяет настройки к собранной доске (копии: строка очереди остаётся как была).
// Решается здесь, а не при сборе пинов: доску могли собрать заранее, а настройки поменять потом.
function applySettings(board, s) {
  board = structuredClone(board);
  const folders = board.folders;
  const video = (m) => {
    if (m.kind !== "video" && m.kind !== "hls") return;
    if (s.video === "skip") m.skip = true;
    else if (s.video === "cover" && m.cover) Object.assign(m, { kind: "image", url: m.cover });
    else if (m.kind === "hls" && !s.hlsTs) m.noTs = true;
  };
  if (!folders[0] || folders[0].single) {
    for (const pin of folders[0] ? folders[0].pins : []) {
      for (const m of pin.media) {
        if (s.prettyNames && m.stemPretty) m.stem = m.stemPretty;
        video(m);
      }
    }
    return board;
  }

  // имена папок: запрещённые символы на «_» или на похожие; alt — другой вариант, чтобы найти и
  // переименовать папку, скачанную до смены настройки
  const pick = (plain, pretty) => (s.prettyNames && pretty ? pretty : plain);
  const rootName = pick(board.root, board.rootPretty);
  board.rootAlt = rootName === board.root ? board.rootPretty : board.root;
  board.root = rootName;
  for (const sf of folders[0].subfolders) {
    const d = pick(sf.dir, sf.dirPretty);
    sf.alt = d === sf.dir ? sf.dirPretty : sf.dir;
    sf.dir = d;
  }
  folders.forEach((f, i) => {
    if (i === 0) f.path = rootName;
    else if (f.dir) f.path = `${rootName}/${pick(f.dir, f.dirPretty)}`;
  });

  // разделы одной папкой: сначала пины разделов, потом остальные — как на странице доски,
  // и сплошная нумерация. Если скачивается один раздел, он, как обычно, в своей папке.
  if (s.sections === "flat" && !board.section && folders.length > 1) {
    const all = [...folders.slice(1), folders[0]].flatMap((f) => f.pins);
    const width = Math.max(4, String(all.length).length);
    all.forEach((pin, i) => {
      pin.n = i + 1;
      for (const m of pin.media) m.stem = `${String(i + 1).padStart(width, "0")}_${restOf(m.stem)}`;
    });
    folders[0].pins = all;
    folders[0].subfolders = [];
    board.folders = [folders[0]];
  }

  for (const f of board.folders) {
    for (const pin of f.pins) {
      for (const m of pin.media) {
        m.key = restOf(m.stem);
        if (!s.numbering) m.stem = m.key;
        video(m);
      }
    }
  }
  return board;
}

// Название папки доски поменялось только из-за настройки «Спецсимволы в именах» — переименовываем
// прежнюю папку, а не качаем доску заново рядом.
async function renameRoot(board, step) {
  if (!board.rootAlt || board.rootAlt === board.root) return;
  if ((await hasDir(root, board.root)) || !(await hasDir(root, board.rootAlt))) return;
  step(`Переименовываю папку «${board.rootAlt}» → «${board.root}»…`);
  await moveDir(root, board.rootAlt, board.root);
}

async function downloadBoard(board, view) {
  const s = settings;
  board = applySettings(board, s);
  const signal = activeSignal || new AbortController().signal;
  view.status("Сверяю с уже скачанным…");
  dirCache.clear(); // папки разделов могли переименоваться
  const stats = { total: 0, done: 0, renamed: 0, removed: 0, dupes: 0, kept: 0 };
  // Pinterest отдал заметно меньше пинов, чем на доске (не вошли в аккаунт, мешал VPN, сбой сайта)
  const partial = !!(board.expected && board.found < board.expected * PARTIAL_SHARE);
  // сверка большой доски может идти долго — показываем каждый шаг, а не одну надпись
  let lastStep = 0;
  const step = (text) => {
    checkCancel();
    const now = Date.now();
    if (now - lastStep < 250) return;
    lastStep = now;
    view.status(text);
  };
  await renameRoot(board, step);
  dirCache.clear();
  await renumberSections(board.folders[0], step);
  checkCancel();
  const jobs = await syncBoard(board, stats, step, partial);
  const total = stats.total;
  let done = stats.done, failed = 0;
  const notes = [];
  if (stats.done) notes.push(`уже было: ${stats.done}`);
  if (stats.renamed) notes.push(`переименовано и перенесено: ${stats.renamed}`);
  if (stats.removed) notes.push(`убрано в «${REMOVED_DIR}»: ${stats.removed}`);
  if (stats.dupes) notes.push(`удалено одинаковых копий: ${stats.dupes}`);
  if (stats.kept) notes.push(`оставлено на месте (Pinterest показал не все пины): ${stats.kept}`);
  if (jobs.length) notes.push(`новых: ${jobs.length}`);
  view.note(notes.join(", "));
  view.update(done, total, failed);

  let next = 0;
  async function worker() {
    while (next < jobs.length && !signal.aborted) {
      const j = jobs[next++];
      try {
        const name = await saveWithRetry(j.dir, j.m);
        j.pin.files[j.k] = name;
        done++;
        // видео вместо прежней обложки: обложка больше не нужна
        for (const f of j.replace || []) {
          if (f.dir !== j.dir || f.name !== name) await f.dir.removeEntry(f.name).catch(() => {});
        }
      } catch (e) {
        if (signal.aborted) return; // отмена — не ошибка
        failed++;
        view.error(`${j.pin.link} — ${e.message || e}`);
      }
      view.update(done, total, failed);
    }
  }
  const parallel = Math.min(10, Math.max(1, Math.round(+s.parallel) || PBD.DEFAULTS.parallel));
  await Promise.all(Array.from({ length: parallel }, worker));
  checkCancel();
  view.status("Пишу галерею…");

  for (const path of board.leftovers || []) {
    try { await removeLeftover(path); } catch { /* остаётся как есть */ }
  }
  for (const folder of board.folders) {
    if (folder.single || folder.skip) continue; // для отдельных пинов галерея не нужна
    const dir = await getDir(folder.path);
    // служебные файлы прошлых версий лежали рядом с картинками — убираем
    for (const old of ["index.html", "pins.json"]) {
      try { await dir.removeEntry(old); } catch { /* нет такого */ }
    }
    const gallery = await dir.getDirectoryHandle(GALLERY_DIR, { create: true });
    await writeReadme(gallery, GALLERY_README);
    await writeReadme(await dir.getDirectoryHandle(REMOVED_DIR, { create: true }), REMOVED_README);
    if (s.gallery) await writeText(gallery, "index.html", indexHtml(folder));
    else await gallery.removeEntry("index.html").catch(() => {}); // галерея выключена в настройках
    const list = folder.pins.map((p) => ({ n: p.n, id: p.id, title: p.title, link: p.link, files: p.files.filter(Boolean) }));
    await writeText(gallery, "pins.json", JSON.stringify(list, null, 1));
  }
  await saveBoardInfo(board, { done, total, failed });
  return { done, total, failed, fresh: jobs.length };
}

// _галерея/board.json: ссылка на доску — по ней доску можно обновить из списка «Мои доски».
// Если скачивался один раздел, а доска уже записана целиком, запись не трогаем.
async function saveBoardInfo(board, r) {
  if (!board.url || (board.folders[0] && board.folders[0].single)) return;
  try {
    const gallery = await (await getDir(board.root)).getDirectoryHandle(GALLERY_DIR, { create: true });
    if (board.section && (await readJson(gallery, BOARD_INFO))) return;
    await writeText(gallery, BOARD_INFO, JSON.stringify({
      url: board.url, id: board.id, title: board.title, user: board.user, section: board.section || null,
      files: r.total, failed: r.failed, updatedAt: Date.now(),
    }, null, 1));
  } catch { /* без записи доска просто не попадёт в список */ }
}

const BOARD_INFO = "board.json";
async function readJson(dir, name) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ состояние для кнопки на странице доски
// Кнопка «Скачать доску» на Pinterest читает job:<адрес доски> и показывает этап и прогресс.
function setJob(job, state) {
  if (!job) return Promise.resolve();
  return chrome.storage.local.set({ ["job:" + job]: { ...state, at: Date.now() } }).catch(() => {});
}

// оборачивает вид доски: всё, что показывается здесь, коротко уходит и на кнопку (не чаще 3 раз в секунду)
function reportingView(view, job) {
  if (!job) return view;
  let last = 0, timer = null, latest = null;
  const flush = () => {
    timer = null;
    last = Date.now();
    setJob(job, latest);
  };
  const push = (state, now) => {
    latest = state;
    if (now) {
      clearTimeout(timer);
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, Math.max(0, 300 - (Date.now() - last)));
    }
  };
  return {
    ...view,
    status(text) {
      view.status(text);
      push({ phase: "sync", text }, true);
    },
    update(done, total, failed) {
      view.update(done, total, failed);
      push({ phase: "download", done, total, failed }, done + failed >= total);
    },
    final(state) {
      clearTimeout(timer);
      timer = null;
      setJob(job, state);
    },
  };
}

// ------------------------------------------------------------ уведомления
// Если вкладка загрузок в фоне, о конце каждой доски или пина сообщаем системным уведомлением.
const NOTE_ID = "pinboard-done";
function notify(title, message) {
  if (!settings.notify || !document.hidden || !chrome.notifications) return;
  try { // уведомление — не главное: если не вышло, загрузка всё равно считается удачной
    chrome.notifications.clear(NOTE_ID); // новое заменяет прежнее, а не копится стопкой
    chrome.notifications.create(NOTE_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title,
      message,
      contextMessage: "Pinterest Board Downloader",
    }, () => void chrome.runtime.lastError);
  } catch { /* без уведомления */ }
}

// Итоги досок копятся, пока идёт серия (очередь и сбор пинов по ссылкам или «Обновить все»),
// а уведомление одно — когда всё закончилось.
const finished = []; // { data, r } или { data, error }
function flushNotify() {
  if (!finished.length || running) return;
  const items = finished.splice(0);
  if (items.length === 1) {
    const [x] = items;
    if (x.error) notify(`Не удалось скачать «${x.data.title}»`, x.error);
    else notifyResult(x.data, x.r);
    return;
  }
  const ok = items.filter((x) => x.r);
  const bad = items.filter((x) => x.error || x.r.failed).length;
  const fresh = ok.reduce((n, x) => n + x.r.fresh, 0);
  const nothing = ok.filter((x) => !x.r.fresh && !x.r.failed).length;
  const parts = [`Новых файлов: ${fresh}.`];
  if (nothing) parts.push(`Без новых пинов: ${nothing}.`);
  if (bad) parts.push(`С ошибками: ${bad} — подробности во вкладке загрузок.`);
  notify(bad ? `Загрузка закончена, с ошибками: ${bad} из ${items.length}` : `Готово, скачано загрузок: ${items.length}`,
    parts.join(" "));
}

function notifyResult(data, r) {
  const single = data.folders[0] && data.folders[0].single;
  const name = single ? data.title : `Доска «${data.title}»`;
  if (r.failed) notify(`${name} скачана с ошибками`, `Скачано ${r.done} из ${r.total}, не скачалось: ${r.failed}. Подробности — во вкладке загрузок.`);
  else if (!r.fresh && r.total) notify(`${name}: новых пинов нет`, `Всё уже было в папке (файлов: ${r.total}).`);
  else notify(single ? `${name} — скачано` : `${name} успешно скачана`, `Новых файлов: ${r.fresh}, всего в папке: ${r.done}.`);
}

if (chrome.notifications) {
  // нажатие на уведомление — к вкладке загрузок
  chrome.notifications.onClicked.addListener(async (id) => {
    if (id !== NOTE_ID) return;
    chrome.notifications.clear(id);
    const t = await chrome.tabs.getCurrent();
    if (t) {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    }
  });
}

// ------------------------------------------------------------ очередь досок
const seen = new Set();
let running = false;
let currentKey = null;
let currentCtrl = null;
// доски, отменённые кнопкой «Остановить», пока у них ещё собирались пины: когда они дойдут
// до очереди, сразу убираем. Если доску потом запустят заново, отмена с неё снимается.
const cancelledJobs = new Map(); // ключ -> время отмены
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    const s = v.newValue;
    if (k.startsWith("job:") && s && s.phase === "collect" && s.at > (cancelledJobs.get(k.slice(4)) || Infinity)) {
      cancelledJobs.delete(k.slice(4));
    }
  }
});

// «Остановить»: убрать всё из очереди, отменить текущую загрузку и доски, у которых ещё ищутся пины.
async function stopAll() {
  const now = Date.now();
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("job:") && v && v.phase === "collect") {
      cancelledJobs.set(k.slice(4), now);
      await setJob(k.slice(4), { phase: "cancelled" });
    }
  }
  for (const p of all.pending || []) {
    if (p.key === currentKey && p.data) continue; // её отменяет currentCtrl
    seen.add(p.key);
    await setJob(p.job, { phase: "removed" });
    await chrome.runtime.sendMessage({ type: "taken", key: p.key, dropped: true });
  }
  if (currentCtrl) currentCtrl.abort();
  renderQueue();
}

// ------------------------------------------------------------ сбор пинов для досок из очереди
// Доска, добавленная ссылкой, стоит в очереди без пинов. Пины собираются, когда до неё доходит
// черёд, а у следующей — заранее, пока качается текущая.
const collecting = new Set(); // ключи строк очереди, у которых уже идёт сбор

function startCollecting(p) {
  if (collecting.has(p.key)) return;
  collecting.add(p.key);
  chrome.runtime.sendMessage({ type: "download", url: p.link, job: p.job }).catch(() => {});
}

// Ждёт, пока у строки очереди появятся пины. Итог: "ok", "removed" (убрали из очереди) или текст ошибки.
// Сбор сообщает о ходе хотя бы раз в пару минут; если вкладка Pinterest замолчала дольше —
// считаем это ошибкой, чтобы из-за одной доски не встала вся очередь.
const COLLECT_SILENCE_MS = 4 * 60 * 1000;
function waitFilled(key, job) {
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (v) => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(watchdog);
      collecting.delete(key);
      resolve(v);
    };
    const watchdog = setInterval(async () => {
      const s = (await chrome.storage.local.get("job:" + job))["job:" + job];
      if (Date.now() - Math.max(started, (s && s.at) || 0) > COLLECT_SILENCE_MS) {
        finish("Pinterest долго не отвечает. Обновите вкладку Pinterest (F5) и добавьте ссылку ещё раз.");
      }
    }, 20000);
    const check = async () => {
      const got = await chrome.storage.local.get(["pending", "job:" + job]);
      const p = (got.pending || []).find((x) => x.key === key);
      if (!p) return finish("removed");
      if (p.data) return finish("ok");
      const s = got["job:" + job];
      if (s && s.phase === "error") finish(s.text || "Ошибка");
    };
    const onChange = (ch, area) => {
      if (area === "local" && (ch.pending || ch["job:" + job])) check();
    };
    chrome.storage.onChanged.addListener(onChange);
    check();
  });
}

// Пока качается доска, пины PREFETCH ближайших досок очереди собираются заранее. Не больше:
// сбор — это сотни запросов к Pinterest (на частые он отвечает «подождите»), а собранные
// пины всей длинной очереди заняли бы много места и успели бы устареть.
const PREFETCH = 2;
async function prefetch() {
  if (!ownQueue || !currentCtrl) return; // только пока эта вкладка качает доску
  const { pending = [] } = await chrome.storage.local.get("pending");
  for (const p of pending.filter((x) => !seen.has(x.key)).slice(0, PREFETCH)) {
    if (!p.data && p.link && !collecting.has(p.key)) startCollecting(p);
  }
}

// Доски и пины, которые ждут своей очереди: пронумерованы в порядке скачивания,
// порядок меняется перетаскиванием мышью, ненужное можно убрать.
let dragging = null;     // строка, которую сейчас тащат
let renderLater = false; // очередь поменялась во время перетаскивания — перерисуем после

function renumber() {
  $("queue").querySelectorAll(".qrow").forEach((row, i) => {
    row.querySelector(".qnum").textContent = i + 1;
  });
}

async function saveOrder() {
  const keys = [...$("queue").querySelectorAll(".qrow")].map((r) => r.dataset.key);
  await chrome.runtime.sendMessage({ type: "reorder", keys });
}

// у досок без пинов в строке очереди виден ход сбора: «Ищу пины… найдено 120»
function paintQueueRow(row, s) {
  const st = row.querySelector(".qst");
  if (!st) return;
  st.textContent = s && s.phase === "collect" ? (s.text || "Ищу пины…").replace(/^.*?: /, "") : "";
  st.title = st.textContent;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    if (!k.startsWith("job:")) continue;
    const row = $("queue").querySelector(`.qrow[data-job="${CSS.escape(k.slice(4))}"]`);
    if (row) paintQueueRow(row, v.newValue);
  }
});

async function renderQueue() {
  if (dragging) {
    renderLater = true;
    return;
  }
  const { pending = [] } = await chrome.storage.local.get("pending");
  const jobKeys = pending.filter((p) => !p.data && p.job).map((p) => "job:" + p.job);
  const got = jobKeys.length ? await chrome.storage.local.get(jobKeys) : {};
  const jobStates = Object.fromEntries(Object.entries(got).map(([k, v]) => [k.slice(4), v]));
  // доска, у которой сейчас собираются пины, ещё видна в очереди — её тоже можно убрать
  const waiting = pending.filter((p) => !seen.has(p.key) || (p.key === currentKey && !p.data));
  const box = $("queue");
  box.innerHTML = "";
  box.hidden = !waiting.length;
  updateEmpty();
  if (!waiting.length) return;
  const h = document.createElement("h3");
  h.textContent = `В очереди: ${waiting.length}`;
  if (waiting.length > 1) {
    const tip = document.createElement("small");
    tip.textContent = "Порядок можно менять, перетаскивая мышью";
    h.append(tip);
    const all = document.createElement("button");
    all.type = "button";
    all.className = "qall";
    all.textContent = "Убрать всё";
    all.title = "Убрать всё из очереди и остановить текущую загрузку";
    all.addEventListener("click", () => {
      all.disabled = true;
      stopAll();
    });
    h.append(all);
  }
  box.append(h);
  waiting.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "qrow";
    row.dataset.key = p.key;
    row.draggable = waiting.length > 1;
    row.innerHTML = `<svg class="grip" viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor">` +
      `<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/>` +
      `<circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>` +
      `<span class="qnum"></span><span class="qname"></span><span class="qst"></span>`;
    row.querySelector(".qnum").textContent = i + 1;
    row.querySelector(".qname").textContent = p.data ? p.data.title : p.title;
    if (p.job) row.dataset.job = p.job;
    if (p.key === currentKey) row.draggable = false; // уже идёт
    paintQueueRow(row, jobStates[p.job]);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Убрать";
    rm.draggable = false;
    rm.addEventListener("click", async () => {
      rm.disabled = true;
      seen.add(p.key);
      await setJob(p.job, { phase: "removed" });
      await chrome.runtime.sendMessage({ type: "taken", key: p.key, dropped: true });
      renderQueue();
    });
    row.append(rm);

    row.addEventListener("dragstart", (e) => {
      dragging = row;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", p.key);
    });
    row.addEventListener("dragover", (e) => {
      if (!dragging || dragging === row) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.parentElement.insertBefore(dragging, after ? row.nextSibling : row);
      renumber();
    });
    row.addEventListener("drop", (e) => e.preventDefault());
    row.addEventListener("dragend", async () => {
      row.classList.remove("dragging");
      dragging = null;
      await saveOrder();
      if (renderLater) {
        renderLater = false;
        renderQueue();
      }
    });
    box.append(row);
  });
}

async function run() {
  if (running) return;
  running = true; // ставим сразу: пока ждём папку, могут прийти новые доски
  if (!(await ensureRoot())) {
    running = false;
    // доски ждут, пока выберут папку, — пусть кнопка на странице доски об этом скажет
    const { pending = [] } = await chrome.storage.local.get("pending");
    for (const p of pending) if (!seen.has(p.key)) await setJob(p.job, { phase: "folder" });
    return;
  }
  try {
    // пока ждать нечего, очередь не занимаем — иначе другие вкладки зря решат, что она занята
    if (await hasWork()) await withQueueLock(processQueue);
  } finally {
    running = false;
    renderQueue();
    flushNotify();
  }
}

async function hasWork() {
  const { pending = [] } = await chrome.storage.local.get("pending");
  return pending.some((p) => !seen.has(p.key));
}

// Если открыто несколько вкладок загрузок, очередь качает только одна — иначе они скачивали бы
// одни и те же доски наперегонки. Та, что качает, каждые несколько секунд отмечается в хранилище.
// Остальные ждут, только пока эта отметка свежая: зависшая или скрытая браузером страница
// может держать очередь, не качая, — тогда её забираем.
const QUEUE_LOCK = "pinboard-queue";
const PAGE_ID = Math.random().toString(36).slice(2);
const OWNER_FRESH_MS = 12000;
let ownQueue = false;
let queueLost = false; // другая вкладка забрала очередь («Качать здесь») — эта перестаёт качать

// очередь забрали: текущую загрузку прерываем, а саму доску оставляем в очереди — её докачает та вкладка
function lostQueue() {
  queueLost = true;
  if (currentCtrl) currentCtrl.abort();
}

async function ownerAlive() {
  try {
    const { queueOwner: o } = await chrome.storage.local.get("queueOwner");
    return !!(o && o.id !== PAGE_ID && Date.now() - o.at < OWNER_FRESH_MS);
  } catch {
    return false;
  }
}

async function withQueueLock(fn) {
  if (!navigator.locks) return fn();
  if (ownQueue) return; // эта страница уже качает очередь
  let done = false;
  const body = async (lock) => {
    if (!lock || done) return;
    done = true;
    ownQueue = true;
    queueLost = false;
    $("other").hidden = true;
    const beat = () => chrome.storage.local.set({ queueOwner: { id: PAGE_ID, at: Date.now() } }).catch(() => {});
    await beat();
    const timer = setInterval(beat, 4000);
    try {
      await fn();
    } finally {
      clearInterval(timer);
      ownQueue = false;
      chrome.storage.local.remove("queueOwner").catch(() => {});
    }
  };
  const request = (opts) => navigator.locks.request(QUEUE_LOCK, opts, body)
    .catch((e) => { if (e && e.name === "AbortError") lostQueue(); });
  await request({ ifAvailable: true });
  if (done) return;
  await new Promise((resolve) => {
    let timer = null;
    const take = () => {
      if (done) return;
      clearInterval(timer);
      request({ steal: true }).then(resolve);
    };
    // «Качать здесь» — забрать очередь, даже если та вкладка ещё качает
    $("otherTake").onclick = take;
    $("otherGo").onclick = () => chrome.runtime.sendMessage({ type: "open", other: true });
    const check = async () => {
      if (done) return;
      if (await ownerAlive()) {
        $("other").hidden = false;
      } else {
        take();
      }
    };
    // та вкладка закроется — замок освободится сам
    request({}).then(() => {
      if (done && !ownQueue) { clearInterval(timer); resolve(); }
    });
    setTimeout(check, 1500); // даём той вкладке отметиться, если она только начала
    timer = setInterval(check, 5000);
  });
}

async function processQueue() {
  while (!queueLost) {
    const { pending = [] } = await chrome.storage.local.get("pending");
    let item = pending.find((p) => !seen.has(p.key));
    if (!item) break;
    seen.add(item.key);
    if (!item.data) { // пины ещё не собраны — собираем сейчас
      currentKey = item.key;
      renderQueue();
      startCollecting(item);
      const res = await waitFilled(item.key, item.job);
      currentKey = null;
      if (queueLost) { seen.delete(item.key); break; }
      if (res === "removed") continue;
      if (res !== "ok") {
        const isPin = !!(item.job && /^(link|pin):/.test(item.job));
        const view = boardView({ title: item.title, folders: [{ single: isPin }] }, () => {});
        view.finish("Не удалось собрать пины", "failed");
        view.error(`${item.link} — ${res}`);
        finished.push({ data: { title: item.title }, error: res });
        await setJob(item.job, { phase: "error", text: res });
        // если сбор всё же закончится позже, его итог не нужен — иначе доска встанет в очередь второй раз
        await chrome.runtime.sendMessage({ type: "taken", key: item.key, dropped: true });
        continue;
      }
      const now = (await chrome.storage.local.get("pending")).pending || [];
      item = now.find((p) => p.key === item.key);
      if (!item) continue;
    }
    if (item.job && cancelledJobs.has(item.job)) { // остановили, пока собирались пины
      cancelledJobs.delete(item.job);
      await setJob(item.job, { phase: "cancelled" });
      await chrome.runtime.sendMessage({ type: "taken", key: item.key });
      continue;
    }
    currentKey = item.key;
    renderQueue();

    const ctrl = new AbortController();
    currentCtrl = ctrl;
    activeSignal = ctrl.signal;
    prefetch();
    const view = reportingView(boardView(item.data, () => ctrl.abort()), item.job);
    try {
      const r = await downloadBoard(item.data, view);
      view.finish(r.fresh || r.failed || !r.total ? `Готово ${r.done} из ${r.total}`
        : `Новых пинов нет — все файлы (${r.total}) уже были в папке`, "done");
      if (view.final) view.final({ phase: "done", ...r });
      finished.push({ data: item.data, r });
      if (typeof libraryChanged === "function") libraryChanged();
    } catch (e) {
      if (queueLost) {
        view.finish("Загрузка продолжится в другой вкладке загрузок.", "cancelled");
      } else if (ctrl.signal.aborted) {
        view.finish("Отменено. Уже скачанное осталось в папке, повторный запуск докачает остальное.", "cancelled");
        if (view.final) view.final({ phase: "cancelled" });
      } else {
        view.finish("Не удалось сохранить", "failed");
        view.error(e.message || String(e));
        if (view.final) view.final({ phase: "failed", text: e.message || String(e) });
        finished.push({ data: item.data, error: e.message || String(e) });
      }
    } finally {
      activeSignal = null;
      currentKey = null;
      currentCtrl = null;
    }
    if (queueLost) { seen.delete(item.key); break; } // доска остаётся в очереди для той вкладки
    await chrome.runtime.sendMessage({ type: "taken", key: item.key });
  }
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.pending) {
    renderQueue();
    run();
    prefetch(); // у одной из досок собрались пины — можно начать следующую
  }
});
$("pick").addEventListener("click", pickFolder);

(async () => {
  const saved = await loadRoot().catch(() => null);
  if (saved) $("folderName").textContent = saved.name;
  renderQueue();
  run();
})();

// ------------------------------------------------------------ обновление расширения
const loadExtDir = () => idb("readonly", (s) => s.get("extDir"));
const saveExtDir = (h) => idb("readwrite", (s) => s.put(h, "extDir"));
let release = null;

// Текст релиза (Markdown) — в простые абзацы, списки и жирный, без innerHTML
function renderNotes(md, box) {
  box.textContent = "";
  let list = null;
  const inline = (parent, text) => {
    text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (!part) return;
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const b = document.createElement("b");
        b.textContent = part.slice(2, -2);
        parent.append(b);
      } else parent.append(part.replace(/`/g, ""));
    });
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    if (/^#{1,6}\s/.test(line)) {
      list = null;
      const h = document.createElement("h4");
      inline(h, line.replace(/^#+\s*/, ""));
      box.append(h);
    } else if (/^[-*]\s/.test(line)) {
      if (!list) { list = document.createElement("ul"); box.append(list); }
      const li = document.createElement("li");
      inline(li, line.replace(/^[-*]\s*/, ""));
      list.append(li);
    } else {
      list = null;
      const p = document.createElement("p");
      inline(p, line);
      box.append(p);
    }
  }
}

function updStep(text, isError) {
  $("updStep").textContent = text || "";
  $("updStep").className = "upd-step" + (isError ? " err" : "");
}

function showRelease(u) {
  // сравниваем с установленной версией сейчас, а не на момент проверки
  if (!u || !u.version || compareVersions(u.version, VERSION) <= 0) {
    $("upd").hidden = true;
    return;
  }
  release = u;
  $("upd").hidden = false;
  $("updTitle").textContent = `Доступна версия ${u.version}`;
  $("updSub").textContent = `Сейчас установлена ${VERSION}. Обновление займёт несколько секунд.`;
  $("updGo").hidden = false;
  $("updClose").hidden = true;
  $("updNotes").hidden = !u.notes;
  if (u.notes) renderNotes(u.notes, $("updNotesText"));
}

function showChecked(u) {
  if (!u || !u.checkedAt) return;
  const when = new Date(u.checkedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const newer = u.version && compareVersions(u.version, VERSION) > 0;
  $("updChecked").textContent = u.error ? `не удалось проверить (${when})` : newer ? "" : `последняя версия, проверено ${when}`;
}

// Папка, из которой расширение загружено в браузер: спрашиваем один раз и запоминаем.
async function getExtensionDir() {
  const saved = await loadExtDir().catch(() => null);
  if (saved && (await hasPermission(saved, true))) {
    const problem = await checkExtensionDir(saved);
    if (!problem) return saved;
    if (problem.ahead) return { dir: saved, ahead: problem.ahead };
  }
  updStep("Выберите папку, в которую распакован архив расширения: в ней лежат manifest.json и подпапка icons. При выборе папки файлы не видны — ориентируйтесь на подпапку icons. Это нужно один раз.");
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: "pinboard-ext", mode: "readwrite", startIn: "documents" });
  } catch (e) {
    if (e.name === "AbortError") { updStep(""); return null; }
    throw e;
  }
  const problem = await checkExtensionDir(dir);
  if (problem && problem.ahead) {
    await saveExtDir(dir);
    return { dir, ahead: problem.ahead };
  }
  if (problem) {
    updStep(problem, true);
    return null;
  }
  await saveExtDir(dir);
  return dir;
}

$("updGo").addEventListener("click", async () => {
  if (!release) return;
  if (currentKey && !confirm("Сейчас идёт загрузка. Она прервётся, а после обновления продолжится с того же места. Обновить?")) return;
  $("updGo").disabled = true;
  try {
    const dir = await getExtensionDir();
    if (!dir) return;
    if (dir.ahead) {
      // новые файлы уже на месте — достаточно перезапустить расширение
      await chrome.runtime.sendMessage({ type: "installing", version: dir.ahead });
      updStep(`В папке уже версия ${dir.ahead} — перезапускаю расширение…`);
      setTimeout(() => chrome.runtime.reload(), 600);
      return;
    }
    await chrome.runtime.sendMessage({ type: "installing", version: release.version });
    await installUpdate(dir, release, (t) => updStep(t));
    updStep("Готово. Перезапускаю расширение…");
    setTimeout(() => chrome.runtime.reload(), 400);
  } catch (e) {
    // чаще всего замену файлов блокирует антивирус — подсказываем, что делать
    updStep(`${String(e.message || e).replace(/\.$/, "")}. Если папка выбрана верно, возможно, менять файлы расширения не даёт антивирус: ` +
      "добавьте папку расширения (и при необходимости папку браузера) в исключения или отключите его на время обновления. " +
      "Либо обновите расширение вручную — инструкция в README.", true);
  } finally {
    $("updGo").disabled = false;
  }
});

$("updClose").addEventListener("click", () => { $("upd").hidden = true; });

// Перезапуск расширения — когда что-то зависло. Вкладка загрузок закроется вместе с ним,
// поэтому фоновый скрипт после перезапуска откроет её снова (флаг reopenDownloader).
$("reloadExt").addEventListener("click", async (e) => {
  e.preventDefault();
  if (currentKey && !confirm("Сейчас идёт загрузка. Она прервётся, а после перезапуска продолжится с того же места: уже скачанные файлы пропустятся. Перезапустить?")) return;
  await chrome.storage.local.set({ reopenDownloader: true });
  chrome.runtime.reload();
});

$("updCheck").addEventListener("click", async (e) => {
  e.preventDefault();
  $("updChecked").textContent = "проверяю…";
  const u = await chrome.runtime.sendMessage({ type: "checkUpdate", force: true });
  showRelease(u);
  showChecked(u);
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.update && !$("updGo").disabled) {
    showRelease(ch.update.newValue);
    showChecked(ch.update.newValue);
  }
});

(async () => {
  const { justUpdated, update } = await chrome.storage.local.get(["justUpdated", "update"]);
  if (justUpdated && justUpdated.to === VERSION) {
    await chrome.storage.local.remove("justUpdated");
    $("upd").hidden = false;
    $("updTitle").textContent = `Расширение обновлено до версии ${VERSION}`;
    $("updSub").textContent = "Обновите открытые вкладки Pinterest (F5), чтобы на них заработала новая версия.";
    $("updGo").hidden = true;
    $("updClose").hidden = false;
    if (update && update.notes && update.version === VERSION) {
      $("updNotes").hidden = false;
      renderNotes(update.notes, $("updNotesText"));
    }
    return;
  }
  showRelease(update);
  showChecked(update);
  const fresh = await chrome.runtime.sendMessage({ type: "checkUpdate" }).catch(() => null);
  if (fresh) {
    showRelease(fresh);
    showChecked(fresh);
  }
})();
