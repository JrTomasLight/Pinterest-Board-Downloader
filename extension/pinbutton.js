// Кнопка «Скачать» поверх пина при наведении мыши — в ленте, на доске и на странице пина.
// Кнопка одна на всю страницу и висит поверх сайта, поэтому вёрстку Pinterest не трогает.
(() => {
  if (window.__pinboardBtn) return;
  window.__pinboardBtn = true;

  const PIN_RE = /\/pin\/([^/?#]+)/;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Скачать через Pinterest Board Downloader";
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3V3zM5 19h14v2H5z"/></svg>' +
    "<span>Скачать</span>";
  Object.assign(btn.style, {
    position: "fixed", zIndex: "2147483646", display: "none", alignItems: "center", gap: "6px",
    padding: "8px 12px", border: "0", borderRadius: "20px", background: "#e60023", color: "#fff",
    font: "600 13px/1 system-ui, -apple-system, Segoe UI, sans-serif", cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,.25)", whiteSpace: "nowrap",
  });
  const label = btn.querySelector("span");

  let card = null;   // элемент пина, над которым кнопка
  let url = null;    // ссылка на этот пин
  let busy = false;

  function mount() {
    if (!btn.isConnected) document.documentElement.append(btn);
  }

  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  // Главное фото/видео на странице пина: самое большое, которое не ссылка на другой пин.
  let mainMedia = null, mainFor = "";
  function findMain() {
    if (mainFor === location.href && mainMedia && mainMedia.isConnected) return mainMedia;
    mainFor = location.href;
    mainMedia = null;
    let best = 0;
    for (const m of document.querySelectorAll("img, video")) {
      if (m.closest('a[href*="/pin/"]')) continue;
      const r = m.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= 200 && r.height >= 150 && area > best) { best = area; mainMedia = m; }
    }
    return mainMedia;
  }

  // Ищем пин под курсором: карточку со ссылкой /pin/… или главное фото на странице пина.
  function pinAt(el, x, y) {
    if (!el || el === btn || btn.contains(el)) return null;
    const a = el.closest && el.closest('a[href*="/pin/"]');
    if (a && PIN_RE.test(a.getAttribute("href")) && a.querySelector("img, video")) {
      const box = a.closest("[data-grid-item]") || a;
      return { card: box, url: new URL(a.getAttribute("href"), location.href).href };
    }
    if (PIN_RE.test(location.pathname)) {
      const m = findMain();
      if (m && inside(m.getBoundingClientRect(), x, y)) return { card: m, url: location.href };
    }
    return null;
  }

  function place() {
    if (!card || !card.isConnected) return hide();
    const r = card.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.width < 60) return hide();
    // левый нижний угол: сверху у Pinterest свои кнопки «Сохранить» и выбор доски
    const top = Math.min(Math.max(r.bottom - 52, r.top + 8), innerHeight - 44);
    btn.style.left = Math.max(r.left + 10, 4) + "px";
    btn.style.top = Math.max(top, 4) + "px";
    btn.style.display = "inline-flex";
  }

  function hide() {
    if (busy) return;
    btn.style.display = "none";
    card = null;
    url = null;
  }

  function setLabel(text, bg) {
    label.textContent = text;
    btn.style.background = bg || "#e60023";
  }

  document.addEventListener("mouseover", (e) => {
    if (busy || e.target === btn || btn.contains(e.target)) return;
    const hit = pinAt(e.target, e.clientX, e.clientY);
    if (hit) {
      if (hit.card !== card) {
        mount();
        card = hit.card;
        url = hit.url;
        setLabel("Скачать");
      }
      place();
    } else if (card && !inside(card.getBoundingClientRect(), e.clientX, e.clientY)) {
      hide();
    }
  }, true);
  document.addEventListener("mouseleave", () => hide());

  addEventListener("scroll", () => card && place(), { passive: true, capture: true });
  addEventListener("resize", () => card && place());

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!url || busy) return;
    busy = true;
    setLabel("Добавляю…");
    let timer = null;
    const finish = (text, bg, title) => {
      chrome.storage.onChanged.removeListener(watch);
      clearTimeout(timer);
      setLabel(text, bg);
      if (title) btn.title = title;
      setTimeout(() => {
        busy = false;
        btn.title = "Скачать через Pinterest Board Downloader";
        hide();
      }, 1800);
    };
    const watch = (ch, area) => {
      const st = area === "local" && ch.status && ch.status.newValue;
      if (!st) return;
      if (st.error) finish("Ошибка", "#8a1c1c", st.error);
      else if (st.done) finish("✓ В очереди", "#1a7f37");
    };
    chrome.storage.onChanged.addListener(watch);
    timer = setTimeout(() => finish("Скачать"), 30000);
    chrome.runtime.sendMessage({ type: "download", url });
  });

  // не даём клику по кнопке открыть пин под ней
  for (const ev of ["mousedown", "mouseup", "pointerdown", "pointerup"]) {
    btn.addEventListener(ev, (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------------- «Скачать доску» в шапке доски
  // Встаёт перед кнопкой «Поделиться» и берёт у неё цвет, высоту и скругление,
  // поэтому выглядит как родная и на своей доске, и на чужой.
  const RESERVED = new Set(["pin", "search", "ideas", "today", "settings", "business", "_", "resource",
    "login", "signup", "explore", "news_hub", "notifications", "messages", "shopping"]);

  function onBoardPage() {
    const p = location.pathname.split("/").filter(Boolean);
    return p.length >= 2 && !RESERVED.has(p[0]) && !RESERVED.has(p[1]);
  }

  const visible = (el) => el && el.getClientRects().length > 0;

  // Кнопка в шапке доски, перед которой встаём. У секретной доски «Поделиться» нет,
  // поэтому дальше пробуем «•••» и любую другую кнопку из блока действий доски.
  const BLOCKS = '[data-test-id="board-actions"], [data-test-id="board-actions-container"], [data-test-id="board-header"]';

  function findShare() {
    // у публичной доски есть «Поделиться», у секретной — только «•••» со своей меткой
    for (const id of ["share-board-button", "more-board-options"]) {
      const tagged = [...document.querySelectorAll(`[data-test-id="${id}"]`)].find(visible);
      if (tagged) return tagged;
    }
    const BTN = 'button, [role="button"]';
    for (const header of document.querySelectorAll(BLOCKS)) {
      const pick = (sel) => [...header.querySelectorAll(sel)].find((b) => visible(b) && !boardBtn.contains(b));
      const found = pick('[aria-label^="Поделиться"], [aria-label^="Share"]') ||
        pick('[aria-label*="вариант" i], [aria-label*="options" i], [aria-label*="ещё" i], [aria-label*="more" i]');
      if (found) return found.closest(BTN) || found;
    }
    return null;
  }

  // элемент ряда кнопок, в котором лежит кнопка-ориентир; выше блока действий не поднимаемся
  function rowItem(share) {
    const stop = share.closest(BLOCKS);
    // ближайший горизонтальный flex-ряд — даже если кнопка в нём одна (секретная доска)
    for (let el = share; el && el !== stop && el.parentElement; el = el.parentElement) {
      const cs = getComputedStyle(el.parentElement);
      if (cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) return el;
    }
    let el = share;
    while (el.parentElement && el.parentElement !== stop && el.parentElement.children.length < 2) el = el.parentElement;
    return el;
  }

  const boardBtn = document.createElement("button");
  boardBtn.type = "button";
  boardBtn.dataset.pinboardDl = "board";
  boardBtn.title = "Скачать всю доску через Pinterest Board Downloader";
  boardBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="currentColor" d="M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3V3zM5 19h14v2H5z"/></svg>' +
    "<span>Скачать доску</span>";
  const boardLabel = boardBtn.querySelector("span");
  let boardBusy = false;

  const opaque = (c) => c && c !== "transparent" && !/rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);

  // Цвет у кнопок Pinterest задаёт не сама <button>, а вложенный элемент — ищем его.
  function styleLike(share) {
    let face = null;
    for (const el of [share, ...share.querySelectorAll("*")]) {
      if (el instanceof SVGElement) continue;
      if (opaque(getComputedStyle(el).backgroundColor)) { face = el; break; }
    }
    const cs = getComputedStyle(face || share);
    const r = (face || share).getBoundingClientRect();
    Object.assign(boardBtn.style, {
      display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap", boxSizing: "border-box",
      height: Math.round(r.height || 48) + "px", padding: "0 16px", border: "0", margin: "0",
      borderRadius: face && cs.borderRadius !== "0px" ? cs.borderRadius : "16px",
      background: face ? cs.backgroundColor : "#e9e9e9",
      color: face ? cs.color : "#111",
      font: "600 14px/1 system-ui, -apple-system, Segoe UI, sans-serif", cursor: "pointer",
    });
  }

  // выравниваем по верхнему краю «Поделиться»
  function alignWith(share) {
    const target = (share.querySelector("button") || share).getBoundingClientRect().top;
    const delta = Math.round(target - boardBtn.getBoundingClientRect().top);
    if (delta) boardBtn.style.marginTop = (parseFloat(boardBtn.style.marginTop) || 0) + delta + "px";
  }

  function ensureBoardButton() {
    if (!onBoardPage()) {
      boardBtn.remove();
      return;
    }
    const share = findShare();
    if (!share) return;
    const item = rowItem(share);
    if (boardBtn.isConnected && boardBtn.nextElementSibling === item) return;
    styleLike(share);
    // в ряду кнопок у Pinterest небольшие отступы между элементами — повторяем их
    const gap = getComputedStyle(item.parentElement).columnGap;
    if (!gap || gap === "normal" || gap === "0px") boardBtn.style.marginRight = "8px";
    item.parentElement.insertBefore(boardBtn, item);
    alignWith(share);
  }

  boardBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (boardBusy) return;
    boardBusy = true;
    boardLabel.textContent = "Собираю пины…";
    let timer = null;
    const finish = (text) => {
      chrome.storage.onChanged.removeListener(watch);
      clearTimeout(timer);
      boardLabel.textContent = text;
      setTimeout(() => {
        boardBusy = false;
        boardLabel.textContent = "Скачать доску";
      }, 2500);
    };
    const watch = (ch, area) => {
      const st = area === "local" && ch.status && ch.status.newValue;
      if (!st) return;
      if (st.error) finish("Ошибка");
      else if (st.done) finish("✓ В очереди");
    };
    chrome.storage.onChanged.addListener(watch);
    timer = setTimeout(() => finish("Скачать доску"), 120000);
    chrome.runtime.sendMessage({ type: "download", url: location.href });
  });

  // Pinterest перерисовывает страницу без перезагрузки — следим и возвращаем кнопку на место
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensureBoardButton();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  ensureBoardButton();
})();
