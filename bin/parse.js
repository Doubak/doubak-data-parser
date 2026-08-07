#!/usr/bin/env node
/**
 * bundle → canonical。**不联网**——这就是「丢掉派生数据、只靠 captures 重建」那条
 * 不变量的可执行形式。
 *
 *   node bin/parse.js <装着一堆 bundle 的目录> [输出目录]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

const [root, outDir = 'canonical-out'] = process.argv.slice(2);
if (!root) {
  console.error('用法: node bin/parse.js <bundle 目录> [输出目录]');
  process.exit(2);
}

const sources = openAll(root);
if (sources.length === 0) {
  console.error(`${root} 下没有找到任何 bundle`);
  process.exit(1);
}

const t0 = Date.now();
const { marks, subjects, broadcasts, longform, warnings, stats } = parse(sources);

mkdirSync(outDir, { recursive: true });
const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(outDir, 'marks.ndjson'), ndjson(marks));
writeFileSync(join(outDir, 'subjects.ndjson'), ndjson(subjects));
writeFileSync(join(outDir, 'broadcasts.ndjson'), ndjson(broadcasts));
writeFileSync(join(outDir, 'longform.ndjson'), ndjson(longform));

const revs = marks.reduce((n, m) => n + m.revisions.length, 0);
console.log(`档案 ${stats.bundles} 份 · 列表页 ${stats.pages} 张 · 观测 ${stats.observations} 次 · ${Date.now() - t0} ms`);
const brevs = broadcasts.reduce((n, b) => n + b.revisions.length, 0);
console.log(`产出 标记 ${marks.length} 条（修订 ${revs}）· 作品 ${subjects.length} 个 · 广播 ${broadcasts.length} 条（修订 ${brevs}）· 长文 ${longform.length} 篇 → ${outDir}/`);
if (Object.keys(stats.skipped).length) console.log('跳过:', stats.skipped);

// 告警必须显眼。静默的抽取器退化正是这套设计从头到尾在防的东西。
const byType = {};
for (const w of warnings) byType[w.type] = (byType[w.type] ?? 0) + 1;
if (warnings.length) {
  console.log('\n告警:', byType);
  for (const w of warnings.slice(0, 5)) console.log('  ', JSON.stringify(w));
} else {
  console.log('告警: 无');
}
