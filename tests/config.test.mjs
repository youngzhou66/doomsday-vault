import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  DEFAULT_CONFIG, PLAYER_PRESETS, normalizeRoots, publicConfig, sanitizeConfig,
} from '../server/config.mjs';

test('空配置得到完整默认值', () => {
  const config = sanitizeConfig({});
  assert.equal(config.version, 1);
  assert.equal(config.tmdb.language, 'zh-CN');
  assert.deepEqual(config.roots, []);
  assert.equal(config.scan.probe, true);
  assert.equal(config.player.preset, 'auto');
  assert.ok(config.scan.extensions.includes('.mkv'));
  assert.deepEqual(config.scan.ignoreSuffixes, [], '默认不忽略任何后缀');
});

test('忽略后缀：去空白、大小写去重、条目上限', () => {
  const config = sanitizeConfig({
    scan: { ignoreSuffixes: [' -trailer ', '-TRAILER', '', '  ', 'sample', 42] },
  });
  assert.deepEqual(config.scan.ignoreSuffixes, ['-trailer', 'sample', '42']);
  const capped = sanitizeConfig({ scan: { ignoreSuffixes: Array.from({ length: 80 }, (_, i) => `s${i}`) } });
  assert.equal(capped.scan.ignoreSuffixes.length, 50);
  const long = sanitizeConfig({ scan: { ignoreSuffixes: ['x'.repeat(100)] } });
  assert.equal(long.scan.ignoreSuffixes[0].length, 60);
});

test('合并补丁不会丢掉其它分区', () => {
  const base = sanitizeConfig({ tmdb: { language: 'en-US', cacheDays: 7 }, server: { port: 8080 } });
  const next = sanitizeConfig({ tmdb: { minScore: 0.7 } }, base);
  assert.equal(next.tmdb.language, 'en-US');
  assert.equal(next.tmdb.cacheDays, 7);
  assert.equal(next.tmdb.minScore, 0.7);
  assert.equal(next.server.port, 8080);
});

test('根目录默认扫描深度为 1 且路径归一化为绝对路径', () => {
  const roots = normalizeRoots([{ path: 'media' }]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].path, path.resolve('media'));
  assert.equal(roots[0].depth, 1);
  assert.equal(roots[0].enabled, true);
  assert.match(roots[0].id, /^r_[0-9a-f]{10}$/);
});

test('根目录深度被钳制在 0..99', () => {
  const roots = normalizeRoots([
    { path: 'a', depth: '5' },
    { path: 'b', depth: 999 },
    { path: 'c', depth: -3 },
    { path: 'd', depth: '' },
  ]);
  assert.equal(roots[0].depth, 5);
  assert.equal(roots[1].depth, 99);
  assert.equal(roots[2].depth, 0);
  assert.equal(roots[3].depth, 1);
});

test('重复根目录按路径去重', () => {
  const target = path.resolve('dupe-root');
  const roots = normalizeRoots([{ path: target }, { path: target }, { path: `${target}${path.sep}.` }]);
  assert.equal(roots.length, 1);
});

test('扩展名统一为小写且带点', () => {
  const config = sanitizeConfig({ scan: { extensions: ['mkv', '.MP4', '', ' avi '] } });
  assert.deepEqual(config.scan.extensions, ['.mkv', '.mp4', '.avi']);
});

test('扩展名留空时回落到默认集合', () => {
  const config = sanitizeConfig({ scan: { extensions: [] } });
  assert.deepEqual(config.scan.extensions, DEFAULT_CONFIG.scan.extensions);
});

test('数值字段被钳制', () => {
  const config = sanitizeConfig({
    scan: { minSizeBytes: -10, probeConcurrency: 999 },
    tmdb: { cacheDays: -5, minScore: 9 },
    server: { port: 70000 },
  });
  assert.equal(config.scan.minSizeBytes, 0);
  assert.equal(config.scan.probeConcurrency, 12);
  assert.equal(config.tmdb.cacheDays, 0);
  assert.equal(config.tmdb.minScore, 1);
  assert.equal(config.server.port, 65535);
});

test('未知播放器预设回退到 auto', () => {
  const config = sanitizeConfig({ player: { preset: 'not-a-player' } });
  assert.equal(config.player.preset, 'auto');
  for (const preset of Object.keys(PLAYER_PRESETS)) {
    assert.equal(sanitizeConfig({ player: { preset } }).player.preset, preset);
  }
});

test('对外配置隐藏 API Key 只留掩码', () => {
  const config = sanitizeConfig({ tmdb: { apiKey: 'abcd1234efgh5678' } });
  const view = publicConfig(config);
  assert.equal(view.tmdb.apiKey, '');
  assert.equal(view.tmdb.apiKeySet, true);
  assert.match(view.tmdb.apiKeyMasked, /^abcd…5678$/);
  assert.equal(publicConfig(config, { revealKey: true }).tmdb.apiKey, 'abcd1234efgh5678');
});

test('净化是可重复执行的（幂等）', () => {
  const once = sanitizeConfig({ roots: [{ path: 'x' }], scan: { extensions: ['mkv'] } });
  const twice = sanitizeConfig(once, once);
  assert.deepEqual(twice, once);
});
