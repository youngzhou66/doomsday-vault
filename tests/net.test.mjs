import assert from 'node:assert/strict';
import test from 'node:test';

import { clearResolutionCache, isSuspiciousAddress, resolveCandidates } from '../server/net.mjs';

test('可疑地址识别：污染源与正常 CDN', () => {
  const poisoned = [
    '2a03:2880:f112:83:face:b00c:0:25de',
    '65.49.26.97',
    '104.244.46.93',
    '8.7.198.46',
    '',
  ];
  for (const address of poisoned) {
    assert.equal(isSuspiciousAddress(address), true, `${address} 应判定为可疑`);
  }
  const healthy = [
    '99.84.215.108',
    '2600:9000:2199:2c00:e:5373:440:93a1',
    '2400:52e0:1a01::996:1',
    '18.66.100.10',
  ];
  for (const address of healthy) {
    assert.equal(isSuspiciousAddress(address), false, `${address} 应判定为可用`);
  }
});

test('系统 DNS 被污染时回退到 DoH', async () => {
  clearResolutionCache();
  const calls = [];
  const result = await resolveCandidates('polluted.example.test', {
    force: true,
    deps: {
      systemResolve: async () => [{ address: '2a03:2880:f112:83:face:b00c:0:25de', family: 6 }],
      dohResolve: async () => {
        calls.push('doh');
        return { ips: [{ address: '203.0.113.10', family: 4 }], via: 'doh:doh.pub' };
      },
      probeTcp: async (address) => address === '203.0.113.10',
      aliases: {},
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.ips[0].address, '203.0.113.10');
  assert.equal(result.via, 'doh:doh.pub');
});

test('DoH 也被污染时，用同域兄弟域名的地址顶上', async () => {
  clearResolutionCache();
  const result = await resolveCandidates('api.themoviedb.org', {
    force: true,
    deps: {
      systemResolve: async (host) => (host === 'api.themoviedb.org'
        ? [{ address: '2a03:2880:f112:83:face:b00c:0:25de', family: 6 }]
        : [{ address: '99.84.215.108', family: 4 }]),
      dohResolve: async () => ({ ips: [{ address: '104.244.46.93', family: 4 }], via: 'doh:doh.pub' }),
      probeTcp: async (address) => address === '99.84.215.108',
      aliases: { 'api.themoviedb.org': ['www.themoviedb.org'] },
    },
  });
  assert.equal(result.via, 'alias:www.themoviedb.org');
  assert.equal(result.ips[0].address, '99.84.215.108');
  assert.ok(result.attempts.some((item) => item.includes('system:无可用地址')));
  assert.ok(result.attempts.some((item) => item.includes('doh')));
});

test('系统 DNS 正常时直接用，不触发 DoH', async () => {
  clearResolutionCache();
  let dohCalled = false;
  const result = await resolveCandidates('healthy.example.test', {
    force: true,
    deps: {
      systemResolve: async () => [{ address: '99.84.215.46', family: 4 }],
      dohResolve: async () => {
        dohCalled = true;
        return { ips: [], via: 'doh:none' };
      },
      probeTcp: async () => true,
      aliases: {},
    },
  });
  assert.equal(result.via, 'system');
  assert.equal(dohCalled, false);
});

test('解析结果有缓存，第二次不再重新解析', async () => {
  clearResolutionCache();
  let resolveCalls = 0;
  const deps = {
    systemResolve: async () => {
      resolveCalls += 1;
      return [{ address: '99.84.215.62', family: 4 }];
    },
    dohResolve: async () => ({ ips: [], via: 'doh:none' }),
    probeTcp: async () => true,
    aliases: {},
  };
  const first = await resolveCandidates('cache.example.test', { force: true, deps });
  const second = await resolveCandidates('cache.example.test', { deps });
  assert.equal(resolveCalls, 1);
  assert.equal(first.ips[0].address, second.ips[0].address);
  assert.equal(second.via, 'system');
});

test('全部策略失败时回退到系统结果，交给上层报错', async () => {
  clearResolutionCache();
  const result = await resolveCandidates('dead.example.test', {
    force: true,
    deps: {
      systemResolve: async () => [{ address: '65.49.26.97', family: 4 }],
      dohResolve: async () => ({ ips: [], via: 'doh:none' }),
      probeTcp: async () => false,
      aliases: {},
    },
  });
  assert.equal(result.via, 'system-unverified');
  assert.equal(result.ips[0].address, '65.49.26.97');
});
