#!/usr/bin/env node
// update-stats.mjs — rich GitHub stats via GraphQL + REST
// Pure Node 18+. Requires GITHUB_TOKEN env var.

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

// ── Yearly contribution calendars ──────────────────────────────────────
async function fetchYears(user, fromYear, toYear) {
  const years = [];
  for (let y = fromYear; y <= toYear; y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = `${y}-12-31T23:59:59Z`;
    const data = await gql(`
      query($user: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $user) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            restrictedContributionsCount
            contributionCalendar {
              totalContributions
              weeks { contributionDays { date contributionCount weekday } }
            }
          }
        }
      }
    `, { user, from, to });
    if (!data.user) throw new Error(`User @${user} not found`);
    years.push({ year: y, ...data.user.contributionsCollection });
  }
  return years;
}

// ── Profile-level info: followers, stars, languages ────────────────────
async function fetchProfileExtras(user) {
  const data = await gql(`
    query($user: String!) {
      user(login: $user) {
        followers { totalCount }
        following { totalCount }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
          totalCount
          nodes {
            stargazerCount
            primaryLanguage { name }
          }
        }
      }
    }
  `, { user });
  const u = data.user;
  const totalStars = u.repositories.nodes.reduce((a, r) => a + r.stargazerCount, 0);
  const langs = {};
  for (const r of u.repositories.nodes) {
    if (r.primaryLanguage) langs[r.primaryLanguage.name] = (langs[r.primaryLanguage.name] || 0) + 1;
  }
  const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
  return {
    followers: u.followers.totalCount,
    following: u.following.totalCount,
    publicRepos: u.repositories.totalCount,
    totalStars,
    topLangs,
  };
}

// ── Aggregate years ────────────────────────────────────────────────────
function aggregate(years) {
  let totalContribs = 0, totalCommits = 0, totalPRs = 0, totalIssues = 0, totalReviews = 0, privateCount = 0;
  const days = [];
  const yearTotals = {};

  for (const y of years) {
    totalContribs += y.contributionCalendar.totalContributions;
    totalCommits  += y.totalCommitContributions;
    totalPRs      += y.totalPullRequestContributions;
    totalIssues   += y.totalIssueContributions;
    totalReviews  += y.totalPullRequestReviewContributions;
    privateCount  += y.restrictedContributionsCount;
    yearTotals[y.year] = y.contributionCalendar.totalContributions;
    for (const wk of y.contributionCalendar.weeks) {
      for (const d of wk.contributionDays) {
        if (d.contributionCount > 0) days.push(d);
      }
    }
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  const activeDays = days.length;

  // Longest streak
  let longest = 0, current = 0, prevDate = null;
  for (const d of days) {
    if (prevDate) {
      const diff = (new Date(d.date) - new Date(prevDate)) / 86400000;
      current = diff === 1 ? current + 1 : 1;
    } else current = 1;
    longest = Math.max(longest, current);
    prevDate = d.date;
  }

  // Current streak
  const today = new Date().toISOString().slice(0, 10);
  let currentStreak = 0;
  if (days.length) {
    const sorted = [...days].reverse();
    const lastDate = sorted[0].date;
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

  // Weekend ratio
  const weekendTotal = weekdayCount[0] + weekdayCount[6];
  const weekdayTotal = weekdayCount.slice(1, 6).reduce((a, b) => a + b, 0);
  const weekendPct = (weekendTotal + weekdayTotal) > 0
    ? Math.round((weekendTotal / (weekendTotal + weekdayTotal)) * 100)
    : 0;

  // Best year
  const bestYear = Object.entries(yearTotals).sort((a, b) => b[1] - a[1])[0];

  // Years coding
  const firstDate = days[0]?.date;
  const yearsCoding = firstDate
    ? Math.max(0.1, (Date.now() - Date.parse(firstDate)) / (1000 * 60 * 60 * 24 * 365))
    : 0;

  // Total possible days
  const totalDays = firstDate
    ? Math.round((Date.now() - Date.parse(firstDate)) / 86400000)
    : 1;
  const activityRate = Math.round((activeDays / totalDays) * 1000) / 10; // %

  // Avg per active day
  const avgPerActive = activeDays > 0 ? Math.round((totalContribs / activeDays) * 10) / 10 : 0;

  return {
    totalContribs, totalCommits, totalPRs, totalIssues, totalReviews, privateCount,
    activeDays, totalDays, activityRate,
    longest, currentStreak,
    peakDay, weekendPct, avgPerActive,
    yearsCoding, firstDate,
    bestYear: bestYear ? { year: bestYear[0], count: bestYear[1] } : null,
  };
}

// ── Peak hour from public commits (UTC) ────────────────────────────────
async function hourDistribution(user) {
  const hours = Array(24).fill(0);
  try {
    const repos = await rest(`/users/${user}/repos?type=public&sort=pushed&per_page=10`);
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
  } catch {}
  return hours;
}

function peakOf(hours) {
  const max = Math.max(...hours);
  return max === 0 ? null : hours.indexOf(max);
}

// ── Achievements (unlocked based on thresholds) ────────────────────────
function achievements(s, extras, peak) {
  const a = [];
  if (s.longest >= 7) a.push('🔥 STREAK STARTER');
  if (s.longest >= 30) a.push('🚀 STREAK MASTER');
  if (s.longest >= 100) a.push('👑 STREAK LEGEND');
  if (s.totalContribs >= 100) a.push('💯 CENTURY');
  if (s.totalContribs >= 500) a.push('⚔️  500 CLUB');
  if (s.totalContribs >= 1000) a.push('🏆 KILO COMMITTER');
  if (peak !== null && (peak < 6 || peak >= 22)) a.push('🌙 NIGHT OWL');
  if (peak !== null && peak >= 5 && peak <= 8) a.push('🌅 EARLY BIRD');
  if (s.weekendPct >= 40) a.push('🍕 WEEKEND WARRIOR');
  if (extras.totalStars >= 1) a.push('⭐ FIRST STAR');
  if (extras.totalStars >= 10) a.push('🌟 RISING STAR');
  if (extras.publicRepos >= 5) a.push('📚 LIBRARY OWNER');
  if (extras.topLangs.length >= 3) a.push('🎨 POLYGLOT');
  if (s.yearsCoding >= 5) a.push('🎖️  VETERAN');
  if (s.currentStreak >= 5) a.push('⚡ ON A ROLL');
  return a;
}

// ── Render markdown ────────────────────────────────────────────────────
function renderBlock(s, extras, peak, hourlyDist) {
  const pad = (n, len) => String(n).padStart(len, '0');
  const bestY = s.bestYear ? `${s.bestYear.year} (${s.bestYear.count})` : '—';

  const ach = achievements(s, extras, peak);
  const achLines = [];
  for (let i = 0; i < ach.length; i += 2) {
    achLines.push(ach.slice(i, i + 2).join('    '));
  }

  // Time-of-day buckets from hourlyDist (24-hour UTC)
  const total = hourlyDist.reduce((a, b) => a + b, 0);
  const SAMPLE_THRESHOLD = 50;   // need this many commits before % is meaningful
  let timingLines = [];
  if (total >= SAMPLE_THRESHOLD) {
    const lateNight = hourlyDist.slice(0, 6).reduce((a, b) => a + b, 0);
    const morning   = hourlyDist.slice(6, 12).reduce((a, b) => a + b, 0);
    const afternoon = hourlyDist.slice(12, 18).reduce((a, b) => a + b, 0);
    const evening   = hourlyDist.slice(18, 24).reduce((a, b) => a + b, 0);
    const buckets = [
      ['🌙 LATE NIGHT (00-06)', lateNight],
      ['🌅 MORNING    (06-12)', morning],
      ['☀️  AFTERNOON  (12-18)', afternoon],
      ['🌃 EVENING    (18-24)', evening],
    ];
    const peakBucket = buckets.reduce((m, b) => b[1] > m[1] ? b : m, buckets[0])[0];
    timingLines = [
      '',
      '🕰️  WHEN YOU CODE (UTC, public commits only)',
      ...buckets.map(([label, count]) => {
        const pct = ((count / total) * 100).toFixed(1).padStart(4);
        const isPeak = label === peakBucket ? '  ← peak' : '';
        return `   ${label}  ${pct}%${isPeak}`;
      }),
      `   Peak hour: ${peak !== null ? String(peak).padStart(2, '0') + ':00' : '—'}`,
      `   Sample size: ${total} commits`,
    ];
  }

  return [
    '### 🎮 CODING STATS',
    '',
    '```',
    '📊 OVERVIEW',
    `   Total: ${s.totalContribs} contribs · ${s.totalCommits} public commits · ${s.privateCount} private`,
    `   First: ${s.firstDate || '—'}`,
    `   Span:  ${s.yearsCoding.toFixed(1)} years (active ${s.activeDays}/${s.totalDays} days · ${s.activityRate}%)`,
    ...timingLines,
    '',
    '📅 DAYS',
    `   Favorite: ${s.peakDay}`,
    `   Weekend coder: ${s.weekendPct}% of activity`,
    `   Avg per active day: ${s.avgPerActive} contribs`,
    '',
    '🔥 STREAKS',
    `   Best:    ${s.longest} consecutive days`,
    `   Current: ${s.currentStreak} days`,
    '',
    '📈 BEST YEAR',
    `   ${bestY}`,
    '',
    '🏆 ACHIEVEMENTS UNLOCKED',
    ...(achLines.length ? achLines.map(l => '   ' + l) : ['   (none yet — keep playing)']),
    '```',
    '',
    '<sub>auto-updated daily · times in UTC · peak hour sampled from public commits</sub>',
  ].join('\n');
}

// ── README injection ───────────────────────────────────────────────────
const START_MARKER = '<!-- COMMIT-STATS:START -->';
const END_MARKER   = '<!-- COMMIT-STATS:END -->';

function injectStats(readme, block) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1) throw new Error('Markers not found');
  return readme.slice(0, start + START_MARKER.length) + '\n' + block + '\n' + readme.slice(end);
}

// ── Main ───────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, '..', 'README.md');

(async () => {
  console.log(`Fetching stats for @${GH_USER} ...`);

  const accountInfo = await gql(`query($user: String!){ user(login: $user) { createdAt } }`, { user: GH_USER });
  const startYear = new Date(accountInfo.user.createdAt).getFullYear();
  const endYear = new Date().getFullYear();
  console.log(`Years: ${startYear}–${endYear}`);

  const [years, extras] = await Promise.all([
    fetchYears(GH_USER, startYear, endYear),
    fetchProfileExtras(GH_USER),
  ]);

  const stats = aggregate(years);
  const hourly = await hourDistribution(GH_USER);
  const peak = peakOf(hourly);

  console.log('Stats:', stats);
  console.log('Extras:', extras);
  console.log('Hourly:', hourly);
  console.log('Peak hour:', peak);

  const block = renderBlock(stats, extras, peak, hourly);
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
