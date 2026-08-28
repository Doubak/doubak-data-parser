/**
 * 一堆档案该不该被一起解析。
 *
 * 这一层的立场是：**分叉不拦，混账号拦死。** 两件事看起来都像「目录里的东西不对」，
 * 但性质相反——分叉只是同一个账号的两批观测，合并是信息更多；混账号是把两个人的
 * 存档合成一份，而且事后分不开。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { topology, assertSingleAccount } from '../src/topology.js';
import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

/** @param {object} m manifest 片段 */
const src = (bundleId, m = {}) => ({
  bundleId,
  manifest: { bundle_id: bundleId, account: { user_id: '82160871' }, ...m },
});

describe('拓扑', () => {
  test('单链：一个根，没有分叉', () => {
    const t = topology([
      src('a'), src('b', { previous_bundle_id: 'a' }), src('c', { previous_bundle_id: 'b' }),
    ]);
    assert.deepEqual(t.roots, ['a']);
    assert.deepEqual(t.forks, []);
  });

  test('分叉与多个根都认得出来', () => {
    // 删掉一份重抓、换台机器、同一天跑两次增量，都会造出这种形状。
    const t = topology([
      src('a'), src('b', { previous_bundle_id: 'a' }), src('c', { previous_bundle_id: 'a' }), src('d'),
    ]);
    assert.deepEqual(t.roots, ['a', 'd']);
    assert.deepEqual(t.forks, [{ parent: 'a', children: ['b', 'c'] }]);
  });

  test('**地板指向的档案不在目录里 → 认出来**', () => {
    // 增量只看了地板以上，地板底下那段谁也没看过。这是个真实的覆盖空洞，
    // 而它看起来一切正常：条数、连续性、其余告警全是好的。
    const t = topology([
      src('b', { crawl_state: [{ route_key: 'broadcast.timeline', floor_from_bundle_id: 'a' }] }),
    ]);
    assert.deepEqual(t.danglingFloors, [
      { bundle: 'b', routeKey: 'broadcast.timeline', missing: 'a' },
    ]);
  });

  test('地板指向的档案在目录里 → 不报', () => {
    const t = topology([
      src('a'),
      src('b', { previous_bundle_id: 'a', crawl_state: [{ route_key: 'r', floor_from_bundle_id: 'a' }] }),
    ]);
    assert.deepEqual(t.danglingFloors, []);
  });

  test('没有 manifest 的档案不当成错', () => {
    // INGESTION.md §2.3：缺 manifest 时该丢弃的是「凭它能下什么结论」，不是数据本身。
    const t = topology([{ bundleId: 'x', manifest: null }]);
    assert.deepEqual(t.accounts, []);
    assert.deepEqual(t.roots, ['x']);
  });
});

describe('混账号', () => {
  test('**直接报错，不是告警**', async () => {
    // 告警是「你可能想看一眼」，而这件事没有「可能」：合进去之后从产出里再也分不开
    // ——身份键里带账号的那部分只在退化层用得上，有 data-cid 的那一半根本不看账号。
    // 而它太容易发生了：把两次导出解压到同一个下载目录就够了。
    const t = topology([src('a'), src('b', { account: { user_id: '999' } })]);
    assert.deepEqual(t.accounts, ['82160871', '999']);
    assert.throws(() => assertSingleAccount(t), /混着 2 个账号/);
  });

  test('同一个账号不报', async () => {
    assert.doesNotThrow(() => assertSingleAccount(topology([src('a'), src('b')])));
    assert.equal(assertSingleAccount(topology([src('a'), src('b')])), null);
  });

  test('--ignore-warnings 放行，但不让它闭嘴', async () => {
    // 绕过的是「停下来」，不是「说出来」：一句被读到的告警，和一次读不到的静默合并，
    // 代价差着一个量级。所以这里既要不抛，又要拿得到那句话。
    const t = topology([src('a'), src('b', { account: { user_id: '999' } })]);
    const msg = assertSingleAccount(t, { ignoreWarnings: true });
    assert.match(msg, /混着 2 个账号/);
    assert.match(msg, /--ignore-warnings/);
  });

  test('放行之后那条要出现在 warnings 里，不能只留在返回值上', async () => {
    // 命令行只印 `warnings`。要是只当返回值传回去，用户在输出里一个字都看不到。
    // 这里的档案是空的（没有 index 行），因为要验的是体检那一段，不是抽取。
    const empty = (bundleId, m = {}) => ({
      ...src(bundleId, m), index: [], crawlState: new Map(), coverage: [], status: 'complete',
      payload: () => null, close: () => {},
    });
    const sources = [empty('a'), empty('b', { account: { user_id: '999' } })];
    // `parse` 是 async，所以这里必须是 `rejects` 而不是 `throws`——
    // `assert.throws` 对一个返回 rejected promise 的函数是**不会失败的**，
    // 它只看有没有同步抛出。写错的话这条断言就永远绿，而它守的是
    // 「两个账号混在一个目录里」这道拦截。
    await assert.rejects(() => parse(sources), /混着 2 个账号/);
    const { warnings } = await parse(sources, { ignoreWarnings: true });
    const hit = warnings.filter((w) => w.type === 'multiple_accounts');
    assert.equal(hit.length, 1, '放行之后必须留下一条告警');
    assert.deepEqual(hit[0].accounts, ['82160871', '999']);
  });
});

describe('对着真实档案', () => {
  const DL = '/home/mewx/downloads/20260806';

  test('**分叉的目录照样解析，而且结果恰好是并集**', async (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 那八份档案真的是两个根：一条 7 份的链，加一份独立的全量重抓。
    const all = openAll(DL);
    const topo = topology(all);
    assert.ok(topo.roots.length > 1, '这个目录本该是分叉的，不然这条测试就是空的');

    const merged = await parse(all);
    const chain = await parse(openAll(DL).filter((s) => s.bundleId !== topo.roots[topo.roots.length - 1]));
    const lone = await parse(openAll(DL).filter((s) => s.bundleId === topo.roots[topo.roots.length - 1]));

    const ids = (r, k) => new Set(r[k].map((x) => x.upstream_id));
    for (const k of ['broadcasts', 'longform']) {
      const union = new Set([...ids(chain, k), ...ids(lone, k)]);
      assert.deepEqual(ids(merged, k), union, `${k}: 合并的结果应当恰好是并集`);
    }

    // **观测一次不多一次不少。** 多算了说明去重坏了，少算了说明合并丢了东西。
    const obs = (r) => r.marks.reduce((n, m) => n + m.revisions.reduce((k, v) => k + v.observations.length, 0), 0);
    assert.equal(obs(merged), obs(chain) + obs(lone));

    // **而且没有凭空多出修订。** 这才是「分叉不是矛盾」的真正含义：另一条分支上的
    // 观测看到的是同样的内容，所以它们只是观测，不构成一次编辑。
    const revs = (r) => r.marks.reduce((n, m) => n + m.revisions.length, 0);
    assert.equal(revs(merged), revs(chain),
      '合并另一条分支之后修订数变了 —— 那意味着分叉被当成了编辑');
  });
});
