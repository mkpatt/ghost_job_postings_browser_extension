/*
  Ghost Job Detector — content script.
  Finds the job posting on the page, runs GhostJobCore.analyze(), remembers the
  job in extension storage (for cross-visit repost detection) and shows a banner.
*/
(function () {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const Core = globalThis.GhostJobCore;
  if (!Core) return;

  const MAX_HISTORY = 3000;
  const BANNER_ID = "ghost-job-detector-banner";

  // Supported sites only: LinkedIn, Indeed, Glassdoor and ZipRecruiter. `path` decides which pages count
  // as a job posting (both sites are single-page apps, so this is re-checked
  // on every navigation). Selectors change often, so each has fallbacks.
  const SITES = [
    { host: /(^|\.)linkedin\.com$/,
      path: /^\/jobs\/(view|search|collections)\b|[?&]currentJobId=/,
      container: [".jobs-search__job-details--container", ".job-view-layout", ".jobs-details", ".jobs-unified-top-card", "main"],
      title: [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", "h1"],
      company: [".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name"] },
    { host: /(^|\.)indeed\.com$/,
      path: /^\/(viewjob|jobs|q-|m\/viewjob)|[?&](jk|vjk)=/,
      container: ["#jobsearch-ViewjobPaneWrapper", ".jobsearch-JobComponent", "#viewJobSSRRoot"],
      title: ["[data-testid='jobsearch-JobInfoHeader-title']", "h2.jobsearch-JobInfoHeader-title", "h1"],
      company: ["[data-testid='inlineHeader-companyName']", "[data-company-name]"] },
    { host: /(^|\.)glassdoor\.com$/,
      path: /^\/(job-listing\/|partner\/joblisting|job\/)|[?&]jl=/i,
      container: ["[data-test='job-details']", "[class*='JobDetails_jobDetailsContainer']", "[class*='JobDetails']", "main"],
      title: ["[data-test='job-title']", "[class*='JobDetails_jobTitle']", "h1"],
      company: ["[data-test='employer-name']", "[class*='EmployerProfile_employerName']"] },
    { host: /(^|\.)ziprecruiter\.com$/,
      path: /^\/(c\/[^/]+\/job\/|jobs\/|job\/|jobs-search|k\/)|[?&](jid|lk)=/i,
      container: ["[data-testid*='job-details' i]", "[class*='job_details' i]", "[class*='JobDetails' i]", ".job_description", "main"],
      title: ["[data-testid*='job-title' i]", "h1", "h2"],
      company: ["[data-testid*='company' i]", "[class*='hiring_company' i]", "a[href*='/co/']"] }
  ];

  function first(selectors) {
    for (const sel of selectors || []) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim()) return el;
      } catch (_) { /* invalid selector on this browser */ }
    }
    return null;
  }

  /** schema.org JobPosting data — most boards and ATSs embed this for Google Jobs. */
  function readJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (_) { continue; }
      const queue = Array.isArray(data) ? data.slice() : [data];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        if (item["@graph"]) queue.push(...item["@graph"]);
        const type = item["@type"];
        if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
          const org = item.hiringOrganization;
          return {
            title: item.title,
            company: typeof org === "string" ? org : org && org.name,
            datePosted: item.datePosted,
            validThrough: item.validThrough,
            description: item.description ? stripHtml(item.description) : ""
          };
        }
      }
    }
    return null;
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body ? doc.body.textContent || "" : "";
  }

  function looksLikeJobPage(site) {
    return !!site && site.path.test(location.pathname + location.search);
  }

  function gatherPosting() {
    const site = SITES.find(s => s.host.test(location.hostname)) || null;
    if (!looksLikeJobPage(site)) return null;
    const ld = readJsonLd();

    const containerEl = first(site.container);
    if (!containerEl) return null; // job pane not rendered yet
    let text = containerEl.innerText || "";
    const banner = document.getElementById(BANNER_ID);
    if (banner && containerEl.contains(banner)) text = text.replace(banner.innerText, "");
    if (ld && ld.description && !text.includes(ld.description.trim().slice(0, 80))) {
      text = text + "\n" + ld.description;
    }
    if (text.trim().length < 200) return null; // content not loaded yet

    const titleEl = first(site.title);
    const companyEl = first(site.company);
    return {
      text,
      meta: {
        title: (ld && ld.title) || (titleEl && titleEl.innerText) || document.title,
        company: (ld && ld.company) || (companyEl && companyEl.innerText) || "",
        datePosted: ld && ld.datePosted,
        validThrough: ld && ld.validThrough,
        url: canonicalUrl(),
        host: location.hostname
      }
    };
  }

  function canonicalUrl() {
    const u = new URL(location.href);
    // LinkedIn and Indeed keep the job id in the query string.
    const keep = ["currentJobId", "jk", "vjk", "jobId", "jl", "jid", "lk"];
    const params = new URLSearchParams();
    keep.forEach(k => { if (u.searchParams.has(k)) params.set(k, u.searchParams.get(k)); });
    const q = params.toString();
    return u.origin + u.pathname + (q ? "?" + q : "");
  }

  // --- Storage -------------------------------------------------------------

  const usePromises = typeof browser !== "undefined";
  function call(fn, ...args) {
    return new Promise(resolve => {
      try {
        if (usePromises) fn(...args).then(resolve, () => resolve(undefined));
        else fn(...args, v => { void (chrome.runtime && chrome.runtime.lastError); resolve(v); });
      } catch (_) { resolve(undefined); }
    });
  }
  const storageGet = key => call(ext.storage.local.get.bind(ext.storage.local), key).then(v => v || {});
  const storageSet = obj => call(ext.storage.local.set.bind(ext.storage.local), obj);

  async function recordAndGetHistory(key, meta, hash) {
    const { ghostJobHistory = {} } = await storageGet("ghostJobHistory");
    const prior = ghostJobHistory[key] ? { ...ghostJobHistory[key], urls: [...(ghostJobHistory[key].urls || [])] } : null;
    const now = Date.now();
    const entry = ghostJobHistory[key] || { firstSeen: now, urls: [], title: meta.title, company: meta.company };
    entry.lastSeen = now;
    entry.hash = hash;
    if (!entry.urls.includes(meta.url)) entry.urls = entry.urls.concat(meta.url).slice(-10);
    ghostJobHistory[key] = entry;

    const keys = Object.keys(ghostJobHistory);
    if (keys.length > MAX_HISTORY) {
      keys.sort((a, b) => (ghostJobHistory[a].lastSeen || 0) - (ghostJobHistory[b].lastSeen || 0))
        .slice(0, keys.length - MAX_HISTORY)
        .forEach(k => delete ghostJobHistory[k]);
    }
    await storageSet({ ghostJobHistory });
    return prior;
  }

  async function getSettings() {
    const { ghostJobSettings = {} } = await storageGet("ghostJobSettings");
    return { minLevel: ghostJobSettings.minLevel || "medium" };
  }

  // --- Banner --------------------------------------------------------------

  function removeBanner() {
    const b = document.getElementById(BANNER_ID);
    if (b) b.remove();
  }

  function showBanner(result) {
    removeBanner();
    const colors = {
      high: { bg: "#b3261e", fg: "#fff" },
      medium: { bg: "#f2a900", fg: "#1a1a1a" },
      low: { bg: "#2e7d32", fg: "#fff" }
    }[result.level];
    const heading = {
      high: "⚠️ Likely ghost job",
      medium: "⚠️ Possible ghost job",
      low: "✅ Few ghost-job warning signs"
    }[result.level];

    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647",
      background: colors.bg, color: colors.fg, font: "14px/1.4 system-ui, sans-serif",
      padding: "8px 14px", boxShadow: "0 2px 6px rgba(0,0,0,.3)"
    });

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" });

    const label = document.createElement("strong");
    label.textContent = `${heading} (score ${result.score})`;
    row.appendChild(label);

    const summary = document.createElement("span");
    summary.textContent = result.reasons.slice(0, 2).map(r => r.category).join(" · ");
    row.appendChild(summary);

    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    row.appendChild(spacer);

    const toggle = button("Details");
    const close = button("✕");
    row.appendChild(toggle);
    row.appendChild(close);
    banner.appendChild(row);

    const details = document.createElement("ul");
    Object.assign(details.style, { display: "none", margin: "8px 0 2px", paddingLeft: "20px" });
    result.reasons.forEach(r => details.appendChild(item(`+${r.points}  ${r.message}`)));
    result.greenFlags.forEach(g => details.appendChild(item(`${g.points}  ✓ ${g.message}`)));
    banner.appendChild(details);

    toggle.addEventListener("click", () => {
      const open = details.style.display === "none";
      details.style.display = open ? "block" : "none";
      toggle.textContent = open ? "Hide" : "Details";
    });
    close.addEventListener("click", removeBanner);

    (document.body || document.documentElement).appendChild(banner);

    function button(txt) {
      const b = document.createElement("button");
      b.textContent = txt;
      Object.assign(b.style, {
        background: "rgba(255,255,255,.2)", color: "inherit", border: "1px solid currentColor",
        borderRadius: "4px", padding: "2px 10px", cursor: "pointer", font: "inherit"
      });
      return b;
    }
    function item(txt) {
      const li = document.createElement("li");
      li.textContent = txt;
      return li;
    }
  }

  // --- Main loop -----------------------------------------------------------

  let lastAnalysis = null;
  let lastSignature = "";
  let running = false;

  async function run() {
    if (running) return;
    const posting = gatherPosting();
    if (!posting) return;

    const hash = Core.hashText(posting.text.slice(0, 5000));
    const signature = posting.meta.url + "|" + hash;
    if (signature === lastSignature) return;

    running = true;
    try {
      lastSignature = signature;
      const key = Core.jobKey(posting.meta.title, posting.meta.company);
      const history = key ? await recordAndGetHistory(key, posting.meta, hash) : null;
      const result = Core.analyze(posting.text, posting.meta, history);
      lastAnalysis = { ...result, title: posting.meta.title, company: posting.meta.company, url: posting.meta.url };
      console.log("[Ghost Job Detector]", lastAnalysis);

      const { minLevel } = await getSettings();
      const rank = { low: 0, medium: 1, high: 2 };
      if (rank[result.level] >= rank[minLevel]) showBanner(result);
      else removeBanner();
    } finally {
      running = false;
    }
  }

  // Job boards are single-page apps: re-run when the URL or content changes.
  let timer = null;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }
  let lastHref = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastSignature = "";
      removeBanner();
    }
    schedule(800);
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  schedule(500);

  // Popup asks for the current page's analysis.
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "ghostJob:getAnalysis") {
      sendResponse({ analysis: lastAnalysis });
    } else if (msg && msg.type === "ghostJob:rerun") {
      lastSignature = "";
      run().then(() => sendResponse({ analysis: lastAnalysis }));
      return true;
    }
    return false;
  });
})();
