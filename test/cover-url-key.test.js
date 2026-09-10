/**
 * 封面 URL 的索引规则。
 *
 * 这条规则唯一的危险方向是**抹多了**：抹掉一段其实携带身份的东西，两张不同的图
 * 就被静默并成一张，而症状是「该开的修订没开」——没有任何报错。所以这里的测试
 * 一半在钉「什么必须被抹掉」，另一半在钉「什么绝不许被抹掉」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coverUrlKey, COVER_URL_KEY_RULES } from '../src/cover-url-key.js';

describe('cover_url_key', () => {
  test('量过的那一族分片被抹平', () => {
    const same = [
      'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp',
      'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp',
      'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp',
      'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp',
    ].map(coverUrlKey);
    assert.equal(new Set(same).size, 1, '四个分片该收成同一个 key');
    assert.match(same[0], /^https:\/\/img\.doubanio\.com\//);
  });

  test('**尺寸段绝不许被抹掉** —— 不同尺寸是不同的字节', () => {
    // 这是这条规则唯一会造成静默数据丢失的方向。实测舞台剧的列表页缩略图与详情页
    // 封面就只差这一段（small ↔ m），把它抹掉等于说「这两张是同一张」。
    const small = coverUrlKey('https://img1.doubanio.com/pview/drama_subject_poster/small/public/x.jpg');
    const m = coverUrlKey('https://img1.doubanio.com/pview/drama_subject_poster/m/public/x.jpg');
    assert.notEqual(small, m);
  });

  test('图片 id 变了，key 就得变 —— 换海报仍然要能被看见', () => {
    assert.notEqual(
      coverUrlKey('https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp'),
      coverUrlKey('https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2909217327.webp'),
    );
  });

  test('没量过的形状一律原样不动', () => {
    // 「不要把图片主机当成闭集」是 CLAUDE.md 的明令，来源是抽取器真的漏抓过一批。
    // qnmob3 是**档案里真的有的**（实测 4 次），它不在那一族里，所以不动。
    for (const u of [
      'https://qnmob3.doubanio.com/view/photo/m/public/p3.jpg',
      'https://imgx.doubanio.com/x.jpg',
      'https://img1.example.com/x.jpg',
      'https://www.douban.com/x.jpg',
      '//img1.doubanio.com/x.jpg',
    ]) {
      assert.equal(coverUrlKey(u), u, `${u} 不该被动`);
    }
  });

  test('只动主机那一段，路径里长得像的东西不许被殃及', () => {
    // 路径里也可能出现 `img1.doubanio.com` 那样的字样（比如某个重定向参数）。
    const u = 'https://img1.doubanio.com/view/photo/public/img1.doubanio.com.jpg';
    assert.equal(coverUrlKey(u), 'https://img.doubanio.com/view/photo/public/img1.doubanio.com.jpg');
  });

  test('http 与 https 分开，null 还是 null', () => {
    assert.equal(coverUrlKey('http://img1.doubanio.com/a.jpg'), 'http://img.doubanio.com/a.jpg');
    assert.notEqual(coverUrlKey('http://img1.doubanio.com/a.jpg'), coverUrlKey('https://img1.doubanio.com/a.jpg'));
    assert.equal(coverUrlKey(null), null);
    assert.equal(coverUrlKey(undefined), null);
  });

  test('规则带版本号 —— 将来换规则时，存量要能说清是按哪套算的', () => {
    // 照 bundle 的 url_key_rules。**不写进 canonical**：那边每条修订都带
    // parser_version，而解析器只有一个，版本号已经唯一确定了这套规则；
    // bundle 那边需要单独一个字段，是因为 bundle 冻结、且可能有别的生产者。
    assert.match(COVER_URL_KEY_RULES, /^doubanio-shard\/\d+$/);
  });
});
