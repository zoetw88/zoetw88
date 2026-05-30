#!/usr/bin/env node
// update-stats.mjs — fetch commit stats via GraphQL (includes private contributions)
// then patch README.md between the COMMIT-STATS markers.
// Requires Node 18+ (built-in fetch).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GH_USER = process.env.GH_USER || 'zoetw88';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN env var is required');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'update-stats-action',
};

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { ...HEADERS, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status}`);
  return res.json();
}

// ── Pull yearly contribution calendars going back N years ──────────────
async function fetchYears(user, fromYear, toYear) {
  const years = [];
  for (let y = fromYear; y <= toYear; y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to   = `${y}-12-31T23:59:59Z`;
    const data = await gql(`
      query($user: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $user) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            totalRepositoriesWithContributedCommits
            restrictedContributionsCount
            contributionCalendar {
              totalContributions
              weeks { contributionDays { date contributionCount weekday } }
            }
          }
          createdAt
        }
      }
    `, { user, from, to });
    if (!data.user) throw new Error(`User @${user} not found`);
    years.push({ year: y, ...data.user.contributionsCollection, createdAt: data.user.createdAt });
  }
  return years;
}

// ── Aggregate across years ──────────────────────────────────────────────
function aggregate(years) {
  let totalCommits = 0, totalPRs = 0, totalIssues = 0, totalReviews = 0, privateCount = 0;
  const days = [];        // {date, count, weekday}
  const reposSet = new Set();   // approximate — graphql doesn't list names

  for (const y of years) {
    totalCommits  += y.totalCommitContributions;
    totalPRs      += y.totalPullRequestContributions;
    totalIssues   += y.totalIssueContributions;
    totalReviews  += y.totalPullRequestReviewContributions;
    privateCount  += y.restrictedContributionsCount;
    for (const wk of y.contributionCalendar.weeks) {
      for (const d of wk.contributionDays) {
        if (d.contributionCount > 0) days.push(d);
      }
    }
  }

  // Sort active days
  days.sort((a, b) => a.date.localeCompare(b.date));
  const activeDays = days.length;

  // Longest streak
  let longest = 0, current = 0, prevDate = null;
  for (const d of days) {
    if (prevDate) {
      const diff = (new Date(d.date) - new Date(prevDate)) / 86400000;
      current = diff === 1 ? current + 1 : 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    prevDate = d.date;
  }

  // Current streak (counting back from latest active day if it's recent)
  const today = new Date().toISOString().slice(0, 10);
  let currentStreak = 0;
  if (days.length) {
    const sorted = [...days].reverse();
    let lastDate = sorted[0].date;
    if (lastDate === today || (Date.parse(today) - Date.parse(lastDate)) / 86400000 <= 1) {
      currentStreak = 1;
      for (let i = 1; i < sorted.length; i++) {
        const diff = (Date.parse(sorted[i - 1].date) - Date.parse(sorted[i].date)) / 86400000;
        if (diff === 1) currentStreak++;
        else break;
      }
    }
  }

  // Peak day-of-week
  const weekdayCount = Array(7).fill(0);
  for (const d of days) weekdayCount[d.weekday] += d.contributionCount;
  const weekdayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const peakDay = weekdayNames[weekdayCount.indexOf(Math.max(...weekdayCount))];

  // Years coding (from first active day → today)
  const firstDate = days[0]?.date;
  const yearsCoding = firstDate
    ? Math.max(0.1, (Date.now() - Date.parse(firstDate)) / (1000 * 60 * 60 * 24 * 365))
    : 0;

  return {
    totalCommits, totalPRs, totalIssues, totalReviews,
    privateCount,
    activeDays,
    longest,
    currentStreak,
    peakDay,
    yearsCoding,
    firstDate,
  };
}

// ── Peak hour: scan recent PUBLIC commits via REST (~last 100 per repo, top 10 repos) ──
async function peakHour(user) {
  try {
    const repos = await rest(`/users/${user}/repos?type=public&sort=pushed&per_page=10`);
    const hours = Array(24).fill(0);
    for (const r of repos.filter(r => !r.fork)) {
      try {
        const commits = await rest(`/repos/${user}/${r.name}/commits?author=${user}&per_page=100`);
        if (!Array.isArray(commits)) continue;
        for (const c of commits) {
          const d = new Date(c.commit?.author?.date);
          if (!isNaN(d)) hours[d.getUTCHours()]++;
        }
      } catch {}
    }
    const max = Math.max(...hours);
    if (max === 0) return null;
    return hours.indexOf(max);
  } catch { return null; }
}

// ── Render markdown block ───────────────────────────────────────────────
function renderBlock(s, peak) {
  const pad = (n, len) => String(n).padStart(len, '0');
  const peakStr = peak !== null
    ? `${String(peak).padStart(2, '0')}:00 UTC · ${s.peakDay}`
    : `${s.peakDay}`;

  return [
    '### 🎮 CODING STATS',
    '',
    '```',
    `COMMITS    ${pad(s.totalCommits, 7)}   PRS       ${pad(s.totalPRs, 5)}`,
    `REVIEWS    ${pad(s.totalReviews, 7)}   ISSUES    ${pad(s.totalIssues, 5)}`,
    '',
    `ACTIVE     ${pad(s.activeDays, 4)} DAYS    YEARS    ${s.yearsCoding.toFixed(1)}`,
    `STREAK     ${pad(s.longest, 4)} BEST    NOW      ${pad(s.currentStreak, 3)} DAYS`,
    '',
    `PEAK       ${peakStr}`,
    '```',
    '',
    `<sub>auto-updated daily · ${s.privateCount} private contributions included · times in UTC</sub>`,
  ].join('\n');
}

// ── README injection ────────────────────────────────────────────────────
const START_MARKER = '<!-- COMMIT-STATS:START -->';
const END_MARKER   = '<!-- COMMIT-STATS:END -->';

function injectStats(readme, block) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1) throw new Error('Markers not found in README.md');
  return readme.slice(0, start + START_MARKER.length) + '\n' + block + '\n' + readme.slice(end);
}

// ── Main ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, '..', 'README.md');

(async () => {
  console.log(`Fetching stats for @${GH_USER} ...`);

  // figure out year range from account creation
  const accountInfo = await gql(`query($user: String!){ user(login: $user) { createdAt } }`, { user: GH_USER });
  const startYear = new Date(accountInfo.user.createdAt).getFullYear();
  const endYear = new Date().getFullYear();
  console.log(`Years to scan: ${startYear}–${endYear}`);

  const years = await fetchYears(GH_USER, startYear, endYear);
  const stats = aggregate(years);
  console.log('Stats:', stats);

  const peak = await peakHour(GH_USER);
  console.log('Peak hour (UTC):', peak);

  const block = renderBlock(stats, peak);
  const readme = readFileSync(README_PATH, 'utf-8');
  const updated = injectStats(readme, block);

  if (updated === readme) {
    console.log('No changes');
    process.exit(0);
  }

  writeFileSync(README_PATH, updated, 'utf-8');
  console.log('Updated');
  process.exit(0);
})();
