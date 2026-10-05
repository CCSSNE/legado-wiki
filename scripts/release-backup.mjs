import { createHash } from 'node:crypto';

export function releaseFingerprint(release, tagObjectSha) {
  return createHash('sha256').update(JSON.stringify({
    id: release.id, tag: release.tag_name, tagObjectSha, name: release.name, body: release.body,
    prerelease: release.prerelease, publishedAt: release.published_at, updatedAt: release.updated_at,
    assets: release.assets.map(a => ({ id: a.id, name: a.name, label: a.label, size: a.size,
      updatedAt: a.updated_at, digest: a.digest })).sort((a, b) => a.id - b.id)
  })).digest('hex');
}

export async function listAll(api, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const r = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`读取 ${path} HTTP ${r.status}: ${r.body?.message || '无效响应'}`);
    items.push(...r.body);
    if (r.body.length < 100) return items;
  }
}

async function requireResponse(api, path, init, status = 200) {
  const r = await api(path, init);
  if (r.status !== status) throw new Error(`${path} HTTP ${r.status}: ${r.body?.message || '未知错误'}`);
  return r.body;
}

export async function resolveTagCommit(api, sourceRepo, object) {
  for (let depth = 0; depth < 8; depth++) {
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error('Release 标签没有指向提交');
    object = (await requireResponse(api, `/repos/${sourceRepo}/git/tags/${object.sha}`)).object;
  }
  throw new Error('Release 附注标签嵌套过深');
}

export function assetMatches(source, backup) {
  return backup?.state === 'uploaded' && backup.size === source.size &&
    (!source.digest || backup.digest === source.digest);
}

// An immutable snapshot has its own tag and release. No published backup is overwritten.
export async function backupRelease({ sourceRepo, backupRepo, release, tagObject, snapshots, api, transfer, uploadManifest,
  now = () => new Date().toISOString(), shouldContinue = () => true }) {
  const fingerprint = releaseFingerprint(release, tagObject.sha);
  const tag = `backup-release/${release.id}-${fingerprint}`;
  const commit = await resolveTagCommit(api, sourceRepo, tagObject);
  let snapshot = snapshots[fingerprint];
  if (snapshot?.complete) return snapshot;
  let target;
  if (snapshot?.backupReleaseId) {
    target = await requireResponse(api, `/repos/${backupRepo}/releases/${snapshot.backupReleaseId}`);
  } else {
    // Drafts also appear in authenticated listings: recover after a lost state save.
    target = (await listAll(api, `/repos/${backupRepo}/releases`)).find(r => r.tag_name === tag);
    if (!target) {
      const ref = await api(`/repos/${backupRepo}/git/ref/tags/${tag}`);
      if (ref.status === 404) {
        await requireResponse(api, `/repos/${backupRepo}/git/refs`, {
          method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit })
        }, 201);
      } else if (ref.status !== 200 || ref.body.object.sha !== commit) {
        throw new Error('Release 备份标签验证失败，拒绝覆盖');
      }
      target = await requireResponse(api, `/repos/${backupRepo}/releases`, {
        method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit,
          name: `${release.name || release.tag_name}（备份）`, body: release.body || '',
          draft: true, prerelease: Boolean(release.prerelease), make_latest: 'false' })
      }, 201);
    }
  }
  const ref = await requireResponse(api, `/repos/${backupRepo}/git/ref/tags/${tag}`);
  if (ref.object.sha !== commit) throw new Error('Release 备份标签提交与上游不一致');
  snapshot ||= { sourceReleaseId: release.id, sourceTag: release.tag_name, fingerprint, sourceCommit: commit,
    backupReleaseId: target.id, backupTag: tag, url: target.html_url, startedAt: now(), complete: false };
  snapshots[fingerprint] = snapshot;
  let assets = await listAll(api, `/repos/${backupRepo}/releases/${target.id}/assets`);
  for (const asset of release.assets) {
    const existing = assets.find(a => a.name === asset.name);
    if (assetMatches(asset, existing)) continue;
    if (!target.draft) throw new Error(`已发布备份附件 ${asset.name} 不完整，拒绝修改旧快照`);
    if (existing) {
      // Only repair an unfinished draft upload (e.g. GitHub's failed-upload 'starter').
      await requireResponse(api, `/repos/${backupRepo}/releases/assets/${existing.id}`, { method: 'DELETE' }, 204);
    }
    if (!shouldContinue()) throw Object.assign(new Error('本轮时间预算已用完，下轮续传'), { code: 'BUDGET' });
    const uploaded = await transfer({ sourceRepo, backupRepo, releaseId: target.id, asset });
    if (!assetMatches(asset, uploaded)) throw new Error(`附件 ${asset.name} 的大小或 SHA256 验证失败`);
  }
  assets = await listAll(api, `/repos/${backupRepo}/releases/${target.id}/assets`);
  if (!release.assets.every(a => assetMatches(a, assets.find(b => b.name === a.name)))) {
    throw new Error('附件未全部验证通过，备份仍保留为草稿，下一轮续传');
  }
  let manifestName = `legado-backup-manifest-${fingerprint}.json`;
  while (release.assets.some(a => a.name === manifestName)) manifestName = `_${manifestName}`;
  if (!target.draft && existingPublishedManifest(assets, manifestName)) {
    return finish();
  }
  const manifest = {
    sourceRepo, sourceUrl: release.html_url, capturedAt: snapshot.startedAt, sourceCommit: commit,
    sourceTagObject: tagObject, release: { id: release.id, tag_name: release.tag_name, name: release.name,
      body: release.body, html_url: release.html_url, prerelease: release.prerelease,
      created_at: release.created_at, published_at: release.published_at, updated_at: release.updated_at,
      assets: release.assets.map(a => ({ id: a.id, name: a.name, label: a.label, size: a.size,
        digest: a.digest, content_type: a.content_type, created_at: a.created_at, updated_at: a.updated_at,
        browser_download_url: a.browser_download_url })) }, copiedAssets: assets.filter(a => release.assets.some(b => b.name === a.name))
      .map(a => ({ name: a.name, id: a.id, size: a.size, digest: a.digest }))
  };
  const manifestData = `${JSON.stringify(manifest, null, 2)}\n`;
  const expectedManifest = { size: Buffer.byteLength(manifestData), digest: `sha256:${createHash('sha256').update(manifestData).digest('hex')}` };
  const existingManifest = assets.find(a => a.name === manifestName);
  if (!assetMatches(expectedManifest, existingManifest)) {
    if (!target.draft) throw new Error('已发布备份的来源清单缺失或已改变，拒绝改写');
    if (existingManifest) await requireResponse(api, `/repos/${backupRepo}/releases/assets/${existingManifest.id}`, { method: 'DELETE' }, 204);
    const uploaded = await uploadManifest({ backupRepo, releaseId: target.id, name: manifestName, content: manifestData });
    if (!assetMatches(expectedManifest, uploaded)) throw new Error('来源清单上传验证失败');
  }
  if (target.draft) {
    target = await requireResponse(api, `/repos/${backupRepo}/releases/${target.id}`, {
      method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'false' })
    });
  }
  if (target.draft) throw new Error('Release 仍是草稿，未完成发布');
  return finish();
  function finish() {
  snapshot.complete = true;
  snapshot.completedAt = now();
  snapshot.assetCount = release.assets.length;
  snapshot.assetBytes = release.assets.reduce((n, a) => n + a.size, 0);
  snapshot.url = target.html_url;
  return snapshot;
  }
}

function existingPublishedManifest(assets, name) {
  const manifest = assets.find(a => a.name === name);
  return manifest?.state === 'uploaded' && manifest.size > 0 && Boolean(manifest.digest);
}
