#!/usr/bin/env node
/**
 * 体检：把启动失败最常见的几类原因逐项检查并给出处理建议。
 *
 *   npm run doctor
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, PLAYER_PRESETS, loadConfig } from '../server/config.mjs';
import { detectFfprobe } from '../server/probe.mjs';
import { detectFfmpeg } from '../server/thumb.mjs';
import { pathExists, readJson, statSafe } from '../server/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.MOVIE_DATA_DIR || path.join(ROOT, 'data'));
const APP_NAME = '末日电影库';

const ok = (message) => console.log(`  \x1b[32m✓\x1b[0m ${message}`);
const warn = (message) => console.log(`  \x1b[33m!\x1b[0m ${message}`);
const bad = (message) => console.log(`  \x1b[31m✗\x1b[0m ${message}`);
const tip = (message) => console.log(`    → ${message}`);

let problems = 0;
const fail = (message, hint) => {
  problems += 1;
  bad(message);
  if (hint) tip(hint);
};

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}（${process.platform}）`);
  else fail(`Node.js ${process.versions.node} 太旧`, '本项目需要 Node.js 20 或更高版本：https://nodejs.org/');
}

async function checkFiles() {
  const required = ['package.json', 'server/index.mjs', 'web/index.html', 'web/js/app.js', 'web/styles.css'];
  for (const relative of required) {
    const target = path.join(ROOT, relative);
    if (await pathExists(target)) ok(`文件存在：${relative}`);
    else fail(`缺少文件：${relative}`, '安装包不完整，请重新解压/克隆整个项目目录');
  }
  if (path.resolve(process.cwd()).toLowerCase() !== ROOT.toLowerCase()) {
    warn(`当前工作目录不是项目根目录（cwd=${process.cwd()}）`);
    tip(`建议先执行：cd /d "${ROOT}"，再运行 npm start`);
  }
}

async function checkDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, `.doctor-${Date.now()}.tmp`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    ok(`数据目录可写：${DATA_DIR}`);
  } catch (err) {
    fail(`数据目录不可写：${DATA_DIR}`, `${err.message}；换一个有写权限的目录：set MOVIE_DATA_DIR=D:\\movie-data`);
    return null;
  }

  const configFile = path.join(DATA_DIR, 'config.json');
  let config = null;
  const configExists = await pathExists(configFile);
  if (!configExists) {
    ok('config.json 尚未生成（首次启动会用默认配置创建）');
  } else {
    try {
      config = await loadConfig(DATA_DIR);
      const backup = path.join(DATA_DIR, 'config.json.bak');
      ok(`config.json 可解析（${config.roots.length} 个根目录）`);
      if (await pathExists(backup)) warn('检测到 config.json.bak，说明之前手动备份过配置');
    } catch (err) {
      fail(`config.json 损坏：${err.message}`, '把它重命名为 config.json.bak，重启会用默认配置；或从 data/backups 恢复');
    }
  }

  const libraryFile = path.join(DATA_DIR, 'library.json');
  if (await pathExists(libraryFile)) {
    try {
      const data = await readJson(libraryFile, null);
      const count = Array.isArray(data?.movies) ? data.movies.length : 0;
      ok(`library.json 可解析（${count} 条记录，${Math.round((await statSafe(libraryFile))?.size / 1024) ?? 0} KiB）`);
      if (!Array.isArray(data?.movies)) warn('library.json 里没有 movies 数组，可能是旧版本或损坏文件');
    } catch (err) {
      fail(`library.json 损坏：${err.message}`, '从 data/backups 里挑一份最新的 library.json 覆盖回来');
    }
  } else {
    ok('library.json 尚未生成（扫描后创建）');
  }
  return config;
}

async function checkRoots(config) {
  if (!config) return;
  if (!config.roots.length) {
    warn('还没有配置电影目录');
    tip('启动后在「设置 → 电影目录」添加，例如 D:\\电影');
    return;
  }
  for (const root of config.roots) {
    const stat = await statSafe(root.path);
    if (!stat) fail(`根目录不可访问：${root.path}`, '盘符没挂载、移动硬盘没插，或路径写错了');
    else if (!stat.isDirectory()) fail(`根目录不是文件夹：${root.path}`);
    else ok(`根目录可用：${root.label}（depth=${root.depth}）${root.enabled ? '' : ' — 已停用'}`);
  }
}

/** 端口状态：free / ours / busy */
function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => finish('busy'));
    socket.once('timeout', () => finish('free'));
    socket.once('error', () => finish('free'));
  });
}

async function checkServer(config) {
  const port = Number(process.env.PORT) || config?.server?.port || 7788;
  const state = await checkPort(port);
  if (state === 'free') {
    ok(`端口 ${port} 空闲，可以直接 npm start`);
  } else {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      const data = await response.json();
      if (data?.app?.name === APP_NAME) {
        ok(`端口 ${port} 上已经有一个「${APP_NAME}」在运行（${data.counts?.total ?? 0} 部影片）`);
        tip(`直接打开 http://127.0.0.1:${port} 即可；要重启请先在原来的窗口按 Ctrl+C`);
      } else {
        fail(`端口 ${port} 被其它程序占用`, `netstat -ano | findstr :${port} 找到 PID，再 taskkill /PID <PID> /F；或换端口 set PORT=7799`);
      }
    } catch {
      fail(`端口 ${port} 被占用，而且不是本程序`, `netstat -ano | findstr :${port}；或换端口 set PORT=7799 && npm start`);
    }
  }
  return port;
}

async function checkFfprobe(config) {
  const state = await detectFfprobe(config?.ffprobePath || DEFAULT_CONFIG.ffprobePath);
  if (state.ok) ok(`ffprobe 可用：${state.version}`);
  else {
    warn('ffprobe 不可用（不影响启动：只是没有时长/分辨率/音轨/字幕信息）');
    tip('装 FFmpeg 并加进 PATH，或在设置里填 ffprobe.exe 的绝对路径');
  }
}

async function checkFfmpeg(config) {
  const state = await detectFfmpeg(config?.thumb?.ffmpegPath || 'ffmpeg');
  if (state.ok) {
    ok(`ffmpeg 可用：${state.version}（截帧支持任意编码）`);
    return;
  }
  warn('ffmpeg 不可用（截帧仍可用「系统缩略图」和「浏览器截帧」兜底）');
  tip('MKV/HEVC 这类系统不解码的容器需要它：装 FFmpeg 或在设置里填绝对路径');
  const portable = path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
  if (await pathExists(portable)) tip(`检测到便携版但不可执行：${portable}`);
}

function checkTmdb(config) {
  if ((process.env.TMDB_API_KEY ?? '').trim()) {
    ok('TMDB API Key：来自环境变量 TMDB_API_KEY');
    return;
  }
  if (config?.tmdb?.apiKey) ok(`TMDB API Key：已配置（${config.tmdb.apiKey.slice(0, 4)}…，语言 ${config.tmdb.language}）`);
  else {
    warn('TMDB API Key 未配置（不影响启动：只是没有海报和简介）');
    tip('在设置里填入 Key，或 set TMDB_API_KEY=xxx && npm start');
  }
}

function checkPlayer(config) {
  const preset = config?.player?.preset ?? 'auto';
  const label = PLAYER_PRESETS[preset]?.label ?? preset;
  ok(`播放器预设：${label}${config?.player?.command ? '（使用自定义命令）' : ''}`);
  if (preset === 'auto') tip('建议装一个 mpv 或 VLC，「自动」会优先用它们');
}

async function main() {
  console.log('');
  console.log(`  ${APP_NAME} · 启动体检`);
  console.log(`  项目目录：${ROOT}`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  系统：Windows ${os.release()} · ${os.arch()}`);
  console.log('');

  await checkNode();
  await checkFiles();
  const config = await checkDataDir();
  await checkRoots(config);
  await checkServer(config);
  await checkFfprobe(config);
  await checkFfmpeg(config);
  checkTmdb(config);
  checkPlayer(config);

  console.log('');
  if (problems === 0) {
    console.log('  结论：没有发现阻断启动的问题。执行 npm start 后，用浏览器打开终端里打印的地址。');
    console.log('  提示：不要直接双击 web/index.html（那样没有后端接口，页面会提示「连不上本地服务」）。');
  } else {
    console.log(`  结论：发现 ${problems} 个问题，按上面的 → 提示处理后重试。`);
  }
  console.log('');
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('体检本身出错了：', err);
  process.exit(1);
});
