(function () {
  "use strict";
  const ext = typeof browser !== "undefined" ? browser : chrome;

  const usePromises = typeof browser !== "undefined";
  function call(fn, ...args) {
    return new Promise(resolve => {
      try {
        if (usePromises) fn(...args).then(resolve, () => resolve(undefined));
        else fn(...args, v => { void (chrome.runtime && chrome.runtime.lastError); resolve(v); });
      } catch (_) { resolve(undefined); }
    });
  }
  const getStore = k => call(ext.storage.local.get.bind(ext.storage.local), k).then(v => v || {});
  const setStore = o => call(ext.storage.local.set.bind(ext.storage.local), o);

  const $ = id => document.getElementById(id);
  const LABELS = { high: "Likely ghost job", medium: "Possible ghost job", low: "Few warning signs" };

  function render(a) {
    const verdict = $("verdict");
    const list = $("reasons");
    list.textContent = "";
    if (!a) {
      verdict.className = "none";
      verdict.textContent = "No job posting detected on this page.";
      $("job").textContent = "";
      return;
    }
    verdict.className = a.level;
    verdict.textContent = `${LABELS[a.level]} — score ${a.score}`;
    $("job").textContent = [a.title, a.company].filter(Boolean).join(" · ");
    a.reasons.forEach(r => {
      const li = document.createElement("li");
      li.textContent = `+${r.points} ${r.message}`;
      list.appendChild(li);
    });
    a.greenFlags.forEach(g => {
      const li = document.createElement("li");
      li.className = "green";
      li.textContent = `${g.points} ✓ ${g.message}`;
      list.appendChild(li);
    });
  }

  async function activeTab() {
    const tabs = await call(ext.tabs.query.bind(ext.tabs), { active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  async function ask(type) {
    const tab = await activeTab();
    if (!tab) return render(null);
    const res = await call(ext.tabs.sendMessage.bind(ext.tabs), tab.id, { type });
    render(res && res.analysis);
  }

  async function refreshCount() {
    const { ghostJobHistory = {} } = await getStore("ghostJobHistory");
    $("jobCount").textContent = Object.keys(ghostJobHistory).length;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const { ghostJobSettings = {} } = await getStore("ghostJobSettings");
    $("minLevel").value = ghostJobSettings.minLevel || "medium";
    $("minLevel").addEventListener("change", async e => {
      await setStore({ ghostJobSettings: { ...ghostJobSettings, minLevel: e.target.value } });
      ask("ghostJob:rerun");
    });
    $("rerun").addEventListener("click", () => ask("ghostJob:rerun"));
    $("clearBtn").addEventListener("click", async () => {
      await setStore({ ghostJobHistory: {} });
      refreshCount();
    });
    refreshCount();
    ask("ghostJob:getAnalysis");
  });
})();
