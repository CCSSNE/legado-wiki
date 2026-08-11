import { mkdir, writeFile } from 'node:fs/promises';

const branches = [
  { id: 'c', name: '阅读 C', tag: 'mine', repo: 'CCSSNE/legadoC', term: 'legado-branch-c', pinned: true, note: '站长开发。' },
  {
    id: 'original',
    name: '阅读 原版',
    tag: 'original',
    repo: 'gedoor/legado',
    term: 'legado-branch-original',
    forksUrl: 'https://github.com/gedoor/legado/forks',
    skipAutoForks: true,
    forks: [{ name: 'CCSSNE/legado', repo: 'CCSSNE/legado', url: 'https://github.com/CCSSNE/legado' }],
    backupRelease: { repo: 'CCSSNE/legado', tag: '3.26.04271714' }
  },
  {
    id: 'tauri',
    name: '阅读 Tauri',
    tag: 'tauri',
    repo: 'LegadoTeam/Legado-Tauri',
    term: 'legado-branch-tauri',
    forksUrl: 'https://github.com/LegadoTeam/Legado-Tauri/forks',
    skipAutoForks: true,
    forks: [{ name: 'CCSSNE/Legado-Tauri', repo: 'CCSSNE/Legado-Tauri', url: 'https://github.com/CCSSNE/Legado-Tauri' }],
    backupRelease: { repo: 'CCSSNE/Legado-Tauri', tag: 'v0.9.9-20260528195115-b00000093' }
  },
  { id: 'harmony', name: '阅读 鸿蒙版', tag: 'harmony', repo: 'mgz0227/legado-Harmony', term: 'legado-branch-harmony' },
  { id: 'md3', name: '阅读 MD3', tag: 'md3', repo: 'HapeLee/legado-with-MD3', term: 'legado-branch-md3' },
  { id: 'sigma', name: '阅读 Sigma / 阅读 Plus', tag: 'plus', repo: 'Luoyacheng/legado-E', term: 'legado-branch-sigma' },
  { id: 'main', name: '阅读Beta / 喵公子版', tag: 'beta', repo: 'LegadoTeam/legado', term: 'legado-branch-main' },
  { id: 'archive', name: '阅读 Archive', tag: 'archive', repo: 'Rimchars/legado', term: 'legado-branch-archive' },
  {
    id: 'max',
    name: '阅读 MAX',
    tag: 'max',
    repo: 'youfengknight/Legado_Max',
    term: 'legado-branch-max',
    note: '版本线相当混乱。',
    relatedTitle: 'MAX 分支',
    relatedRepos: [
      { repo: 'Suml-1/Legado_Max', label: '正统继承?' },
      { repo: 'GEd520/legados', label: '辞晨版MAX' },
      { repo: 'DandanLLab/Legado_Max', label: '蛋蛋版MAX' }
    ]
  },
  { id: 'r', name: '阅读 R', tag: 'r', repo: 'refgd/legado', term: 'legado-branch-r' },
  { id: 'shutiao', name: '薯条版', tag: 'shutiao', repo: 'huajideshutiao/legado', term: 'legado-branch-shutiao' },
  { id: 'jingshiro', name: 'Jingshiro 版', tag: 'jingshiro', repo: 'Jingshiro/legado', term: 'legado-branch-jingshiro' },
  { id: 't', name: '阅读 T', tag: 't', repo: 'skybbk1001/legadoT', term: 'legado-branch-t' },
  { id: 'ng', name: '阅读 NG', tag: 'ng', repo: 'joestar817/legado_NG', term: 'legado-branch-ng' }
];

const token = process.env.GITHUB_TOKEN || '';
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'legado-wiki-data-updater'
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const yearMs = 365 * 24 * 60 * 60 * 1000;

function normalizeRelease(release) {
  return {
    name: release.name,
    tagName: release.tag_name,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    createdAt: release.created_at,
    body: release.body,
    assets: Array.isArray(release.assets)
      ? release.assets.map(asset => ({
          name: asset.name,
          size: asset.size,
          browserDownloadUrl: asset.browser_download_url
        }))
      : []
  };
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}`);
  }
  return response.json();
}

async function hydrateBranch(branch) {
  const result = { ...branch, stars: null, sourceUpdatedAt: null, githubArchived: false, release: null, errors: [] };

  try {
    const repo = await githubJson(`/repos/${branch.repo}`);
    result.stars = repo.stargazers_count;
    result.sourceUpdatedAt = repo.pushed_at;
    result.githubArchived = repo.archived;
  } catch (error) {
    result.errors.push(`仓库信息同步失败：${error.message}`);
  }

  await sleep(250);

  try {
    const releases = await githubJson(`/repos/${branch.repo}/releases?per_page=1`);
    if (Array.isArray(releases) && releases.length > 0) {
      result.release = normalizeRelease(releases[0]);
    }
  } catch (error) {
    result.errors.push(`版本信息同步失败：${error.message}`);
  }

  if (!result.release && branch.backupRelease) {
    await sleep(250);
    try {
      const release = await githubJson(`/repos/${branch.backupRelease.repo}/releases/tags/${branch.backupRelease.tag}`);
      result.release = normalizeRelease(release);
      result.release.sourceRepo = branch.backupRelease.repo;
      result.release.sourceUrl = release.html_url;
    } catch (error) {
      result.errors.push(`补档版本同步失败：${error.message}`);
    }
  }

  if (!result.release) {
    result.abandoned = '弃坑';
    result.abandonedReason = '无公开 Release';
  } else {
    const releaseTime = Date.parse(result.release.publishedAt || result.release.createdAt || '');
    if (Number.isFinite(releaseTime) && Date.now() - releaseTime > yearMs) {
      result.abandoned = '弃坑';
      result.abandonedReason = 'Release 超过 1 年未更新';
    }
  }

  if (Array.isArray(branch.forks) && branch.forks.length) {
    result.forks = [];
    for (const fork of branch.forks) {
      await sleep(250);
      if (!fork.repo) {
        result.forks.push(fork);
        continue;
      }

      try {
        const repo = await githubJson(`/repos/${fork.repo}`);
        result.forks.push({
          name: fork.name || repo.full_name,
          repo: fork.repo,
          url: repo.html_url,
          stars: repo.stargazers_count,
          updatedAt: repo.pushed_at
        });
      } catch (error) {
        result.forks.push({
          name: fork.name || fork.repo,
          repo: fork.repo,
          url: fork.url || `https://github.com/${fork.repo}`,
          error: error.message
        });
      }
    }
  }

  if (branch.forksUrl && !branch.skipAutoForks) {
    await sleep(250);
    try {
      const forks = await githubJson(`/repos/${branch.repo}/forks?sort=stargazers&per_page=5`);
      const existing = new Set((result.forks || []).map(fork => fork.repo || fork.name));
      const autoForks = Array.isArray(forks)
        ? forks
            .filter(fork => !existing.has(fork.full_name))
            .map(fork => ({
            name: fork.full_name,
            repo: fork.full_name,
            url: fork.html_url,
            stars: fork.stargazers_count,
            updatedAt: fork.pushed_at
          }))
        : [];
      result.forks = [...(result.forks || []), ...autoForks];
    } catch (error) {
      result.errors.push(`Fork 同步失败：${error.message}`);
      result.forks = result.forks || [];
    }
  }

  if (Array.isArray(branch.relatedRepos) && branch.relatedRepos.length) {
    result.relatedRepos = [];
    for (const related of branch.relatedRepos) {
      await sleep(250);
      try {
        const repo = await githubJson(`/repos/${related.repo}`);
        result.relatedRepos.push({
          repo: related.repo,
          label: related.label,
          url: repo.html_url,
          stars: repo.stargazers_count,
          updatedAt: repo.pushed_at
        });
      } catch (error) {
        result.relatedRepos.push({
          repo: related.repo,
          label: related.label,
          url: `https://github.com/${related.repo}`,
          error: error.message
        });
      }
    }
  }

  await sleep(250);
  return result;
}

const hydrated = [];
for (const branch of branches) {
  hydrated.push(await hydrateBranch(branch));
}

hydrated.sort((left, right) => {
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  return (right.stars ?? -1) - (left.stars ?? -1);
});

const data = {
  generatedAt: new Date().toISOString(),
  branches: hydrated
};

await mkdir('data', { recursive: true });
await writeFile('data/branches.json', `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' });
