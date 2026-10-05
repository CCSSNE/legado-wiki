export function recordStatus(state, branch, result, at = new Date().toISOString()) {
  state.statuses ||= {};
  const previous = state.statuses[branch.id];
  const project = state.projects[branch.id];
  const status = result.status === 'gone' ? 'unavailable' : result.status;
  // Successful auto-handling is an event; the current health is normal.
  const health = ['synced', 'rotated', 'renamed'].includes(status) ? 'normal' : status;
  const message = health === 'normal' ? '正常同步' : result.message;
  const events = previous?.events || [];
  if (!previous || previous.status !== health || previous.message !== message || result.notify) {
    const restored = previous && ['error', 'unavailable'].includes(previous.status) && health === 'normal';
    events.push({ at, type: restored ? 'restored' : status, message: restored ? `恢复同步；${result.message}` : result.message });
  }
  state.statuses[branch.id] = {
    name: branch.name || branch.id, repo: project?.upstreamRepo || branch.repo,
    status: health, message, since: events.at(-1)?.at || at,
    backupRepo: project?.backupRepo || null, activeBranch: project?.activeBranch || null, events
  };
}
