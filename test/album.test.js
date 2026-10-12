import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractAlbumList,
  extractAlbumDetail,
  mergeAlbumPages,
} from '../src/extract-album.js';
import { parse } from '../src/parse.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const PHOTOS_HOME = fixture('photos-home.html');
const PHOTOS_HOME_EMPTY = fixture('photos-home-empty.html');
const PHOTOS_ALBUM = fixture('photos-album.html');

describe('个人相册列表（photo.album_list）', () => {
  test('抽取相册列表，字段完备', () => {
    const list = extractAlbumList(PHOTOS_HOME);
    assert.ok(list.length > 0);
    const first = list[0];
    assert.equal(first.id, '100276481');
    assert.equal(first.url, 'https://www.douban.com/photos/album/100276481/');
    assert.equal(first.title, '收集1000句告白可以召唤出什么？');
    assert.ok(first.desc.includes('乙女游戏截屏'));
    assert.equal(first.claimedCount, 1055);
    assert.equal(first.updatedAt, '2025-02-09');
    assert.equal(first.coverPhotoId, '2554205896');
  });

  test('空相册主页返回空数组', () => {
    const list = extractAlbumList(PHOTOS_HOME_EMPTY);
    assert.deepEqual(list, []);
  });
});

describe('相册详情与照片列表（photo.album）', () => {
  test('抽取相册详情与照片，包含全尺寸大图与说明', () => {
    const album = extractAlbumDetail(PHOTOS_ALBUM, 'https://www.douban.com/photos/album/100276481/');
    assert.ok(album);
    assert.equal(album.id, '100276481');
    assert.equal(album.title, '收集1000句告白可以召唤出什么？');
    assert.ok(album.desc.includes('乙女游戏截屏'));
    assert.equal(album.claimedCount, 1055);
    assert.equal(album.updatedAt, '2025-02-09 23:23:44');
    assert.equal(album.privacy, 'public');

    assert.ok(album.photos.length > 0);
    const p0 = album.photos[0];
    assert.equal(p0.id, '2918226736');
    assert.equal(p0.url, 'https://www.douban.com/photos/photo/2918226736/');
    assert.equal(p0.thumbnail_url, 'https://img9.doubanio.com/view/photo/m/public/p2918226736.webp');
    assert.equal(p0.image_url, 'https://img9.doubanio.com/view/photo/large/public/p2918226736.webp');
    assert.equal(p0.caption, '虔诚之花的晚钟-Dante');

    // title 属性未截断
    const p3 = album.photos[3];
    assert.equal(p3.id, '2918226739');
    assert.equal(p3.caption, '虔诚之花的晚钟-Dante【官配的求婚太标准了wwww');
  });

  test('多页相册拼接按顺序排列并赋予序号 seq', () => {
    const page1 = {
      start: 0,
      album: {
        id: '100276481',
        title: '相册测试',
        photos: [
          { id: '1', url: 'u1', image_url: 'i1', thumbnail_url: 't1', caption: 'c1', seq: null },
          { id: '2', url: 'u2', image_url: 'i2', thumbnail_url: 't2', caption: 'c2', seq: null },
        ],
      },
      observation: { capture_ids: ['cap1'] },
    };
    const page2 = {
      start: 18,
      album: {
        id: '100276481',
        title: '相册测试',
        photos: [
          { id: '3', url: 'u3', image_url: 'i3', thumbnail_url: 't3', caption: 'c3', seq: null },
        ],
      },
      observation: { capture_ids: ['cap2'] },
    };

    const merged = mergeAlbumPages([page2, page1]);
    assert.ok(merged);
    assert.equal(merged.album.photos.length, 3);
    assert.deepEqual(merged.album.photos.map((p) => p.id), ['1', '2', '3']);
    assert.deepEqual(merged.album.photos.map((p) => p.seq), [0, 1, 2]);
  });

  test('mergeAlbumPages: 真实页面结合后续分页合并，验证乱序输入、照片去重与连续序号 seq', () => {
    const realDetail = extractAlbumDetail(PHOTOS_ALBUM, 'https://www.douban.com/photos/album/100276481/');
    assert.equal(realDetail.photos.length, 18);

    const page1 = {
      start: 0,
      album: realDetail,
      observation: { capture_ids: ['cap-alb-1'] },
    };

    // 构造第二页：包含 1 个重复照片（已在第一页出现）与 2 个全新照片
    const page2 = {
      start: 18,
      album: {
        id: '100276481',
        title: realDetail.title,
        desc: realDetail.desc,
        claimedCount: 1055,
        updatedAt: realDetail.updatedAt,
        privacy: 'public',
        photos: [
          { ...realDetail.photos[0] }, // 重复项
          { id: '30000001', url: 'https://www.douban.com/photos/photo/30000001/', image_url: 'https://img.doubanio.com/large/30000001.jpg', thumbnail_url: 'https://img.doubanio.com/m/30000001.jpg', caption: '新增照片 1', seq: null },
          { id: '30000002', url: 'https://www.douban.com/photos/photo/30000002/', image_url: 'https://img.doubanio.com/large/30000002.jpg', thumbnail_url: 'https://img.doubanio.com/m/30000002.jpg', caption: '新增照片 2', seq: null },
        ],
      },
      observation: { capture_ids: ['cap-alb-2'] },
    };

    // 故意以逆序 [page2, page1] 传入，验证内部按 start 排序
    const merged = mergeAlbumPages([page2, page1]);
    assert.ok(merged);
    assert.equal(merged.album.id, '100276481');
    assert.equal(merged.album.claimedCount, 1055);
    // 18 原有 + 2 新增（1 重复被去重）= 20
    assert.equal(merged.album.photos.length, 20);
    assert.equal(merged.album.photos[0].id, realDetail.photos[0].id);
    assert.equal(merged.album.photos[18].id, '30000001');
    assert.equal(merged.album.photos[19].id, '30000002');
    // seq 必须连续且从 0 开始
    assert.deepEqual(merged.album.photos.map((p) => p.seq), Array.from({ length: 20 }, (_, i) => i));
  });

  test('parse() 端到端解析多页相册：同一相册多次翻页捕获正确归并为单一规范记录', async () => {
    const row1 = {
      capture_id: 'cap-p1',
      route_key: 'photo.album',
      intent: 'photo.album',
      url: 'https://www.douban.com/photos/album/100276481/?m_start=0',
      verdict: 'ok',
      surface: 'html',
    };
    const row2 = {
      capture_id: 'cap-p2',
      route_key: 'photo.album',
      intent: 'photo.album',
      url: 'https://www.douban.com/photos/album/100276481/?m_start=18',
      verdict: 'ok',
      surface: 'html',
    };

    // 为第二页构造两张新照片的 HTML
    const page2Html = PHOTOS_ALBUM
      .replace('2918226736', '30000001')
      .replace('2918226737', '30000002');

    const fakeSource = {
      status: 'complete',
      manifest: null,
      bundleId: 'bundle-album-multipage',
      index: [row1, row2],
      crawlState: new Map(),
      coverage: new Map(),
      payload: async (r) => (r.capture_id === 'cap-p1' ? PHOTOS_ALBUM : page2Html),
      close: () => {},
    };

    const result = await parse([fakeSource]);
    assert.equal(result.albums.length, 1);

    const alb = result.albums[0];
    assert.equal(alb.upstream_id, '100276481');
    assert.equal(alb.revisions.length, 1);

    const rev = alb.revisions[0];
    assert.equal(rev.fields.title, '收集1000句告白可以召唤出什么？');
    assert.equal(rev.fields.claimed_count, 1055);
    // 第一页 18 张 + 第二页替换出的 2 张新照片（其余 16 张与第一页 ID 重复）= 20 张
    assert.equal(rev.fields.photos.length, 20);
    assert.deepEqual(rev.fields.photos.map((p) => p.seq), Array.from({ length: 20 }, (_, i) => i));

    // observations[0].capture_ids 完整记录两页的捕获 ID
    assert.deepEqual(rev.observations[0].capture_ids.sort(), ['cap-p1', 'cap-p2']);
  });
});
