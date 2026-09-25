# Ghost Job Detector – Firefox Extension (v2.1)

Scores job postings on LinkedIn, Indeed, Glassdoor and ZipRecruiter for ghost-job warning signs and shows a banner explaining why.

Example:

![image](https://github.com/user-attachments/assets/e66ed1cb-2b1e-4fa1-9e24-86716f947fb9)

## How to Install (Temporary for Testing)

1. Download and extract this extension.
2. Open Firefox and go to `about:debugging`.
3. Click **"This Firefox"** → **"Load Temporary Add-on..."**
4. Select the `manifest.json` file in the extracted folder.

> ⚠️ Note: You'll need to re-load it each time you restart Firefox.

## Targeted Sites

The extension only runs on these sites, and only analyzes job pages on them:
- `https://*.linkedin.com/*` – `/jobs/view`, job search / collections with a job selected
- `https://*.indeed.com/*` – `/viewjob`, job searches with a job open
- `https://*.glassdoor.com/*` – job listings and searches with a job open
- `https://*.ziprecruiter.com/*` – job pages and searches with a job open

## Files

- `manifest.json` – extension manifest (MV2)
- `detector-core.js` – scoring engine (pure logic, testable in Node)
- `content-script.js` – finds the posting on the page, stores history, shows the banner
- `popup.html` / `popup.js` – per-page breakdown, banner threshold, history reset
- `icon.png` – extension icon

## Privacy

No data leaves your browser. Job history is kept in the extension's local storage only.

## Signals scored
| Signal | Points |
|---|---|
| Posted 30+ / 60+ / 90+ days (page text or schema.org `datePosted`) | +2 / +3 / +4 |
| "Reposted" label | +3 |
| schema.org `validThrough` already passed / >6 months out | +2 / +1 |
| Disclosure that no vacancy exists or no plan to fill within 90 days (Ontario ESA / NY-style) | +5 |
| Talent-pool / pipeline / evergreen / "future opportunities" language | +3 |
| Pay range ≥2× or ≥$80k wide / >$50k wide / no pay info | +2 / +1 / +1 |
| Very short description, heavy buzzwords, no team or reporting line | +1 each |
| Senior title with entry-level requirements | +1 |
| Unnamed "confidential client" (agency resume harvesting) | +1 |
| 100+ applicants and still open after 3+ weeks | +1 |
| "No longer accepting applications" still shown | +1 |
| You saw the same job 14+ / 30+ days ago | +1 / +3 |
| Same job seen under a different listing URL/ID | +2 |
| **Green flags:** posted ≤7 days, "existing vacancy" disclosure, tight pay range, "Actively reviewing applicants" / "Responsive employer" / "Typically responds within" | −1 to −3 |

Score ≥6 = likely ghost job, 3–5 = possible, <3 = few warning signs.

## Research sources
- Greenhouse 2025 study: ~1 in 5 US postings fake or never filled — https://en.wikipedia.org/wiki/Ghost_job
- Ontario ESA posting rules (Jan 1 2026): vacancy statement, $50k range cap, AI disclosure — https://www.ontario.ca/document/your-guide-employment-standards-act-0/requirements-related-publicly-advertised-job
- New York ghost-job bill (90-day hiring disclosure) — https://www.shrm.org/topics-tools/news/talent-acquisition/new-york-law-ghost-job-postings
- Red flags: posting age, reposts, wide ranges, no team/reporting line — https://www.newsweek.com/listings-for-ghost-jobs-are-rising-heres-how-to-spot-them-12108650
- LinkedIn analysis (27.4% likely ghost, 30-day threshold) — https://blog.theinterviewguys.com/ghost-jobs-exposed/
- Evergreen posting language — https://staffingbystarboard.com/blog/the-rise-of-evergreen-postings-real-or-fake-opportunities/
- Employer responsiveness badges (LinkedIn, Indeed, Greenhouse) — https://fortune.com/2025/02/02/linkedin-indeed-greenhouse-job-seekers-likely-response-interviews
