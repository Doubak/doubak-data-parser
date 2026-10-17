import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createDummyBundle(dir, bundleId, account) {
  const bdir = join(dir, bundleId);
  mkdirSync(bdir, { recursive: true });
  const manifest = {
    bundle_id: bundleId,
    manifest_version: '1.4',
    created_at: '2026-10-17T00:00:00Z',
    account,
    crawl_state: [],
    coverage: [],
  };
  writeFileSync(join(bdir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(bdir, `index-${bundleId}.ndjson`), '');
  return bdir;
}

test('CLI --account 选项与多账号分流', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'parse-cli-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const bundlesDir = join(tmp, 'bundles');
  mkdirSync(bundlesDir);
  createDummyBundle(bundlesDir, '20260801T000000Z-111111', { user_id: '100', nickname: 'Alice' });
  createDummyBundle(bundlesDir, '20260801T000000Z-222222', { user_id: '200', nickname: 'Bob' });

  // 1. 无参数混跑：应当 Fail-Fast 报错退出（code 1）
  const r1 = spawnSync(process.execPath, ['bin/parse.js', bundlesDir, join(tmp, 'out1')], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /混着 2 个账号/);

  // 2. --account 指定存在的账号：成功生成该账号
  const out2 = join(tmp, 'out2');
  const r2 = spawnSync(process.execPath, ['bin/parse.js', bundlesDir, out2, '--account', '100', '--no-verify'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r2.status, 0);
  assert.ok(existsSync(join(out2, 'marks.ndjson')));
  assert.match(r2.stdout, new RegExp(out2));

  // 3. --account 指定不存在的账号：报错退出（code 1）并列出已发现账号
  const r3 = spawnSync(process.execPath, ['bin/parse.js', bundlesDir, join(tmp, 'out3'), '--account', '999', '--no-verify'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /未在输入目录中找到账号 999/);
  assert.match(r3.stderr, /100、200/);

  // 4. --all-accounts：分流生成到子目录
  const out4 = join(tmp, 'out4');
  const r4 = spawnSync(process.execPath, ['bin/parse.js', bundlesDir, out4, '--all-accounts', '--no-verify'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r4.status, 0);
  assert.ok(existsSync(join(out4, '100', 'marks.ndjson')));
  assert.ok(existsSync(join(out4, '200', 'marks.ndjson')));
  assert.match(r4.stdout, /正在解析账号 100/);
  assert.match(r4.stdout, /正在解析账号 200/);

  // 5. 互斥参数：--account 与 --all-accounts 一起用报错（code 2）
  const r5 = spawnSync(process.execPath, ['bin/parse.js', bundlesDir, join(tmp, 'out5'), '--account', '100', '--all-accounts'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r5.status, 2);
  assert.match(r5.stderr, /不能同时使用/);
});
