#!/usr/bin/env node
/**
 * bundle → canonical。**不联网**——这就是「丢掉派生数据、只靠 captures 重建」那条
 * 不变量的可执行形式。
 *
 *   node bin/parse.js <装着一堆 bundle 的目录> [输出目录]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openAll, crowdedDirs, NODE_VERIFY_HOST, zipsIn } from '../src/bundle-source.js';
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
  // **说得出下一步。** 扩展在 Firefox 上导出交出来的是一个 zip，而这里收的是目录
  // ——中间隔着一步解压。只说「没找到」的话，用户会去翻别的目录、以为导出坏了。
  // 与扩展那边 `describeNoBundles` 是同一条判据、同一句话。
  const zips = zipsIn(root);
  const ours = zips.filter((z) => /^doubak-.*\.zip$/i.test(z));
  if (ours.length) {
    console.error(`  找到了 ${ours[0]}——**这是一个 zip 壳子，要先解压**。`);
    console.error('  解开之后里面是一个 doubak-bundle-… 目录，那个才是档案本身；');
    console.error('  它与 Chrome 直接导出的完全一样，把解开后的目录喂给这个命令即可。');
  } else if (zips.length) {
    console.error(`  这个目录里有 ${zips.length} 个 zip 文件。如果其中哪一个是导出的档案，请先解压。`);
  }
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

// **同一份档案被放了两处，也要说出来。**
//
// 已经按索引前缀去重了（见 bundle-source.js 的 dedupe），所以产出是对的；
// 说一声是因为**它解释了「档案 N 份」这个数字为什么跟目录里数出来的不一样**。
// 不说的话，用户数出 27 个文件夹、这里报 26 份，看起来像漏读了一份——
// 而「漏读一份」正是这个项目最怕的那种静默失败，不该让正确的行为长得像它。
function reportDuplicates(sources) {
  for (const s of sources) {
    for (const dir of s.duplicateDirs) {
      console.log(`\n档案 ${s.bundleId} 在两处各有一份，只读了一份：`);
      console.log(`   读的  ${s.dir}`);
      console.log(`   略过  ${dir}`);
      console.log('   索引是同一份（或是它的前缀），所以两份读出来的东西一样。');
      console.log('   不去重的话，每条记录会多出一次「这个 bundle 又看见了它」的出处。');
    }
    // **同编号但索引对不上，是另一回事，两份都读。** 少读一份会静默丢数据，
    // 而重复的出处只是难看。方向不对称，所以处置也不一样。
    for (const dir of s.conflictingDirs) {
      console.log(`\n⚠ 编号 ${s.bundleId} 有两份，而它们的索引对不上：`);
      console.log(`   ${s.dir}`);
      console.log(`   ${dir}`);
      console.log('   两份都读了（并集是安全的），但它们的观测会各记一次。');
      console.log('   正常情况下不该出现——编号带着时间戳和随机后缀。请核对这两个目录。');
    }
  }
}

reportCrowded(sources);
reportDuplicates(sources);

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

// **同一个网址另有成功捕获的那些，折成一行。**
//
// 实测这份档案里有 2 条：同一次抓取把同一篇日记抓了三遍，前两遍判不出来（当时
// 抽取器还不认 topic 那套模板），第三遍成了——那篇日记连正文带两张配图都在
// canonical 里。列进上面那张表的话，它会**永远**在那儿：档案是冻结的，那两条
// 捕获再也不会变。而这个项目已经数过五次「一个永远有条目的失败列表，是没人看的
// 失败列表」，两条常驻项就足够让第三条真的挡不住人的眼。
//
// 但也不能抹掉：那一页少了一次观测，极端情况下少的是一条修订。所以说，只是别
// 让它顶着「可离线救回」的名字站在待办清单上。
if (stats.recalibratableCovered) {
  console.log(`\n另有 ${stats.recalibratableCovered} 条判不出来的捕获，`
    + '它们的网址在这份档案里另有成功捕获 —— 内容不缺，重跑最多多出一条修订。');
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
