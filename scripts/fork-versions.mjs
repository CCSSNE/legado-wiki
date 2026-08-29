import { readFile } from 'node:fs/promises';

const ORG = process.env.FORK_ORG || 'legado-backup';
const TOKEN = process.env.GITHUB_TOKEN;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'legado-wiki-fork-bot',
  'Content-Type': 'application/json'
};

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { headers, ...init });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const data = JSON.parse(await readFile('data/branches.json', 'utf8'));
const results = [];

for (const branch of data.branches) {
  if (branch.backupRelease) {
    results.push({ id: branch.id, repo: branch.repo, status: 'skipped', message: '上游已删库且已手动补档，跳过' });
    continue;
  }
  if (!branch.repo) continue;

  const [owner, repo] = branch.repo.split('/');
  const forkName = `legado-${branch.id}`;

  const existing = await api(`/repos/${ORG}/${forkName}`);
  if (existing.status === 200) {
    results.push({ id: branch.id, repo: branch.repo, status: 'exists', message: `已有 ${ORG}/${forkName}` });
    continue;
  }

  const res = await api(`/repos/${owner}/${repo}/forks`, {
    method: 'POST',
    body: JSON.stringify({ organization: ORG, name: forkName, default_branch_only: false })
  });

  if (res.status === 202 || res.status === 200) {
    results.push({ id: branch.id, repo: branch.repo, status: 'queued', message: `fork 排队创建中: ${ORG}/${forkName}` });
  } else {
    results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `HTTP ${res.status}: ${res.body?.message ?? '未知错误'}` });
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
}

let failed = 0;
for (const r of results) {
  console.log(`[${r.status.padEnd(7)}] ${r.id} (${r.repo}): ${r.message}`);
  if (r.status === 'error') failed += 1;
}
console.log(`\n共 ${results.length} 项: ${results.filter(r => r.status === 'queued').length} 新建排队, ${results.filter(r => r.status === 'exists').length} 已存在, ${results.filter(r => r.status === 'skipped').length} 跳过, ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
