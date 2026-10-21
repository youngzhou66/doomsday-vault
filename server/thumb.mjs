/**
 * 封面截帧：TMDB 没有封面的片子，从视频里抓一帧当封面。
 *
 * 两条路径：
 *   1. 服务端 ffmpeg（任意编码都能解，推荐）；
 *   2. 浏览器 canvas 截帧（前端把 dataURL 传上来），适合没装 ffmpeg 但浏览器能解码的 MP4。
 *
 * 自定义封面存在 data/cache/posters/ 下，优先级高于本地图与 TMDB 海报。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureDir, pathExists, statSafe, writeFileAtomic } from './fsx.mjs';
import { grabShellThumbnail, jpegSize } from './osthumb.mjs';
import { projectToolsDir } from './probe.mjs';

const VERSION_TIMEOUT_MS = 6000;
const CAPTURE_TIMEOUT_MS = 60000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/** 常见安装位置（Windows）。 */
function windowsCandidates() {
  const out = [];
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const userProfile = process.env['USERPROFILE'] ?? '';
  // 优先项目内便携版，卸载时删目录即可
  out.push(
    path.join(projectToolsDir(), 'ffmpeg.exe'),
    path.join(projectToolsDir(), 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  );
  if (localAppData) out.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
  if (userProfile) out.push(path.join(userProfile, 'scoop', 'shims', 'ffmpeg.exe'));
  return out;
}

function runProcess(bin, args, { timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('ffmpeg 执行超时'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`找不到可执行文件：${bin}`) : err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg 退出码 ${code}${stderr.trim() ? `：${stderr.trim().split('\n').at(-1)}` : ''}`));
    });
  });
}

/**
 * 探测 ffmpeg 是否可用。
 * @param {string} configured 配置里的路径（命令名或绝对路径）
 */
export async function detectFfmpeg(configured = 'ffmpeg') {
  const list = [];
  if (configured) list.push(configured);
  list.push('ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (process.platform === 'win32') list.push(...windowsCandidates());

  const tried = [];
  let lastError = null;
  for (const candidate of list) {
    if (!candidate || tried.includes(candidate)) continue;
    tried.push(candidate);
    if (path.isAbsolute(candidate) && !(await pathExists(candidate))) continue;
    try {
      const { stdout } = await runProcess(candidate, ['-version'], { timeoutMs: VERSION_TIMEOUT_MS });
      const firstLine = stdout.split('\n')[0]?.trim() || 'ffmpeg';
      return { ok: true, path: candidate, version: firstLine, error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    path: null,
    version: null,
    error: `未找到 ffmpeg（${lastError?.message ?? '未知原因'}）。安装 FFmpeg 后可在设置里填绝对路径，或改用浏览器截帧。`,
  };
}

function isImageBuffer(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e;
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return jpeg || png || webp;
}

export class Thumbnailer {
  /**
   * @param {{
   *   dataDir: string,
   *   getConfig: () => any,
   *   run?: Function,
   *   detect?: Function,
   *   shell?: Function,
   * }} options run/detect/shell 可注入，便于测试
   */
  constructor({ dataDir, getConfig, run = runProcess, detect = detectFfmpeg, shell = grabShellThumbnail }) {
    this.dataDir = dataDir;
    this.getConfig = getConfig;
    this.run = run;
    this.detect = detect;
    this.grabShell = shell;
    this.posterDir = path.join(dataDir, 'cache', 'posters');
    this.state = { ok: false, path: null, version: null, error: '尚未检测', checkedAt: null };
  }

  get config() {
    return this.getConfig();
  }

  get width() {
    const value = Number(this.config.thumb?.width);
    return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 120), 2000) : 500;
  }

  get offsetPercent() {
    const value = Number(this.config.thumb?.offsetPercent);
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 95) : 20;
  }

  /** 探测并缓存 ffmpeg 状态。 */
  async refresh({ force = false } = {}) {
    if (!force && this.state.checkedAt && Date.now() - this.state.checkedAt < 60000) return this.state;
    const configured = String(this.config.thumb?.ffmpegPath ?? this.config.ffprobePath ?? 'ffmpeg');
    this.state = { ...(await this.detect(configured)), checkedAt: Date.now() };
    return this.state;
  }

  /** 自定义封面文件（按记录 id 命名，扩展名随来源格式）。 */
  customFile(movieId, ext = '.jpg') {
    return path.join(this.posterDir, `custom-${movieId}${ext}`);
  }

  /** 找到某个记录的自定义封面（不依赖记录里的扩展名，直接扫目录）。 */
  async findCustom(movieId) {
    for (const ext of ALLOWED_UPLOAD_TYPES.values()) {
      const file = this.customFile(movieId, ext);
      if (await pathExists(file)) return file;
    }
    return null;
  }

  /**
   * 用 ffmpeg 从视频里截一帧。
   * @param {{path: string, probe?: object}} movie
   * @param {{atSec?: number, percent?: number}} [options]
   */
  async captureFromVideo(movie, { atSec = null, percent = null } = {}) {
    const state = await this.refresh();
    if (!state.ok) {
      const error = new Error(state.error);
      error.code = 'FFMPEG_UNAVAILABLE';
      throw error;
    }

    const duration = Number(movie?.probe?.durationSec) || 0;
    const ratio = percent === null ? this.offsetPercent : Math.min(Math.max(Number(percent) || 0, 0), 95);
    const target = atSec !== null
      ? Math.max(Number(atSec) || 0, 0)
      : Math.max(Math.round((duration * ratio) / 100), 1);

    await ensureDir(this.posterDir);
    const out = this.customFile(movie.id, '.jpg');
    const baseArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(target),
      '-i', movie.path,
      '-frames:v', '1',
      '-vf', `scale=${this.width}:-2`,
      '-q:v', '3',
      '-y', out,
    ];

    try {
      await this.run(state.path, baseArgs, { timeoutMs: CAPTURE_TIMEOUT_MS });
    } catch (err) {
      // 有些文件是「只有封面图没有视频流」或首帧定位失败，换一种映射再试一次
      const fallbackArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-i', movie.path,
        '-map', '0:v:0',
        '-frames:v', '1',
        '-vf', `scale=${this.width}:-2`,
        '-q:v', '3',
        '-y', out,
      ];
      try {
        await this.run(state.path, fallbackArgs, { timeoutMs: CAPTURE_TIMEOUT_MS });
      } catch {
        throw new Error(`截帧失败：${err.message}`);
      }
    }

    const stat = await statSafe(out);
    if (!stat?.isFile() || stat.size < 256) throw new Error('截帧失败：没有生成有效图片');
    const buffer = await fs.readFile(out);
    if (!isImageBuffer(buffer)) throw new Error('截帧失败：输出不是图片');
    const dims = jpegSize(buffer);

    return {
      file: path.basename(out),
      atSec: target,
      width: dims?.width ?? this.width,
      height: dims?.height ?? null,
      source: 'ffmpeg',
      bytes: stat.size,
    };
  }

  /**
   * 保存浏览器 canvas 截帧（dataURL）。
   * @param {string} movieId
   * @param {string} dataUrl data:image/jpeg;base64,...
   */
  async saveDataUrl(movieId, dataUrl) {
    const match = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''));
    if (!match) throw new Error('图片数据格式不正确');
    const [, mime, base64] = match;
    const ext = ALLOWED_UPLOAD_TYPES.get(mime.toLowerCase());
    if (!ext) throw new Error('只接受 JPEG / PNG / WebP 图片');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw new Error('图片内容为空');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('图片超过 8MB');
    if (!isImageBuffer(buffer)) throw new Error('图片内容无法识别');

    await ensureDir(this.posterDir);
    const out = this.customFile(movieId, ext);
    await writeFileAtomic(out, buffer);
    await this.pruneOtherExtensions(movieId, ext);
    return { file: path.basename(out), source: 'browser', bytes: buffer.length };
  }

  /** 同一条记录只保留一张自定义封面。 */
  async pruneOtherExtensions(movieId, keepExt) {
    for (const ext of ALLOWED_UPLOAD_TYPES.values()) {
      if (ext === keepExt) continue;
      await fs.rm(this.customFile(movieId, ext), { force: true }).catch(() => {});
    }
  }

  /**
   * 向操作系统要缩略图（资源管理器里看到的那张）。
   * 依赖系统解码器：MKV/HEVC 在没装解码器的 Windows 上会失败，属正常。
   * @returns {Promise<null|{file: string, source: string, width: number|null, height: number|null, bytes: number}>}
   */
  async captureFromShell(movie, { size = null } = {}) {
    const shot = await this.grabShell(movie.path, {
      size: size ?? this.width,
      workDir: path.join(this.dataDir, 'cache', 'tmp'),
    });
    if (!shot?.buffer?.length) return null;

    const ext = shot.buffer[0] === 0x89 ? '.png' : '.jpg';
    await ensureDir(this.posterDir);
    const out = this.customFile(movie.id, ext);
    await writeFileAtomic(out, shot.buffer);
    await this.pruneOtherExtensions(movie.id, ext);
    return {
      file: path.basename(out),
      source: 'shell',
      via: shot.via,
      width: shot.width ?? null,
      height: shot.height ?? null,
      bytes: shot.buffer.length,
    };
  }

  /**
   * 自动选路：系统缩略图 → ffmpeg 截帧。
   * 两条都不行时抛 NO_FRAME_SOURCE，前端会提示可以改用浏览器截帧。
   * @param {{id: string, path: string, probe?: object}} movie
   * @param {{mode?: 'auto'|'shell'|'ffmpeg', atSec?: number|null, percent?: number|null}} [options]
   */
  async capture(movie, { mode = 'auto', atSec = null, percent = null } = {}) {
    const attempts = [];
    if (mode === 'auto' || mode === 'shell') {
      const shot = await this.captureFromShell(movie);
      if (shot) return shot;
      attempts.push('系统缩略图不可用');
    }
    if (mode === 'auto' || mode === 'ffmpeg') {
      const ffmpeg = await this.refresh();
      if (ffmpeg.ok) {
        try {
          return await this.captureFromVideo(movie, { atSec, percent });
        } catch (err) {
          attempts.push(err.message);
        }
      } else {
        attempts.push('未安装 ffmpeg');
      }
    }

    const error = new Error(
      `拿不到画面（${attempts.join('；')}）。`
      + '系统没有这个格式的解码器，安装 FFmpeg 后可截帧；浏览器能播放的文件也可以直接用「浏览器截帧」。',
    );
    error.code = 'NO_FRAME_SOURCE';
    throw error;
  }

  /** 删除自定义封面，回退到本地图 / TMDB。 */
  async removeCustom(movieId) {
    let removed = false;
    for (const ext of ALLOWED_UPLOAD_TYPES.values()) {
      const file = this.customFile(movieId, ext);
      if (await pathExists(file)) {
        await fs.rm(file, { force: true });
        removed = true;
      }
    }
    return removed;
  }
}

/** 默认导出：给上层直接用的临时目录工具（测试/诊断时偶尔需要）。 */
export function tempImagePath(prefix = 'dmv-thumb-') {
  return path.join(os.tmpdir(), `${prefix}${Date.now().toString(36)}.jpg`);
}
