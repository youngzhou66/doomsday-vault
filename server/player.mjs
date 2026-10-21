/**
 * 调用本地播放器。
 *
 * 只接受库内已登记过的文件路径（由调用方校验），
 * 命令模板支持 {file} / {time} 占位符，{time} 在无续播位置时整段剔除。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PRESET_COMMANDS } from './presets.mjs';

const WINDOWS_AUTO = ['mpv.exe', 'vlc.exe', 'PotPlayerMini64.exe', 'PotPlayerMini.exe', 'mpc-hc64.exe', 'mpc-be64.exe'];
const MAC_AUTO = ['iina', 'vlc', 'mpv'];
const LINUX_AUTO = ['mpv', 'vlc', 'celluloid', 'totem'];

/** 按 shell 规则切分命令模板（支持单双引号）。 */
export function splitCommand(input) {
  const text = String(input ?? '').trim();
  if (!text) return [];
  const tokens = [];
  let current = '';
  let quote = null;
  let hasContent = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      hasContent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

/** 在 PATH 中查找可执行文件。 */
export async function findExecutable(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try {
      const stat = await fs.stat(name);
      return stat.isFile() ? name : null;
    } catch {
      return null;
    }
  }
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const hasExt = path.extname(name) !== '';
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.join(dir, `${name}${ext.toLowerCase()}`);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // 继续找
      }
    }
  }
  return null;
}

/** 系统默认程序打开。 */
function systemOpen(file) {
  if (process.platform === 'win32') {
    return { bin: 'cmd', args: ['/c', 'start', '', file], label: '系统默认播放器' };
  }
  if (process.platform === 'darwin') return { bin: 'open', args: [file], label: '系统默认播放器' };
  return { bin: 'xdg-open', args: [file], label: '系统默认播放器' };
}

/**
 * 解析出实际要执行的命令，不启动进程。
 * @param {{preset?: string, command?: string, file: string, startSec?: number}} input
 */
export async function buildLaunch({ preset = 'auto', command = '', file, startSec = 0 }) {
  const resume = Number(startSec) > 5 ? Math.floor(Number(startSec)) : 0;
  const template = String(command ?? '').trim();

  const render = (tokens) => {
    const out = [];
    for (const token of tokens) {
      if (token.includes('{time}')) {
        if (!resume) continue;
        out.push(token.replaceAll('{time}', String(resume)));
        continue;
      }
      out.push(token.replaceAll('{file}', file));
    }
    return out;
  };

  if (template) {
    const tokens = splitCommand(template);
    if (!tokens.length) throw new Error('播放器命令为空');
    const rendered = render(tokens);
    if (rendered.length === 1) rendered.push(file);
    return { bin: rendered[0], args: rendered.slice(1), label: '自定义命令', command: rendered.join(' ') };
  }

  if (preset === 'system') {
    const launch = systemOpen(file);
    return { ...launch, command: [launch.bin, ...launch.args].join(' ') };
  }

  if (preset === 'auto' || !preset) {
    const candidates = process.platform === 'win32' ? WINDOWS_AUTO : process.platform === 'darwin' ? MAC_AUTO : LINUX_AUTO;
    for (const candidate of candidates) {
      const found = await findExecutable(candidate);
      if (!found) continue;
      const base = path.basename(found).toLowerCase().replace(/\.exe$/, '');
      const presetKey = base.includes('pot') ? 'potplayer' : base.includes('vlc') ? 'vlc' : base.includes('mpc') ? 'mpc' : base.includes('iina') ? 'iina' : 'mpv';
      const tokens = render(splitCommand(PRESET_COMMANDS[presetKey] ?? '{file}'));
      return {
        bin: found,
        args: tokens.slice(1),
        label: presetKey,
        command: [found, ...tokens.slice(1)].join(' '),
      };
    }
    const launch = systemOpen(file);
    return { ...launch, label: '系统默认播放器（未找到 mpv/VLC）', command: [launch.bin, ...launch.args].join(' ') };
  }

  const templateForPreset = PRESET_COMMANDS[preset];
  if (!templateForPreset) throw new Error(`未知播放器预设：${preset}`);
  const tokens = splitCommand(templateForPreset);
  const rendered = render(tokens);
  const bin = rendered[0];
  const found = await findExecutable(bin);
  if (!found) throw new Error(`找不到播放器可执行文件：${bin}（可在设置里填写完整路径）`);
  return { bin: found, args: rendered.slice(1), label: preset, command: [found, ...rendered.slice(1)].join(' ') };
}

/**
 * 启动本地播放器（不等待退出）。
 * @returns {Promise<{ok: boolean, label: string, command: string, error?: string}>}
 */
export async function launchPlayer(input) {
  const launch = await buildLaunch(input);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launch.bin, launch.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      resolve({ ok: false, label: launch.label, command: launch.command, error: err.message });
      return;
    }
    child.on('error', (err) => {
      resolve({
        ok: false,
        label: launch.label,
        command: launch.command,
        error: err.code === 'ENOENT' ? `找不到可执行文件：${launch.bin}` : err.message,
      });
    });
    // 立刻返回，播放器进程独立存活
    child.unref();
    setTimeout(() => resolve({ ok: true, label: launch.label, command: launch.command }), 150);
  });
}
