// 访问统计快照：分别读取两个站点（GitHub Pages 原站 + EdgeOne 国内站）的不蒜子累计值，
// 按北京时间到分钟记录到 data/stats.json，每小时一条（由 workflow 每小时调度保证颗粒度）。
//
// 自我扣除：不蒜子每次查询都会让该域名的计数 +1（实测确认），本脚本每次运行会对每个站
// 各发 1 次查询。因此记录里保存截止本次运行累计的自动化查询次数 runs，
// 前端展示时用 原始值 - runs 得到不含自己请求的净数。
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const STATS_FILE = 'data/stats.json';
const BUSUANZI_URL = 'https://busuanzi.ibruce.info/busuanzi?jsonpCallback=BusuanziCallback';

const SITES = [
  { key: 'github', label: 'GitHub Pages', referer: 'https://ccssne.github.io/legado-wiki/' },
  { key: 'edgeone', label: 'EdgeOne', referer: 'https://legado.erchuang.online/' }
];

async function fetchBusuanzi(referer) {
  const response = await fetch(BUSUANZI_URL, {
    headers: { Referer: referer }
  });
  if (!response.ok) {
    throw new Error(`不蒜子接口返回 ${response.status}（${referer}）`);
  }
  const text = await response.text();
  // 返回形如 try{BusuanziCallback_12345({...});}catch(e){}，提取其中的 JSON 对象
  const match = text.match(/\((\{[\s\S]*?\})\)/);
  if (!match) {
    throw new Error(`不蒜子返回格式异常（${referer}）`);
  }
  const data = JSON.parse(match[1]);
  const numbers = {};
  for (const [key, out] of [['site_pv', 'pv'], ['site_uv', 'uv'], ['page_pv', 'pagePv']]) {
    const value = Number(data[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`不蒜子字段 ${key} 异常：${data[key]}（${referer}）`);
    }
    numbers[out] = value;
  }
  return numbers;
}

// 北京时间当前时刻（到分钟），格式 YYYY-MM-DD HH:mm
function nowKey() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function main() {
  let meta = { runs: 0 };
  let stats = [];
  try {
    const parsed = JSON.parse(await readFile(STATS_FILE, 'utf8'));
    if (parsed && Number.isInteger(parsed.meta?.runs)) {
      meta = { runs: parsed.meta.runs };
    }
    // 只保留新格式记录（带 time 与 runs）；旧格式（仅按天）直接丢弃，从本次起重新积累
    if (Array.isArray(parsed.records)) {
      stats = parsed.records.filter(record => typeof record.time === 'string' && Number.isInteger(record.runs));
    }
  } catch {
    // 文件不存在或损坏时从空列表开始
  }

  // 两个站都查到才算成功，任一失败则整次快照放弃，避免记下残缺数据
  const values = {};
  let total = { pv: 0, uv: 0, pagePv: 0 };
  for (const site of SITES) {
    values[site.key] = await fetchBusuanzi(site.referer);
    total.pv += values[site.key].pv;
    total.uv += values[site.key].uv;
    total.pagePv += values[site.key].pagePv;
  }

  const runs = meta.runs + 1;
  const entry = {
    time: nowKey(),
    runs,
    ...total,
    github: values.github,
    edgeone: values.edgeone
  };

  const index = stats.findIndex(item => item.time === entry.time);
  if (index >= 0) {
    stats[index] = entry;
  } else {
    stats.push(entry);
  }
  stats.sort((a, b) => a.time.localeCompare(b.time));
  meta.runs = runs;

  const output = `${JSON.stringify({ meta, records: stats }, null, 2)}\n`;
  const existing = await readFile(STATS_FILE, 'utf8').catch(() => '');
  if (existing === output) {
    console.log(`${entry.time} 的数据未变化，跳过写入`);
    return;
  }

  await mkdir('data', { recursive: true });
  await writeFile(STATS_FILE, output, { encoding: 'utf8' });
  const parts = SITES.map(site => `${site.label} pv=${values[site.key].pv} uv=${values[site.key].uv}`).join('，');
  console.log(`已记录 ${entry.time}（第 ${runs} 次自动化查询）：合计 pv=${total.pv} uv=${total.uv}（${parts}）`);
}

main().catch(error => {
  console.error(`访问统计快照失败：${error.message}`);
  process.exit(1);
});