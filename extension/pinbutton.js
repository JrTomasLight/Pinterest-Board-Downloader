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
})();
