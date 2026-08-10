import { mkdir, writeFile } from 'node:fs/promises';

const branches = [
  { id: 'c', name: '阅读 C', tag: 'mine', repo: 'CCSSNE/legadoC', term: 'legado-branch-c', pinned: true, note: '站长自用分支，固定置顶。' },
  { id: 'original', name: '阅读 原版', tag: 'original', repo: 'gedoor/legado', term: 'legado-branch-original', abandoned: '2026-05-27 弃坑' },
  { id: 'tauri', name: '阅读 Tauri', tag: 'tauri', repo: 'LegadoTeam/Legado-Tauri', term: 'legado-branch-tauri', abandoned: '2026-05-28 弃坑' },
  { id: 'harmony', name: '阅读 鸿蒙版', tag: 'harmony', repo: 'mgz0227/legado-Harmony', term: 'legado-branch-harmony', abandoned: '2026-05-15 弃坑' },
  { id: 'md3', name: '阅读 MD3', tag: 'md3', repo: 'HapeLee/legado-with-MD3', term: 'legado-branch-md3' },
  { id: 'sigma', name: '阅读 Sigma', tag: 'plus', repo: 'Luoyacheng/legado-E', term: 'legado-branch-sigma', note: '也称阅读 Plus。' },
  { id: 'main', name: '喵公子版', tag: 'beta', repo: 'LegadoTeam/legado', term: 'legado-branch-main', note: '阅读 Beta。' },
  { id: 'archive', name: '阅读 Archive', tag: 'archive', repo: 'Rimchars/legado', term: 'legado-branch-archive' },
  { id: 'max', name: '阅读 MAX', tag: 'max', repo: 'youfengknight/Legado_Max', term: 'legado-branch-max', abandoned: '2026-06-17 弃坑', note: '版本线相当混乱。' },
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
      const release = releases[0];
      result.release = {
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
  } catch (error) {
    result.errors.push(`版本信息同步失败：${error.message}`);
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
