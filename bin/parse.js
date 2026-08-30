#!/usr/bin/env node
/**
 * bundle → canonical。**不联网**——这就是「丢掉派生数据、只靠 captures 重建」那条
 * 不变量的可执行形式。
 *
 *   node bin/parse.js <装着一堆 bundle 的目录> [输出目录]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openAll, crowdedDirs, NODE_VERIFY_HOST } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';
import { verifyAll, badCaptures } from '../src/verify.js';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const [root, outDir = 'canonical-out'] = argv.filter((a) => !a.startsWith('--'));

// 只认一种写法。整个项目的命令行都用连字符（`--shelf-history`、`--no-shelf-history`、
// `--sample=`…），多留一个下划线别名换来的是「到底哪个才对」，而不是少打一次字。
const KNOWN = ['--ignore-warnings', '--no-verify'];
const bad = flags.filter((f) => !KNOWN.includes(f));
if (bad.length) {
  console.error(`不认识这些开关：${bad.join(' ')}`);
  console.error(`能用的：${KNOWN.join(' / ')}`);
  process.exit(2);
}
const ignoreWarnings = flags.includes('--ignore-warnings');
/**
 * **默认查。**
 *
 * 这一节整个的教训就是：要人主动去跑的完整性检查没人跑——`validate.py` 一直
 * 都在，覆盖的情况也几乎全，可它 24 份档案里有 4 份永远报错，于是从来没人跑它。
 * 一个默认关着的开关，等于把「要不要相信这些字节」这个问题推给一个此刻根本
 * 不知道有这回事的人。
 *
 * 代价是实测一份 619 MB / 23962 条捕获的真实档案上多 8.3 秒（解析本身 16.3 秒）。
 *
 * **不与 `--ignore-warnings` 合并**：那一个管的是「混了多个账号还要不要继续」，
 * 是一个致命条件的闸门；完整性发现根本不致命（坏的那几条会被排除，其余照常
 * 摄取）。一个开关管两件性质不同的事，用它的人就不知道自己关掉了什么——
 * 想绕开账号检查的人不该顺手把字节校验也关了。
 */
const verify = !flags.includes('--no-verify');

if (!root) {
  console.error('用法: node bin/parse.js <bundle 目录> [输出目录] [--ignore-warnings]');
  console.error('  目录**连同子目录**一起找，找到的每一份 bundle 都会喂进去');
  console.error('  --ignore-warnings  混了多个账号时照样解析（合进同一份 canonical 之后分不开，慎用）');
  console.error('  --no-verify        跳过字节校验（默认是查的）。快，但坏掉的捕获会照常进 canonical');
  process.exit(2);
}

const sources = openAll(root);
if (sources.length === 0) {
  console.error(`${root} 下没有找到任何 bundle`);
  process.exit(1);
}

// **一个目录里塞了不止一份档案，要说出来。**
//
// 能读出来不等于该这么放：其中至多一份能配上它的 manifest，其余的
// crawl_state / coverage 就都没有了——数据还在，能下的结论少了。
function reportCrowded(sources) {
  const crowded = crowdedDirs(sources);
  if (!crowded.length) return;
  for (const c of crowded) {
    console.log(`\n⚠ ${c.dir}`);
    console.log(`   这一个目录里有 ${c.bundles.length} 份档案的文件混在一起。`);
    const without = c.bundles.filter((b) => !c.withManifest.includes(b));
    if (c.withManifest.length) {
      console.log(`   只有 ${c.withManifest.join('、')} 配得上目录里那份 manifest.json；`);
      console.log(`   另外 ${without.length} 份按「没有 manifest」处理（读得到捕获，`);
      console.log('   但没有 crawl_state / coverage，不能据此判断谁被删了）。');
    }
    console.log('   想拿全的话：按 index-<编号>.ndjson 把它们各自分到一个目录里，');
    console.log('   段文件名里就嵌着编号，照着分即可。');
  }
}

reportCrowded(sources);

const t0 = Date.now();

// ── 可选：先核字节
//
// **查出问题不中止，而是把那几条排除掉。** 一张图坏了不该让另外两万条观测也
// 进不来（INGESTION.md §2.3——丢弃的是凭它能下的结论，不是数据）。产出照写，
// 退出码非零——「这趟干不干净」与「还能救回什么」是两个问题，各自有各自的出口。
let skipCaptures = new Set();
let verifyFindings = [];
if (verify) {
  const v0 = Date.now();
  const { findings, checked } = await verifyAll(sources, NODE_VERIFY_HOST);
  verifyFindings = findings;
  skipCaptures = badCaptures(findings);
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  console.log(
    `完整性：段 ${checked.segments} 个（${mb(checked.bytes)}）· 捕获 ${checked.captures} 条`
    + ` · ${Date.now() - v0} ms —— ${findings.length ? `${findings.length} 处发现` : '全部对得上'}`,
  );
  if (findings.length) {
    // 这里只印一句摘要。**要看清楚是哪一种对不上，跑 verify.js**——它按类型
    // 折叠、每类都写了「这是什么、下一步做什么」，那些话不该在这儿抄第二遍。
    const kinds = [...new Set(findings.map((f) => f.kind))].join('、');
    console.log(`  类型：${kinds}`);
    console.log(`  受影响的捕获 ${skipCaptures.size} 条，**已排除**，不进 canonical。`);
    console.log('  细节：node bin/verify.js <同一个目录>');
  }
  // 段缓存在 verifyAll 里已经放掉了；下面解析会按需重新读。
}

// 体检不过是**用户的输入有问题**，不是这个程序崩了。原样抛出去会印一屏栈回溯，
// 而那屏字里唯一有用的一句被埋在中间——用户要读的是「怎么办」。
let parsed;
try {
  parsed = await parse(sources, { ignoreWarnings, skipCaptures });
} catch (err) {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
}
const { marks, subjects, broadcasts, longform, doulists, warnings, stats, topology } = parsed;

mkdirSync(outDir, { recursive: true });
const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(outDir, 'marks.ndjson'), ndjson(marks));
writeFileSync(join(outDir, 'subjects.ndjson'), ndjson(subjects));
writeFileSync(join(outDir, 'broadcasts.ndjson'), ndjson(broadcasts));
writeFileSync(join(outDir, 'longform.ndjson'), ndjson(longform));
writeFileSync(join(outDir, 'doulists.ndjson'), ndjson(doulists));

// **把档案的拓扑说出来，但不替用户取舍。** 多个根、分叉都很正常（删掉一份重抓、
// 换台机器、同一天跑两次增量都会分叉），而分叉不是矛盾：捕获是带时间戳的观测，
// 两条分支只是同一个账号的两批观测。挑一条链解析反而会丢东西。
//
// 说出来是因为「我到底喂进去了什么」应该看得见——而不是因为它需要用户做决定。
if (topology.roots.length > 1 || topology.forks.length) {
  const short = (id) => id.slice(-6);
  const bits = [`${topology.roots.length} 个起点`];
  if (topology.forks.length) bits.push(`${topology.forks.length} 处分叉`);
  console.log(`\n档案不是一条单链：${bits.join('，')}（起点 ${topology.roots.map(short).join('、')}）`);
  console.log('  分叉不影响结果——合并的是观测，不是结论。挑一条链解析反而会丢掉另一条上的东西。');
}

const revs = marks.reduce((n, m) => n + m.revisions.length, 0);
console.log(`档案 ${stats.bundles} 份 · 列表页 ${stats.pages} 张 · 观测 ${stats.observations} 次 · ${Date.now() - t0} ms`);
const brevs = broadcasts.reduce((n, b) => n + b.revisions.length, 0);
console.log(`产出 标记 ${marks.length} 条（修订 ${revs}）· 作品 ${subjects.length} 个 · 广播 ${broadcasts.length} 条（修订 ${brevs}）· 长文 ${longform.length} 篇 · 豆列 ${doulists.length} 份 → ${outDir}/`);
if (Object.keys(stats.skipped).length) console.log('跳过:', stats.skipped);

// **把「改一行就能救回来的」单独说。**
//
// 混在「有 N 条失败」里的话，用户只能去做代价最大的那个动作——重抓。而这些页面
// 已经原样躺在 WARC 里了，改好抽取器离线重跑就行，一个请求都不用发。
const recal = Object.entries(stats.recalibratable);
if (recal.length) {
  const total = recal.reduce((n, [, v]) => n + v, 0);
  console.log(`\n可离线救回 ${total} 条（页面已在档案里，改抽取器重跑即可，不必重抓）：`);
  for (const [route, n] of recal.sort((a, b) => b[1] - a[1])) console.log(`   ${route}  ${n}`);
}

// 告警必须显眼。静默的抽取器退化正是这套设计从头到尾在防的东西。
const byType = {};
for (const w of warnings) byType[w.type] = (byType[w.type] ?? 0) + 1;
if (warnings.length) {
  console.log('\n告警:', byType);
  for (const w of warnings.slice(0, 5)) console.log('  ', JSON.stringify(w));
} else {
  console.log('告警: 无');
}

// **产出写了，退出码仍然非零。** 回答的是两个不同的问题：文件说「还能救回什么」，
// 退出码说「这趟干不干净」。脚本里 `--verify` 后面接 `&&` 的人要的是后者。
if (verifyFindings.length) process.exit(1);
