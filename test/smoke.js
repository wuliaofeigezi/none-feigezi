'use strict';
// 冒烟测试：模拟两个客户端加入并对打，验证服务器权威循环不崩溃、状态正常广播
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://127.0.0.1:3000';

function makeClient(name, sid) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    s.on('connect_error', reject);
    s.on('connect', () => s.emit('join', { name, sessionId: sid }));
    s.on('welcome', (w) => resolve({ s, w }));
  });
}

(async () => {
  const sidA = 'test_sid_alice_001';
  const sidB = 'test_sid_bob_002';
  const c1 = await makeClient('Alice', sidA);
  console.log('A 加入:', c1.w.self.name, '@', c1.w.self.x.toFixed(1), c1.w.self.z.toFixed(1), '地图盒子数:', c1.w.map.boxes.length);

  const c2 = await makeClient('Bob', sidB);
  console.log('B 加入:', c2.w.self.name);

  // 双方持续开火 + 移动，跑 4 秒
  let statesA = 0, statesB = 0, killsSeen = 0, pickupsSeen = 0;
  let lastMe1 = c1.w.self;
  c1.s.on('state', () => statesA++);
  c2.s.on('state', () => statesB++);
  c1.s.on('me', (m) => { lastMe1 = m; });
  c1.s.on('kill', (k) => { killsSeen++; console.log('击杀事件:', k.killerName, '->', k.victimName); });
  c2.s.on('kill', (k) => { killsSeen++; });

  const input = { fwd: 1, strafe: 0, jump: true, fire: true, yaw: Math.PI / 2, pitch: 0 };
  const t = setInterval(() => {
    c1.s.emit('input', { ...input, yaw: Math.random() * Math.PI * 2 });
    c2.s.emit('input', { ...input, yaw: Math.random() * Math.PI * 2 });
  }, 50);

  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(t);

  const me1 = lastMe1;
  console.log('A 状态:', JSON.stringify({ alive: me1.alive, health: me1.health, kills: me1.kills, deaths: me1.deaths, score: me1.score }));
  console.log('A 收到 state 次数:', statesA, '| B:', statesB, '| 击杀事件:', killsSeen);

  // 验证血包状态
  const gotState = await new Promise((r) => { c1.s.once('state', r); c1.s.emit('input', { fwd: 0, strafe: 0, jump: false, fire: false, yaw: 0, pitch: 0 }); });
  pickupsSeen = gotState.pickups.length;
  console.log('血包数量:', pickupsSeen, '| 玩家数:', gotState.players.length);

  if (statesA > 40 && statesB > 40 && pickupsSeen === 5) {
    console.log('\n✅ 冒烟测试通过');
  } else {
    console.log('\n❌ 冒烟测试异常');
  }

  // ---- 持续开火回归：长时间按住开火，弹道不应中断 ----
  let projStates = 0;
  c1.s.on('state', (st) => { if (st.projectiles.length > 0) projStates++; });
  const hold = setInterval(() => c2.s.emit('input', { fwd: 0, strafe: 0, jump: false, fire: true, yaw: 0, pitch: 0 }), 50);
  await new Promise((r) => setTimeout(r, 2000));
  clearInterval(hold);
  console.log('B 持续开火 2s，A 观测到带弹道 state 次数:', projStates);
  if (projStates < 10) {
    console.log('\n❌ 持续开火回归测试失败');
    process.exit(1);
  }
  console.log('✅ 持续开火回归通过');

  // ---- 断线重连回归：同 sessionId 重连应恢复原玩家（不新增、不触发 playerJoined） ----
  let joinedDuring = 0;
  c1.s.on('playerJoined', () => { joinedDuring++; });
  c2.s.close(); // 模拟 B 断线
  await new Promise((r) => setTimeout(r, 600));
  const c3 = await makeClient('Bob', sidB); // 同名同 sessionId 重新加入 → 应恢复而非新建
  await new Promise((r) => setTimeout(r, 800));
  const st2 = await new Promise((r) => { c1.s.once('state', r); });
  const hasBob = st2.players.some((p) => p.name === 'Bob');
  console.log('重连后玩家数:', st2.players.length, '| 含 Bob:', hasBob, '| 期间 playerJoined:', joinedDuring);
  // 允许存在其他真实玩家，但恢复连接不应触发 playerJoined（即没有新建玩家）
  if (st2.players.length < 2 || !hasBob || joinedDuring > 0) {
    console.log('\n❌ 断线重连回归测试失败');
    process.exit(1);
  }
  console.log('✅ 断线重连回归通过（同 sessionId 恢复原玩家身份）');

  c1.s.close(); c3.s.close();
  process.exit(0);
})().catch((e) => { console.error('冒烟测试失败:', e); process.exit(1); });
