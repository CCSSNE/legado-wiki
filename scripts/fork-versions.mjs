import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBackup } from './fork-sync.mjs';
import { recordStatus } from './backup-status.mjs';

const ORG = process.env.FORK_ORG || 'legado-backup';
const TOKEN = process.env.GITHUB_TOKEN;
const STATE_PATH = 'data/fork-sync.json';
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(path, init = {}) {
  const method = init.method || 'GET';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        ...init, signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'legado-wiki-fork-bot',
          'Content-Type': 'application/json'
        }
      });
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = { message: `非 JSON 响应（HTTP ${res.status}）` }; }
      if (method === 'GET' && (res.status >= 500 || res.status === 429) && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { status: res.status, body };
    } catch (error) {
      if (method !== 'GET' || attempt === 2) throw new Error(`GitHub 连接失败：${error.message}`);
      await sleep(1000 * (attempt + 1));
    }
  }
}

let state;
let original;
try {
  if (!TOKEN) throw new Error('缺少 FORK_TOKEN / GITHUB_TOKEN');
  original = await readFile(STATE_PATH, 'utf8');
  state = JSON.parse(original);
  if (state.version !== 1 || !state.projects || Array.isArray(state.projects)) throw new Error('备份状态格式无效，拒绝重置');
  const main = JSON.parse(await readFile('data/branches.json', 'utf8'));
  const extra = JSON.parse(await readFile('data/branches-static.json', 'utf8'));
  const branches = [...new Map([...main.branches, ...extra.branches].map(b => [b.id, b])).values()];
  for (const branch of branches) {
    if (!branch.repo || branch.backupRelease || branch.skipAutoForks) {
      const result = { id: branch.id, repo: branch.repo, status: 'skipped', message: '人工配置跳过 Fork 备份（补档／镜像仓）' };
      results.push(result);
      recordStatus(state, branch, result);
      continue;
    }
    let result;
    try {
      result = { id: branch.id, repo: branch.repo, ...await syncBackup({ branch, state, org: ORG, api }) };
    } catch (error) {
      result = { id: branch.id, repo: branch.repo, status: 'error', message: error.message };
    }
    if (['error', 'unavailable'].includes(state.statuses?.[branch.id]?.status) && ['synced', 'renamed', 'rotated'].includes(result.status)) result.notify = true;
    results.push(result);
    recordStatus(state, branch, result);
  }
  state.checkedAt = new Date().toISOString();
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (serialized !== original) {
    await writeFile(STATE_PATH, serialized);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git(['config', 'user.name', 'github-actions[bot]']);
      git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
      git(['add', STATE_PATH]);
      git(['commit', '-m', '记录 Fork 备份分支及历史换代']);
      let pushed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { git(['push', 'origin', 'HEAD:main']); pushed = true; break; }
        catch {
          // Another data workflow can commit while this workflow is running.
          git(['fetch', 'origin', 'main']);
          git(['rebase', 'origin/main']);
        }
      }
      if (!pushed) throw new Error('备份状态提交失败，下轮将核验已有分支后重试');
    }
  }
} catch (error) {
  results.push({ id: 'workflow', repo: 'CCSSNE/legado-wiki', status: 'error', message: error.message });
}

for (const r of results) console.log(`[${r.status.padEnd(12)}] ${r.id} (${r.repo || ''}): ${r.message}`);
const errors = results.filter(r => r.status === 'error');
const notifications = results.filter(r => r.notify);
const lines = [...errors, ...notifications].map(r => `${r.id} ${r.repo || ''}：${r.message}`);
console.log(`\n共 ${results.length} 项：${results.filter(r => r.status === 'synced').length} 同步，${results.filter(r => r.status === 'rotated').length} 换代，${errors.length} 失败`);
if (errors.length) process.exitCode = 1;
if (process.env.GITHUB_OUTPUT) {
  const reason = errors.length ? 'sync_error' : notifications.length ? 'auto_handled' : '';
  const delimiter = `BODY_${crypto.randomUUID()}`;
  await appendFile(process.env.GITHUB_OUTPUT,
    `alert=${lines.length > 0}\nalert_reason=${reason}\nalert_body<<${delimiter}\n${lines.join('\n')}\n${delimiter}\n`);
}
