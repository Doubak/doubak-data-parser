import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractAlbumList,
  extractAlbumDetail,
  mergeAlbumPages,
} from '../src/extract-album.js';

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
});
