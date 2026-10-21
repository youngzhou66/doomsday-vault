import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLaunch, splitCommand } from '../server/player.mjs';
import { PRESET_COMMANDS } from '../server/presets.mjs';

test('命令切分支持引号与空格路径', () => {
  assert.deepEqual(splitCommand('mpv --fullscreen "D:\\Movies\\A B.mkv"'), ['mpv', '--fullscreen', 'D:\\Movies\\A B.mkv']);
  assert.deepEqual(splitCommand("vlc --start-time=30 'file name.mkv'"), ['vlc', '--start-time=30', 'file name.mkv']);
  assert.deepEqual(splitCommand('   '), []);
  assert.deepEqual(splitCommand('mpv'), ['mpv']);
});

test('自定义命令替换 {file}', async () => {
  const launch = await buildLaunch({
    command: 'mpv --fullscreen "{file}"',
    file: 'D:\\电影\\教父.mkv',
    startSec: 0,
  });
  assert.equal(launch.bin, 'mpv');
  assert.deepEqual(launch.args, ['--fullscreen', 'D:\\电影\\教父.mkv']);
  assert.equal(launch.label, '自定义命令');
});

test('无续播位置时整段 {time} 参数被丢弃', async () => {
  const launch = await buildLaunch({ command: 'mpv --start={time} "{file}"', file: 'a.mkv', startSec: 0 });
  assert.deepEqual(launch.args, ['a.mkv']);
});

test('有续播位置时 {time} 替换为秒数', async () => {
  const launch = await buildLaunch({ command: 'mpv --start={time} "{file}"', file: 'a.mkv', startSec: 137 });
  assert.deepEqual(launch.args, ['--start=137', 'a.mkv']);
});

test('小于 5 秒的续播位置视为从头播放', async () => {
  const launch = await buildLaunch({ command: 'mpv --start={time} "{file}"', file: 'a.mkv', startSec: 3 });
  assert.deepEqual(launch.args, ['a.mkv']);
});

test('模板里没有 {file} 时自动补上文件路径', async () => {
  const launch = await buildLaunch({ command: 'PotPlayerMini64', file: 'D:\\a.mkv' });
  assert.deepEqual(launch.args, ['D:\\a.mkv']);
});

test('系统默认预设直接交给 OS', async () => {
  const launch = await buildLaunch({ preset: 'system', file: 'D:\\电影\\教父.mkv' });
  if (process.platform === 'win32') {
    assert.equal(launch.bin, 'cmd');
    assert.deepEqual(launch.args, ['/c', 'start', '', 'D:\\电影\\教父.mkv']);
  } else if (process.platform === 'darwin') {
    assert.equal(launch.bin, 'open');
  } else {
    assert.equal(launch.bin, 'xdg-open');
  }
});

test('预设命令都带 {file} 占位符', () => {
  for (const [key, command] of Object.entries(PRESET_COMMANDS)) {
    if (key === 'auto' || key === 'system') continue;
    assert.match(command, /\{file\}/, `${key} 缺少 {file}`);
  }
});

test('未知预设给出明确错误', async () => {
  await assert.rejects(
    () => buildLaunch({ preset: 'nope', file: 'a.mkv' }),
    /未知播放器预设/,
  );
});
