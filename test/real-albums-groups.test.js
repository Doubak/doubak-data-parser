import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { realBundle, have } from './real-archive.js';
import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

const BUNDLE_NAME = 'doubak-bundle-20261011T061919Z-ede695';
const BUNDLE_DIR = realBundle(BUNDLE_NAME);

describe('真实个人相册与小组档案端到端解析', () => {
  const skip = have(BUNDLE_DIR) ? false : `缺少真实测试档案 ${BUNDLE_NAME}`;

  test('个人相册与小组话题完整解析且无修订撕裂', { skip }, async () => {
    const sources = openAll(BUNDLE_DIR);
    const parsed = await parse(sources);
    for (const s of sources) s.close();

    const { albums, groupTopics, groupJoins } = parsed;

    // 1. 个人相册
    assert.equal(albums.length, 1);
    const album = albums[0];
    assert.equal(album.upstream_id, '2229573758');
    assert.equal(album.revisions.length, 1);
    const af = album.revisions[0].fields;
    assert.equal(af.title, 'Doubak 豆备 的截图相册');
    assert.equal(af.desc, '主要是用来测试啦');
    assert.equal(af.claimed_count, 2);
    assert.equal(af.photos.length, 2);
    assert.deepEqual(af.photos.map((p) => p.id), ['2936569494', '2936569487']);
    assert.deepEqual(af.photos.map((p) => p.seq), [0, 1]);
    assert.ok(af.photos[0].image_url.includes('/view/photo/large/'));

    // 2. 加入的小组
    assert.equal(groupJoins.length, 34);
    assert.equal(new Set(groupJoins.map((g) => g.upstream_id)).size, 34);
    const j0 = groupJoins.find((g) => g.upstream_id === '722855');
    assert.ok(j0);
    assert.equal(j0.revisions[0].fields.name, '短剧开始啦');

    // 3. 发起的讨论话题
    assert.equal(groupTopics.length, 3);
    const t0 = groupTopics.find((t) => t.upstream_id === '258053730');
    assert.ok(t0);
    const tf = t0.revisions[0].fields;
    assert.equal(tf.title, '请问有番外6集的字幕嘛，找到了无字幕版但是有点啃不动');
    assert.equal(tf.published_at.raw, '2022-01-16 17:08:37');
    assert.equal(tf.group_id, '722855');
    assert.equal(tf.group_name, '短剧开始啦');
    assert.ok(tf.body.includes('RT'));
    assert.equal(tf.images.length, 0);
  });
});
