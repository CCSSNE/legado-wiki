import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBackup } from '../scripts/fork-sync.mjs';
import { recordStatus } from '../scripts/backup-status.mjs';

const branch = { id: 'example', name: '示例', repo: 'author/project' };
function fixture(options = {}) {
  const state = { version: 1, projects: {} };
  const upstream = { id: 42, full_name: 'author/project', default_branch: 'main' };
  const backup = { fork: true, parent: { id: 42 }, default_branch: 'main' };
  const refs = new Map([['main', options.old || 'old']]);
  const mutations = [];
  let reads = 0;
  const sourceSha = options.source || 'new';
  const ok = body => ({ status: 200, body });
  const api = async (path, init = {}) => {
    if (options.hook) {
      const override = options.hook(path, init);
      if (override) return override;
    }
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (method !== 'GET') mutations.push({ method, path, body });
    if (path === '/repos/legado-backup/legado-example') {
      if (method === 'PATCH') { backup.default_branch = body.default_branch; return ok(backup); }
      return ok(backup);
    }
    if (path === '/repositories/42') return ok(upstream);
    if (path.startsWith('/repos/author/project/git/ref/heads/')) {
      reads++;
      return ok({ object: { sha: options.moving && reads > 1 ? 'changed' : sourceSha } });
    }
    if (path.includes('/compare/')) return options.compare || ok({ ahead_by: 0 });
    if (path.startsWith('/repos/legado-backup/legado-example/git/ref/heads/')) {
      const name = path.split('/git/ref/heads/')[1];
      return refs.has(name) ? ok({ object: { sha: refs.get(name) } }) : { status: 404, body: { message: 'Not Found' } };
    }
    if (path.includes('/git/refs/heads/') && method === 'PATCH') {
      assert.equal(body.force, false);
      refs.set(path.split('/git/refs/heads/')[1], body.sha);
      return ok({ object: { sha: body.sha } });
    }
    if (path.endsWith('/git/refs') && method === 'POST') {
      refs.set(body.ref.slice('refs/heads/'.length), body.sha);
      return { status: 201, body: { object: { sha: body.sha } } };
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { state, upstream, backup, refs, mutations, api, run: () => syncBackup({ branch, state, org: 'legado-backup', api, now: () => '2026-10-05T01:00:00Z' }) };
}

test('normal changes fast-forward without force; unchanged heads do not write', async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 'synced');
  assert.equal(f.refs.get('main'), 'new');
  assert.equal(f.state.projects.example.activeBranch, 'main');
  const count = f.mutations.length;
  await f.run();
  assert.equal(f.mutations.length, count);
});

for (const [name, compare] of [
  ['diverged', { status: 200, body: { ahead_by: 11 } }],
  ['unrelated', { status: 404, body: { message: 'No common ancestor between old and new.' } }]
]) {
  test(`${name} creates and verifies a new branch while preserving the old one`, async () => {
    const f = fixture({ compare });
    assert.equal((await f.run()).status, 'rotated');
    const p = f.state.projects.example;
    assert.equal(p.activeBranch, 'backup/v2-new');
    assert.equal(f.refs.get('main'), 'old');
    assert.equal(f.refs.get(p.activeBranch), 'new');
    assert.equal(p.retired[0].head, 'old');
    assert.equal(f.backup.default_branch, p.activeBranch);
    assert.equal((await f.run()).status, 'synced');
    assert.equal(f.mutations.filter(x => x.method === 'POST').length, 1);
  });
}

test('an interrupted state save reuses the verified generation', async () => {
  const f = fixture({ compare: { status: 200, body: { ahead_by: 1 } } });
  f.refs.set('backup/v2-new', 'new');
  await f.run();
  assert.equal(f.state.projects.example.activeBranch, 'backup/v2-new');
  assert.equal(f.mutations.filter(x => x.method === 'POST').length, 0);
});

test('rename follows stable repository ID and records new names only once', async () => {
  const f = fixture({ old: 'new' });
  await f.run();
  f.upstream.full_name = 'author/renamed';
  f.upstream.default_branch = 'develop';
  const originalApi = f.api;
  f.api = (path, init) => originalApi(path.replace('/repos/author/renamed/', '/repos/author/project/'), init);
  const run = () => syncBackup({ branch, state: f.state, org: 'legado-backup', api: f.api });
  assert.equal((await run()).status, 'renamed');
  assert.equal((await run()).notify, false);
  assert.equal(f.mutations.length, 0);
});

for (const code of [404, 403, 429, 500]) {
  test(`upstream HTTP ${code} is an error, never a history rotation`, async () => {
    const f = fixture({ hook: path => path === '/repositories/42' ? { status: code, body: { message: 'Unavailable' } } : null });
    await assert.rejects(f.run());
    assert.equal(f.mutations.length, 0);
    assert.equal(f.refs.get('main'), 'old');
  });
}

test('a generic comparison 404 is an error, unlike no-common-ancestor 404', async () => {
  const f = fixture({ compare: { status: 404, body: { message: 'Not Found' } } });
  await assert.rejects(f.run(), /比较历史 HTTP 404/);
  assert.equal(f.mutations.length, 0);
});

test('network exceptions preserve all refs', async () => {
  const f = fixture({ hook: path => { if (path === '/repositories/42') throw new Error('connection reset'); } });
  await assert.rejects(f.run(), /connection reset/);
  assert.equal(f.mutations.length, 0);
});

test('a moving upstream is retried next time, without creating a generation', async () => {
  const f = fixture({ moving: true, compare: { status: 200, body: { ahead_by: 1 } } });
  await assert.rejects(f.run(), /分支发生变化/);
  assert.equal(f.mutations.length, 0);
});

test('410 is still probed on every run and automatically recovers', async () => {
  let gone = true;
  const f = fixture({ hook: path => path === '/repositories/42' && gone ? { status: 410 } : null });
  assert.equal((await f.run()).notify, true);
  assert.equal((await f.run()).notify, false);
  gone = false;
  assert.equal((await f.run()).status, 'synced');
  assert.equal(f.state.projects.example.status, 'active');
});

test('failed branch creation preserves old mapping and history', async () => {
  const f = fixture({ compare: { status: 200, body: { ahead_by: 1 } },
    hook: (path, init) => path.endsWith('/git/refs') && init.method === 'POST' ? { status: 422, body: { message: 'workflow permission missing' } } : null });
  await assert.rejects(f.run(), /workflow permission/);
  assert.equal(f.state.projects.example, undefined);
  assert.equal(f.refs.get('main'), 'old');
});

test('status log records transitions and recovery, not repeated polling', () => {
  const state = { projects: {} };
  recordStatus(state, branch, { status: 'synced', message: '正常' }, '1');
  recordStatus(state, branch, { status: 'error', message: '上游不可见' }, '2');
  recordStatus(state, branch, { status: 'error', message: '上游不可见' }, '3');
  recordStatus(state, branch, { status: 'synced', message: '恢复' }, '4');
  assert.equal(state.statuses.example.events.length, 3);
  assert.equal(state.statuses.example.events.at(-1).type, 'restored');
  assert.equal(state.statuses.example.status, 'normal');
});
