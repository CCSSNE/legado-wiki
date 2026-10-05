import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function releaseTransport(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'legado-wiki-release-backup' };
  async function upload(backupRepo, releaseId, name, content, size, contentType) {
    const url = `https://uploads.github.com/repos/${backupRepo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const r = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': contentType,
      'Content-Length': String(size) }, body: content, duplex: 'half', signal: AbortSignal.timeout(600000) });
    if (r.status !== 201) throw new Error(`上传附件 ${name} HTTP ${r.status}`);
    return r.json();
  }
  return {
    uploadManifest: ({ backupRepo, releaseId, name, content }) => upload(backupRepo, releaseId, name,
      content, Buffer.byteLength(content), 'application/json'),
    async transfer({ sourceRepo, backupRepo, releaseId, asset }) {
      const directory = await mkdtemp(join(tmpdir(), 'legado-release-'));
      const file = join(directory, 'asset.bin');
      try {
        let digest;
        let downloadError;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const publicUrl = asset.browser_download_url && new URL(asset.browser_download_url);
            const fallback = attempt === 3 && publicUrl?.origin === 'https://github.com' &&
              publicUrl.pathname.startsWith(`/${sourceRepo}/releases/download/`);
            const r = await fetch(fallback ? publicUrl.href : `https://api.github.com/repos/${sourceRepo}/releases/assets/${asset.id}`, {
              headers: fallback ? { 'User-Agent': headers['User-Agent'] } : { ...headers, Accept: 'application/octet-stream' },
              signal: AbortSignal.timeout(120000)
            });
            if (!r.ok || !r.body) throw new Error(`下载附件 ${asset.name} HTTP ${r.status}`);
            const hash = createHash('sha256');
            const checksum = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
            await pipeline(Readable.fromWeb(r.body), checksum, createWriteStream(file));
            digest = `sha256:${hash.digest('hex')}`;
            downloadError = null;
            break;
          } catch (e) {
            downloadError = e;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
        if (downloadError) throw downloadError;
        const size = (await stat(file)).size;
        if (size !== asset.size || (asset.digest && asset.digest !== digest)) throw new Error(`下载附件 ${asset.name} 的大小或 SHA256 不匹配`);
        const uploaded = await upload(backupRepo, releaseId, asset.name, createReadStream(file), size,
          asset.content_type || 'application/octet-stream');
        if (uploaded.size !== size || uploaded.digest !== digest) throw new Error(`上传附件 ${asset.name} 的 SHA256 不匹配`);
        return uploaded;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}
