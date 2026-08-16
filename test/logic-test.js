'use strict';
// 确定性逻辑测试：物理、跳跳台、机甲模块伤害（机炮/激光/巡飞弹）、核心死亡、复活、
// 腿部损毁减速（人形/蜘蛛）、血包、边界、死斗模式、断线重连恢复、房间席位迁移
// 直接驱动 Game / Room（不依赖网络），需与当前 server 代码 API 保持同步
const assert = require('assert');
const { Game } = require('../server/game');
const { MAP } = require('../server/map');
const { RoomManager, Room } = require('../server/rooms');
const { MODULE_LEG, MODULE_CHEST, MODULE_CORE } = require('../public/js/neon-shared.js');

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
// 开局需先在局内选择机甲（机甲改为局内选择）
game.onMechSelect('A', { index: 0 });
game.onMechSelect('B', { index: 0 });

const pA = game.players.get('A');
const pB = game.players.get('B');
assert(pA && pB, '两个玩家应已创建');
assert(pA.mechType === 'humanoid', '默认机甲应为人形');
assert(pA.mech.legs.length === 2 && pA.mech.chest === 250 && pA.mech.core === 100, '人形模块血量 腿100/胸250/核100');
assert(pA.weapons.length === 4, '人形应 4 战斗模块槽');

function place(p, x, z, y = 0) {
  p.pos.x = x; p.pos.z = z; p.pos.y = y;
  p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
}
function input(s, o) {
  s.trigger('input', Object.assign({ fwd: 0, strafe: 0, jump: false, fire: false, yaw: 0, pitch: 0 }, o));
}
// 给玩家换武器（跳过机库，直接改状态）
function setWeapon(p, type) {
  p.weapons = [type];
  p.weaponState = [{ type, ammo: 5, reloading: false, reloadEndsAt: 0, charge: 1, fireCd: 0 }];
}

// ---- 1. 移动：yaw=0 前进应沿 -z ----
place(pA, 0, 14);
input(A, { fwd: 1 });
game.tick();
console.log('移动后位置:', pA.pos.x.toFixed(2), pA.pos.y.toFixed(2), pA.pos.z.toFixed(2), 'yaw:', pA.yaw.toFixed(2), 'vel.z:', pA.vel.z.toFixed(2));
assert(pA.pos.z < 14 && pA.pos.x === 0 && pA.pos.y === 0, 'yaw=0 前进应沿 -z 且贴地');

// ---- 2. 跳跃已禁用（所有机甲不可手动跳跃） ----
place(pA, 0, 14);
input(A, { jump: true });
game.tick();
game.tick();
assert(pA.vel.y <= 0 && pA.pos.y <= 0.01, '跳跃已禁用，不应跳起');

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
place(pA, 0, 0);
pA.pos.y = 6;
input(A, {});
for (let i = 0; i < 6; i++) game.tick();
console.log('落到箱顶后 y:', pA.pos.y.toFixed(2), 'grounded:', pA.grounded);
assert(Math.abs(pA.pos.y - 5) < 0.01 && pA.grounded, '应落在中央高台顶部 y=5');

// ---- 6. 箱顶自由行走（不卡边） ----
input(A, { fwd: 1 });
for (let i = 0; i < 60; i++) game.tick(); // 人形减速后需更多 tick 走完箱顶
assert(pA.pos.z < -6, '应能从箱顶走过并越过边缘（z 应 < -6）');

// ---- 7. 机炮命中模块（弹体飞行不穿墙）：平射打胸部、压低枪口打腿部 ----
place(pA, 0, 12);
place(pB, 0, 16);
input(A, { fire: true, yaw: Math.PI, pitch: 0 }); // 朝 +z 平射（4 挺机炮齐射）
const chest0 = pB.mech.chest;
for (let i = 0; i < 40; i++) game.tick(); // 持续射击等弹体命中
assert(pB.mech.chest < chest0, '机炮平射应命中胸部模块');
const legs0 = pB.mech.legs.slice();
input(A, { fire: true, yaw: Math.PI, pitch: -0.2 }); // 压低枪口
for (let i = 0; i < 40; i++) game.tick();
assert(pB.mech.legs.some((h, i) => h < legs0[i]), '压低枪口应命中腿部模块');
input(A, { fire: false });

// ---- 8. 核心被击即死（直接驱动模块伤害） ----
place(pB, 0, 16);
const died = game.damageModule(pB, MODULE_CORE, 9999, 'A', Date.now());
assert(died === true && !pB.alive, '核心被击应死亡');
assert(pA.kills === 1 && pA.score === 100, '击杀应计 1 杀 100 分，实际 kills=' + pA.kills + ' score=' + pA.score);
assert(game.killfeed[0] && game.killfeed[0].victim === 'Bob', '击杀播报应记录 Bob');
// ffa 模式复活，模块满血
pB.respawnAt = Date.now();
let g1 = 0;
while (!pB.alive && g1++ < 100) game.tick();
assert(pB.alive, '应复活');
assert(pB.mech.chest === pB.mech.chestMax && pB.mech.legs.every((h) => h === 100), '复活应满模块');

// ---- 9. 边界 ----
place(pA, 200, 0);
input(A, { fwd: 1, yaw: 0 });
for (let i = 0; i < 5; i++) game.tick();
assert(Math.abs(pA.pos.x) <= 45 && Math.abs(pA.pos.z) <= 45, '不应越出场地边界');

// ---- 11. 人形腿部损毁减速：1 腿 -50%，2 腿 -80% ----
place(pA, 0, 0);
input(A, { fwd: 1, yaw: Math.PI });
game.tick();
const fullSpd = Math.abs(pA.vel.z);
pA.mech.legs[0] = 0;
pA.legsDestroyed = game.countLegsDestroyed(pA);
game.tick();
console.log('人形 1 腿损毁 vel.z:', pA.vel.z.toFixed(2), '(期望 -4.75)');
assert(Math.abs(Math.abs(pA.vel.z) - fullSpd * 0.5) < 0.01, '人形 1 腿损毁应减速 50%');
pA.mech.legs[1] = 0;
pA.legsDestroyed = game.countLegsDestroyed(pA);
game.tick();
console.log('人形 2 腿损毁 vel.z:', pA.vel.z.toFixed(2), '(期望 -1.90)');
assert(Math.abs(Math.abs(pA.vel.z) - fullSpd * 0.2) < 0.01, '人形 2 腿损毁应减速 80%');

// ---- 12. 镭射激光：接触施加灼烧（每秒 5 伤害持续 10 秒），停止照射后继续掉血 ----
setWeapon(pA, 'laser');
place(pA, 0, 12);
place(pB, 0, 16);
input(A, { fire: true, yaw: Math.PI, pitch: 0 });
const chestL0 = pB.mech.chest;
for (let i = 0; i < 5; i++) game.tick();
input(A, { fire: false });
assert(pB.burns.size > 0, '激光接触应施加灼烧状态');
assert(pB.mech.chest < chestL0, '激光灼烧应造成伤害');
const chestL1 = pB.mech.chest;
for (let i = 0; i < 40; i++) game.tick(); // 2 秒
assert(pB.mech.chest < chestL1, '停止照射后灼烧应继续掉血');
assert(pB.mech.chest > 0, '灼烧不应瞬间击杀（250 胸足够）');

// ---- 13. 巡飞弹：5 发齐射，弧线越地形，落地爆炸伤害（随机命中模块） ----
setWeapon(pA, 'loiter');
pB.burns.clear(); // 隔离上一测试的灼烧
place(pA, 0, 12);
place(pB, 0, 16);
input(A, { fire: true, yaw: Math.PI, pitch: -0.5 });
const moduleSum0 = pB.mech.legs.reduce((a, b) => a + b, 0) + pB.mech.chest;
game.tick(); // 先跑一 tick 触发齐射
let g2 = 0;
while (game.projectiles.length > 0 && g2++ < 300) game.tick();
input(A, { fire: false });
assert(game.projectiles.length === 0, '巡飞弹应已全部落地');
const moduleSum1 = pB.mech.legs.reduce((a, b) => a + b, 0) + pB.mech.chest;
console.log('巡飞弹后模块总血量:', moduleSum1, '<', moduleSum0);
assert(moduleSum1 < moduleSum0, '巡飞弹爆炸应造成模块伤害');

// ---- 14. 蜘蛛腿部减速表：1→5% 3→50% 5→95% 6→0 ----
place(pB, 20, 20);
pB.mechType = 'spider';
pB.mech.legs = [100, 100, 100, 100, 100, 100];
pB.legsDestroyed = 0;
input(B, { fwd: 1, yaw: Math.PI });
game.tick();
const spd0 = Math.abs(pB.vel.z);
assert(Math.abs(spd0 - 4.75) < 0.01, '蜘蛛满血移速应为 4.75（移速减缓50%）');
const spiderMuls = [0.95, 0.75, 0.5, 0.2, 0.05, 0];
for (let i = 0; i < 6; i++) {
  pB.mech.legs[i] = 0;
  pB.legsDestroyed = game.countLegsDestroyed(pB);
  game.tick();
  const expect = spd0 * spiderMuls[i];
  console.log('蜘蛛 ' + (i + 1) + ' 腿损毁 vel.z:', pB.vel.z.toFixed(2), '(期望 ' + (expect === 0 ? '0' : (-expect).toFixed(2)) + ')');
  assert(Math.abs(Math.abs(pB.vel.z) - expect) < 0.01, '蜘蛛 ' + (i + 1) + ' 腿损毁减速比例错误');
}
assert(pB.legsDestroyed === 6, '6 腿应全部损毁');

// ---- 14.5 蜘蛛爬墙：贴墙朝墙移动时垂直上升 ----
pB.mech.legs = [100, 100, 100, 100, 100, 100];
pB.legsDestroyed = 0;
place(pB, -26, -30); // 高塔西侧（塔 x -33..-27）
input(B, { fwd: 1, yaw: Math.PI / 2 }); // 朝 -x 走向塔壁
let climbed = false;
for (let i = 0; i < 40; i++) {
  game.tick();
  if (pB.pos.y > 2) { climbed = true; break; }
}
console.log('蜘蛛爬墙后 y:', pB.pos.y.toFixed(2), 'climbing:', pB.climbing);
assert(climbed, '蜘蛛应能爬墙上升');

// ---- 14.6 武器索敌：锁定后即使不瞄向目标，弹体也能命中 ----
setWeapon(pA, 'gau12');
place(pA, 0, 12);
place(pB, 0, 16);
game.onLock('A', { targetId: 'B' }); // 先放置再锁定（有视线）
assert(game.players.get('A').lockId === 'B', '有视线时应锁定成功');
input(A, { fire: true, yaw: 0, pitch: 0 }); // 瞄向 -z（完全背对 B）
const lockSum0 = pB.mech.legs.reduce((a, b) => a + b, 0) + pB.mech.chest;
game.tick(); // 发射（弹体强导转向 B）
let gL = 0;
while (game.projectiles.length > 0 && gL++ < 120) game.tick();
input(A, { fire: false });
game.onLock('A', { targetId: null }); // 解除锁定
const lockSum1 = pB.mech.legs.reduce((a, b) => a + b, 0) + pB.mech.chest;
console.log('索敌命中后模块总血量:', lockSum1, '<', lockSum0);
assert(lockSum1 < lockSum0, '锁定时应命中锁定目标（即使未瞄向目标）');

// ---- 14.7 局内换机甲：死亡后选择第二台机甲再部署 ----
pA.mechs = [{ type: 'humanoid', weapons: [] }, { type: 'spider', weapons: [] }];
pA.mechIndex = 0;
game.damageModule(pA, MODULE_CORE, 9999, 'B', Date.now());
assert(!pA.alive, 'A 应死亡');
game.onMechSelect('A', { index: 1 }); // 选择蜘蛛
game.tick(); // 到点复活
assert(pA.alive && pA.mechType === 'spider' && pA.mech.legs.length === 6, '应换成蜘蛛满血复活');
// 存活状态不可换机甲
const typeBefore = pA.mechType; // pA 当前存活（蜘蛛）
game.onMechSelect('A', { index: 0 });
assert(pA.mechType === typeBefore, '存活状态不应允许换机甲');

// ---- 14.8 准星瞄准点：未索敌时子弹朝准星方向开火（即使 yaw/pitch 指向别处） ----
setWeapon(pA, 'gau12');
input(B, {}); // B 静止，避免跑出准星点
place(pA, 0, 12);
place(pB, 0, 16);
A.trigger('input', { fwd: 0, strafe: 0, jump: false, fire: true, yaw: 0, pitch: 0, aimX: 0, aimY: 1, aimZ: 16 });
const aimSum0 = pB.mech.legs.reduce((a, b) => a + b, 0) + pB.mech.chest;
for (let i = 0; i < 40; i++) game.tick();
A.trigger('input', { fwd: 0, strafe: 0, jump: false, fire: false, yaw: 0, pitch: 0 });
const aimSum1 = pB.mech.legs.reduce((a, b) => a + b, 0) + pB.mech.chest;
console.log('准星瞄准命中后模块总血量:', aimSum1, '<', aimSum0);
assert(aimSum1 < aimSum0, '未索敌时子弹应朝准星瞄准点开火');

// ---- 15. 死斗模式（大局计分制）：回合制，先赢 2 回合获胜 ----
const D = fakeSocket('D');
const E = fakeSocket('E');
const duelGame = new Game(io, 'room_duel', { mode: 'duel', maxPlayers: 8, matchMinutes: 5 }, {});
duelGame.start([
  { socketId: 'D', name: 'Delta', sessionId: 'sid_d', mechs: [{ type: 'humanoid', weapons: [] }, { type: 'spider', weapons: [] }] },
  { socketId: 'E', name: 'Echo', sessionId: 'sid_e', mechs: [{ type: 'humanoid', weapons: [] }, { type: 'spider', weapons: [] }] },
]);
clearInterval(duelGame.timer);
duelGame.timer = null;
// 死斗开局选机甲
duelGame.onMechSelect('D', { index: 0 });
duelGame.onMechSelect('E', { index: 0 });
const pD = duelGame.players.get('D');
const pE = duelGame.players.get('E');
assert(pD.team !== pE.team, '死斗应分属两队');
assert(pD.lives === 2 && pD.mechs.length === 2, '死斗应携带两台机甲（两次生命）');
// 第 1 回合：D 击杀一次 → 换蜘蛛；再击杀 → 出局 → E 队赢得回合
duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
assert(!pD.alive && pD.usedMechs.has(0) && pD.lives === 1, '死亡一次应消耗一台机甲');
pD.respawnAt = Date.now();
duelGame.tick();
assert(pD.alive && pD.mechType === 'spider', '第二台机甲应为蜘蛛');
duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
assert(!pD.alive && pD.usedMechs.size === 2 && pD.lives === 0, '两次死亡后应出局');
duelGame.tick();
assert(duelGame.duel.phase === 'roundOver' && duelGame.duel.roundWins[pE.team] === 1, 'E 队应赢得第 1 回合');
// 第 2 回合：重置后再次全灭 D → E 队赢下大局
duelGame.duel.roundOverAt = Date.now();
duelGame.tick(); // 进入第 2 回合（重置）
assert(duelGame.duel.round === 2 && duelGame.duel.phase === 'play', '应开始第 2 回合');
assert(pD.usedMechs.size === 0 && pD.lives === 2, '回合开始应重置机甲');
duelGame.tick(); // 全员复活
assert(pD.alive, '第 2 回合应复活');
duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
pD.respawnAt = Date.now();
duelGame.tick();
duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
duelGame.tick();
assert(duelGame.duel.roundWins[pE.team] === 2 && duelGame.duel.winnerTeam === pE.team, 'E 队应赢下大局（2:0）');
const overEvt = emitted.find(([ev, d]) => ev === 'game:over' && d && d.mode === 'duel');
assert(overEvt && overEvt[1].duel && overEvt[1].duel.roundWins && overEvt[1].duel.roundWins[pE.team] === 2, 'game:over 应携带大局比分');

// ---- 16. 断线重连恢复（Game 层）：同 sessionId 恢复原玩家，并返回旧 socketId ----
game.onLeave('A');
assert(!game.players.get('A').connected, '断线后 connected 应为 false');
const oldId = game.resume(fakeSocket('A2'), 'sid_alice');
assert(oldId === 'A', 'resume 应返回旧 socketId');
assert(game.players.has('A2') && !game.players.has('A'), '玩家 key 应迁移到新 socketId');
assert(game.players.get('A2').name === 'Alice' && game.players.get('A2').score === pA.score, '恢复玩家数据应保留');

// ---- 17. 房间席位迁移（rooms 层，断线重连幽灵席位修复） ----
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
room.onPlayerGone('B3_new');
assert(!room.players.has('B3_new'), '对局结束应能移除迁移后的席位（不留幽灵席位）');
// 机库配置透传：addPlayer 应清洗并保存机甲
const mechRoom = new Room(rm, io, fakeSocket('M'), { mode: 'duel' });
mechRoom.addPlayer(fakeSocket('M2'), { name: 'Mech', sessionId: 'sid_m', mechs: [{ type: 'spider', weapons: ['laser', 'loiter', 'gau12'] }, { type: 'humanoid', weapons: [] }] });
assert(mechRoom.players.get('M2').mechs.length === 2, '应保存 2 台机甲配置');
assert(mechRoom.players.get('M2').mechs[0].type === 'spider' && mechRoom.players.get('M2').mechs[0].weapons.length === 3, '蜘蛛应 3 武器槽');

console.log('\n✅ 全部逻辑测试通过');
process.exit(0);
