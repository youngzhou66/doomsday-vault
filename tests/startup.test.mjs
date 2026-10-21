import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getFreePort, makeTempDir, waitFor } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'index.mjs');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.mjs');

test('重复启动：识别出已在运行的实例并以 0 退出', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-start-');
  const port = await getFreePort();
  const env = { ...process.env, MOVIE_DATA_DIR: dir, PORT: String(port) };
  const first = spawn(process.execPath, [SERVER], { env, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    first.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await cleanup();
  });

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  }, { timeout: 20000, interval: 200, label: '第一个实例启动' });

  const second = spawn(process.execPath, [SERVER], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  second.stdout.on('data', (chunk) => {
    output += chunk;
  });
  second.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => second.on('close', resolve));

  assert.equal(code, 0, `第二个实例应以 0 退出，实际 ${code}：${output}`);
  assert.match(output, /已经在运行/);
  assert.match(output, new RegExp(`127\\.0\\.0\\.1:${port}`));

  // 第一个实例仍然存活且服务正常
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.ok, true);
});

test('--port 参数可以换端口启动', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-start2-');
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER, `--port=${port}`], {
    env: { ...process.env, MOVIE_DATA_DIR: dir, PORT: '' },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await cleanup();
  });

  const health = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }, { timeout: 20000, interval: 200, label: '自定义端口启动' });

  assert.equal(health.app.name, '末日电影库');
  assert.equal(health.ok, true);
});

test('医生脚本：干净环境下体检通过', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-doctor-');
  t.after(cleanup);
  const port = await getFreePort();
  const result = spawnSync(process.execPath, [DOCTOR], {
    cwd: ROOT,
    env: { ...process.env, MOVIE_DATA_DIR: dir, PORT: String(port), TMDB_API_KEY: '' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `doctor 应以 0 退出：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /没有发现阻断启动的问题/);
  assert.match(result.stdout, /端口 \d+ 空闲/);
  assert.match(result.stdout, /数据目录可写/);
});
