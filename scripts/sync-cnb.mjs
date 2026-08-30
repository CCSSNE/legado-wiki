import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CNB 上游 → GitHub 镜像 同步脚本
//
// 设计要点（详见 docs/mirror-cnb-iyuedu-plan.md）：
// - 匿名 git 协议读 CNB 上游，无需 CNB 令牌；
// - 镜像仓历史 = 上游历史经 git-filter-repo --strip-blobs-bigger-than 100M 的确定性过滤
//   （GitHub 单文件 100MiB 硬限制；过滤规则每次一致，上游历史保持追加 ⇒ 快进检测依然有效）；
// - 上游若 force push / 重写历史 ⇒ 过滤后历史与镜像不再构成快进 ⇒ 不推送 + rewritten 告警；
// - data/cnb-sync.json 里的 head 记录的是「上游原始 HEAD」，与镜像（过滤后）哈希不同属预期。
//
// 环境变量：
//   MIRROR_TOKEN  对镜像仓有写权限的 GitHub token（兼容 GITHUB_TOKEN 回退）
//   MIRROR_ORG    镜像所在组织/用户，默认 legado-backup
//   本地调试时脚本不会向 wiki 仓库提交（仅 GITHUB_ACTIONS=true 时提交）。

const CONFIG_PATH = 'data/cnb-sync.json';
const STRIP_BIGGER_THAN = '100M';

const token = process.env.MIRROR_TOKEN || process.env.GITHUB_TOKEN || '';
const mirrorOrg = process.env.MIRROR_ORG || 'legado-backup';

const outputs = { updated: 'false', pushed: 'false', rewritten: 'false', gone: 'false', alert: 'false', alert_reason: '', head: '', mirror_head: '' };

function emitOutputs() {
  if (process.env.GITHUB_OUTPUT) {
    for (const [k, v] of Object.entries(outputs)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
    }
  }
}

function log(msg) { console.log(msg); }

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim();
}

function gitAllowFail(cwd, args) {
  try {
    return { code: 0, out: git(cwd, args) };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '').toString().trim() };
  }
}

function runFilterRepo(cwd, ref) {
  const args = ['--strip-blobs-bigger-than', STRIP_BIGGER_THAN, '--refs', ref, '--force'];
  try {
    execFileSync('git', ['filter-repo', ...args], { cwd, encoding: 'utf8', stdio: 'inherit' });
    return;
  } catch { /* 尝试 python 方式 */ }
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-m', 'git_filter_repo', ...args], { cwd, encoding: 'utf8', stdio: 'inherit' });
      return;
    } catch { /* 下一个 */ }
  }
  throw new Error('git-filter-repo 不可用（git filter-repo / python -m git_filter_repo 均失败）');
}

function die(message) {
  console.error(`[fatal] ${message}`);
  emitOutputs();
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  die(`读取 ${CONFIG_PATH} 失败: ${e.message}`);
}
const entries = config.mirrors || config;

let changedConfig = false;
let anyError = false;

for (const [id, entry] of Object.entries(entries)) {
  log(`\n===== ${id} =====`);
  const upstream = entry.upstream;
  const upstreamBranch = entry.upstreamBranch || 'main';
  const mirrorFull = entry.mirror || `${mirrorOrg}/${id}`;
  const [owner, repo] = mirrorFull.split('/');
  const mirrorUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  // 1. 匿名读上游 HEAD（快速路径：无更新直接结束）
  const ls = gitAllowFail('.', ['ls-remote', upstream, `refs/heads/${upstreamBranch}`]);
  if (ls.code !== 0 || !ls.out) {
    outputs.gone = 'true';
    anyError = true;
    log(`[gone] 无法读取上游 ${upstream}（已删除或网络不可达）`);
    continue;
  }
  const upstreamHead = ls.out.split(/\s+/)[0];
  outputs.head = upstreamHead;
  log(`上游 HEAD: ${upstreamHead}`);

  if (entry.head === upstreamHead) {
    log('与上次同步记录一致，无更新。');
    continue;
  }

  // 2. bare 克隆镜像仓
  const work = mkdtempSync(path.join(tmpdir(), `cnb-sync-${id}-`));
  try {
    const mirrorDir = path.join(work, 'mirror.git');
    const clone = gitAllowFail('.', ['clone', '--bare', mirrorUrl, mirrorDir]);
    if (clone.code !== 0) {
      anyError = true;
      log(`[error] 克隆镜像仓 ${mirrorFull} 失败（不存在或无权限）：\n${(clone.out || '').slice(-500)}`);
      continue;
    }

    // 3. 匿名 fetch 上游
    git(mirrorDir, ['remote', 'add', 'upstream_src', upstream]);
    git(mirrorDir, ['fetch', '--no-tags', 'upstream_src', upstreamBranch]);

    // 4. 与建仓时同一规则的确定性过滤（只重写 upmain 引用）
    const filteredRef = 'upmain';
    git(mirrorDir, ['branch', filteredRef, `refs/remotes/upstream_src/${upstreamBranch}`]);
    runFilterRepo(mirrorDir, filteredRef);
    const filteredHead = git(mirrorDir, ['rev-parse', filteredRef]);
    outputs.mirror_head = filteredHead;

    // 5. 快进校验
    const hasMain = gitAllowFail(mirrorDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).code === 0;
    let ffOk = true;
    if (hasMain) {
      const ff = gitAllowFail(mirrorDir, ['merge-base', '--is-ancestor', 'main', filteredRef]);
      ffOk = ff.code === 0;
      if (ffOk && git(mirrorDir, ['rev-parse', 'main']) === filteredHead) {
        log('镜像已包含该上游状态（自愈），仅补记 head。');
      }
    } else {
      log('镜像仓尚无 main 分支，按首次引导处理。');
    }

    if (!ffOk) {
      outputs.rewritten = 'true';
      log('[rewritten] 过滤后的上游历史与镜像不构成快进（疑似 force push / 历史重写），本次不推送，等待人工确认。');
      continue; // 不更新 head 记录，下轮重新检测
    }

    // 6. 推送（镜像与过滤结果一致时为无操作）
    if (!hasMain || git(mirrorDir, ['rev-parse', 'main']) !== filteredHead) {
      git(mirrorDir, ['push', mirrorUrl, `${filteredRef}:refs/heads/${upstreamBranch}`]);
      outputs.pushed = 'true';
      log(`[pushed] 镜像已更新到 ${filteredHead.slice(0, 10)}（上游 ${upstreamHead.slice(0, 10)}）`);
    }
    outputs.updated = 'true';

    // 7. 记录上游 head
    entry.head = upstreamHead;
    entry.syncedAt = new Date().toISOString();
    changedConfig = true;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

// 8. CI 内把 head 记录提交回 wiki 仓库
if (process.env.GITHUB_ACTIONS === 'true' && changedConfig) {
  try {
    git('.', ['config', 'user.name', 'legado-wiki-bot']);
    git('.', ['config', 'user.email', 'actions@users.noreply.github.com']);
    git('.', ['add', CONFIG_PATH]);
    const commit = gitAllowFail('.', ['commit', '-m', `CNB 镜像同步记录: ${(outputs.head || '').slice(0, 10)}`]);
    if (commit.code === 0) {
      git('.', ['push', 'origin', process.env.GITHUB_REF_NAME || 'main']);
      log('已提交同步记录回 wiki 仓库。');
    }
  } catch (e) {
    log(`提交同步记录失败（不影响镜像）: ${e.message}`);
  }
}

const alert = outputs.rewritten === 'true' || outputs.gone === 'true';
outputs.alert = alert ? 'true' : 'false';
outputs.alert_reason = [outputs.rewritten === 'true' ? 'rewritten' : null, outputs.gone === 'true' ? 'gone' : null]
  .filter(Boolean).join(',');
log(`\n结果: updated=${outputs.updated} pushed=${outputs.pushed} rewritten=${outputs.rewritten} gone=${outputs.gone} alert=${outputs.alert}`);
emitOutputs();
if (anyError && !alert) process.exitCode = 1;
