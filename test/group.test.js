import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractGroupJoins,
  extractGroupPublish,
  extractGroupTopic,
} from '../src/extract-group.js';
import { parse } from '../src/parse.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const GROUP_JOINS = fixture('group-joins.html');
const GROUP_JOINS_MANAGER = fixture('group-joins-manager.html');
const GROUP_PUBLISH = fixture('group-publish.html');
const GROUP_PUBLISH_PAGINATED = fixture('group-publish-paginated.html');
const GROUP_TOPIC = fixture('group-topic.html');
const GROUP_TOPIC_WITH_IMAGE = fixture('group-topic-with-image.html');

describe('加入的小组（group.joins）', () => {
  test('普通用户：抽取 114 个小组，无重复，字段完备', () => {
    const list = extractGroupJoins(GROUP_JOINS);
    assert.equal(list.length, 114);
    assert.equal(new Set(list.map((g) => g.id)).size, 114);

    const first = list[0];
    assert.equal(first.id, '623999');
    assert.equal(first.url, 'https://www.douban.com/group/623999/');
    assert.equal(first.name, '来自ASMR');
    assert.equal(first.role, 'member');
    assert.equal(first.member_count, 889);
    assert.ok(first.icon_url.includes('8d6bae0415a4737'));
  });

  test('管理与普通权限区分：正确识别 manager 与 member 角色', () => {
    const list = extractGroupJoins(GROUP_JOINS_MANAGER);
    assert.equal(list.length, 52);
    const managers = list.filter((g) => g.role === 'manager');
    const members = list.filter((g) => g.role === 'member');
    assert.ok(managers.length > 0);
    assert.ok(members.length > 0);
    assert.equal(managers.length + members.length, 52);
    assert.equal(managers[0].id, '676327');
  });
});

describe('发起的讨论（group.publish & group.item）', () => {
  test('讨论列表页：抽取 3 篇话题，包含标题、发布日期与所属小组', () => {
    const topics = extractGroupPublish(GROUP_PUBLISH);
    assert.equal(topics.length, 3);
    assert.deepEqual(topics.map((t) => t.id), ['258053730', '254900406', '110871731']);

    const first = topics[0];
    assert.equal(first.title, '请问有番外6集的字幕嘛，找到了无字幕版但是有点啃不动');
    assert.equal(first.published_at, '2022-01-16');
    assert.equal(first.group_id, '722855');
    assert.equal(first.group_name, '短剧开始啦');
    assert.equal(first.group_url, 'https://www.douban.com/group/722855/');
  });

  test('话题详情页：抽取全文正文、发布时间、所属小组与内嵌图片', () => {
    const topic = extractGroupTopic(GROUP_TOPIC, 'https://www.douban.com/group/topic/258053730/');
    assert.ok(topic);
    assert.equal(topic.id, '258053730');
    assert.equal(topic.title, '请问有番外6集的字幕嘛，找到了无字幕版但是有点啃不动');
    assert.equal(topic.published_at, '2022-01-16 17:08:37');
    assert.equal(topic.group_id, '722855');
    assert.equal(topic.group_name, '短剧开始啦');
    assert.ok(topic.body.includes('RT'));

    assert.equal(topic.images.length, 1);
    assert.equal(topic.images[0].url, 'https://img3.doubanio.com/view/group_topic/l/public/p742323977.jpg');
    assert.equal(topic.images[0].caption, '番外剧照');
  });

  test('话题详情页（含单张无图注插图）：抽取全文正文、发布时间、所属小组与内嵌图片', () => {
    const topic = extractGroupTopic(GROUP_TOPIC_WITH_IMAGE, 'https://www.douban.com/group/topic/206243320/');
    assert.ok(topic);
    assert.equal(topic.id, '206243320');
    assert.equal(topic.title, '本季最烂');
    assert.equal(topic.published_at, '2020-12-27 01:01:42');
    assert.equal(topic.group_id, '707926');
    assert.equal(topic.group_name, '成为神明之日');
    assert.equal(topic.group_url, 'https://www.douban.com/group/707926/');
    assert.ok(topic.body.includes('这大概是本季最烂的一部了'));
    assert.ok(topic.body.includes('![](https://img9.doubanio.com/view/group_topic/l/public/p379527796.jpg)'));

    assert.equal(topic.images.length, 1);
    assert.equal(topic.images[0].url, 'https://img9.doubanio.com/view/group_topic/l/public/p379527796.jpg');
    assert.equal(topic.images[0].caption, null);
  });

  test('多页讨论列表页（group-publish-paginated.html）：抽取全部 44 篇话题，字段完备', () => {
    const topics = extractGroupPublish(GROUP_PUBLISH_PAGINATED);
    assert.equal(topics.length, 44);

    const first = topics[0];
    assert.equal(first.id, '475801232');
    assert.equal(first.title, '天空给的惊喜：一朵云马');
    // 当年话题在列表页中不带年份（如 02-23），published_at 为 null
    assert.equal(first.published_at, null);
    assert.equal(first.group_id, '699356');
    assert.equal(first.group_name, '无用美学');
    assert.equal(first.group_url, 'https://www.douban.com/group/699356/');

    // 跨年历史话题带完整日期
    const withYear = topics[3];
    assert.equal(withYear.published_at, '2024-01-30');

    const last = topics[topics.length - 1];
    assert.equal(last.id, '213980953');
    assert.ok(last.title);
    assert.equal(last.published_at, '2021-03-11');
    assert.ok(last.group_id);

    assert.ok(topics.every((t) => t.id && t.title && t.group_id && t.group_name));
  });

  test('parse() 端到端解析多页发起的讨论：合并各页话题并优先采用已抓取正文', async () => {
    // 模拟多页 group.publish：第一页包含 44 个话题，第二页为 GROUP_PUBLISH（3 个话题）
    const rowPub1 = {
      capture_id: 'cap-pub-1',
      route_key: 'group.publish',
      intent: 'group.publish',
      url: 'https://www.douban.com/group/people/BlocksTower/publish?start=0',
      verdict: 'ok',
      surface: 'html',
    };
    const rowPub2 = {
      capture_id: 'cap-pub-2',
      route_key: 'group.publish',
      intent: 'group.publish',
      url: 'https://www.douban.com/group/people/BlocksTower/publish?start=50',
      verdict: 'ok',
      surface: 'html',
    };
    // 话题 258053730 同时抓到了正文详情页
    const rowTopic = {
      capture_id: 'cap-topic-1',
      route_key: 'group.item',
      intent: 'group.item',
      url: 'https://www.douban.com/group/topic/258053730/',
      verdict: 'ok',
      surface: 'html',
    };

    const payloads = {
      'cap-pub-1': GROUP_PUBLISH_PAGINATED,
      'cap-pub-2': GROUP_PUBLISH,
      'cap-topic-1': GROUP_TOPIC,
    };

    const fakeSource = {
      status: 'complete',
      manifest: null,
      bundleId: 'bundle-group-multipage',
      index: [rowPub1, rowPub2, rowTopic],
      crawlState: new Map(),
      coverage: new Map(),
      payload: async (r) => payloads[r.capture_id] ?? '',
      close: () => {},
    };

    const result = await parse([fakeSource]);
    // 44 (来自 page1) + 2 (page2 中除 258053730 外的 2 篇未抓正文话题) + 1 (258053730 抓了正文) = 47 篇
    assert.equal(result.groupTopics.length, 47);

    // 抓了详情页的话题含有正文与图片
    const detailed = result.groupTopics.find((t) => t.upstream_id === '258053730');
    assert.ok(detailed);
    assert.ok(detailed.revisions[0].fields.body.includes('RT'));
    assert.equal(detailed.revisions[0].fields.images.length, 1);

    // 未抓详情页的话题仅有列表信息，正文为 null
    const stub = result.groupTopics.find((t) => t.upstream_id === '475801232');
    assert.ok(stub);
    assert.equal(stub.revisions[0].fields.body, null);
    assert.equal(stub.revisions[0].fields.title, '天空给的惊喜：一朵云马');
  });
});
