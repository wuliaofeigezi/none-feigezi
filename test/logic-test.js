'use strict';
// 确定性逻辑测试：物理、跳跳台、射击伤害、击杀、复活、箱顶站立（直接驱动 Game，不依赖网络）
const assert = require('assert');
const { Game } = require('../server/game');
const { MAP } = require('../server/map');

function fakeSocket(id) {
  const handlers = {};
  const emitted = [];
  const s = {
    id, emitted,
    emit(ev, data) { emitted.push([ev, data]); },
    on(ev, fn) { handlers[ev] = fn; },
    trigger(ev, data) { if (handlers[ev]) handlers[ev](data); },
    disconnect() {},
  };
  return s;
}

const sockets = new Map();
const io = { sockets: { sockets }, emit() {}, on() {} };
const game = new Game(io);

const A = fakeSocket('A');
const B = fakeSocket('B');
// 不调用 game.start()（避免真实 interval 竞争），手动注册连接处理
game.onConnect(A);
game.onConnect(B);
A.trigger('join', { name: 'Alice' });
B.trigger('join', { name: 'Bob' });

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

console.log('\n✅ 全部逻辑测试通过');
game.timer && clearInterval(game.timer);
process.exit(0);
