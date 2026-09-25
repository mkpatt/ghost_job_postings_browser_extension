/*
  Ghost Job Detector — scoring engine (no DOM access, so it can be unit-tested).

  Each signal adds (or subtracts) points and records a human-readable reason.
  Signals are based on 2025–2026 research into ghost jobs:
    - Listings live 30+ days / reposted repeatedly (Greenhouse, ResumeUp.AI LinkedIn study)
    - Evergreen / "talent pool" / future-consideration language
    - Missing or implausibly wide pay ranges (Ontario caps ranges at $50k from Jan 2026)
    - Vague descriptions with no team, reporting line, or concrete duties
    - Explicit vacancy disclosures (Ontario ESA, Jan 2026; New York bill passed 2026)
    - Employer-responsiveness badges on LinkedIn / Indeed (green flags)
*/
(function (root) {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;

  // --- Phrase lists -------------------------------------------------------

  // Generic filler that shows up in template-style postings.
  const BUZZWORDS = [
    "fast-paced", "fast paced", "dynamic environment", "self-starter", "self starter",
    "rockstar", "rock star", "ninja", "guru", "synergy", "wear many hats",
    "motivated professional", "results-driven", "go-getter", "team player",
    "hit the ground running", "work hard, play hard", "like a family",
    "other duties as assigned", "passionate individual", "highly motivated"
  ];

  // Pipeline / evergreen / resume-collection language.
  const PIPELINE_PATTERNS = [
    /talent (pool|pipeline|community|network)/,
    /future (opportunit|opening|role|position|need)/,
    /for future consideration/,
    /pipeline (req|requisition|role|position|posting)/,
    /evergreen (req|requisition|role|position|posting|job)/,
    /(always|continuously|constantly) (accepting|looking|hiring|reviewing)/,
    /(general|speculative) application/,
    /not (a|an) (current|active|immediate) (opening|vacancy|position)/,
    /no (current|immediate) (opening|vacancy|vacancies)/,
    /(may|might) not (be )?(an )?(immediate|current)(ly)? (open|opening|available)/,
    /as (positions|openings|roles) become available/,
    /keep your (resume|cv|application) on file/,
    /anticipat\w+ (future )?(openings|needs|growth)/
  ];

  // Explicit "no real vacancy" disclosures (Ontario ESA / NY-style statements).
  const NO_VACANCY_PATTERNS = [
    /(this|the) (posting|position|role|job) is not for an existing vacancy/,
    /(a )?vacancy does not (currently )?exist/,
    /no vacancy (currently )?exists/,
    /not (currently )?an existing vacancy/,
    /does not (currently )?(expect|intend) to fill/,
    /(intends|expects|plans) to fill (this|the) (position|role) in more than 90 days/,
    /seeking (resumes|applications|candidates) for future consideration/
  ];

  // Explicit "real vacancy" disclosures — green flags.
  const VACANCY_PATTERNS = [
    /(this|the) (posting|position|role|job) is for an existing vacancy/,
    /(an )?existing vacancy/,
    /(a )?vacancy (currently )?exists/,
    /(intends|expects|plans) to fill (this|the) (position|role) (with)?in 90 days or less/,
    /(intends|expects|plans) to fill (this|the) (position|role) within \d+ days/
  ];

  // Employer-responsiveness indicators shown by job boards — green flags.
  const RESPONSIVE_PATTERNS = [
    /actively reviewing applicants/,
    /actively recruiting/,
    /responsive employer/,
    /typically responds within/,
    /(usually|often) responds within/,
    /urgently hiring/,
    /hiring (manager|team) (is )?(active|reviewing)/
  ];

  // Staffing agencies harvesting resumes with an unnamed client.
  const AGENCY_PATTERNS = [
    /confidential (company|client|employer)/,
    /our client,? (a|an|is)/,
    /on behalf of (our|a) client/,
    /undisclosed (company|client)/
  ];

  const REPOST_PATTERNS = [
    /\breposted\b/,
    /this job (has been|was) reposted/,
    /repost(ed)? date/
  ];

  const CLOSED_PATTERNS = [
    /no longer accepting applications/,
    /this job (has )?(expired|closed)/,
    /position (has been )?filled/
  ];

  // --- Helpers ------------------------------------------------------------

  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ");
  }

  function anyMatch(patterns, text) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[0];
    }
    return null;
  }

  function unitToDays(n, unit) {
    unit = unit.toLowerCase();
    if (unit.startsWith("min") || unit.startsWith("hour") || unit.startsWith("hr") || unit.startsWith("sec")) return 0;
    if (unit.startsWith("day") || unit === "d") return n;
    if (unit.startsWith("week") || unit === "w" || unit === "wk") return n * 7;
    if (unit.startsWith("month") || unit === "mo") return n * 30;
    if (unit.startsWith("year") || unit === "y" || unit === "yr") return n * 365;
    return null;
  }

  /** Oldest "posted / reposted N units ago" style age found in the text, in days. */
  function extractAgeDays(text) {
    let best = null;
    let reposted = false;
    const re = /(?:(?:(re)?posted|active|listed|published|opened)\s*(?:on\s+)?|·\s*)(\d+)\+?\s*(minutes?|mins?|hours?|hrs?|days?|d|weeks?|wks?|w|months?|mo|years?|yrs?|y)\s+ago/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const days = unitToDays(parseInt(m[2], 10), m[3]);
      if (days === null) continue;
      if (best === null || days > best) best = days;
      if (m[1]) reposted = true;
    }
    if (/(posted|active)\s+(a|one)\s+month\s+ago/.test(text)) best = Math.max(best || 0, 30);
    if (/(posted|active)\s+(a|one)\s+year\s+ago/.test(text)) best = Math.max(best || 0, 365);
    return { days: best, reposted };
  }

  function parseMoney(numStr, suffix) {
    let n = parseFloat(numStr.replace(/,/g, ""));
    if (isNaN(n)) return null;
    if (suffix && suffix.toLowerCase() === "k") n *= 1000;
    return n;
  }

  /** Finds the first salary range like "$70,000 - $180,000" or "$70k–$180k". */
  function extractSalaryRange(text) {
    const re = /[$£€]\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s*(?:-|to|–)\s*[$£€]?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?/i;
    const m = text.match(re);
    if (!m) return null;
    let lo = parseMoney(m[1], m[2] || m[4]);
    let hi = parseMoney(m[3], m[4]);
    if (lo === null || hi === null || hi <= lo) return null;
    // Only treat as an annual salary range (ignore hourly ranges like $20-$25).
    if (hi < 1000) return { lo, hi, hourly: true };
    return { lo, hi, hourly: false };
  }

  function hasAnyPay(text) {
    return /[$£€]\s?\d/.test(text) ||
      /(salary|compensation|pay range|pay rate|base pay|hourly rate|wage)[^.]{0,60}\d/.test(text);
  }

  function daysBetween(a, b) {
    return Math.floor((b - a) / DAY);
  }

  // --- Main analysis ------------------------------------------------------

  /**
   * @param {string} rawText   Visible text of the job posting.
   * @param {object} meta      { title, company, datePosted, validThrough, url, host, now }
   * @param {object|null} history  Prior sighting of this job: { firstSeen, lastSeen, urls[], hash }
   * @returns {{score:number, level:string, reasons:Array, greenFlags:Array}}
   */
  function analyze(rawText, meta, history) {
    meta = meta || {};
    const now = meta.now || Date.now();
    const text = normalize(rawText);
    const title = normalize(meta.title);
    const reasons = [];
    const greenFlags = [];
    let score = 0;

    function flag(points, category, message) {
      score += points;
      reasons.push({ points, category, message });
    }
    function green(points, category, message) {
      score -= points;
      greenFlags.push({ points: -points, category, message });
    }

    // 1. Posting age (on-page text + structured data)
    const age = extractAgeDays(text);
    let ageDays = age.days;
    if (meta.datePosted) {
      const posted = Date.parse(meta.datePosted);
      if (!isNaN(posted)) {
        const d = daysBetween(posted, now);
        if (d >= 0 && (ageDays === null || d > ageDays)) ageDays = d;
      }
    }
    if (ageDays !== null) {
      if (ageDays >= 90) flag(4, "Age", `Listing has been up about ${ageDays} days. Postings live 3+ months are rarely real openings.`);
      else if (ageDays >= 60) flag(3, "Age", `Listing has been up about ${ageDays} days — well past the ~30 days most real roles take to fill.`);
      else if (ageDays >= 30) flag(2, "Age", `Listing has been up about ${ageDays} days (30+ days is a common ghost-job threshold).`);
      else if (ageDays <= 7) green(1, "Age", `Posted recently (${ageDays === 0 ? "today" : ageDays + " days ago"}).`);
    }

    // 2. Reposted
    if (age.reposted || anyMatch(REPOST_PATTERNS, text)) {
      flag(3, "Repost", "Marked as reposted. Repeatedly reposting the same ad is a top ghost-job signal.");
    }

    // 3. Structured-data expiry
    if (meta.validThrough) {
      const vt = Date.parse(meta.validThrough);
      if (!isNaN(vt)) {
        const d = daysBetween(now, vt);
        if (d < 0) flag(2, "Expiry", `The page's own data says this listing expired ${-d} days ago, but it's still live.`);
        else if (d > 180) flag(1, "Expiry", `Listing is set to stay open for ${d} more days — typical of evergreen postings.`);
      }
    }

    // 4. Explicit vacancy disclosures (Ontario / New York-style statements)
    const noVac = anyMatch(NO_VACANCY_PATTERNS, text);
    if (noVac) {
      flag(5, "Disclosure", `Posting discloses there is no current vacancy or no near-term plan to fill it ("${noVac}").`);
    } else {
      const vac = anyMatch(VACANCY_PATTERNS, text);
      if (vac) green(3, "Disclosure", `Posting states it is for a real vacancy ("${vac}").`);
    }

    // 5. Evergreen / talent-pool language
    const pipeline = anyMatch(PIPELINE_PATTERNS, text);
    if (pipeline && !noVac) {
      flag(3, "Pipeline", `Uses pipeline/evergreen language ("${pipeline}") — may be collecting resumes rather than hiring now.`);
    }

    // 6. Pay transparency
    const range = extractSalaryRange(text);
    if (range && !range.hourly) {
      const spread = range.hi - range.lo;
      const ratio = range.hi / range.lo;
      if (ratio >= 2 || spread >= 80000) {
        flag(2, "Pay", `Pay range is extremely wide ($${Math.round(range.lo).toLocaleString()}–$${Math.round(range.hi).toLocaleString()}). Vague ranges often mean the role isn't defined.`);
      } else if (spread > 50000) {
        flag(1, "Pay", `Pay range spans more than $50k (Ontario now caps posted ranges at $50k).`);
      } else {
        green(1, "Pay", "Lists a specific, reasonable pay range.");
      }
    } else if (!range && !hasAnyPay(text)) {
      flag(1, "Pay", "No salary or pay information found.");
    }

    // 7. Vagueness
    const words = text.split(" ").filter(Boolean).length;
    if (words > 0 && words < 150) {
      flag(1, "Vague", `Description is very short (~${words} words).`);
    }
    const buzz = BUZZWORDS.filter(b => text.includes(b));
    if (buzz.length >= 3) {
      flag(1, "Vague", `Heavy on generic buzzwords: ${buzz.slice(0, 5).join(", ")}.`);
    }
    const hasTeamContext = /(report(s|ing)? (directly )?to|reporting line|hiring manager|you'?ll (join|work with)|join (our|the) [a-z-]+ team|as part of the [a-z-]+ team|your manager)/.test(text);
    if (!hasTeamContext && words >= 150) {
      flag(1, "Vague", "No reporting line, named team, or hiring manager mentioned.");
    }

    // 8. Title / seniority mismatch
    if (/\b(senior|sr\.?|lead|principal|staff|director|head of|manager)\b/.test(title) &&
        /(entry[- ]level|0-1 years|0 to 1 year|no experience (required|necessary)|recent (graduate|grad))/.test(text)) {
      flag(1, "Mismatch", "Senior-level title but the description asks for entry-level experience.");
    }

    // 9. Staffing-agency resume harvesting
    const agency = anyMatch(AGENCY_PATTERNS, text);
    if (agency) flag(1, "Agency", `Employer isn't named ("${agency}") — agencies sometimes post roles to collect resumes.`);

    // 10. Applicant volume vs. age
    const applicants = text.match(/(over|more than)?\s*(\d[\d,]*)\+?\s+applicants/);
    if (applicants) {
      const n = parseInt(applicants[2].replace(/,/g, ""), 10);
      if (n >= 100 && ageDays !== null && ageDays >= 21) {
        flag(1, "Applicants", `${applicants[0].trim()} and still open after ${ageDays} days.`);
      }
    }

    // 11. Employer responsiveness badges (green flags)
    const responsive = anyMatch(RESPONSIVE_PATTERNS, text);
    if (responsive) green(2, "Responsive", `Job board shows an activity signal: "${responsive}".`);

    // 12. Closed-but-listed
    const closed = anyMatch(CLOSED_PATTERNS, text);
    if (closed) flag(1, "Closed", `Page says "${closed}" — the listing is stale.`);

    // 13. Your own browsing history (repost detection across visits)
    if (history && history.firstSeen) {
      const sinceFirst = daysBetween(history.firstSeen, now);
      const otherUrls = (history.urls || []).filter(u => u !== meta.url);
      if (sinceFirst >= 30) {
        flag(3, "History", `You first saw this same job ${sinceFirst} days ago and it's still being advertised.`);
      } else if (sinceFirst >= 14) {
        flag(1, "History", `You first saw this same job ${sinceFirst} days ago.`);
      }
      if (otherUrls.length >= 1 && sinceFirst >= 7) {
        flag(2, "History", `This job has appeared under ${otherUrls.length + 1} different listing URLs — likely re-posted under a new ID.`);
      }
    }

    let level = "low";
    if (score >= 6) level = "high";
    else if (score >= 3) level = "medium";

    return { score, level, ageDays, reasons, greenFlags };
  }

  /** Stable key for a job: title + company, normalised. */
  function jobKey(title, company) {
    const clean = s => normalize(s)
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const t = clean(title).slice(0, 80);
    const c = clean(company).slice(0, 60);
    if (!t) return null;
    return c ? `${t} @ ${c}` : t;
  }

  /** Small non-cryptographic hash (FNV-1a) of the description. */
  function hashText(text) {
    let h = 0x811c9dc5;
    const s = normalize(text);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  const api = { analyze, jobKey, hashText, extractAgeDays, extractSalaryRange, normalize };
  root.GhostJobCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
