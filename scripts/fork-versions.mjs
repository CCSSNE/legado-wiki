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

const mainData = JSON.parse(await readFile('data/branches.json', 'utf8'));
let staticBranches = [];
try {
  const staticData = JSON.parse(await readFile('data/branches-static.json', 'utf8'));
  if (Array.isArray(staticData.branches)) staticBranches = staticData.branches;
} catch {
  staticBranches = [];
}
const data = { branches: [...mainData.branches, ...staticBranches] };
const results = [];
const alerts = new Set(); // 触发过的告警类型: rewritten / default_branch_changed / gone

for (const branch of data.branches) {
  if (branch.backupRelease) {
    results.push({ id: branch.id, repo: branch.repo, status: 'skipped', message: '上游已删库且已手动补档，跳过' });
    continue;
  }
  if (branch.skipAutoForks) {
    results.push({ id: branch.id, repo: branch.repo, status: 'skipped', message: 'skipAutoForks：不走 fork 备份（镜像/补档仓库）' });
    continue;
  }
  if (!branch.repo) continue;

  const [owner, repo] = branch.repo.split('/');
  const forkName = `legado-${branch.id}`;

  const existing = await api(`/repos/${ORG}/${forkName}`);
  if (existing.status === 200) {
    const forkBranch = existing.body?.default_branch || 'main';

    // 查询上游，检测「删库」和「默认分支改名」
    const upstream = await api(`/repos/${owner}/${repo}`);
    if (upstream.status === 404 || upstream.status === 410) {
      alerts.add('gone');
      results.push({ id: branch.id, repo: branch.repo, status: 'gone', message: `上游 ${owner}/${repo} 已删库，保住 fork 备份，等你补档（在 wiki 写上 backupRelease 后自动退出 fork 列表）` });
      continue;
    }
    if (upstream.status !== 200) {
      results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `查询上游 HTTP ${upstream.status}: ${upstream.body?.message ?? '未知错误'}` });
      continue;
    }
    const upstreamBranch = upstream.body?.default_branch || 'main';

    if (upstreamBranch !== forkBranch) {
      alerts.add('default_branch_changed');
      results.push({ id: branch.id, repo: branch.repo, status: 'default_branch_changed', message: `上游默认分支由 ${forkBranch} 改为 ${upstreamBranch}，请人工确认是否要跟随` });
    }

    const ff = await isFastForwardable(owner, upstreamBranch, `${ORG}/${forkName}`, forkBranch);
    if (ff.ok === false) {
      // 上游历史被重写 → 不同步，保住 fork，并标记以便发邮件告警
      alerts.add('rewritten');
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
      alerts.add('gone');
      results.push({ id: branch.id, repo: branch.repo, status: 'gone', message: `上游已删库，保住 fork 备份，等你补档（在 wiki 写上 backupRelease 后自动退出 fork 列表）` });
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
    alerts.add('gone');
    results.push({ id: branch.id, repo: branch.repo, status: 'gone', message: `上游 ${owner}/${repo} 已删库，等你补档（在 wiki 写上 backupRelease 后自动退出 fork 列表）` });
  } else {
    results.push({ id: branch.id, repo: branch.repo, status: 'error', message: `HTTP ${res.status}: ${res.body?.message ?? '未知错误'}` });
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
}

let failed = 0;
for (const r of results) {
  console.log(`[${r.status.padEnd(22)}] ${r.id} (${r.repo}): ${r.message}`);
  if (r.status === 'error') failed += 1;
}
const rewritten = results.filter(r => r.status === 'rewritten');
const gone = results.filter(r => r.status === 'gone');
const defChanged = results.filter(r => r.status === 'default_branch_changed');
const errored = results.filter(r => r.status === 'error');
// 同步失败也要告警：否则像 FORK_TOKEN 缺 workflow 权限这种 422 会连续静默失败
if (errored.length > 0) alerts.add('sync_error');
console.log(`\n共 ${results.length} 项: ${results.filter(r => r.status === 'queued').length} 新建排队, ${results.filter(r => r.status === 'synced').length} 已同步, ${results.filter(r => r.status === 'rewritten').length} 历史被重写未同步, ${results.filter(r => r.status === 'default_branch_changed').length} 默认分支改名, ${results.filter(r => r.status === 'skipped').length} 跳过, ${results.filter(r => r.status === 'gone').length} 上游已删, ${failed} 失败`);
for (const [label, list] of [['\n被重写列表:', rewritten], ['\n上游删库列表:', gone], ['\n默认分支改名列表:', defChanged]]) {
  if (list.length > 0) {
    console.log(label);
    for (const r of list) console.log(`  - ${r.id} (${r.repo})`);
  }
}

if (failed > 0) process.exitCode = 1;

// 写入 GITHUB_OUTPUT，供 workflow 判断是否发告警邮件
if (process.env.GITHUB_OUTPUT) {
  const fs = await import('node:fs');
  const alert = alerts.size > 0 ? 'true' : 'false';
  const reason = [...alerts].join(',');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert=${alert}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert_reason=${reason}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `rewritten=${alerts.has('rewritten') ? 'true' : 'false'}\n`);
}
