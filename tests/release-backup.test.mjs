import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backupRelease, releaseFingerprint, listAll, resolveTagCommit } from '../scripts/release-backup.mjs';

const release = { id: 1, tag_name: 'beta', name: 'Beta', body: '说明', prerelease: true,
  published_at: '2026-01-01', updated_at: '2026-01-02', assets: [
    { id: 2, name: 'app.apk', size: 10, digest: 'sha256:abc', updated_at: '2026-01-02' }
  ] };
function fixture() {
  let target;
  let ref;
  let assets = [];
  let nextId = 10;
  let transfers = 0;
  const mutations = [];
  const snapshots = {};
  async function api(path, init = {}) {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (method !== 'GET') mutations.push({ path, method, body });
    if (path.includes('/git/ref/tags/')) return { status: ref ? 200 : 404, body: ref ? { object: { sha: ref } } : {} };
    if (method === 'POST' && path.endsWith('/git/refs')) { ref = body.sha; return { status: 201, body: {} }; }
    if (method === 'POST' && path.endsWith('/releases')) {
      target = { ...body, id: 3, html_url: 'https://github.com/backup/project/releases/tag/snapshot' };
      return { status: 201, body: target };
    }
    if (method === 'PATCH') { target = { ...target, ...body }; return { status: 200, body: target }; }
    if (method === 'DELETE') {
      assets = assets.filter(a => !path.endsWith(`/${a.id}`)); return { status: 204, body: null };
    }
    if (path.includes('/assets?')) return { status: 200, body: assets };
    if (path.includes('/releases?')) return { status: 200, body: target ? [target] : [] };
    if (path.endsWith('/releases/3')) return { status: 200, body: target };
    throw new Error(`Unexpected ${method} ${path}`);
  }
  const args = { sourceRepo: 'source/project', backupRepo: 'backup/project', release: structuredClone(release),
    tagObject: { type: 'commit', sha: 'commit1' }, snapshots, api, now: () => '2026-10-05',
    transfer: async ({ asset }) => {
      transfers++;
      const uploaded = { ...asset, id: nextId++, state: 'uploaded' }; assets.push(uploaded); return uploaded;
    },
    uploadManifest: async ({ name, content }) => {
      const uploaded = { id: nextId++, name, size: Buffer.byteLength(content), state: 'uploaded',
        digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
      assets.push(uploaded); return uploaded;
    }
  };
  return { args, mutations, get target() { return target; }, get assets() { return assets; },
    get transfers() { return transfers; } };
}
test('fingerprints ignore download counters, but detect content, assets and tag rewrites', () => {
  const initial = releaseFingerprint(release, 'a');
  assert.equal(initial, releaseFingerprint({ ...release, download_count: 999,
    assets: release.assets.map(a => ({ ...a, download_count: 100 })) }, 'a'));
  assert.notEqual(initial, releaseFingerprint({ ...release, body: 'changed' }, 'a'));
  assert.notEqual(initial, releaseFingerprint(release, 'b'));
  assert.notEqual(initial, releaseFingerprint({ ...release, assets: [] }, 'a'));
});
test('backs up all attachments, manifest and tag before publishing; repeats do nothing', async () => {
  const f = fixture();
  const snapshot = await backupRelease(f.args);
  assert.equal(snapshot.complete, true);
  assert.equal(f.target.draft, false);
  assert.equal(f.target.prerelease, true);
  assert.equal(f.assets.length, 2);
  assert.equal(snapshot.sourceCommit, 'commit1');
  const changes = f.mutations.length;
  await backupRelease(f.args);
  assert.equal(f.mutations.length, changes);
  assert.equal(f.transfers, 1);
  assert.ok(f.mutations.every(m => m.path.startsWith('/repos/backup/project/')));
});
test('failed uploads stay draft and resume without duplicating verified attachments', async () => {
  const f = fixture();
  const transfer = f.args.transfer;
  f.args.transfer = async () => { throw new Error('download failed'); };
  await assert.rejects(backupRelease(f.args), /download failed/);
  assert.equal(f.target.draft, true);
  assert.equal(Object.values(f.args.snapshots)[0].complete, false);
  f.args.transfer = transfer;
  f.args.uploadManifest = async () => { throw new Error('manifest failed'); };
  await assert.rejects(backupRelease(f.args), /manifest failed/);
  const recovered = fixture().args.uploadManifest;
  // Use the same fixture transport and assets when retrying the manifest.
  f.args.uploadManifest = async ({ name, content }) => {
    const a = await recovered({ name, content }); f.assets.push(a); return a;
  };
  await backupRelease(f.args);
  assert.equal(f.transfers, 1);
  assert.equal(f.target.draft, false);
});
test('budget exhaustion preserves a draft for the next run', async () => {
  const f = fixture();
  await assert.rejects(backupRelease({ ...f.args, shouldContinue: () => false }), e => e.code === 'BUDGET');
  assert.equal(f.target.draft, true);
  assert.equal(f.transfers, 0);
  await backupRelease(f.args);
  assert.equal(f.target.draft, false);
});
test('size or checksum mismatch never publishes', async () => {
  const f = fixture();
  f.args.transfer = async () => ({ name: 'app.apk', size: 9, state: 'uploaded', digest: 'sha256:wrong' });
  await assert.rejects(backupRelease(f.args), /验证失败/);
  assert.equal(f.target.draft, true);
});
test('recover published snapshot after loss of local state without modifying it', async () => {
  const f = fixture();
  await backupRelease(f.args);
  f.args.snapshots = {};
  const changes = f.mutations.length;
  const snapshot = await backupRelease({ ...f.args, now: () => '2027-01-01' });
  assert.equal(snapshot.complete, true);
  assert.equal(f.mutations.length, changes);
});
test('published snapshot with missing attachments is never repaired in place', async () => {
  const f = fixture();
  await backupRelease(f.args);
  f.args.snapshots = {};
  f.assets.splice(0, 1);
  await assert.rejects(backupRelease(f.args), /拒绝修改旧快照/);
});
test('annotated tags resolve to their commit and reject invalid objects', async () => {
  const api = async () => ({ status: 200, body: { object: { type: 'commit', sha: 'resolved' } } });
  assert.equal(await resolveTagCommit(api, 'source/project', { type: 'tag', sha: 'tag' }), 'resolved');
  await assert.rejects(resolveTagCommit(api, 'source/project', { type: 'tree', sha: 'tree' }), /没有指向提交/);
});
test('pagination includes the second page and propagates unavailable upstream', async () => {
  const items = await listAll(async path => ({ status: 200, body: path.endsWith('page=1') ? Array(100).fill(1) : [2] }), '/releases');
  assert.equal(items.length, 101);
  await assert.rejects(listAll(async () => ({ status: 404, body: {} }), '/releases'), /HTTP 404/);
});
