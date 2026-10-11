import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractGroupJoins,
  extractGroupPublish,
  extractGroupTopic,
} from '../src/extract-group.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const GROUP_JOINS = fixture('group-joins.html');
const GROUP_JOINS_MANAGER = fixture('group-joins-manager.html');
const GROUP_PUBLISH = fixture('group-publish.html');
const GROUP_TOPIC = fixture('group-topic.html');

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
});
