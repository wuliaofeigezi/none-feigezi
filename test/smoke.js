'use strict';
// 冒烟测试：模拟完整房间流程（建房 → 加入 → 开局 → 对打 → 持续开火 → 断线重连+席位迁移 → 离房）
// 需要先启动服务器：npm start（默认 http://127.0.0.1:3000），再运行本测试：npm run test:smoke
const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(name, sid) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    s.on('connect_error', reject);
    s.on('connect', () => resolve(s));
  });
}

// 先挂监听再触发事件，避免错过先到达的事件（如 welcome 紧跟 room:joined）
function once(s, ev, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(ev, h); reject(new Error('等待 ' + ev + ' 超时')); }, ms || 8000);
    function h(d) { clearTimeout(t); s.off(ev, h); resolve(d); }
    s.on(ev, h);
  });
}

(async () => {
  const sidA = 'test_sid_alice_001';
  const sidB = 'test_sid_bob_002';

  // ---- 建房（Alice） ----
  const a = await makeClient('Alice', sidA);
  const joinedAP = once(a, 'room:joined');
  a.emit('room:create', { name: 'Alice', playerName: 'Alice', sessionId: sidA, mode: 'ffa' });
  const joinedA = await joinedAP;
  const code = joinedA.room.code;
  assert(joinedA.room.settings.mode === 'ffa', '默认模式应为 ffa');
  console.log('A 建房:', code, '| 当前人数:', joinedA.room.players.length);

  // ---- Bob 加入（大厅阶段） ----
  const b = await makeClient('Bob', sidB);
  const joinedBP = once(b, 'room:joined');
  b.emit('room:join', { code, name: 'Bob', sessionId: sidB });
  const joinedB = await joinedBP;
  assert(joinedB.room.players.length === 2, '加入后应有 2 人');
  console.log('B 加入房间，当前人数:', joinedB.room.players.length);

  // ---- 房主开局：两人都应收到 welcome ----
  const welcomeAP = once(a, 'welcome');
  const welcomeBP = once(b, 'welcome');
  a.emit('room:start');
  const welcomeA = await welcomeAP;
  const welcomeB = await welcomeBP;
  assert(welcomeA.map.boxes.length > 0, 'welcome 应携带地图数据');
  assert(welcomeA.resumed === false && welcomeB.resumed === false, '首次开局 resumed 应为 false');
  console.log('开局:', welcomeA.self.name, '+', welcomeB.self.name, '| 地图盒子数:', welcomeA.map.boxes.length);

  // ---- 对打 4 秒（站桩射击，避免游走误吃血包导致断言抖动） ----
  let statesA = 0, statesB = 0, killsSeen = 0;
  let lastMe1 = welcomeA.self;
  a.on('state', () => statesA++);
  b.on('state', () => statesB++);
  a.on('me', (m) => { lastMe1 = m; });
  a.on('kill', (k) => { killsSeen++; console.log('击杀事件:', k.killerName, '->', k.victimName); });
  b.on('kill', () => killsSeen++);

  const input = { fwd: 0, strafe: 0, jump: false, fire: true, yaw: Math.PI / 2, pitch: 0 };
  const t = setInterval(() => {
    a.emit('input', { ...input, yaw: Math.random() * Math.PI * 2 });
    b.emit('input', { ...input, yaw: Math.random() * Math.PI * 2 });
  }, 50);
  await sleep(4000);
  clearInterval(t);

  console.log('A 状态:', JSON.stringify({ alive: lastMe1.alive, health: lastMe1.health, kills: lastMe1.kills, deaths: lastMe1.deaths, score: lastMe1.score }));
  console.log('state 次数 A:', statesA, '| B:', statesB, '| 击杀事件:', killsSeen);

  const gotState = await new Promise((r) => a.once('state', r));
  console.log('血包数量:', gotState.pickups.length, '| 玩家数:', gotState.players.length);
  if (!(statesA > 40 && statesB > 40 && gotState.pickups.length === 5)) {
    console.log('\n❌ 冒烟基础异常');
    process.exit(1);
  }

  // ---- 持续开火回归：长时间按住开火，弹道不应中断 ----
  let projStates = 0;
  a.on('state', (st) => { if (st.projectiles.length > 0) projStates++; });
  const hold = setInterval(() => b.emit('input', { fwd: 0, strafe: 0, jump: false, fire: true, yaw: 0, pitch: 0 }), 50);
  await sleep(2000);
  clearInterval(hold);
  console.log('B 持续开火 2s，A 观测到带弹道 state 次数:', projStates);
  if (projStates < 10) {
    console.log('\n❌ 持续开火回归测试失败');
    process.exit(1);
  }
  console.log('✅ 持续开火回归通过');

  // ---- 断线重连：同 sessionId 恢复原玩家（不新增、不触发 playerJoined） ----
  let joinedDuring = 0;
  a.on('playerJoined', () => joinedDuring++);
  b.close(); // Bob 断线
  await sleep(600);
  const c3 = await makeClient('Bob', sidB);
  const joinedCP = once(c3, 'room:joined');
  const welcomeCP = once(c3, 'welcome');
  c3.emit('room:join', { code, name: 'Bob', sessionId: sidB });
  const joinedC = await joinedCP;
  const welcomeC = await welcomeCP;
  assert(joinedC.inGame === true, '重连应标记 inGame');
  assert(welcomeC.resumed === true, '重连 welcome 应标记 resumed');
  console.log('重连: inGame=', joinedC.inGame, '| resumed=', welcomeC.resumed);
  await sleep(800);
  const st2 = await new Promise((r) => a.once('state', r));
  const hasBob = st2.players.some((p) => p.name === 'Bob');
  console.log('重连后玩家数:', st2.players.length, '| 含 Bob:', hasBob, '| 期间 playerJoined:', joinedDuring);
  if (st2.players.length < 2 || !hasBob || joinedDuring > 0) {
    console.log('\n❌ 断线重连回归测试失败');
    process.exit(1);
  }
  console.log('✅ 断线重连回归通过（同 sessionId 恢复原玩家身份）');

  // ---- 席位迁移验证：新 socketId 必须能被 roomOf 找到（能正常离开房间） ----
  // 修复前：room.players 仍以旧 socketId 为 key，roomOf(新id) 找不到房间 → 收到 NOT_IN_ROOM 错误
  const left = await new Promise((resolve, reject) => {
    c3.once('room:left', (d) => resolve(d));
    c3.emit('room:leave');
    setTimeout(() => reject(new Error('room:left 超时 —— roomOf 未找到新 socketId，席位迁移失败')), 5000);
  });
  console.log('✅ 席位迁移验证通过（新 socketId 可正常离房，room code:', left.code, '）');

  // 房主仍在对局中
  await sleep(300);
  const st3 = await new Promise((r) => a.once('state', r));
  console.log('Bob 离开后玩家数:', st3.players.length);
  if (st3.players.length !== 1) {
    console.log('\n❌ 离房后玩家数异常');
    process.exit(1);
  }

  a.close(); c3.close();
  console.log('\n✅ 冒烟测试通过');
  process.exit(0);
})().catch((e) => { console.error('冒烟测试失败:', e); process.exit(1); });
