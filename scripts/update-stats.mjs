#!/usr/bin/env node
// update-stats.mjs — fetch GitHub commit stats and update README.md
// Pure Node, no npm install required. Requires Node 18+ (built-in fetch).

const GH_USER = process.env.GH_USER || 'zoetw88';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN env var is required');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'update-stats-action',
};

async function ghFetch(path) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Fetch repos (public, non-fork, sorted by pushed; paginated) ---
async function getRepos() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const data = await ghFetch(
      `/users/${GH_USER}/repos?type=public&sort=pushed&per_page=100&page=${page}&affiliation=owner`
    );
    if (!data.length) break;
    all.push(...data);
    if (data.length < 100) break;
  }
  return all.filter((r) => !r.fork);
}

// --- Fetch ALL commits by the user for a repo (paginated up to 5 pages = 500 commits) ---
async function getCommits(repoName) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const data = await ghFetch(
        `/repos/${GH_USER}/${repoName}/commits?author=${GH_USER}&per_page=100&page=${page}`
      );
      if (!Array.isArray(data) || data.length === 0) break;
      const dates = data
        .filter((c) => c.commit?.author?.date)
        .map((c) => new Date(c.commit.author.date));
      all.push(...dates);
      if (data.length < 100) break;
    } catch (e) {
      // 409 = empty repo; other errors logged but don't fail the whole job
      if (!String(e.message).includes('409')) {
        console.warn(`  ! ${repoName}: ${e.message}`);
      }
      break;
    }
  }
  return all;
}

// --- Analysis helpers ---
function longestStreak(dates) {
  if (dates.length === 0) return 0;
  const uniqueDays = [...new Set(dates.map((d) => d.toISOString().slice(0, 10)))].sort();
  let longest = 1;
  let current = 1;
  for (let i = 1; i < uniqueDays.length; i++) {
    const prev = new Date(uniqueDays[i - 1]);
    const curr = new Date(uniqueDays[i]);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

function peakHour(dates) {
  const counts = Array(24).fill(0);
  for (const d of dates) counts[d.getUTCHours()]++;
  return counts.indexOf(Math.max(...counts));
}

function peakDayName(dates) {
  const names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const counts = Array(7).fill(0);
  for (const d of dates) counts[d.getUTCDay()]++;
  return names[counts.indexOf(Math.max(...counts))];
}

function yearsCoding(dates) {
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  return Math.round((span / (1000 * 60 * 60 * 24 * 365)) * 10) / 10;
}

// --- Render the stats block ---
function renderBlock(stats) {
  const { totalCommits, repoCount, years, streak, peak, peakDay } = stats;

  const pointsStr = String(totalCommits).padStart(7, '0');
  const worldStr = `${repoCount} REPOS`;
  const timeStr = `${years.toFixed(1)} YRS`;
  const livesStr = `${streak} STREAK`;
  const peakStr = `${String(peak).padStart(2, '0')}:00 · ${peakDay}`;

  return [
    '### 🎮 CODING STATS',
    '',
    '```',
    `POINTS  ${pointsStr}   ·   WORLD  ${worldStr}`,
    `TIME    ${timeStr}   ·   LIVES  ${livesStr}`,
    `PEAK    ${peakStr}`,
    '```',
    '',
    '<sub>auto-updated daily · times in UTC</sub>',
  ].join('\n');
}

// --- README update ---
const START_MARKER = '<!-- COMMIT-STATS:START -->';
const END_MARKER = '<!-- COMMIT-STATS:END -->';

function injectStats(readmeContent, block) {
  const startIdx = readmeContent.indexOf(START_MARKER);
  const endIdx = readmeContent.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Markers not found in README.md');
  }
  return (
    readmeContent.slice(0, startIdx + START_MARKER.length) +
    '\n' +
    block +
    '\n' +
    readmeContent.slice(endIdx)
  );
}

// --- Main ---
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, '..', 'README.md');

(async () => {
  console.log(`Fetching stats for @${GH_USER} ...`);

  const repos = await getRepos();
  console.log(`Found ${repos.length} public non-fork repos`);

  const allDates = [];
  let reposWithCommits = 0;

  for (const repo of repos) {
    const dates = await getCommits(repo.name);
    if (dates.length > 0) {
      reposWithCommits++;
      allDates.push(...dates);
    }
    process.stdout.write('.');
  }
  console.log('');

  if (allDates.length === 0) {
    console.log('No commits found — skipping README update');
    process.exit(0);
  }

  const stats = {
    totalCommits: allDates.length,
    repoCount: reposWithCommits,
    years: yearsCoding(allDates),
    streak: longestStreak(allDates),
    peak: peakHour(allDates),
    peakDay: peakDayName(allDates),
  };

  console.log('Stats:', stats);

  const block = renderBlock(stats);
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
