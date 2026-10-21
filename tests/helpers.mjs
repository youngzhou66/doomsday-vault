/** 测试公用工具：临时目录、写文件、假 ffprobe 状态。 */
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 创建临时目录，返回路径与清理函数。 */
export async function makeTempDir(prefix = 'dmv-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 写一个指定大小的伪视频文件（内容可复现）。 */
export async function writeFakeVideo(file, sizeBytes = 4096, seed = 7) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const buffer = Buffer.alloc(sizeBytes);
  let value = seed;
  for (let index = 0; index < sizeBytes; index += 1) {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    buffer[index] = value & 0xff;
  }
  await fs.writeFile(file, buffer);
  return buffer;
}

/** 未安装 ffprobe 时的状态对象。 */
export const NO_FFPROBE = { ok: false, path: null, version: null, error: '测试环境无 ffprobe' };

/** 轮询直到条件成立或超时。 */
export async function waitFor(fn, { timeout = 8000, interval = 120, label = '条件' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - startedAt > timeout) throw new Error(`等待${label}超时`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * 向系统要一个当前空闲的端口。
 * 测试文件是并行跑的，固定端口段会互相撞车，所以每次现取。
 */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
