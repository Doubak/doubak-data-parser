/**
 * 真实档案在哪。
 *
 * 这个仓库里有一批**对着真实档案跑**的测试，而真实档案是私人数据，不进仓库、
 * 也不进 CI，所以它们在别处会「带原因跳过」。这一份的存在只为一件事：
 * **路径只写一处。**
 *
 * 起因是路径烂过一次，而且是无声的。档案本来在 `~/downloads/20260806`，后来
 * 归拢进 `~/downloads/exports/`，四处写死的字面量就此全部指空——于是那批测试
 * 从「跳过」变成了**永远跳过**，`npm test` 照样全绿，而这个项目里几乎每一个
 * 真 bug 都是这批测试发现的（「不是靠 review，是靠喂它没见过的数据」）。
 *
 * `DOUBAK_ARCHIVE_DIR` 可以指到别处，方便在另一台机器上跑。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一堆 bundle 的根目录。 */
export const ARCHIVE = process.env.DOUBAK_ARCHIVE_DIR ?? join(homedir(), 'downloads', 'exports');

/** 里头那份按日期归拢的旧档案集合（24 份，横跨四个格式版本）。 */
export const ARCHIVE_20260806 = join(ARCHIVE, '20260806');

/**
 * 一份 bundle 的目录。
 *
 * 先看那个按日期归拢的子目录，再看根目录——**新抓的档案是直接落在根上的**，
 * 只找子目录的话，对着新档案写的测试会「带原因跳过」，而那个原因是假的
 * （档案就在这台机器上）。这个文件本来就是为了「路径别再无声地烂掉」而存在的。
 *
 * @param {string} name bundle 目录名 @returns {string}
 */
export const realBundle = (name) => {
  const dated = join(ARCHIVE_20260806, name);
  return existsSync(dated) ? dated : join(ARCHIVE, name);
};

/** @param {string} p @returns {boolean} */
export const have = (p) => existsSync(p);

/**
 * 从真实档案里取一条捕获的正文。
 *
 * 有几条测试原来读的是 `~/downloads/` 下手工另存的一份页面，而那些散页早就
 * 没了——测试于是**永远跳过**。同一张页面本来就在档案里，冻着，跑不掉；
 * 从档案里读还顺带证明了「这一页确实在档案里」。
 *
 * @param {string} bundleName bundle 目录名
 * @param {string} captureId 完整的 capture_id
 * @returns {Promise<string|null>} 档案不在就是 null
 */
export async function readCapture(bundleName, captureId) {
  const dir = realBundle(bundleName);
  if (!existsSync(dir)) return null;
  const { openAll } = await import('../src/bundle-source.js');
  for (const s of openAll(dir)) {
    const row = s.index.find((r) => r.capture_id === captureId);
    if (!row) { s.close(); continue; }
    const body = await s.payload(row);
    s.close();
    return body;
  }
  return null;
}
