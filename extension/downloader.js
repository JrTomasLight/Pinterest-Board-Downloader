// Страница загрузки: пишет файлы досок прямо в выбранную папку
// (без окна «Сохранить как» на каждый файл).

const PARALLEL = 4;
const $ = (id) => document.getElementById(id);

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
const GALLERY_DIR = "_галерея"; // index.html и pins.json
const NUM = /^\d+_/;           // номер позиции в начале имени файла
const restOf = (stem) => stem.replace(NUM, ""); // id пина (+ _01 для карусели) без номера

// Файлы пинов в папке, сгруппированные по id пина (без номера позиции):
// так скачанный пин узнаётся, даже если на доске он сдвинулся.
async function existingPinFiles(dir) {
  const map = new Map(); // id -> [имена файлов]
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file" || name.endsWith(".crswap") || !NUM.test(name)) continue;
    const rest = restOf(name.replace(/\.[^.]+$/, ""));
    if (!map.has(rest)) map.set(rest, []);
    map.get(rest).push(name);
  }
  return map;
}

// Переименование/перенос файла. move() есть не во всех версиях браузера — тогда копируем.
async function moveFile(dir, name, targetDir, newName) {
  const h = await dir.getFileHandle(name);
  if (h.move) {
    try {
      await (targetDir === dir ? h.move(newName) : h.move(targetDir, newName));
      return;
    } catch { /* пробуем копированием */ }
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
async function renumberSections(rootFolder) {
  if (!rootFolder.subfolders.length) return 0;
  const rootDir = await getDir(rootFolder.path);
  const dirs = [];
  for await (const [name, h] of rootDir.entries()) if (h.kind === "directory") dirs.push(name);
  const wanted = new Set(rootFolder.subfolders.map((s) => s.dir));
  const title = (d) => d.replace(/^\d+ /, "");
  let moved = 0;
  for (const s of rootFolder.subfolders) {
    if (dirs.includes(s.dir)) continue;
    const old = dirs.find((d) => !wanted.has(d) && /^\d+ /.test(d) && title(d) === title(s.dir));
    if (!old) continue;
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

async function syncFolder(folder, dir, stats) {
  if (folder.single) return syncSingles(folder, dir, stats);
  const have = await existingPinFiles(dir);
  const jobs = [];
  let removedDir = null;
  const putAway = async (name) => {
    removedDir ??= await dir.getDirectoryHandle(REMOVED_DIR, { create: true });
    await moveFile(dir, name, removedDir, name);
    stats.removed++;
  };

  const renames = [];
  for (const pin of folder.pins) {
    pin.files = pin.media.map(() => null);
    pin.media.forEach((m, k) => {
      stats.total++;
      const names = have.get(restOf(m.stem));
      if (!names) {
        jobs.push({ dir, pin, k, m });
        return;
      }
      have.delete(restOf(m.stem));
      const keep = names.find((n) => n.startsWith(m.stem + ".")) || names[0];
      const target = m.stem + keep.slice(keep.lastIndexOf("."));
      renames.push({ keep, target, extra: names.filter((n) => n !== keep) });
      pin.files[k] = target;
      stats.done++;
    });
  }

  for (const r of renames) for (const n of r.extra) await putAway(n); // дубликаты
  for (const names of have.values()) for (const n of names) await putAway(n); // убраны с доски
  // в имени есть id пина, поэтому новое имя не может быть занято другим пином
  for (const r of renames) {
    if (r.keep === r.target) continue;
    await moveFile(dir, r.keep, dir, r.target);
    stats.renamed++;
  }
  return jobs;
}

async function writeResponse(dir, name, resp) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await resp.body.pipeTo(w);
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

async function get(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status}`);
      if (r.status === 403 || r.status === 404) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw last;
}

async function head(url) {
  try {
    return (await fetch(url, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

function extOf(url, kind) {
  const m = new URL(url).pathname.toLowerCase().match(/\.(jpe?g|png|gif|webp|mp4)$/);
  return m ? "." + m[1] : kind === "image" ? ".jpg" : ".mp4";
}

async function saveHls(dir, stem, url) {
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
  // запасной вариант — склеиваем поток в .ts (открывается в VLC и большинстве плееров)
  let playlist = await (await get(url)).text();
  if (playlist.includes("#EXT-X-STREAM-INF")) {
    let best = null, bw = -1;
    const lines = playlist.split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = l.match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
      if (m && lines[i + 1] && +m[1] > bw) { bw = +m[1]; best = new URL(lines[i + 1], url).href; }
    });
    url = best;
    playlist = await (await get(url)).text();
  }
  const segs = playlist.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, url).href);
  const name = stem + ".ts";
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    for (const s of segs) await w.write(await (await get(s)).arrayBuffer());
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* */ }
    throw e;
  }
  return name;
}

async function saveMedia(dir, m) {
  if (m.kind === "hls") return saveHls(dir, m.stem, m.url);
  let resp;
  try {
    resp = await get(m.url);
  } catch (e) {
    // оригинала картинки иногда нет — берём 736px
    if (m.kind === "image" && m.url.includes("/originals/")) resp = await get(m.url.replace("/originals/", "/736x/"));
    else throw e;
  }
  const name = m.stem + extOf(m.url, m.kind);
  await writeResponse(dir, name, resp);
  return name;
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
function boardView(board) {
  const el = document.createElement("section");
  el.className = "board";
  el.innerHTML = `<h2></h2><div class="bar"><i></i></div><div class="row"><span class="st"></span><span class="er"></span></div>`;
  el.querySelector("h2").textContent = board.title;
  if (board.gated) {
    const w = document.createElement("p");
    w.className = "warn";
    w.textContent = `Найдено только ${board.found} из ${board.expected} пинов — похоже, вы не вошли в аккаунт Pinterest.`;
    el.append(w);
  }
  const noteEl = document.createElement("p");
  noteEl.className = "note";
  el.append(noteEl);
  const details = document.createElement("details");
  details.hidden = true;
  details.innerHTML = "<summary>Что не скачалось</summary>";
  el.append(details);
  $("boards").prepend(el);
  return {
    status(text) {
      el.querySelector(".st").textContent = text;
    },
    note(text) {
      noteEl.textContent = text;
    },
    update(done, total, failed, finished) {
      el.querySelector(".bar i").style.width = (total ? ((done + failed) / total) * 100 : 100) + "%";
      const st = el.querySelector(".st");
      st.textContent = `${finished ? "Готово" : "Скачиваю…"} ${done} из ${total}`;
      st.className = "st" + (finished ? " done" : "");
      el.querySelector(".er").textContent = failed ? `ошибок: ${failed}` : "";
    },
    error(text) {
      details.hidden = false;
      const row = document.createElement("div");
      row.textContent = text;
      details.append(row);
    },
  };
}

async function downloadBoard(board) {
  const view = boardView(board);
  view.status("Сверяю с уже скачанным…");
  dirCache.clear(); // папки разделов могли переименоваться
  const stats = { total: 0, done: 0, renamed: 0, removed: 0 };
  const jobs = [];
  await renumberSections(board.folders[0]);
  for (const folder of board.folders) {
    jobs.push(...(await syncFolder(folder, await getDir(folder.path), stats)));
  }
  const total = stats.total;
  let done = stats.done, failed = 0;
  const notes = [];
  if (stats.done) notes.push(`уже было: ${stats.done}`);
  if (stats.renamed) notes.push(`перенумеровано: ${stats.renamed}`);
  if (stats.removed) notes.push(`убрано в «${REMOVED_DIR}»: ${stats.removed}`);
  if (jobs.length) notes.push(`новых: ${jobs.length}`);
  view.note(notes.join(", "));
  view.update(done, total, failed, false);

  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      try {
        j.pin.files[j.k] = await saveMedia(j.dir, j.m);
        done++;
      } catch (e) {
        failed++;
        view.error(`${j.pin.link} — ${e.message || e}`);
      }
      view.update(done, total, failed, false);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  for (const folder of board.folders) {
    if (folder.single) continue; // для отдельных пинов галерея не нужна
    const dir = await getDir(folder.path);
    // служебные файлы прошлых версий лежали рядом с картинками — убираем
    for (const old of ["index.html", "pins.json"]) {
      try { await dir.removeEntry(old); } catch { /* нет такого */ }
    }
    const gallery = await dir.getDirectoryHandle(GALLERY_DIR, { create: true });
    await writeText(gallery, "index.html", indexHtml(folder));
    const list = folder.pins.map((p) => ({ n: p.n, id: p.id, title: p.title, link: p.link, files: p.files.filter(Boolean) }));
    await writeText(gallery, "pins.json", JSON.stringify(list, null, 1));
  }
  view.update(done, total, failed, true);
}

// ------------------------------------------------------------ очередь досок
const seen = new Set();
let running = false;

async function run() {
  if (running) return;
  if (!(await ensureRoot())) return;
  running = true;
  try {
    while (true) {
      const { pending = [] } = await chrome.storage.local.get("pending");
      const item = pending.find((p) => !seen.has(p.key));
      if (!item) break;
      seen.add(item.key);
      try {
        await downloadBoard(item.data);
      } catch (e) {
        boardView(item.data).error("Не удалось сохранить: " + (e.message || e));
      }
      await chrome.runtime.sendMessage({ type: "taken", key: item.key });
    }
  } finally {
    running = false;
  }
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.pending) run();
});
$("pick").addEventListener("click", pickFolder);

(async () => {
  const saved = await loadRoot().catch(() => null);
  if (saved) $("folderName").textContent = saved.name;
  run();
})();
