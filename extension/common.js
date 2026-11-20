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

  // имя файла или папки, допустимое в Windows
  // (точка или пробел в конце имени Windows не допускает — убираем их и после обрезки по длине)
  function safeName(s, limit = 80) {
    const trim = (x) => x.replace(/^[.\s]+|[.\s]+$/g, "");
    s = trim(String(s || "").replace(/[<>:"/\\|?*\x00-\x1f~]/g, "_").replace(/\s+/g, " "));
    return trim(s.slice(0, limit)) || "untitled";
  }

  return { RESERVED, ACTIVE, isActive, isPinterestHost, pathParts, isBoardPath, isProfilePath, boardKey, safeName };
})();
