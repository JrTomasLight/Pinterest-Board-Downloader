// Общее для фонового скрипта, страниц расширения и скриптов на страницах Pinterest:
// разбор адресов Pinterest, ключ доски и имена папок. Подключается несколько раз в одну
// и ту же вкладку (pinbutton.js и content.js), поэтому без объявлений верхнего уровня
// (и всегда заново: после обновления расширения во вкладке могла остаться прежняя версия).
self.PBD = (() => {
  // первые части адреса, которые не являются именем автора или доски
  const RESERVED = new Set(["pin", "search", "ideas", "today", "settings", "business", "_", "resource",
    "login", "signup", "explore", "news_hub", "notifications", "messages", "shopping"]);

  // этапы загрузки доски, пока она не закончилась
  const ACTIVE = new Set(["collect", "queued", "folder", "sync", "download"]);
  // Сбор, сверка и скачивание сообщают о ходе постоянно. Если такой этап давно не обновлялся,
  // его прервали (перезапуск расширения или браузера, закрытая вкладка) — он больше не идёт.
  const STALE_MS = 10 * 60 * 1000;
  const isActive = (s) => !!s && ACTIVE.has(s.phase) &&
    (!["collect", "sync", "download"].includes(s.phase) || Date.now() - (s.at || 0) < STALE_MS);

  const isPinterestHost = (host) => /(^|\.)pinterest\.[a-z.]+$/.test(host);

  function pathParts(url) {
    try {
      return new URL(url).pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    } catch {
      return null;
    }
  }

  // /<автор>/<доска>/ или /<автор>/<доска>/<раздел>/; /<автор>/_saved/ — это профиль, а не доска
  const isBoardPath = (p) => !!p && p.length >= 2 && !RESERVED.has(p[0]) && !RESERVED.has(p[1]) && !p[1].startsWith("_");
  const isProfilePath = (p) => !!p && p.length >= 1 && !RESERVED.has(p[0]) && (p.length === 1 || p[1].startsWith("_"));

  // Ключ доски — адрес без домена в нижнем регистре: одна доска на pinterest.com и pinterest.ru — одна запись.
  // По нему кнопка «Скачать доску», очередь и список «Мои доски» узнают одну и ту же доску.
  function boardKey(url) {
    const p = pathParts(url);
    return p ? p.map((x) => x.toLowerCase()).join("/") : null;
  }

  // Похожие символы, которые Windows разрешает в именах (настройка «Спецсимволы в именах»).
  const LOOKALIKE = { "<": "＜", ">": "＞", ":": "：", '"': "＂", "/": "⧸", "\\": "⧹", "|": "｜", "?": "？", "*": "＊" };

  // имя файла или папки, допустимое в Windows: запрещённые символы — на «_» или (pretty) на похожие
  // (точка или пробел в конце имени Windows не допускает — убираем их и после обрезки по длине)
  function safeName(s, limit = 80, pretty = false) {
    const trim = (x) => x.replace(/^[.\s]+|[.\s]+$/g, "");
    s = trim(String(s || "").replace(/[<>:"/\\|?*\x00-\x1f~]/g, (c) => (pretty && LOOKALIKE[c]) || "_").replace(/\s+/g, " "));
    return trim(s.slice(0, limit)) || "untitled";
  }

  // Настройки (вкладка «Настройки» страницы загрузок) — в chrome.storage.local под ключом "settings".
  // Хранятся только изменённые значения; остальное берётся отсюда.
  const DEFAULTS = {
    parallel: 6,          // файлов доски одновременно
    numbering: true,      // номер пина на доске в начале имени файла
    prettyNames: false,   // запрещённые символы в названиях — на похожие, а не на «_»
    sections: "folders",  // разделы доски: "folders" — подпапками, "flat" — всё одной папкой
    gallery: true,        // _галерея/index.html
    video: "video",       // "video" — видео, "cover" — только обложка, "skip" — пропускать
    hlsTs: true,          // нет mp4, только поток HLS — склеить в .ts (иначе сохранить обложку)
    notify: true,         // системное уведомление, когда загрузки закончились
    theme: "auto",        // "auto", "light", "dark"
  };
  async function getSettings() {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      return { ...DEFAULTS, ...(settings || {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  // Тема страниц расширения: data-theme="light"/"dark" перебивает системную, без атрибута — как в системе.
  function applyTheme(theme) {
    const r = document.documentElement;
    if (theme === "light" || theme === "dark") r.dataset.theme = theme;
    else delete r.dataset.theme;
  }
  function watchTheme() {
    getSettings().then((s) => applyTheme(s.theme));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.settings) applyTheme((ch.settings.newValue || {}).theme);
    });
  }

  return { RESERVED, ACTIVE, isActive, isPinterestHost, pathParts, isBoardPath, isProfilePath, boardKey, safeName,
    DEFAULTS, getSettings, applyTheme, watchTheme };
})();
