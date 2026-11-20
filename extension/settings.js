// Вкладка «Настройки» страницы загрузок. Каждое поле с data-set="<имя>" — одна настройка из PBD.DEFAULTS.
// В chrome.storage.local ("settings") хранятся только значения, отличные от значений по умолчанию:
// так новые значения по умолчанию в следующих версиях дойдут и до тех, кто настройки не трогал.

const setFields = [...document.querySelectorAll("[data-set]")];

function paintSettings(s) {
  for (const el of setFields) {
    const v = s[el.dataset.set];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v);
  }
}

// сохранения идут строго по одному: иначе два быстрых переключения прочитают одно и то же
// и второе затрёт первое
let saving = Promise.resolve();
function saveSetting(name, value) {
  saving = saving.then(async () => {
    const { settings: saved = {} } = await chrome.storage.local.get("settings");
    const next = { ...saved, [name]: value };
    if (value === PBD.DEFAULTS[name]) delete next[name];
    await chrome.storage.local.set({ settings: next });
  }).catch(() => {});
  return saving;
}

for (const el of setFields) {
  el.addEventListener("change", () => {
    const name = el.dataset.set;
    const def = PBD.DEFAULTS[name];
    const value = el.type === "checkbox" ? el.checked : typeof def === "number" ? Number(el.value) : el.value;
    saveSetting(name, value);
  });
}

$("setReset").addEventListener("click", async () => {
  if (!confirm("Вернуть все настройки к значениям по умолчанию?")) return;
  await chrome.storage.local.remove("settings");
});

PBD.getSettings().then(paintSettings);
// настройки могли поменять в другой вкладке загрузок
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) paintSettings({ ...PBD.DEFAULTS, ...(ch.settings.newValue || {}) });
});
