/**
 * ffprobe 探测：定位二进制 + 解析输出。
 * ffprobe 只是"可选增强"：没有它时库仍可扫描、解析文件名、刮削元数据。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from './fsx.mjs';

const VERSION_TIMEOUT_MS = 6000;
const PROBE_TIMEOUT_MS = 45000;

/** 跑一个子进程并收集输出。 */
function run(bin, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
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
      reject(new Error(`ffprobe 超时（${Math.round(timeout / 1000)}s）：${path.basename(args.at(-1) ?? '')}`));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
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
      else reject(new Error(`ffprobe 退出码 ${code}${stderr.trim() ? `：${stderr.trim().split('\n').at(-1)}` : ''}`));
    });
  });
}

/** 项目自带的便携版目录（tools/ffmpeg）。 */
export function projectToolsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'ffmpeg');
}

function windowsCandidates() {
  const out = [];
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const userProfile = process.env['USERPROFILE'] ?? '';
  // 优先项目内便携版，卸载时删目录即可
  out.push(
    path.join(projectToolsDir(), 'ffprobe.exe'),
    path.join(projectToolsDir(), 'bin', 'ffprobe.exe'),
    'C:\\ffmpeg\\bin\\ffprobe.exe',
    path.join(programFiles, 'ffmpeg', 'bin', 'ffprobe.exe'),
    path.join(programFilesX86, 'ffmpeg', 'bin', 'ffprobe.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe',
  );
  if (localAppData) {
    out.push(
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe'),
      path.join(localAppData, 'Programs', 'ffmpeg', 'bin', 'ffprobe.exe'),
    );
  }
  if (userProfile) {
    out.push(
      path.join(userProfile, 'scoop', 'shims', 'ffprobe.exe'),
      path.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe'),
    );
  }
  return out;
}

function unixCandidates() {
  return ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/snap/bin/ffprobe'];
}

/**
 * 探测可用的 ffprobe。
 * @param {string} configured 配置里的路径（可以是命令名或绝对路径）
 * @returns {Promise<{ok: boolean, path: string|null, version: string|null, error: string|null, candidates: string[]}>}
 */
export async function detectFfprobe(configured = 'ffprobe') {
  const list = [];
  if (configured) list.push(configured);
  list.push('ffprobe', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (process.platform === 'win32') list.push(...windowsCandidates());
  else list.push(...unixCandidates());

  const tried = [];
  let lastError = null;
  for (const candidate of list) {
    if (!candidate || tried.includes(candidate)) continue;
    tried.push(candidate);
    // 绝对路径先看文件是否存在，省一次 spawn 失败
    if (path.isAbsolute(candidate) && !(await pathExists(candidate))) continue;
    try {
      const { stdout } = await run(candidate, ['-version'], { timeout: VERSION_TIMEOUT_MS });
      const firstLine = stdout.split('\n')[0]?.trim() || 'ffprobe';
      return { ok: true, path: candidate, version: firstLine, error: null, candidates: tried };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    path: null,
    version: null,
    error: `未找到 ffprobe（${lastError?.message ?? '未知原因'}）。可安装 FFmpeg 或在上方「ffprobe 路径」填入绝对路径。`,
    candidates: tried,
  };
}

function parseRate(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const [num, den] = rate.split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) {
    return Math.round((num / den) * 1000) / 1000;
  }
  const value = Number(rate);
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function detectHdr(stream) {
  const sideData = Array.isArray(stream?.side_data_list) ? stream.side_data_list : [];
  const sideTypes = sideData.map((item) => String(item?.side_data_type ?? '')).join(' ');
  if (/dovi|dolby vision/i.test(sideTypes) || /dvhe|dav1/i.test(stream?.codec_tag_string ?? '')) return 'Dolby Vision';
  if (/hdr10\+/i.test(sideTypes)) return 'HDR10+';
  const transfer = String(stream?.color_transfer ?? '').toLowerCase();
  if (transfer === 'smpte2084') return 'HDR10';
  if (transfer === 'arib-std-b67') return 'HLG';
  return null;
}

function detectBitDepth(stream) {
  const raw = Number(stream?.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const pixFmt = String(stream?.pix_fmt ?? '');
  const match = pixFmt.match(/p(\d{1,2})(?:le|be)?$/);
  if (match) return Number(match[1]);
  if (/10/.test(pixFmt)) return 10;
  if (/12/.test(pixFmt)) return 12;
  return null;
}

/** ffprobe JSON -> 精简结构。 */
export function normalizeProbe(json) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const format = json?.format ?? {};
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const video = videoStreams.find((s) => s.disposition?.attached_pic !== 1) ?? videoStreams[0] ?? null;
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle');

  const durationSec =
    Number(format.duration) ||
    Number(video?.duration) ||
    Number(audio[0]?.duration) ||
    0;

  return {
    container: String(format.format_name ?? '').split(',')[0] || null,
    durationSec: Math.round(durationSec * 1000) / 1000,
    bitrate: Number(format.bit_rate) || null,
    sizeBytes: Number(format.size) || null,
    chapterCount: Array.isArray(json?.chapters) ? json.chapters.length : 0,
    video: video
      ? {
          codec: String(video.codec_name ?? '').toUpperCase() || null,
          profile: video.profile ?? null,
          width: Number(video.width) || null,
          height: Number(video.height) || null,
          fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
          bitDepth: detectBitDepth(video),
          pixFmt: video.pix_fmt ?? null,
          hdr: detectHdr(video),
          durationSec: Number(video.duration) || null,
        }
      : null,
    audio: audio.map((stream, index) => ({
      index: Number(stream.index ?? index),
      codec: String(stream.codec_name ?? '').toUpperCase() || null,
      channels: Number(stream.channels) || null,
      channelLayout: stream.channel_layout ?? null,
      bitrate: Number(stream.bit_rate) || null,
      sampleRate: Number(stream.sample_rate) || null,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      default: stream.disposition?.default === 1,
    })),
    subtitles: subtitles.map((stream, index) => ({
      index: Number(stream.index ?? index),
      codec: String(stream.codec_name ?? '').toUpperCase() || null,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      forced: stream.disposition?.forced === 1,
      default: stream.disposition?.default === 1,
    })),
    probedAt: new Date().toISOString(),
  };
}

/**
 * 探测单个文件。
 * @param {string} bin ffprobe 路径
 * @param {string} file 视频绝对路径
 */
export async function probeFile(bin, file, { timeout = PROBE_TIMEOUT_MS } = {}) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    file,
  ];
  const { stdout } = await run(bin, args, { timeout });
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe 输出无法解析为 JSON');
  }
  if (json?.error) throw new Error(json.error.string ?? 'ffprobe 报错');
  return normalizeProbe(json);
}
