const $ = (id) => document.getElementById(id);

let tab = null;

// что открыто во вкладке: "pin", "board" или null
function pageKind(url) {
  try {
    if (!PBD.isPinterestHost(new URL(url).hostname)) return null;
  } catch {
    return null; // не ссылка
  }
  const p = PBD.pathParts(url);
  if (p[0] === "pin" && p[1]) return "pin";
  return PBD.isBoardPath(p) ? "board" : null;
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
// вкладка загрузок (открытая или новая) переключится на «Настройки»
$("settings").addEventListener("click", async () => {
  await chrome.storage.local.set({ showTab: { tab: "settings", at: Date.now() } });
  chrome.runtime.sendMessage({ type: "open" });
});
PBD.watchTheme();
$("ver").textContent = "v" + chrome.runtime.getManifest().version;
$("repo").href = "https://github.com/JrTomasLight/Pinterest-Board-Downloader";

// плашка о новой версии — по нажатию открывается вкладка загрузок с кнопкой «Обновить»
async function showUpdate() {
  const { update: u } = await chrome.storage.local.get("update");
  const on = u && u.version && compareVersions(u.version, chrome.runtime.getManifest().version) > 0;
  $("upd").hidden = !on;
  if (on) {
    $("upd").textContent = `Доступна версия ${u.version} — обновить`;
    const small = document.createElement("small");
    small.textContent = "Откроется вкладка загрузок, обновление займёт несколько секунд";
    $("upd").append(small);
  }
}
$("upd").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open" }));
showUpdate();

load();
