#!/usr/bin/env node
/**
 * bundle → canonical。**不联网**——这就是「丢掉派生数据、只靠 captures 重建」那条
 * 不变量的可执行形式。
 *
 *   node bin/parse.js <装着一堆 bundle 的目录> [输出目录] [--account=<uid>] [--all-accounts]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openAll, crowdedDirs, NODE_VERIFY_HOST, zipsIn } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';
import { verifyAll, badCaptures } from '../src/verify.js';
import { accountsFromSources, filterSourcesByAccount, groupSourcesByAccount } from '../src/account.js';

const argv = process.argv.slice(2);
let root = null;
let outDir = 'canonical-out';
let targetAccount = null;
let allAccounts = false;
let ignoreWarnings = false;
let verify = true;

const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--ignore-warnings') {
    ignoreWarnings = true;
  } else if (arg === '--no-verify') {
    verify = false;
  } else if (arg === '--all-accounts') {
    allAccounts = true;
  } else if (arg === '--account') {
    targetAccount = argv[++i];
    if (!targetAccount || targetAccount.startsWith('--')) {
      console.error('--account 需要一个账号 UID');
      process.exit(2);
    }
  } else if (arg.startsWith('--account=')) {
    targetAccount = arg.slice('--account='.length);
    if (!targetAccount) {
      console.error('--account 需要一个账号 UID');
      process.exit(2);
    }
  } else if (arg.startsWith('--')) {
    console.error(`不认识这些开关：${arg}`);
    console.error(`能用的：--ignore-warnings / --no-verify / --account=<uid> / --all-accounts`);
    process.exit(2);
  } else {
    positionals.push(arg);
  }
}

if (targetAccount && allAccounts) {
  console.error('--account 与 --all-accounts 不能同时使用');
  process.exit(2);
}

root = positionals[0];
if (positionals[1]) outDir = positionals[1];

if (!root) {
  console.error('用法: node bin/parse.js <bundle 目录> [输出目录] [--account=<uid>] [--all-accounts] [--ignore-warnings]');
  console.error('  目录**连同子目录**一起找，找到的每一份 bundle 都会喂进去');
  console.error('  --account=<uid>    只解析指定账号的归档包（可解决多账号混放问题）');
  console.error('  --all-accounts     按账号自动分流，分别输出到 <输出目录>/<uid>/');
  console.error('  --ignore-warnings  混了多个账号时照样解析（合进同一份 canonical 之后分不开，慎用）');
  console.error('  --no-verify        跳过字节校验（默认是查的）。快，但坏掉的捕获会照常进 canonical');
  process.exit(2);
}

const allSources = openAll(root);
if (allSources.length === 0) {
  console.error(`${root} 下没有找到任何 bundle`);
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

function reportDuplicates(sources) {
  for (const s of sources) {
    for (const dir of s.duplicateDirs) {
      console.log(`\n档案 ${s.bundleId} 在两处各有一份，只读了一份：`);
      console.log(`   读的  ${s.dir}`);
      console.log(`   略过  ${dir}`);
      console.log('   索引是同一份（或是它的前缀），所以两份读出来的东西一样。');
      console.log('   不去重的话，每条记录会多出一次「这个 bundle 又看见了它」的出处。');
    }
    for (const dir of s.conflictingDirs) {
      console.log(`\n⚠ 编号 ${s.bundleId} 有两份，而它们的索引对不上：`);
      console.log(`   ${s.dir}`);
      console.log(`   ${dir}`);
      console.log('   两份都读了（并集是安全的），但它们的观测会各记一次。');
      console.log('   正常情况下不该出现——编号带着时间戳和随机后缀。请核对这两个目录。');
    }
  }
}

async function runParse(sources, targetOutDir) {
  reportCrowded(sources);
  reportDuplicates(sources);

  const t0 = Date.now();
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
      const kinds = [...new Set(findings.map((f) => f.kind))].join('、');
      console.log(`  类型：${kinds}`);
      console.log(`  受影响的捕获 ${skipCaptures.size} 条，**已排除**，不进 canonical。`);
      console.log('  细节：node bin/verify.js <同一个目录>');
    }
  }

  let parsed;
  try {
    parsed = await parse(sources, { ignoreWarnings, skipCaptures });
  } catch (err) {
    console.error(`\n✖ ${err.message}`);
    process.exit(1);
  }
  const {
    marks, subjects, broadcasts, longform, doulists,
    profile = [], albums = [], groupTopics = [], groupJoins = [],
    warnings, stats, topology,
  } = parsed;

  mkdirSync(targetOutDir, { recursive: true });
  const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(join(targetOutDir, 'marks.ndjson'), ndjson(marks));
  writeFileSync(join(targetOutDir, 'subjects.ndjson'), ndjson(subjects));
  writeFileSync(join(targetOutDir, 'broadcasts.ndjson'), ndjson(broadcasts));
  writeFileSync(join(targetOutDir, 'longform.ndjson'), ndjson(longform));
  writeFileSync(join(targetOutDir, 'doulists.ndjson'), ndjson(doulists));
  writeFileSync(join(targetOutDir, 'albums.ndjson'), ndjson(albums));
  writeFileSync(join(targetOutDir, 'group_topics.ndjson'), ndjson(groupTopics));
  writeFileSync(join(targetOutDir, 'group_joins.ndjson'), ndjson(groupJoins));
  writeFileSync(join(targetOutDir, 'profile.ndjson'), ndjson(profile));

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
  console.log(`产出 标记 ${marks.length} 条（修订 ${revs}）· 作品 ${subjects.length} 个 · 广播 ${broadcasts.length} 条（修订 ${brevs}）· 长文 ${longform.length} 篇 · 豆列 ${doulists.length} 份 · 相册 ${albums.length} 个 · 小组话题 ${groupTopics.length} 篇 · 加入小组 ${groupJoins.length} 个 → ${targetOutDir}/`);
  if (Object.keys(stats.skipped).length) console.log('跳过:', stats.skipped);

  const recal = Object.entries(stats.recalibratable);
  if (recal.length) {
    const total = recal.reduce((n, [, v]) => n + v, 0);
    console.log(`\n可离线救回 ${total} 条（页面已在档案里，改抽取器重跑即可，不必重抓）：`);
    for (const [route, n] of recal.sort((a, b) => b[1] - a[1])) console.log(`   ${route}  ${n}`);
  }

  if (stats.recalibratableCovered) {
    console.log(`\n另有 ${stats.recalibratableCovered} 条判不出来的捕获，`
      + '它们的网址在这份档案里另有成功捕获 —— 内容不缺，重跑最多多出一条修订。');
  }

  const byType = {};
  for (const w of warnings) byType[w.type] = (byType[w.type] ?? 0) + 1;
  if (warnings.length) {
    console.log('\n告警:', byType);
    for (const w of warnings.slice(0, 5)) console.log('  ', JSON.stringify(w));
  } else {
    console.log('告警: 无');
  }

  return verifyFindings.length === 0;
}

if (targetAccount) {
  const filtered = filterSourcesByAccount(allSources, targetAccount);
  if (filtered.length === 0) {
    const known = [...accountsFromSources(allSources).keys()].filter((k) => k && k !== 'unknown');
    console.error(`\n✖ 未在输入目录中找到账号 ${targetAccount} 的归档包。`);
    console.error(`  已发现账号：${known.length ? known.join('、') : '（无已知账号）'}`);
    process.exit(1);
  }
  const clean = await runParse(filtered, outDir);
  if (!clean) process.exit(1);
} else if (allAccounts) {
  const groups = groupSourcesByAccount(allSources);
  const uids = [...groups.keys()].filter((k) => k && k !== 'unknown');
  if (uids.length <= 1) {
    const clean = await runParse(allSources, outDir);
    if (!clean) process.exit(1);
  } else {
    console.log(`\n发现 ${uids.length} 个账号的归档包（${uids.join('、')}），按账号分流解析：`);
    let hasFailures = false;
    for (const uid of uids) {
      const accSources = groups.get(uid);
      const accOutDir = join(outDir, uid);
      console.log(`\n========================================`);
      console.log(`正在解析账号 ${uid}（${accSources.length} 份档案）→ ${accOutDir}/`);
      console.log(`========================================`);
      const clean = await runParse(accSources, accOutDir);
      if (!clean) hasFailures = true;
    }
    if (hasFailures) process.exit(1);
  }
} else {
  const clean = await runParse(allSources, outDir);
  if (!clean) process.exit(1);
}
