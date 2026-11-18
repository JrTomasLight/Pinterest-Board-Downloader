const $ = (id) => document.getElementById(id);
const RESERVED = new Set(["pin", "search", "ideas", "today", "settings", "business", "_", "resource",
  "login", "signup", "explore", "news_hub", "notifications", "messages", "shopping"]);

let tab = null;

// что открыто во вкладке: "pin", "board" или null
function pageKind(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)pinterest\.[a-z.]+$/.test(u.hostname)) return null;
    const p = u.pathname.split("/").filter(Boolean);
    if (p[0] === "pin" && p[1]) return "pin";
    if (p.length >= 2 && !RESERVED.has(p[0]) && !RESERVED.has(p[1])) return "board";
  } catch { /* не ссылка */ }
  return null;
}

function render(status) {
  status = status || {};
  const busy = !!status.text && !status.done && !status.error;
  $("collecting").textContent = status.text || "";
  $("error").textContent = status.error || "";
  $("go").disabled = busy;
  $("paste").disabled = busy;
}

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const kind = tab && pageKind(tab.url);
  if (kind) {
    $("go").hidden = false;
    $("go").textContent = kind === "pin" ? "Скачать этот пин" : "Скачать эту доску";
  } else {
    $("hint").textContent = "Откройте доску или пин на Pinterest, или вставьте ссылку ниже.";
  }
  const { status } = await chrome.storage.local.get("status");
  // старое сообщение о завершении не показываем
  render(status && (status.done || status.error) ? null : status);
  if (!kind) $("url").focus();
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.status) render(ch.status.newValue);
});

function start(url) {
  render({ text: "Ищу пины…" });
  chrome.runtime.sendMessage({ type: "download", url, tabId: tab && tab.id });
}

$("go").addEventListener("click", () => start(tab.url));
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) {
    render({ error: "Вставьте ссылку на пин или доску." });
    return;
  }
  start(url);
  $("url").value = "";
});
$("open").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open" }));
$("ver").textContent = "v" + chrome.runtime.getManifest().version;
$("repo").href = "https://github.com/JrTomasLight/Pinterest-Board-Downloader";

load();
