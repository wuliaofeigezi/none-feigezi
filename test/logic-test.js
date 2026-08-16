'use strict';
// 确定性逻辑测试：物理、跳跳台、射击伤害、击杀、复活、箱顶站立、房间席位迁移
// 直接驱动 Game / Room（不依赖网络），需与当前 server 代码 API 保持同步
const assert = require('assert');
const { Game } = require('../server/game');
const { MAP } = require('../server/map');
const { RoomManager, Room } = require('../server/rooms');

const sockets = new Map();
const emitted = [];
const io = {
  sockets: { sockets },
  to() { return { emit(ev, data) { emitted.push([ev, data]); } }; },
  emit() {},
  on() {},
};

function fakeSocket(id) {
  const handlers = {};
  const s = {
    id,
    emitted: [],
    join() {},
    emit(ev, data) { s.emitted.push([ev, data]); },
    on(ev, fn) { handlers[ev] = fn; },
    trigger(ev, data) { if (handlers[ev]) handlers[ev](data); },
    disconnect() {},
  };
  sockets.set(id, s);
  return s;
}

const A = fakeSocket('A');
const B = fakeSocket('B');
const game = new Game(io, 'room_logic', { mode: 'ffa', maxPlayers: 16, matchMinutes: 5 }, {});
// start() 会启动真实 interval，测试中立即停掉，改为手动 tick 驱动
game.start([
  { socketId: 'A', name: 'Alice', sessionId: 'sid_alice' },
  { socketId: 'B', name: 'Bob', sessionId: 'sid_bob' },
]);
clearInterval(game.timer);
game.timer = null;

const pA = game.players.get('A');
const pB = game.players.get('B');
assert(pA && pB, '两个玩家应已创建');
assert(pA.health === 100, '初始血量 100');

function place(p, x, z, y = 0) {
  p.pos.x = x; p.pos.z = z; p.pos.y = y;
  p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
}
function input(s, o) {
  s.trigger('input', Object.assign({ fwd: 0, strafe: 0, jump: false, fire: false, yaw: 0, pitch: 0 }, o));
}

// ---- 1. 移动：yaw=0 前进应沿 -z ----
place(pA, 0, 14);
input(A, { fwd: 1 });
game.tick();
console.log('移动后位置:', pA.pos.x.toFixed(2), pA.pos.y.toFixed(2), pA.pos.z.toFixed(2), 'yaw:', pA.yaw.toFixed(2), 'vel.z:', pA.vel.z.toFixed(2));
assert(pA.pos.z < 14 && pA.pos.x === 0 && pA.pos.y === 0, 'yaw=0 前进应沿 -z 且贴地');

// ---- 2. 跳跃 ----
place(pA, 0, 14);
input(A, { jump: true });
game.tick(); // 本 tick 施加跳跃速度
game.tick(); // 本 tick 位置上升
assert(pA.vel.y > 0 && pA.pos.y > 0, '应跳起');

// ---- 3. 跳跳台 ----
place(pA, MAP.jumpPads[0].x, MAP.jumpPads[0].z);
input(A, {});
game.tick();
console.log('跳跳台后 vel.y:', pA.vel.y.toFixed(2));
assert(pA.vel.y >= 19, '跳跳台应提供 ~20 的向上速度');

// ---- 4. 撞墙：从 (0,14) 走向中央高台应被挡住 ----
place(pA, 0, 14);
input(A, { fwd: 1 });
for (let i = 0; i < 30; i++) game.tick();
console.log('撞墙后位置:', pA.pos.x.toFixed(2), pA.pos.z.toFixed(2));
assert(pA.pos.z >= 6.44, '不应穿透中央高台（z 应停在 ~6.45）');

// ---- 5. 落到箱顶并站立 ----
place(pA, 0, 0); // 箱顶正上方（水平范围在 ±6 内）
pA.pos.y = 6;
input(A, {});
for (let i = 0; i < 6; i++) game.tick();
console.log('落到箱顶后 y:', pA.pos.y.toFixed(2), 'grounded:', pA.grounded);
assert(Math.abs(pA.pos.y - 5) < 0.01 && pA.grounded, '应落在中央高台顶部 y=5');

// ---- 6. 箱顶自由行走（不卡边） ----
input(A, { fwd: 1 });
for (let i = 0; i < 30; i++) game.tick();
console.log('箱顶行走后 z:', pA.pos.z.toFixed(2));
assert(pA.pos.z < -6, '应能从箱顶走过并越过边缘（z 应 < -6）');

// ---- 7. 射击命中与击杀（开阔地面对面） ----
place(pA, 0, 12);
place(pB, 0, 16);
input(A, { fire: true, yaw: Math.PI }); // 朝 +z 瞄准 B
input(B, {});
let guard = 0;
while (pB.alive && guard++ < 100) game.tick();
console.log('B 状态:', JSON.stringify({ alive: pB.alive, health: pB.health, deaths: pB.deaths }));
assert(!pB.alive, 'B 应被击杀');
assert(pA.kills === 1 && pA.score === 100, 'A 应得 1 杀 100 分，实际 kills=' + pA.kills + ' score=' + pA.score);
const kf = game.killfeed[0];
assert(kf && kf.killer === 'Alice' && kf.victim === 'Bob', '击杀播报应记录 Alice 击杀 Bob');

// ---- 8. 复活 ----
pB.respawnAt = Date.now(); // 手动触发复活判定
let guard2 = 0;
while (!pB.alive && guard2++ < 100) game.tick();
console.log('复活后 B 血量:', pB.health, 'alive:', pB.alive);
assert(pB.alive && pB.health === 100, 'B 应满血复活');

// ---- 9. 血包 ----
pA.health = 50;
place(pA, MAP.pickups[1].x, MAP.pickups[1].z); // 用 ( -22, -22 )，前面未被动过
input(A, {});
game.tick();
console.log('吃血包后血量:', pA.health);
assert(pA.health === 75, '血包应 +25');

// ---- 10. 边界 ----
place(pA, 200, 0);
input(A, { fwd: 1, yaw: 0 });
for (let i = 0; i < 5; i++) game.tick();
assert(Math.abs(pA.pos.x) <= 45 && Math.abs(pA.pos.z) <= 45, '不应越出场地边界');

// ---- 11. 断线重连恢复（Game 层）：同 sessionId 恢复原玩家，并返回旧 socketId ----
game.onLeave('A'); // 模拟 Alice 断线（connected=false）
assert(!game.players.get('A').connected, '断线后 connected 应为 false');
const oldId = game.resume(fakeSocket('A2'), 'sid_alice');
assert(oldId === 'A', 'resume 应返回旧 socketId');
assert(game.players.has('A2') && !game.players.has('A'), '玩家 key 应迁移到新 socketId');
assert(game.players.get('A2').name === 'Alice' && game.players.get('A2').score === pA.score, '恢复玩家数据应保留');

// ---- 12. 房间席位迁移（rooms 层，断线重连幽灵席位修复） ----
const rm = new RoomManager(io);
const hostSock = fakeSocket('H');
const bobSock = fakeSocket('B3');
const room = new Room(rm, io, hostSock, { mode: 'ffa', maxPlayers: 8, matchMinutes: 5 });
room.addPlayer(hostSock, { name: 'Host', sessionId: 'sid_host' });
room.addPlayer(bobSock, { name: 'Bob', sessionId: 'sid_bob3' });
assert(room.players.has('H') && room.players.has('B3'), '席位应存在');
assert(room.migrateSeat('B3', 'B3_new') === true, '迁移应成功');
assert(!room.players.has('B3') && room.players.has('B3_new'), '旧席位应移除、新席位应建立');
assert(room.players.get('B3_new').name === 'Bob', '迁移后玩家数据应保留');
assert(room.migrateSeat('H', 'H_new') === true, '房主席位迁移应成功');
assert(room.hostId === 'H_new' && room.players.get('H_new').isHost, '房主身份应跟随迁移');
assert(room.migrateSeat('H_new', 'B3_new') === false, '目标席位已占用应拒绝迁移');
assert(room.players.size === 2, '迁移不应改变席位总数');
// 模拟对局结束：席位 key 已迁移，onPlayerGone 能正确清空
room.onPlayerGone('B3_new');
assert(!room.players.has('B3_new'), '对局结束应能移除迁移后的席位（不留幽灵席位）');

console.log('\n✅ 全部逻辑测试通过');
process.exit(0);
