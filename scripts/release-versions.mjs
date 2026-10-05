import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { backupRelease, listAll, releaseFingerprint } from './release-backup.mjs';
import { releaseTransport } from './release-assets.mjs';

const token = process.env.GITHUB_TOKEN;
const path = 'data/release-sync.json';
const deadline = Date.now() + 20 * 60 * 1000;
const maxSnapshots = 8;
const errors = [];
let state;
async function api(path, init = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://api.github.com${path}`, { ...init,
        signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json', 'User-Agent': 'legado-release-backup' } });
      const raw = await r.text();
      let body;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { message: '非 JSON 响应' }; }
      if ((!init.method || init.method === 'GET') && (r.status >= 500 || r.status === 429) && attempt < 2) continue;
      return { status: r.status, body };
    } catch (e) {
      if (init.method || attempt === 2) throw new Error(`GitHub 连接失败：${e.message}`);
    }
  }
}
function record(p, status, message) {
  const now = new Date().toISOString();
  p.events ||= [];
  if (p.status !== status || p.message !== message) p.events.push({ at: now, status, message });
  p.status = status;
  p.message = message;
  p.lastCheckedAt = now;
  console.log(`[${status}] ${p.repo}: ${message}`);
}
try {
  if (!token) throw new Error('缺少 FORK_TOKEN');
  state = JSON.parse(await readFile(path, 'utf8'));
  if (state.version !== 1 || !state.projects || !Number.isInteger(state.nextIndex)) throw new Error('Release 状态格式无效');
  const forks = JSON.parse(await readFile('data/fork-sync.json', 'utf8'));
  const entries = Object.entries(forks.projects).filter(([, p]) => p.upstreamId && p.backupRepo);
  const start = state.nextIndex % entries.length;
  const order = Array.from({ length: entries.length }, (_, i) => (start + i) % entries.length);
  order.sort((a, b) => Number(state.projects[entries[b][0]]?.status === 'error') - Number(state.projects[entries[a][0]]?.status === 'error'));
  const transport = releaseTransport(token);
  let completed = 0;
  let nextStart;
  for (let offset = 0; offset < entries.length; offset++) {
    const index = order[offset];
    const [id, fork] = entries[index];
    if (Date.now() >= deadline) { state.nextIndex = index; break; }
    const p = state.projects[id] ||= { repo: fork.upstreamRepo, backupRepo: fork.backupRepo, snapshots: {} };
    let attempting;
    try {
      // ID lookup follows GitHub renames. A 404 is retried next run, never disables monitoring.
      const source = await api(`/repositories/${fork.upstreamId}`);
      if (source.status !== 200) throw new Error(`上游不可见或请求失败 HTTP ${source.status}: ${source.body?.message || ''}`);
      p.repo = source.body.full_name;
      const releases = (await listAll(api, `/repos/${p.repo}/releases`)).filter(r => !r.draft);
      const tagResponse = releases.length ? await api(`/repos/${p.repo}/git/matching-refs/tags/`) : { status: 200, body: [] };
      if (tagResponse.status !== 200 || !Array.isArray(tagResponse.body)) throw new Error(`读取标签 HTTP ${tagResponse.status}`);
      const refs = tagResponse.body;
      const tags = new Map(refs.map(r => [r.ref.replace(/^refs\/tags\//, ''), r.object]));
      p.sourceReleaseCount = releases.length;
      const pending = [];
      const missing = [];
      for (const release of releases) {
        const object = tags.get(release.tag_name);
        if (!object) { missing.push(release.tag_name); continue; }
        if (!p.snapshots[releaseFingerprint(release, object.sha)]?.complete) pending.push({ release, object });
      }
      p.pending = pending.length + missing.length;
      // Newest first, at most one new snapshot per source each run; rotate the starting source.
      if (pending.length && completed < maxSnapshots && Date.now() < deadline) {
        const { release, object } = pending[0];
        release.assets = await listAll(api, `/repos/${p.repo}/releases/${release.id}/assets`);
        attempting = releaseFingerprint(release, object.sha);
        await backupRelease({ sourceRepo: p.repo, backupRepo: p.backupRepo, release, tagObject: object,
          snapshots: p.snapshots, api, ...transport, shouldContinue: () => Date.now() < deadline,
          verifySource: async fingerprint => {
            const current = await api(`/repos/${p.repo}/releases/${release.id}`);
            const tag = await api(`/repos/${p.repo}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
            if (current.status !== 200 || tag.status !== 200) throw new Error('上传期间上游发布或标签不可访问，下轮重新探测');
            current.body.assets = await listAll(api, `/repos/${p.repo}/releases/${release.id}/assets`);
            if (releaseFingerprint(current.body, tag.body.object.sha) !== fingerprint) throw new Error('上传期间上游发布已改变，保留草稿，下轮备份新版本');
          } });
        completed++;
        if (completed === maxSnapshots) nextStart = (index + 1) % entries.length;
        p.pending--;
      }
      p.completedCount = Object.values(p.snapshots).filter(s => s.complete).length;
      if (missing.length) throw new Error(`Release 标签不存在：${missing.join(', ')}；保留已有快照，继续探测`);
      if (p.failedFingerprint && pending.some(({ release, object }) => releaseFingerprint(release, object.sha) === p.failedFingerprint) && !p.snapshots[p.failedFingerprint]?.complete) {
        throw new Error(p.message);
      }
      delete p.failedFingerprint;
      record(p, p.pending ? 'pending' : 'normal', releases.length
        ? `已保留 ${p.completedCount} 个快照，当前发布待备份 ${p.pending} 个`
        : '上游暂无公开 Release，继续探测');
    } catch (e) {
      if (attempting && e.code !== 'BUDGET') p.failedFingerprint = attempting;
      p.completedCount = Object.values(p.snapshots).filter(s => s.complete).length;
      record(p, e.code === 'BUDGET' ? 'pending' : 'error', e.message);
      if (e.code !== 'BUDGET') errors.push(`${p.repo}: ${e.message}`);
    }
    // Move past sources that received a turn, even when their upstream is unavailable.
    state.nextIndex = (index + 1) % entries.length;
  }
  if (nextStart !== undefined) state.nextIndex = nextStart;
  state.checkedAt = new Date().toISOString();
} catch (e) { errors.push(e.message); }
finally {
  // Persist unfinished drafts too, so a failed download can resume next run.
  if (state) {
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        git(['config', 'user.name', 'github-actions[bot]']);
        git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
        git(['add', path]);
        if (git(['diff', '--cached', '--name-only']).trim()) {
          git(['commit', '-m', '记录 Release 备份快照与续传进度']);
          let pushed = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { git(['push', 'origin', 'HEAD:main']); pushed = true; break; }
            catch { git(['fetch', 'origin', 'main']); git(['rebase', 'origin/main']); }
          }
          if (!pushed) throw new Error('状态推送失败，下轮恢复已有 Release');
        }
      } catch (e) { errors.push(`状态保存失败：${e.message}`); }
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
