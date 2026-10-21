import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';

import { sanitizeConfig } from '../server/config.mjs';
import { Thumbnailer } from '../server/thumb.mjs';
import { isSuspiciousAddress } from '../server/net.mjs';
import { jpegSize, resolveStrategy, shellThumbnailSupported } from '../server/osthumb.mjs';
import { makeTempDir, writeFakeVideo } from './helpers.mjs';

/** 构造一张最小可解析的 JPEG（带 SOF0，含宽高；尾部补足到 400+ 字节）。 */
function tinyJpeg(width = 500, height = 281) {
  return Buffer.concat([
    Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]),
    // 模拟扫描数据（实际解析只看 SOF，这里只是为了满足最小体积校验）
    Buffer.alloc(400, 0x20),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const config = () => sanitizeConfig({ thumb: { offsetPercent: 20, width: 500 } });

/** 假的 ffmpeg：把输出路径参数当目标文件写进去。 */
function fakeRunner({ failFirst = false, bytes = tinyJpeg() } = {}) {
  const calls = [];
  let count = 0;
  const run = async (bin, args) => {
    calls.push({ bin, args });
    count += 1;
    if (failFirst && count === 1) throw new Error('模拟定位失败');
    const out = args[args.length - 1];
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, bytes);
    return { stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('jpegSize 能读出宽高', () => {
  assert.deepEqual(jpegSize(tinyJpeg(500, 281)), { width: 500, height: 281 });
  assert.equal(jpegSize(Buffer.from([1, 2, 3])), null);
  assert.equal(jpegSize(Buffer.alloc(0)), null);
});

test('策略优先级：系统缩略图 → ffmpeg → 浏览器', () => {
  assert.equal(resolveStrategy({ platform: 'win32', shellOk: true, ffmpegOk: true, browserOk: true }), 'shell');
  assert.equal(resolveStrategy({ platform: 'win32', shellOk: false, ffmpegOk: true, browserOk: true }), 'ffmpeg');
  assert.equal(resolveStrategy({ platform: 'win32', shellOk: false, ffmpegOk: false, browserOk: true }), 'browser');
  assert.equal(resolveStrategy({ platform: 'win32', shellOk: false, ffmpegOk: false, browserOk: false }), null);
  // 非支持平台即使 shellOk 也跳过
  assert.equal(resolveStrategy({ platform: 'aix', shellOk: true, ffmpegOk: false, browserOk: true }), 'browser');
  assert.equal(shellThumbnailSupported('win32'), true);
  assert.equal(shellThumbnailSupported('darwin'), true);
  assert.equal(shellThumbnailSupported('aix'), false);
});

test('ffmpeg 截帧：按百分比取帧并写入自定义封面', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-');
  t.after(cleanup);
  const video = path.join(dir, 'media', 'movie.mkv');
  await writeFakeVideo(video, 4096, 3);

  const runner = fakeRunner();
  const thumbnailer = new Thumbnailer({
    dataDir: dir,
    getConfig: config,
    run: runner.run,
    detect: async () => ({ ok: true, path: 'ffmpeg', version: 'ffmpeg 9.9', error: null }),
    shell: async () => null,
  });

  const result = await thumbnailer.captureFromVideo({ id: 'm_test', path: video, probe: { durationSec: 3600 } });
  assert.equal(result.source, 'ffmpeg');
  assert.equal(result.atSec, 720, '3600 秒的 20% 应为 720 秒');
  assert.equal(result.width, 500);
  assert.equal(result.height, 281, '高度应从截出的 JPEG 头里解析');

  const seekArg = runner.calls[0].args[runner.calls[0].args.indexOf('-ss') + 1];
  assert.equal(seekArg, '720');
  assert.ok(runner.calls[0].args.includes('scale=500:-2'));

  const file = thumbnailer.customFile('m_test', '.jpg');
  const stat = await fs.stat(file);
  assert.ok(stat.size > 0);
});

test('ffmpeg 截帧：首次失败时用 -map 0:v:0 重试一次', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-retry-');
  t.after(cleanup);
  const video = path.join(dir, 'movie.mkv');
  await writeFakeVideo(video, 2048, 4);
  const runner = fakeRunner({ failFirst: true });
  const thumbnailer = new Thumbnailer({
    dataDir: dir,
    getConfig: config,
    run: runner.run,
    detect: async () => ({ ok: true, path: 'ffmpeg', version: 'x', error: null }),
    shell: async () => null,
  });

  const result = await thumbnailer.captureFromVideo({ id: 'm_retry', path: video, probe: { durationSec: 1000 } });
  assert.equal(result.source, 'ffmpeg');
  assert.equal(runner.calls.length, 2);
  assert.ok(runner.calls[1].args.includes('-map'));
});

test('ffmpeg 不可用时给出 FFMPEG_UNAVAILABLE', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-nofe-');
  t.after(cleanup);
  const video = path.join(dir, 'movie.mkv');
  await writeFakeVideo(video, 1024, 5);
  const thumbnailer = new Thumbnailer({
    dataDir: dir,
    getConfig: config,
    detect: async () => ({ ok: false, path: null, version: null, error: '未找到 ffmpeg' }),
    shell: async () => null,
  });
  await assert.rejects(
    () => thumbnailer.captureFromVideo({ id: 'm_x', path: video }),
    (err) => err.code === 'FFMPEG_UNAVAILABLE',
  );
});

test('系统缩略图拿不到、ffmpeg 也没有时抛 NO_FRAME_SOURCE', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-none-');
  t.after(cleanup);
  const video = path.join(dir, 'movie.mkv');
  await writeFakeVideo(video, 1024, 6);
  const thumbnailer = new Thumbnailer({
    dataDir: dir,
    getConfig: config,
    detect: async () => ({ ok: false, path: null, version: null, error: '未找到 ffmpeg' }),
    shell: async () => null,
  });
  await assert.rejects(
    () => thumbnailer.capture({ id: 'm_y', path: video }),
    (err) => err.code === 'NO_FRAME_SOURCE' && /未安装 ffmpeg/.test(err.message),
  );
});

test('系统缩略图可用时优先于 ffmpeg', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-shell-');
  t.after(cleanup);
  const video = path.join(dir, 'movie.mp4');
  await writeFakeVideo(video, 1024, 7);
  let ffmpegCalls = 0;
  const thumbnailer = new Thumbnailer({
    dataDir: dir,
    getConfig: config,
    run: async () => {
      ffmpegCalls += 1;
      throw new Error('不应该走到 ffmpeg');
    },
    detect: async () => ({ ok: true, path: 'ffmpeg', version: 'x', error: null }),
    shell: async () => ({ buffer: tinyJpeg(320, 180), width: 320, height: 180, via: 'shell' }),
  });
  const result = await thumbnailer.capture({ id: 'm_shell', path: video });
  assert.equal(result.source, 'shell');
  assert.equal(result.width, 320);
  assert.equal(ffmpegCalls, 0, '有系统缩略图就不该调用 ffmpeg');
  assert.ok((await fs.stat(thumbnailer.customFile('m_shell', '.jpg'))).size > 0);
});

test('浏览器截帧上传：校验格式并清理旧扩展名', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-upload-');
  t.after(cleanup);
  const thumbnailer = new Thumbnailer({ dataDir: dir, getConfig: config });
  const dataUrl = `data:image/jpeg;base64,${tinyJpeg(640, 360).toString('base64')}`;
  const result = await thumbnailer.saveDataUrl('m_upload', dataUrl);
  assert.equal(result.source, 'browser');
  assert.match(result.file, /\.jpg$/);

  const pngUrl = `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`;
  await assert.rejects(() => thumbnailer.saveDataUrl('m_upload', pngUrl), /无法识别/);
  await assert.rejects(() => thumbnailer.saveDataUrl('m_upload', 'data:text/plain;base64,aGk='), /只接受/);
  await assert.rejects(() => thumbnailer.saveDataUrl('m_upload', 'not-a-data-url'), /格式不正确/);
});

test('取消自定义封面会删掉文件', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-thumb-remove-');
  t.after(cleanup);
  const thumbnailer = new Thumbnailer({ dataDir: dir, getConfig: config });
  const dataUrl = `data:image/jpeg;base64,${tinyJpeg(300, 200).toString('base64')}`;
  await thumbnailer.saveDataUrl('m_remove', dataUrl);
  assert.ok(await thumbnailer.findCustom('m_remove'));
  assert.equal(await thumbnailer.removeCustom('m_remove'), true);
  assert.equal(await thumbnailer.findCustom('m_remove'), null);
  assert.equal(await thumbnailer.removeCustom('m_remove'), false);
});

test('配置里的截帧参数被钳制在合理范围', () => {
  const wide = sanitizeConfig({ thumb: { width: 99999, offsetPercent: 200 } });
  assert.equal(wide.thumb.width, 2000);
  assert.equal(wide.thumb.offsetPercent, 95);
  const narrow = sanitizeConfig({ thumb: { width: 1, offsetPercent: -5 } });
  assert.equal(narrow.thumb.width, 120);
  assert.equal(narrow.thumb.offsetPercent, 0);
});

// 保持与 net.test 相同的污染地址判定（避免测试文件之间重复实现走样）
test('（回归）污染地址判定仍然有效', () => {
  assert.equal(isSuspiciousAddress('104.244.46.93'), true);
});
