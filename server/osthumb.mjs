/**
 * 系统缩略图：直接向操作系统要「资源管理器里能看到的那张图」。
 *
 * 为什么优先用它：
 *   - 零依赖：不用装 FFmpeg，也不用解视频；
 *   - 和用户在文件夹里看到的一致，符合直觉；
 *   - 秒级返回（系统本来就有缩略图缓存）。
 *
 * 局限：能不能出图取决于系统装了哪些解码器/缩略图提供器。
 * 例如 Windows 默认不解 MKV/HEVC，这时资源管理器本身也只显示图标，
 * 我们同样拿不到——需要退回 FFmpeg 截帧。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureDir, pathExists } from './fsx.mjs';

const SCRIPT_TIMEOUT_MS = 20000;

/**
 * Windows：用 IShellItemImageFactory 取缩略图。
 * 脚本在首次使用时写到 data 目录，之后复用。
 */
const WINDOWS_SCRIPT = String.raw`param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Size = 500
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ShellThumb
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

    [Flags]
    private enum SIIGBF
    {
        RESIZETOFIT = 0x00,
        BIGGERSIZEOK = 0x01,
        MEMORYONLY = 0x02,
        ICONONLY = 0x04,
        THUMBNAILONLY = 0x08,
        INCACHEONLY = 0x10
    }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        void GetImage(SIZE size, SIIGBF flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    public static string Save(string path, string outFile, int size)
    {
        Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        object item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
        IShellItemImageFactory factory = (IShellItemImageFactory)item;
        IntPtr hbitmap;
        factory.GetImage(new SIZE(size, size), SIIGBF.THUMBNAILONLY | SIIGBF.RESIZETOFIT, out hbitmap);
        try
        {
            using (Image image = Image.FromHbitmap(hbitmap))
            {
                image.Save(outFile, ImageFormat.Jpeg);
                return image.Width + "x" + image.Height;
            }
        }
        finally
        {
            DeleteObject(hbitmap);
        }
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
Write-Output ([ShellThumb]::Save($Path, $Out, $Size))
`;

/** 读 JPEG 的宽高（只解析 SOF 段，够用且无依赖）。 */
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0..SOF15（排除 DHT/JPG/DAC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width && height ? { width, height } : null;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function runProcess(bin, args, { timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
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
      reject(new Error('系统缩略图超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `退出码 ${code}`));
    });
  });
}

/** 当前平台是否可能提供系统缩略图。 */
export function shellThumbnailSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

/**
 * 向系统要缩略图。
 * @param {string} file 视频绝对路径
 * @param {{size?: number, workDir: string}} options workDir 用于放临时脚本与输出
 * @returns {Promise<{buffer: Buffer, width: number|null, height: number|null, via: string}|null>}
 */
export async function grabShellThumbnail(file, { size = 500, workDir } = {}) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  await ensureDir(workDir);

  if (process.platform === 'win32') {
    const scriptPath = path.join(workDir, 'shell-thumb.ps1');
    if (!(await pathExists(scriptPath))) await fs.writeFile(scriptPath, WINDOWS_SCRIPT, 'utf8');
    const out = path.join(workDir, `thumb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.jpg`);
    try {
      await runProcess('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Path', file,
        '-Out', out,
        '-Size', String(size),
      ]);
      const buffer = await fs.readFile(out).catch(() => null);
      if (!buffer || buffer.length < 256 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
      const dims = jpegSize(buffer);
      return { buffer, width: dims?.width ?? null, height: dims?.height ?? null, via: 'shell' };
    } catch {
      return null;
    } finally {
      await fs.rm(out, { force: true }).catch(() => {});
    }
  }

  if (process.platform === 'darwin') {
    // qlmanage 输出 <name>.png 到指定目录
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmv-ql-'));
    try {
      await runProcess('qlmanage', ['-t', '-s', String(size), '-o', outDir, file]);
      const entries = await fs.readdir(outDir).catch(() => []);
      const png = entries.find((name) => name.toLowerCase().endsWith('.png'));
      if (!png) return null;
      const buffer = await fs.readFile(path.join(outDir, png));
      if (buffer.length < 256) return null;
      // PNG：宽高在 IHDR
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { buffer, width, height, via: 'quicklook' };
    } catch {
      return null;
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Linux：常见缩略图工具
  for (const [bin, args] of [
    ['ffmpegthumbnailer', ['-i', file, '-s', String(size), '-o']],
    ['gnome-thumbnailer', ['-s', String(size), file]],
  ]) {
    const out = path.join(workDir, `thumb-${Date.now().toString(36)}.png`);
    try {
      await runProcess(bin, [...args, out]);
      const buffer = await fs.readFile(out).catch(() => null);
      if (buffer && buffer.length > 256) {
        return { buffer, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), via: bin };
      }
    } catch {
      // 换下一个工具
    } finally {
      await fs.rm(out, { force: true }).catch(() => {});
    }
  }
  return null;
}

/**
 * 选择截帧策略：系统缩略图 → ffmpeg → 浏览器。
 * 纯函数，方便单测。
 * @param {{platform?: string, shellOk?: boolean, ffmpegOk?: boolean, browserOk?: boolean}} input
 */
export function resolveStrategy({ platform = process.platform, shellOk = false, ffmpegOk = false, browserOk = false } = {}) {
  if (shellOk && shellThumbnailSupported(platform)) return 'shell';
  if (ffmpegOk) return 'ffmpeg';
  if (browserOk) return 'browser';
  return null;
}
