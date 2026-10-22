// EdgeOne Makers Edge Function: live GitHub stats for the profile README.
//
// Route:  GET /api/stats
// Cache:  KV binding named STATS_KV, stale-while-revalidate (TTL 15 min).
// Env:    GITHUB_TOKEN (required), GITHUB_LOGIN (optional), REFRESH_TOKEN (optional)
//
// Response shape matches stats.json, so badges only need their URL swapped.

const API = "https://api.github.com";
// Bump the key suffix when the payload shape changes, to invalidate old entries.
const KV_KEY = "profile_stats_v4";
const TTL_SECONDS = 900;
const DAY = 86400000;
const ACTIVE_WINDOW_DAYS = 90;
const CALENDAR_WINDOW_DAYS = 365;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
};

const PROFILE_QUERY = `
query ProfileStats($login: String!) {
  user(login: $login) {
    followers { totalCount }
    createdAt
    contributionsCollection {
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
      commitContributionsByRepository(maxRepositories: 100) {
        contributions(first: 1) { totalCount }
        repository { primaryLanguage { name } }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount
      nodes {
        nameWithOwner
        isArchived
        isPrivate
        pushedAt
        stargazerCount
        primaryLanguage { name }
        repositoryTopics(first: 1) { totalCount }
        licenseInfo { key }
      }
    }
  }
}`;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

async function github(url, env, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "xmz-profile-stats",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// KV is injected as a global variable named after the binding, not via env.
function kv(env) {
  return typeof STATS_KV !== "undefined" && STATS_KV ? STATS_KV : null;
}

async function readEntry(env) {
  const store = kv(env);
  if (!store) return null;
  try {
    const entry = await store.get(KV_KEY, { type: "json" });
    if (entry && typeof entry.ts === "number" && entry.data) return entry;
  } catch (error) {
    console.error("kv get failed", error);
  }
  return null;
}

async function writeEntry(env, data) {
  const store = kv(env);
  if (!store) return;
  try {
    await store.put(KV_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (error) {
    console.error("kv put failed", error);
  }
}

async function releaseStats(repos, env) {
  const perRepo = await mapLimit(repos, 6, async (repo) => {
    const releases = await github(`${API}/repos/${repo.nameWithOwner}/releases?per_page=100`, env);
    return {
      count: releases.length,
      downloads: releases.reduce(
        (sum, release) =>
          sum + (release.assets || []).reduce((inner, asset) => inner + (asset.download_count || 0), 0),
        0,
      ),
    };
  });
  return {
    count: perRepo.reduce((sum, item) => sum + item.count, 0),
    downloads: perRepo.reduce((sum, item) => sum + item.downloads, 0),
  };
}

async function countSearch(path, query, env) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await github(`${API}${path}?per_page=1&q=${encodeURIComponent(query)}`, env);
      return result.total_count || 0;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

function summarizeCalendar(collection) {
  const days = collection.contributionCalendar.weeks
    .flatMap((week) => week.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  const windowStart = isoDay(-(CALENDAR_WINDOW_DAYS - 1));
  const activeDays = days.filter((day) => day.date >= windowStart && day.contributionCount > 0).length;

  let longest = 0;
  let current = 0;
  let previous = null;
  for (const day of days) {
    if (day.contributionCount > 0) {
      const yesterday = new Date(new Date(`${day.date}T00:00:00Z`).getTime() - DAY)
        .toISOString()
        .slice(0, 10);
      current = previous === yesterday ? current + 1 : 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
    previous = day.date;
  }

  const months = {};
  for (const day of days) {
    const month = day.date.slice(0, 7);
    months[month] = (months[month] || 0) + day.contributionCount;
  }

  const total =
    collection.contributionCalendar.totalContributions +
    (collection.restrictedContributionsCount || 0);

  return {
    total,
    activeDays,
    longest,
    busiestDay: Math.max(0, ...days.map((day) => day.contributionCount)),
    busiestMonth: Math.max(0, ...Object.values(months)),
    average: activeDays ? Math.round((total / activeDays) * 10) / 10 : 0,
  };
}

function languageLine(collection) {
  const counts = new Map();
  for (const item of collection.commitContributionsByRepository || []) {
    const name = item.repository?.primaryLanguage?.name || "Other";
    counts.set(name, (counts.get(name) || 0) + (item.contributions?.totalCount || 0));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
}

async function buildStats(env, previous = {}) {
  const login = env.GITHUB_LOGIN || "xiaomizhoubaobei";

  const payload = await github(`${API}/graphql`, env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: PROFILE_QUERY, variables: { login } }),
  });
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  const user = payload.data.user;
  // Public repos only, to stay in sync with the public_repos count.
  const repos = user.repositories.nodes.filter((repo) => !repo.isPrivate);
  const collection = user.contributionsCollection;
  const calendar = summarizeCalendar(collection);

  let releases;
  let downloads;
  try {
    const releaseInfo = await releaseStats(repos, env);
    releases = releaseInfo.count;
    downloads = releaseInfo.downloads;
  } catch (error) {
    // Never cache a bogus 0: reuse the previous entry, or fail the whole refresh.
    if (typeof previous.releases !== "number" || typeof previous.release_downloads !== "number") {
      throw error;
    }
    console.error("release stats failed, keeping previous values", error);
    releases = previous.releases;
    downloads = previous.release_downloads;
  }

  let commits;
  try {
    commits = await countSearch("/search/commits", `author:${login}`, env);
  } catch (error) {
    if (typeof previous.commits !== "number") throw error;
    console.error("commit search failed, keeping previous value", error);
    commits = previous.commits;
  }

  let pullRequests;
  try {
    pullRequests = await countSearch("/search/issues", `author:${login} is:pr`, env);
  } catch (error) {
    if (typeof previous.pull_requests !== "number") throw error;
    console.error("pr search failed, keeping previous value", error);
    pullRequests = previous.pull_requests;
  }

  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * DAY;
  const activeRepos = repos.filter(
    (repo) => !repo.isArchived && repo.pushedAt && Date.parse(repo.pushedAt) >= cutoff,
  ).length;

  return {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    public_repos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    stars: repos.reduce((sum, repo) => sum + (repo.stargazerCount || 0), 0),
    commits,
    contributions_year: calendar.total,
    active_repos: `${activeRepos}/${repos.length}`,
    releases,
    pull_requests: pullRequests,
    longest_streak: calendar.longest,
    active_days: calendar.activeDays,
    busiest_day: calendar.busiestDay,
    busiest_month: calendar.busiestMonth,
    avg_per_active_day: calendar.average,
    release_downloads: downloads,
    account_since: user.createdAt.slice(0, 7),
    language_line: languageLine(collection),
    repos_without_topics: repos.filter((repo) => (repo.repositoryTopics?.totalCount || 0) === 0).length,
    repos_without_license: repos.filter((repo) => !repo.licenseInfo).length,
    source: "edgeone-kv",
  };
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({ error: "GITHUB_TOKEN is not configured" }, 500);
  }

  const url = new URL(request.url);
  const forced =
    Boolean(env.REFRESH_TOKEN) && url.searchParams.get("token") === env.REFRESH_TOKEN;

  let entry = await readEntry(env);
  const ageSeconds = entry ? Math.round((Date.now() - entry.ts) / 1000) : Infinity;

  if (forced || !entry || ageSeconds > TTL_SECONDS) {
    const job = buildStats(env, entry?.data).then(async (data) => {
      await writeEntry(env, data);
      return data;
    });

    if (entry && !forced) {
      // Serve the stale copy immediately, refresh in the background.
      if (typeof waitUntil === "function") {
        waitUntil(job.catch((error) => console.error("background refresh failed", error)));
      } else {
        job.catch((error) => console.error("background refresh failed", error));
      }
    } else {
      try {
        entry = { ts: Date.now(), data: await job };
      } catch (error) {
        console.error("refresh failed", error);
        if (!entry) {
          return jsonResponse({ error: "github api unavailable", detail: String(error) }, 502);
        }
      }
    }
  }

  const headers = {
    "cache-control": forced ? "no-store" : "public, max-age=300",
    "x-stats-generated-at": entry.data.generated_at,
    "x-stats-age": String(entry ? Math.round((Date.now() - entry.ts) / 1000) : 0),
  };

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...CORS_HEADERS, ...headers } });
  }

  return jsonResponse(
    { ...entry.data, cache_age_seconds: Math.round((Date.now() - entry.ts) / 1000) },
    200,
    headers,
  );
}
