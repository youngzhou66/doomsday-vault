import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { normalizeProbe } from '../server/probe.mjs';

const SAMPLE = {
  format: {
    format_name: 'matroska,webm',
    duration: '7200.5',
    bit_rate: '12000000',
    nb_streams: 3,
  },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'hevc',
      profile: 'Main 10',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p10le',
      bits_per_raw_sample: '10',
      r_frame_rate: '24000/1001',
      color_transfer: 'smpte2084',
    },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, bit_rate: '640000', tags: { language: 'eng' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'chi' }, disposition: { default: 1 } },
  ],
  chapters: [],
};

test('探测结果归一化：画面/音轨/字幕/章节', () => {
  const probe = normalizeProbe(SAMPLE);
  assert.equal(probe.container, 'matroska', '多值 format_name 只取第一个');
  assert.equal(probe.durationSec, 7200.5);
  assert.equal(probe.video.width, 1920);
  assert.equal(probe.video.height, 1080);
  assert.equal(probe.video.codec, 'HEVC');
  assert.equal(probe.video.bitDepth, 10);
  assert.equal(probe.video.hdr, 'HDR10');
  assert.equal(probe.audio.length, 1);
  assert.equal(probe.audio[0].language, 'eng');
  assert.equal(probe.subtitles.length, 1);
  assert.equal(probe.subtitles[0].default, true);
  assert.equal(probe.chapterCount, 0);
  assert.ok(probe.probedAt);
});

test('探测结果不包含机器名等本机隐私', () => {
  const probe = normalizeProbe(SAMPLE);
  assert.equal('host' in probe, false, '不能把 os.hostname() 写进记录');
  assert.equal(JSON.stringify(probe).includes(os.hostname()), false);
});

test('探测结果容错：缺字段 / 空输入不抛错', () => {
  const probe = normalizeProbe({});
  assert.equal(probe.container, null);
  assert.equal(probe.durationSec, 0);
  assert.equal(probe.video, null);
  assert.deepEqual(probe.audio, []);
  assert.deepEqual(probe.subtitles, []);
  assert.equal(normalizeProbe(null).video, null);
});
