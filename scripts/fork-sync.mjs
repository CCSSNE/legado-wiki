// Only the tracked active branch is writable. Retired branches are never changed.
export async function syncBackup({ branch, state, org, api, now = () => new Date().toISOString() }) {
  const fail = (operation, response) => {
    throw new Error(`${operation} HTTP ${response.status}: ${response.body?.message || '未知错误'}`);
  };
  const get = async path => {
    const r = await api(path);
    if (r.status !== 200) fail(path, r);
    return r.body;
  };
  const backupRepo = `${org}/legado-${branch.id}`;
  const previous = state.projects[branch.id];
  const backup = await api(`/repos/${backupRepo}`);
  if (![200, 404].includes(backup.status)) fail('查询备份', backup);
  // Pin identity before following a rename: an old name can be taken by a new repository.
  const expectedId = previous?.upstreamId || backup.body?.parent?.id;
  const upstreamPath = expectedId ? `/repositories/${expectedId}` : `/repos/${branch.repo}`;
  const upstreamResponse = await api(upstreamPath);
  if (upstreamResponse.status === 410) {
    if (backup.status !== 200) throw new Error('上游已移除且没有可验证的备份');
    const entry = previous || {
      upstreamId: expectedId, upstreamRepo: branch.repo, backupRepo,
      activeBranch: backup.body.default_branch, generation: 1, retired: []
    };
    const notify = entry.status !== 'gone';
    entry.status = 'gone';
    entry.goneAt ||= now();
    state.projects[branch.id] = entry;
    return { status: 'gone', notify, message: '上游 HTTP 410，保留全部备份分支；后续仍检查是否恢复' };
  }
  if (upstreamResponse.status === 404) {
    throw new Error('上游 HTTP 404：可能删除、私有化或令牌失去权限，无法确认删库；保留备份，未同步');
  }
  if (upstreamResponse.status !== 200) fail('查询上游', upstreamResponse);
  const upstream = upstreamResponse.body;
  if (expectedId && upstream.id !== expectedId) throw new Error('上游仓库 ID 改变，不能自动认定为改名');
  if (backup.status === 404) {
    if (previous) throw new Error('已有状态记录但备份仓库不可访问，可能权限不足；不自动重建');
    const r = await api(`/repos/${upstream.full_name}/forks`, {
      method: 'POST', body: JSON.stringify({ organization: org, name: `legado-${branch.id}`, default_branch_only: false })
    });
    if (![200, 202].includes(r.status)) fail('创建 Fork', r);
    return { status: 'queued', notify: false, message: `${backupRepo} 创建排队中，下轮验证后记录` };
  }
  if (!backup.body.fork || backup.body.parent?.id !== upstream.id) {
    throw new Error('备份不属于当前上游的 Fork 网络，拒绝自动改写');
  }
  const entry = previous ? structuredClone(previous) : {
    upstreamId: upstream.id, upstreamRepo: upstream.full_name, upstreamBranch: upstream.default_branch,
    backupRepo, activeBranch: backup.body.default_branch, generation: 1, retired: []
  };
  if (entry.backupRepo !== backupRepo) throw new Error('备份仓库映射不匹配');
  const renamed = entry.upstreamRepo !== upstream.full_name || (entry.upstreamBranch && entry.upstreamBranch !== upstream.default_branch);
  const refPath = name => `/repos/${backupRepo}/git/ref/heads/${name}`;
  const sourcePath = `/repos/${upstream.full_name}/git/ref/heads/${upstream.default_branch}`;
  const source = await get(sourcePath);
  const target = await get(refPath(entry.activeBranch));
  const sourceSha = source.object.sha;
  const oldSha = target.object.sha;
  let rotated = false;
  let reason;
  if (oldSha !== sourceSha) {
    const comparePath = `/repos/${backupRepo}/compare/${sourceSha}...${oldSha}`;
    const compare = await api(comparePath);
    const classify = response => {
      if (response.status === 200 && Number.isInteger(response.body?.ahead_by)) {
        return response.body.ahead_by === 0 ? 'fast_forward' : 'diverged';
      }
      if (response.status === 404 && /No common ancestor/i.test(response.body?.message || '')) return 'unrelated';
      fail('比较历史', response);
    };
    reason = classify(compare);
    if (reason === 'fast_forward') {
      const r = await api(`/repos/${backupRepo}/git/refs/heads/${entry.activeBranch}`, {
        method: 'PATCH', body: JSON.stringify({ sha: sourceSha, force: false })
      });
      if (r.status !== 200) fail('快进同步（不强推）', r);
    } else {
      // Recheck both refs and the comparison before creating a generation.
      if ((await get(sourcePath)).object.sha !== sourceSha || (await get(refPath(entry.activeBranch))).object.sha !== oldSha) {
        throw new Error('核验期间分支发生变化，留待下轮重试');
      }
      if (classify(await api(comparePath)) !== reason) throw new Error('两次历史比较不一致，未切换');
      // A deterministic SHA suffix recovers a created branch if persisting state failed.
      const generation = entry.generation + 1;
      const next = `backup/v${generation}-${sourceSha}`;
      const existing = await api(refPath(next));
      if (existing.status === 404) {
        const r = await api(`/repos/${backupRepo}/git/refs`, {
          method: 'POST', body: JSON.stringify({ ref: `refs/heads/${next}`, sha: sourceSha })
        });
        if (r.status !== 201) fail('创建下一代备份分支', r);
      } else if (existing.status !== 200) {
        fail('查询下一代备份分支', existing);
      } else if (existing.body.object.sha !== sourceSha) {
        throw new Error('下一代分支已存在但提交不同，拒绝覆盖');
      }
      if ((await get(refPath(next))).object.sha !== sourceSha) throw new Error('新分支验证失败，保留旧映射');
      entry.retired.push({ branch: entry.activeBranch, head: oldSha, retiredAt: now(), reason });
      entry.activeBranch = next;
      entry.generation = generation;
      rotated = true;
    }
    if ((await get(refPath(entry.activeBranch))).object.sha !== sourceSha) throw new Error('同步后的分支 SHA 验证失败');
  }
  entry.upstreamRepo = upstream.full_name;
  entry.upstreamBranch = upstream.default_branch;
  entry.status = 'active';
  delete entry.goneAt;
  // Record a verified generation even if updating repository metadata fails.
  state.projects[branch.id] = entry;
  if (rotated || entry.generation > 1) {
    if (backup.body.default_branch !== entry.activeBranch) {
      const r = await api(`/repos/${backupRepo}`, {
        method: 'PATCH', body: JSON.stringify({ default_branch: entry.activeBranch })
      });
      if (r.status !== 200) fail('切换备份默认分支（历史已保留，映射已记录）', r);
    }
  }
  return {
    status: rotated ? 'rotated' : renamed ? 'renamed' : 'synced', notify: Boolean(rotated || renamed || previous?.status === 'gone'),
    message: rotated
      ? `历史 ${reason}：旧分支已保留，${backupRepo}/${entry.activeBranch} 接收新历史`
      : `${upstream.full_name}:${upstream.default_branch} → ${backupRepo}:${entry.activeBranch} 已同步`
  };
}
