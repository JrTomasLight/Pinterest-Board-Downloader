// Работает внутри открытой вкладки Pinterest: собирает пины доски по порядку,
// используя тот же API, что и сам сайт, и ваш текущий вход в аккаунт.
(() => {
  try {
    if (window.__pinboardDl && window.__pinboardDl()) return; // уже работает
  } catch { /* скрипт от прежней версии расширения — ставим новый */ }
  window.__pinboardDl = () => !!(chrome.runtime && chrome.runtime.id);

  const { safeName, isBoardPath, pathParts } = PBD;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REQUEST_TIMEOUT = 30000;
  const DETAILS_PARALLEL = 4;

  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  let cachedVersion = null;
  async function appVersion() {
    if (cachedVersion !== null) return cachedVersion;
    try {
      cachedVersion = JSON.parse(document.getElementById("__PWS_DATA__").textContent).appVersion || "";
    } catch {
      cachedVersion = "";
    }
    if (!cachedVersion) {
      // страница без встроенных данных — берём версию с главной
      try {
        const html = await (await fetch(location.origin + "/", { credentials: "include" })).text();
        cachedVersion = (html.match(/"appVersion":"(\w+)"/) || [])[1] || "";
      } catch { /* без версии */ }
    }
    return cachedVersion;
  }

  // onRetry(попытка, причина) — сообщить, что Pinterest ответил ошибкой и запрос повторяется:
  // так видно, что сбор не завис, а ждёт сайт
  async function resource(name, options, sourceUrl, onRetry) {
    const params = new URLSearchParams({
      source_url: sourceUrl,
      data: JSON.stringify({ options, context: {} }),
    });
    const headers = {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": csrf(),
      "X-Pinterest-Source-Url": sourceUrl,
      "X-Pinterest-PWS-Handler": sourceUrl.startsWith("/pin/") ? "www/pin/[id].js"
        : /^\/[^/]+\/$/.test(sourceUrl) ? "www/[username].js" : "www/[username]/[slug].js",
    };
    const v = await appVersion();
    if (v) headers["X-APP-VERSION"] = v;

    let lastErr, status = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt && onRetry) onRetry(attempt + 1, lastErr && lastErr.message);
      // без тайм-аута один зависший ответ Pinterest навсегда останавливает сбор пинов
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
      try {
        const r = await fetch(`${location.origin}/resource/${name}/get/?${params}`, {
          headers,
          credentials: "include",
          signal: ctrl.signal,
        });
        if (r.ok) return (await r.json()).resource_response;
        status = r.status;
        lastErr = new Error(r.status === 429 ? "Pinterest просит подождать (слишком много запросов)" : `${name}: HTTP ${r.status}`);
        if (r.status === 403 || r.status === 404) throw lastErr;
      } catch (e) {
        lastErr = ctrl.signal.aborted ? new Error("Pinterest не ответил за 30 секунд") : e;
        if (/HTTP 40[34]/.test(String(e.message))) throw e;
      } finally {
        clearTimeout(timer);
      }
      // «слишком много запросов» — ждём заметно дольше, иначе Pinterest откажет снова
      await sleep((status === 429 ? 10000 : 1500) * (attempt + 1));
    }
    throw lastErr;
  }

  async function* paginate(name, options, src, onRetry) {
    let bookmark = null;
    while (true) {
      const opts = { ...options };
      if (bookmark) opts.bookmarks = [bookmark];
      const r = await resource(name, opts, src, onRetry);
      for (const item of r.data || []) yield item;
      bookmark = r.bookmark;
      if (!bookmark || bookmark === "-end-") return;
    }
  }

  // ---------------------------------------------------------------- медиа пина
  function bestMp4(list) {
    let best = null, bestW = -1;
    for (const v of Object.values(list || {})) {
      const url = (v && v.url) || "";
      if (url.split("?")[0].endsWith(".mp4") && (v.width || 0) > bestW) {
        best = url;
        bestW = v.width || 0;
      }
    }
    return best;
  }

  // cover — обложка видео: её сохраняют вместо видео, если так выбрано в настройках
  function videoMedia(list, cover) {
    const vals = Object.values(list || {});
    cover = cover || (vals.find((v) => v && v.thumbnail) || {}).thumbnail || null;
    const mp4 = bestMp4(list);
    if (mp4) return { kind: "video", url: mp4, cover };
    for (const v of vals) {
      if (v && v.url && v.url.includes(".m3u8")) return { kind: "hls", url: v.url, cover };
    }
    return null;
  }

  function imageUrl(images) {
    if (!images) return null;
    for (const k of ["orig", "originals"]) if (images[k] && images[k].url) return images[k].url;
    let best = null;
    for (const v of Object.values(images)) if (v && v.url && (!best || (v.width || 0) > (best.width || 0))) best = v;
    return best ? best.url : null;
  }

  function pinMedia(pin) {
    const out = [];
    for (const page of (pin.story_pin_data && pin.story_pin_data.pages) || []) {
      for (const block of page.blocks || []) {
        const vl = block.video && block.video.video_list;
        const vm = vl && videoMedia(vl);
        if (vm) { out.push(vm); continue; }
        const img = imageUrl(block.image && block.image.images);
        if (img) out.push({ kind: "image", url: img });
      }
    }
    if (out.length) return out;

    for (const slot of (pin.carousel_data && pin.carousel_data.carousel_slots) || []) {
      const img = imageUrl(slot.images);
      if (img) out.push({ kind: "image", url: img });
    }
    if (out.length) return out;

    const vm = videoMedia(pin.videos && pin.videos.video_list, imageUrl(pin.images));
    if (vm) return [vm];
    const img = imageUrl(pin.images);
    return img ? [{ kind: "image", url: img }] : [];
  }

  function needsDetails(pin) {
    if (pin.story_pin_data_id && !(pin.story_pin_data && (pin.story_pin_data.pages || []).length)) return true;
    if (pin.is_video && !(pin.videos && pin.videos.video_list)) return true;
    return false;
  }

  const isPin = (x) => x && x.type === "pin" && x.id;

  // ---------------------------------------------------------------- доска
  function parseBoard(href) {
    const parts = pathParts(href);
    return isBoardPath(parts) ? { user: parts[0], slug: parts[1], section: parts[2] || null } : null;
  }

  // текст для повтора запроса: «Доска: Pinterest не ответил за 30 секунд — пробую ещё раз (2 из 4)…»
  const retryNote = (label, progress) => (n, why) =>
    progress(`${label}: ${why || "Pinterest не ответил"} — пробую ещё раз (${n} из 4)…`);

  async function collectPins(iter, src, label, progress) {
    const pins = [];
    for await (const item of iter) {
      if (isPin(item)) {
        pins.push(item);
        if (pins.length % 25 === 0) progress(`${label}: найдено пинов ${pins.length}…`);
      }
    }
    progress(`${label}: найдено пинов ${pins.length}`);
    // у видео и story-пинов в ленте доски нет ссылок на файлы — дозапрашиваем их по несколько сразу
    const todo = [];
    pins.forEach((p, i) => needsDetails(p) && todo.push(i));
    let next = 0, done = 0;
    async function worker() {
      while (next < todo.length) {
        const i = todo[next++];
        try {
          const full = (await resource("PinResource", { id: pins[i].id, field_set_key: "detailed" }, src,
            retryNote(label, progress))).data;
          if (full) pins[i] = full;
        } catch { /* оставляем как есть */ }
        done++;
        if (done % 5 === 0 || done === todo.length) {
          progress(`${label}: найдено пинов ${pins.length}, уточняю видео и story-пины: ${done} из ${todo.length}`);
        }
      }
    }
    await Promise.all(Array.from({ length: DETAILS_PARALLEL }, worker));
    return pins;
  }

  function toFolder(path, title, pins) {
    const width = Math.max(4, String(pins.length).length);
    return {
      path,
      title,
      subfolders: [],
      pins: pins.map((pin, i) => {
        const num = String(i + 1).padStart(width, "0");
        const media = pinMedia(pin);
        return {
          n: i + 1,
          id: String(pin.id),
          title: pin.title || pin.grid_title || "",
          link: `https://www.pinterest.com/pin/${pin.id}/`,
          media: media.map((m, k) => ({
            ...m,
            stem: `${num}_${pin.id}` + (media.length > 1 ? `_${String(k + 1).padStart(2, "0")}` : ""),
          })),
        };
      }),
    };
  }

  async function collectBoard(href, progress) {
    const b = parseBoard(href);
    if (!b) throw new Error("Откройте страницу доски (pinterest.com/<автор>/<доска>/).");
    // в заголовках запроса допустима только латиница, поэтому кириллицу в адресе кодируем
    const src = `/${encodeURIComponent(b.user)}/${encodeURIComponent(b.slug)}/`;
    const board = (await resource("BoardResource",
      { username: b.user, slug: b.slug, field_set_key: "detailed" }, src, retryNote("Доска", progress))).data;
    if (!board || !board.id) throw new Error("Доска не найдена.");

    // Имена папок — в двух вариантах (запрещённые символы на «_» и на похожие): какой взять,
    // решает вкладка загрузок по настройкам, когда до доски дойдёт черёд.
    const rootName = safeName(`${b.user} - ${board.name || b.slug}`);
    const rootPretty = safeName(`${b.user} - ${board.name || b.slug}`, 80, true);
    const rootPath = rootName;
    progress(`Доска «${board.name}»: ${board.pin_count} пинов…`);

    let sections = [];
    if (board.section_count) {
      for await (const s of paginate("BoardSectionsResource", { board_id: board.id }, src, retryNote("Разделы", progress))) sections.push(s);
    }
    // номер папки раздела — его место на доске, даже если скачивается один раздел
    const width = String(sections.length).length;
    sections.forEach((s, i) => {
      const num = String(i + 1).padStart(width, "0");
      s._dir = `${num} ${safeName(s.title || s.slug || s.id)}`;
      s._dirPretty = `${num} ${safeName(s.title || s.slug || s.id, 80, true)}`;
    });
    if (b.section) {
      sections = sections.filter((s) => s.slug === b.section);
      if (!sections.length) throw new Error(`Раздел «${b.section}» не найден.`);
    }

    const folders = [];
    let found = 0;
    const subfolders = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const dir = s._dir;
      const label = `Раздел «${s.title}»`;
      progress(`${label}…`);
      const pins = await collectPins(
        paginate("BoardSectionPinsResource", { section_id: s.id, page_size: 25 }, src, retryNote(label, progress)),
        src, label, progress);
      found += pins.length;
      const f = toFolder(`${rootPath}/${dir}`, `${board.name} / ${s.title}`, pins);
      f.dir = dir;
      f.dirPretty = s._dirPretty;
      folders.push(f);
      subfolders.push({ name: s.title || dir, dir, dirPretty: s._dirPretty });
    }

    let rootPins = [];
    if (!b.section) {
      rootPins = await collectPins(
        paginate("BoardFeedResource", {
          board_id: board.id, board_url: src, page_size: 25,
          field_set_key: "react_grid_pin", filter_section_pins: true,
        }, src, retryNote("Доска", progress)), src, "Доска", progress);
      found += rootPins.length;
    }
    const root = toFolder(rootPath, board.name || b.slug, rootPins);
    root.subfolders = subfolders;
    // скачивается один раздел — пины в корне доски не трогаем (иначе их сочтёт убранными с доски)
    if (b.section) root.skip = true;
    folders.unshift(root);

    const expected = b.section ? null : board.pin_count;
    const gated = expected && found < expected * 0.8 && found <= 30;
    const url = `https://www.pinterest.com${src}` + (b.section ? `${encodeURIComponent(b.section)}/` : "");
    return {
      id: board.id, title: board.name || b.slug, root: rootPath, rootPretty, folders, found, expected, gated,
      url, user: b.user, section: b.section || null,
    };
  }

  // ---------------------------------------------------------------- доски профиля
  async function listBoards(user) {
    const src = `/${encodeURIComponent(user)}/`;
    const out = [];
    for await (const b of paginate("BoardsResource", {
      username: user, page_size: 25, privacy_filter: "all", sort: "last_pinned_to", field_set_key: "profile_grid_item",
    }, src)) {
      if (!b || !b.url || !b.name || (b.type && b.type !== "board")) continue;
      out.push({
        id: String(b.id),
        name: b.name,
        url: new URL(b.url, "https://www.pinterest.com").href,
        pins: b.pin_count || 0,
        secret: b.privacy === "secret" || b.privacy === "protected",
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- отдельные пины
  const SINGLE_DIR = "Отдельные пины";

  async function collectSinglePins(ids, progress) {
    const pins = [];
    for (const id of ids) {
      progress(`Пин ${id}…`);
      let resp;
      try {
        resp = await resource("PinResource", { id, field_set_key: "detailed" }, `/pin/${id}/`, retryNote(`Пин ${id}`, progress));
      } catch (e) {
        throw new Error(/HTTP 404/.test(e.message) ? `Пин ${id} не найден (удалён или скрыт).` : e.message);
      }
      if (!resp.data) throw new Error(`Пин ${id} не найден.`);
      pins.push(resp.data);
    }
    const folder = {
      path: SINGLE_DIR,
      title: SINGLE_DIR,
      single: true,
      subfolders: [],
      pins: pins.map((pin, i) => {
        const media = pinMedia(pin);
        const title = pin.title || pin.grid_title || "";
        // имя файла: название пина и id, чтобы его было легко узнать в папке
        const base = (title ? safeName(title, 60) + " - " : "") + pin.id;
        const basePretty = (title ? safeName(title, 60, true) + " - " : "") + pin.id;
        const slot = (k) => (media.length > 1 ? `_${String(k + 1).padStart(2, "0")}` : "");
        return {
          n: i + 1,
          id: String(pin.id),
          title,
          link: `https://www.pinterest.com/pin/${pin.id}/`,
          media: media.map((m, k) => ({ ...m, stem: base + slot(k), stemPretty: basePretty + slot(k) })),
        };
      }),
    };
    if (!folder.pins.some((p) => p.media.length)) throw new Error("В пине не нашлось картинки или видео.");
    const first = folder.pins[0];
    return {
      id: "pins",
      title: pins.length === 1 ? `Пин: ${first.title || first.id}` : `Пины (${pins.length})`,
      root: SINGLE_DIR,
      folders: [folder],
      found: pins.length,
    };
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.cmd === "boards") {
        listBoards(msg.user).then((boards) => reply({ boards }), (e) => reply({ error: String(e.message || e) }));
        return true;
      }
      if (msg.cmd !== "collect") return;
      reply({ ok: true });
      const job = msg.job; // по нему кнопка «Скачать доску» узнаёт, что происходит с её доской
      const progress = (text) => chrome.runtime.sendMessage({ type: "progress", text, job });
      const work = msg.pins ? collectSinglePins(msg.pins, progress) : collectBoard(msg.board || location.href, progress);
      work
        .then((data) => chrome.runtime.sendMessage({ type: "collected", data, job }))
        .catch((e) => chrome.runtime.sendMessage({ type: "error", text: String(e.message || e), job }));
    });
  }
})();
