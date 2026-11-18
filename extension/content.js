// Работает внутри открытой вкладки Pinterest: собирает пины доски по порядку,
// используя тот же API, что и сам сайт, и ваш текущий вход в аккаунт.
(() => {
  if (window.__pinboardDl) return;
  window.__pinboardDl = true;

  const RESERVED = new Set(["pin", "search", "ideas", "today", "settings", "business", "_", "resource",
    "login", "signup", "explore", "news_hub", "notifications", "messages", "shopping"]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async function resource(name, options, sourceUrl) {
    const params = new URLSearchParams({
      source_url: sourceUrl,
      data: JSON.stringify({ options, context: {} }),
    });
    const headers = {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": csrf(),
      "X-Pinterest-Source-Url": sourceUrl,
      "X-Pinterest-PWS-Handler": sourceUrl.startsWith("/pin/") ? "www/pin/[id].js" : "www/[username]/[slug].js",
    };
    const v = await appVersion();
    if (v) headers["X-APP-VERSION"] = v;

    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${location.origin}/resource/${name}/get/?${params}`, {
          headers,
          credentials: "include",
        });
        if (r.ok) return (await r.json()).resource_response;
        lastErr = new Error(`${name}: HTTP ${r.status}`);
        if (r.status === 403 || r.status === 404) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (/HTTP 40[34]/.test(String(e.message))) throw e;
      }
      await sleep(1500 * (attempt + 1));
    }
    throw lastErr;
  }

  async function* paginate(name, options, src) {
    let bookmark = null;
    while (true) {
      const opts = { ...options };
      if (bookmark) opts.bookmarks = [bookmark];
      const r = await resource(name, opts, src);
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

  function videoMedia(list) {
    const mp4 = bestMp4(list);
    if (mp4) return { kind: "video", url: mp4 };
    for (const v of Object.values(list || {})) {
      if (v && v.url && v.url.includes(".m3u8")) return { kind: "hls", url: v.url };
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

    const vm = videoMedia(pin.videos && pin.videos.video_list);
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
  function safeName(s, limit = 80) {
    s = String(s || "").replace(/[<>:"/\\|?*\x00-\x1f~]/g, "_").replace(/\s+/g, " ").trim();
    s = s.replace(/^[.\s]+|[.\s]+$/g, "");
    return (s || "untitled").slice(0, limit);
  }

  function parseBoard(href) {
    const u = new URL(href);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2 || RESERVED.has(parts[0]) || RESERVED.has(parts[1])) return null;
    return { user: parts[0], slug: parts[1], section: parts[2] || null };
  }

  async function collectPins(iter, src, label, progress) {
    const pins = [];
    for await (const item of iter) {
      if (isPin(item)) {
        pins.push(item);
        if (pins.length % 25 === 0) progress(`${label}: найдено пинов ${pins.length}…`);
      }
    }
    for (let i = 0; i < pins.length; i++) {
      if (!needsDetails(pins[i])) continue;
      try {
        const full = (await resource("PinResource", { id: pins[i].id, field_set_key: "detailed" }, src)).data;
        if (full) pins[i] = full;
      } catch { /* оставляем как есть */ }
    }
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
      { username: b.user, slug: b.slug, field_set_key: "detailed" }, src)).data;
    if (!board || !board.id) throw new Error("Доска не найдена.");

    const rootName = safeName(`${b.user} - ${board.name || b.slug}`);
    const rootPath = rootName;
    progress(`Доска «${board.name}»: ${board.pin_count} пинов…`);

    let sections = [];
    if (board.section_count) {
      for await (const s of paginate("BoardSectionsResource", { board_id: board.id }, src)) sections.push(s);
    }
    if (b.section) {
      sections = sections.filter((s) => s.slug === b.section);
      if (!sections.length) throw new Error(`Раздел «${b.section}» не найден.`);
    }

    const folders = [];
    let found = 0;
    const width = String(sections.length).length;
    const subfolders = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const dir = `${String(i + 1).padStart(width, "0")} ${safeName(s.title || s.slug || s.id)}`;
      const label = `Раздел «${s.title}»`;
      progress(`${label}…`);
      const pins = await collectPins(
        paginate("BoardSectionPinsResource", { section_id: s.id, page_size: 25 }, src), src, label, progress);
      found += pins.length;
      folders.push(toFolder(`${rootPath}/${dir}`, `${board.name} / ${s.title}`, pins));
      subfolders.push({ name: s.title || dir, dir });
    }

    let rootPins = [];
    if (!b.section) {
      rootPins = await collectPins(
        paginate("BoardFeedResource", {
          board_id: board.id, board_url: src, page_size: 25,
          field_set_key: "react_grid_pin", filter_section_pins: true,
        }, src), src, "Доска", progress);
      found += rootPins.length;
    }
    const root = toFolder(rootPath, board.name || b.slug, rootPins);
    root.subfolders = subfolders;
    folders.unshift(root);

    const expected = b.section ? null : board.pin_count;
    const gated = expected && found < expected * 0.8 && found <= 30;
    return { id: board.id, title: board.name || b.slug, root: rootPath, folders, found, expected, gated };
  }

  // ---------------------------------------------------------------- отдельные пины
  const SINGLE_DIR = "Отдельные пины";

  async function collectSinglePins(ids, progress) {
    const pins = [];
    for (const id of ids) {
      progress(`Пин ${id}…`);
      let resp;
      try {
        resp = await resource("PinResource", { id, field_set_key: "detailed" }, `/pin/${id}/`);
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
        return {
          n: i + 1,
          id: String(pin.id),
          title,
          link: `https://www.pinterest.com/pin/${pin.id}/`,
          media: media.map((m, k) => ({ ...m, stem: base + (media.length > 1 ? `_${String(k + 1).padStart(2, "0")}` : "") })),
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
      if (msg.cmd !== "collect") return;
      reply({ ok: true });
      const progress = (text) => chrome.runtime.sendMessage({ type: "progress", text });
      const job = msg.pins ? collectSinglePins(msg.pins, progress) : collectBoard(msg.board || location.href, progress);
      job
        .then((data) => chrome.runtime.sendMessage({ type: "collected", data }))
        .catch((e) => chrome.runtime.sendMessage({ type: "error", text: String(e.message || e) }));
    });
  }
})();
