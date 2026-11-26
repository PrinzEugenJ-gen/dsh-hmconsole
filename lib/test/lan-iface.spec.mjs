
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

const { lanAddresses, lanUrls } = await import('../lan-server.mjs')

const orig = os.networkInterfaces

function withIfaces(fixture, fn) {
  os.networkInterfaces = () => fixture
  try { return fn() } finally { os.networkInterfaces = orig }
}

const v4m = (address, mac) => ({ address, mac, family: 'IPv4', internal: false })

const v4 = (address) => ({ address, family: 'IPv4', internal: false })
const lo = () => ({ address: '127.0.0.1', family: 'IPv4', internal: true })

const addrs = (list) => list.map((x) => x.address).sort()

test('混合网卡：只留 WLAN，VMware / vEthernet(WSL) 都排掉', () => {
  const out = withIfaces({
    'WLAN': [v4('192.168.31.10')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.23.160.1')],
    'VMware Network Adapter VMnet8': [v4('192.168.137.1')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.31.10'])
})

test('全是虚拟网卡：回退原逻辑，一个地址都不许少', () => {
  const out = withIfaces({
    'vEthernet (Default Switch)': [v4('172.20.0.1')],
    'Docker Desktop': [v4('172.21.0.1')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['172.20.0.1', '172.21.0.1'])
})

test('Tailscale + WLAN：两条都留（叠加网不排）', () => {
  const out = withIfaces({
    'Tailscale': [v4('100.101.102.103')],
    'WLAN': [v4('192.168.31.10')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['100.101.102.103', '192.168.31.10'])
})

test('只有 Tailscale：保留（用户可能就靠它异地连）', () => {
  const out = withIfaces({ 'Tailscale': [v4('100.101.102.103')] }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['100.101.102.103'])
})

test('中文网卡名「以太网」：当物理网卡保留，不误杀', () => {
  const out = withIfaces({ '以太网': [v4('192.168.1.5')] }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.1.5'])
})

test('Wi-Fi Direct 虚拟适配器 + WLAN：只留 WLAN', () => {
  const out = withIfaces({
    'Microsoft Wi-Fi Direct Virtual Adapter': [v4('192.168.137.2')],
    'WLAN': [v4('192.168.31.10')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.31.10'])
})

test('只有回环（internal）：一个都不给', () => {
  const out = withIfaces({ 'Loopback Pseudo-Interface 1': [lo()] }, () => lanAddresses())
  assert.deepEqual(out, [])
})

test('排序：192.168 优先于 10.x 优先于 172.16-31，其余垫底', () => {
  const out = withIfaces({
    'WLAN': [v4('8.8.4.4'), v4('172.20.5.5')],
    'Ethernet': [v4('10.0.0.9'), v4('192.168.0.2')]
  }, () => lanAddresses())
  assert.deepEqual(out.map((x) => x.address), ['192.168.0.2', '10.0.0.9', '172.20.5.5', '8.8.4.4'])
})

test('非 IPv4 / internal 的记录一律跳过（IPv6、回环）', () => {
  const out = withIfaces({
    'WLAN': [{ address: 'fe80::1', family: 'IPv6', internal: false }, lo(), v4('192.168.31.10')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.31.10'])
})

test('第 1345 节 · Array Networks SSL VPN + 热点：只留热点那条', () => {
  const out = withIfaces({
    'Array Networks SSL VPN': [v4('111.187.81.27')],
    'WLAN': [v4('192.168.43.4')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.43.4'])
})

test('第 1345 节 · 主流企业 VPN 网卡名逐个都要排掉', () => {
  const names = [
    'Array Networks SSL VPN',
    'OpenVPN Wintun',
    'OpenVPN Data Channel Offload',
    'Sangfor SSL VPN CS Support System VNIC',
    'EasyConnect',
    '深信服 VPN 虚拟网卡',
    'Cisco AnyConnect VPN',
    'Pulse Secure VPN'
  ]
  for (const nm of names) {
    const out = withIfaces({ [nm]: [v4('10.8.0.6')], 'WLAN': [v4('192.168.43.4')] }, () => lanAddresses())
    assert.deepEqual(addrs(out), ['192.168.43.4'], nm + ' 没被排掉')
  }
})

test('第 1345 节 · tun / tap / ppp 不再要求名字带数字', () => {
  for (const nm of ['tun', 'tun0', 'tun4', 'tap', 'tap0', 'ppp', 'ppp1', 'TAP-Windows Adapter V9']) {
    const out = withIfaces({ [nm]: [v4('10.8.0.6')], 'WLAN': [v4('192.168.43.4')] }, () => lanAddresses())
    assert.deepEqual(addrs(out), ['192.168.43.4'], nm + ' 没被排掉')
  }
})

test('第 1345 节 · 叠加网照旧不排：Tailscale / ZeroTier + 热点，三条都留', () => {
  const out = withIfaces({
    'Tailscale': [v4('100.101.102.103')],
    'ZeroTier One [8056c2e21c000001]': [v4('172.22.0.9')],
    'WLAN': [v4('192.168.43.4')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['100.101.102.103', '172.22.0.9', '192.168.43.4'])
})

test('第 1345 节 · 只有 VPN 网卡时仍回退原逻辑（不许退化成没有地址）', () => {
  const out = withIfaces({
    'Array Networks SSL VPN': [v4('111.187.81.27')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['111.187.81.27'])
})

test('返回结构是 { name, address }，name 用的是真实网卡名', () => {
  const out = withIfaces({ 'WLAN': [v4('192.168.31.10')] }, () => lanAddresses())
  assert.deepEqual(out, [{ name: 'WLAN', address: '192.168.31.10' }])
})

test('第 1673 节 · 中文名「以太网 2」+ VirtualBox MAC：排掉，不占「默认」位', () => {
  const out = withIfaces({
    '以太网 2': [v4m('192.168.56.1', '0A-00-27-00-00-0E')],
    'WLAN': [v4m('192.168.1.22', 'AA-BB-CC-DD-EE-01')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.1.22'])
  assert.equal(out[0].address, '192.168.1.22', '第一顺位必须是真实 WLAN')
})

test('第 1673 节 · 复刻用户现场：只剩 WLAN 与 Clash TUN，且 lanUrls 首位是 WLAN', () => {
  const fixture = {
    '以太网 2': [v4m('192.168.56.1', '0a:00:27:00:00:0e')],
    'WLAN': [v4m('192.168.1.22', 'aa:bb:cc:dd:ee:01')],
    'Meta': [v4m('198.18.0.1', 'aa:bb:cc:dd:ee:02')]
  }
  const out = withIfaces(fixture, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.1.22', '198.18.0.1'])
  assert.equal(out[0].address, '192.168.1.22')
  const urls = withIfaces(fixture, () => lanUrls(8898))
  assert.deepEqual(urls, [
    'http://192.168.1.22:8898/dsh-hmconsole',
    'http://198.18.0.1:8898/dsh-hmconsole'
  ])
})

test('第 1673 节 · VMware 四种 MAC 前缀都要认出来（名字随便叫）', () => {
  const macs = ['00:50:56:aa:bb:cc', '00:0c:29:aa:bb:cc', '00:05:69:aa:bb:cc', '00:1c:14:aa:bb:cc']
  for (const mac of macs) {
    const out = withIfaces({
      '以太网 3': [v4m('192.168.137.1', mac)],
      'WLAN': [v4m('192.168.31.10', 'aa:bb:cc:dd:ee:01')]
    }, () => lanAddresses())
    assert.deepEqual(addrs(out), ['192.168.31.10'], mac + ' 没被排掉')
  }
})

test('第 1673 节 · MAC 缺失 / 全零占位：不误杀，中文名照旧当物理网卡保留', () => {
  const out = withIfaces({
    '以太网 2': [v4('192.168.1.5')],
    '以太网 3': [v4m('192.168.1.6', '00:00:00:00:00:00')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.1.5', '192.168.1.6'])
})

test('第 1673 节 · 整机只有 VirtualBox 网卡：仍回退原逻辑，不许退化成没有地址', () => {
  const out = withIfaces({
    '以太网 2': [v4m('192.168.56.1', '0A-00-27-00-00-0E')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.56.1'])
})

test('第 1673 节 · 叠加网网卡的 MAC 不在表里，照旧保留', () => {
  const out = withIfaces({
    'Tailscale': [v4m('100.101.102.103', 'aa:bb:cc:dd:ee:03')],
    'WLAN': [v4m('192.168.43.4', 'aa:bb:cc:dd:ee:01')],
    '以太网 2': [v4m('192.168.56.1', '0A-00-27-00-00-0E')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['100.101.102.103', '192.168.43.4'])
})
