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

// 判断上游默认分支相对 fork 默认分支是否为"线性可快进"（安全同步）。
// 若 fork 存在上游已没有的 commit（即上游历史被 force push / rebase / reset 重写过），
// return false，此时应保住 fork 不做同步。
async function isFastForwardable(upstreamOwner, upstreamBranch, forkFull, forkBranch) {
  const [forkOwner, forkRepo] = forkFull.split('/');
  const cmp = await api(
    `/repos/${forkOwner}/${forkRepo}/compare/${upstreamOwner}:${upstreamBranch}...${forkOwner}:${forkBranch}`
  );
  if (cmp.status !== 200 || !cmp.body) {
    return { ok: null, detail: `compare HTTP ${cmp.status}: ${cmp.body?.message ?? '未知错误'}` };
  }
  // base=上游, head=fork。ahead_by = fork 有而上游没有的 commit 数。
  if (cmp.body.ahead_by === 0) {
    // fork 的历史完全包含在上游历史里，可安全快进
    return { ok: true, detail: `compare=${cmp.body.status}, behind_by=${cmp.body.behind_by}, ahead_by=${cmp.body.ahead_by}` };
  }
  return { ok: false, detail: `compare=${cmp.body.status}, behind_by=${cmp.body.behind_by}, ahead_by=${cmp.body.ahead_by}（fork 存在上游已抛弃的历史）` };
}

const data = JSON.parse(await readFile('data/branches.json', 'utf8'));
const results = [];
let rewrittenAny = false;

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
    const upstreamBranch = existing.body?.default_branch || 'main';
    const forkBranch = existing.body?.default_branch || 'main';

    const ff = await isFastForwardable(owner, upstreamBranch, `${ORG}/${forkName}`, forkBranch);
    if (ff.ok === false) {
      // 上游历史被重写 → 不同步，保住 fork，并标记以便发邮件告警
      rewrittenAny = true;
      results.push({ id: branch.id, repo: branch.repo, status: 'rewritten', message: `检测到上游历史被重写，本次未同步：${ff.detail}` });
      continue;
    }
    if (ff.ok === null) {
      results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `无法判断上游历史：${ff.detail}` });
      continue;
    }

    const sync = await api(`/repos/${ORG}/${forkName}/merge-upstream`, {
      method: 'POST',
      body: JSON.stringify({ branch: forkBranch })
    });
    if (sync.status === 200) {
      results.push({ id: branch.id, repo: branch.repo, status: 'synced', message: `${ORG}/${forkName} ${sync.body?.message ?? '已同步'}` });
    } else if (sync.status === 404 || sync.status === 410) {
      results.push({ id: branch.id, repo: branch.repo, status: 'gone', message: `上游已删库，等你补档（在 wiki 写上 backupRelease 后自动退出 fork 列表）` });
    } else if (sync.status === 409) {
      results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `同步冲突 HTTP 409，需人工检查 ${ORG}/${forkName}` });
    } else {
      results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `同步失败 HTTP ${sync.status}: ${sync.body?.message ?? '未知错误'}` });
    }
    continue;
  }

  const res = await api(`/repos/${owner}/${repo}/forks`, {
    method: 'POST',
    body: JSON.stringify({ organization: ORG, name: forkName, default_branch_only: false })
  });

  if (res.status === 202 || res.status === 200) {
    results.push({ id: branch.id, repo: branch.repo, status: 'queued', message: `fork 排队创建中: ${ORG}/${forkName}` });
  } else if (res.status === 404 || res.status === 410) {
    results.push({ id: branch.id, repo: branch.repo, status: 'gone', message: '上游已删库，等你补档（在 wiki 写上 backupRelease 后自动退出 fork 列表）' });
  } else {
    results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `HTTP ${res.status}: ${res.body?.message ?? '未知错误'}` });
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
}

let failed = 0;
for (const r of results) {
  console.log(`[${r.status.padEnd(9)}] ${r.id} (${r.repo}): ${r.message}`);
  if (r.status === 'error') failed += 1;
}
const rewritten = results.filter(r => r.status === 'rewritten');
console.log(`\n共 ${results.length} 项: ${results.filter(r => r.status === 'queued').length} 新建排队, ${results.filter(r => r.status === 'synced').length} 已同步, ${results.filter(r => r.status === 'rewritten').length} 历史被重写未同步, ${results.filter(r => r.status === 'skipped').length} 跳过, ${results.filter(r => r.status === 'gone').length} 上游已删, ${failed} 失败`);
if (rewritten.length > 0) {
  console.log('\n被重写列表:');
  for (const r of rewritten) console.log(`  - ${r.id} (${r.repo})`);
}

if (failed > 0) process.exitCode = 1;

// 写入 GITHUB_OUTPUT，供 workflow 判断是否发告警邮件
if (process.env.GITHUB_OUTPUT) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `rewritten=${rewrittenAny ? 'true' : 'false'}\n`);
}
