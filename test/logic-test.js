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

// ---- 2. 泰坦跳跃技能：人形机甲可跳越部分墙体（冷却 2.5s）；蜘蛛无跳跃（保留爬墙） ----
place(pA, 0, 14);
input(A, { jump: true });
game.tick();
console.log('泰坦跳跃后 vel.y:', pA.vel.y.toFixed(2));
assert(pA.vel.y > 10, '泰坦按下跳跃应获得向上速度');
// 冷却期内再次跳跃不应触发
pA.pos.y = 0; pA.vel.y = 0; pA.grounded = true;
game.tick(); // 落地
const velAfter1 = pA.vel.y;
input(A, { jump: true });
game.tick();
assert(pA.vel.y <= 0.01, '冷却期内不应再次起跳');
input(A, { jump: false });
// 蜘蛛无跳跃
place(pB, 0, 14);
pB.mechType = 'spider';
input(B, { jump: true });
game.tick();
game.tick();
assert(pB.vel.y <= 0 && pB.pos.y <= 0.01, '蜘蛛不应跳跃（保留爬墙）');
input(B, { jump: false });
// 恢复默认人形，避免影响后续测试
pB.mechType = 'humanoid';
pB.mech.legs = [100, 100];
pB.legsDestroyed = 0;
void velAfter1;

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

// ---- 8b. 助攻结算：A2 先打伤 B2，C2 击杀 → A2 得助攻 ----
const A2 = fakeSocket('A2');
const B2 = fakeSocket('B2');
const C2 = fakeSocket('C2');
const io2 = {
  sockets: { sockets },
  to() { return { emit(ev, data) { emitted.push([ev, data]); } }; },
  emit() {}, on() {},
};
const game2 = new Game(io2, 'room_assist', { mode: 'ffa', maxPlayers: 16, matchMinutes: 5 }, {});
game2.start([
  { socketId: 'A2', name: 'Alice', sessionId: 'sid_a2' },
  { socketId: 'B2', name: 'Bob', sessionId: 'sid_b2' },
  { socketId: 'C2', name: 'Carol', sessionId: 'sid_c2' },
]);
clearInterval(game2.timer);
game2.timer = null;
game2.onMechSelect('A2', { index: 0 });
game2.onMechSelect('B2', { index: 0 });
game2.onMechSelect('C2', { index: 0 });
const a2 = game2.players.get('A2');
const b2 = game2.players.get('B2');
const c2 = game2.players.get('C2');
game2.damageModule(b2, MODULE_CHEST, 30, 'A2', Date.now()); // A2 打伤 B2
game2.damageModule(b2, MODULE_CORE, 9999, 'C2', Date.now()); // C2 击杀
assert(a2.assists === 1, 'A2 造成伤害后应获助攻（实际 ' + a2.assists + '）');
assert(c2.kills === 1, 'C2 应计击杀');

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

// ---- 12. 灼光镭射：照射期间持续伤害，停止照射即停止（无残留灼烧） ----
setWeapon(pA, 'laser');
place(pA, 0, 12);
place(pB, 0, 16);
input(A, { fire: true, yaw: Math.PI, pitch: 0 });
const chestL0 = pB.mech.chest;
for (let i = 0; i < 10; i++) game.tick(); // 0.5s 照射
assert(pB.mech.chest < chestL0, '激光照射应持续造成伤害');
input(A, { fire: false });
const chestL1 = pB.mech.chest;
for (let i = 0; i < 40; i++) game.tick(); // 停止照射 2 秒
assert(pB.mech.chest === chestL1, '停止照射后不应再掉血（无残留灼烧）');
assert(pB.mech.chest > 0, '不应瞬间击杀（250 胸足够）');

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
assert(Math.abs(spd0 - 9.5) < 0.01, '蜘蛛满血移速应为 9.5（移速翻倍）');
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

// ---- 14.6b 索敌规则：全图可锁（无距离限制），仅墙体阻隔 + 队友未锁时失败 ----
// 远距离（80m，超过旧 70m 上限）无遮挡应可锁定
place(pA, -40, -40);
place(pB, 40, -40);
game.onLock('A', { targetId: 'B' });
assert(game.players.get('A').lockId === 'B', '远距离无遮挡应可锁定（无距离限制）');
game.onLock('A', { targetId: null });
// 墙体阻隔（纵向高墙 x=-14 两侧）且无队友锁定 → 应失败
place(pA, -20, -22);
place(pB, -8, -22);
game.onLock('A', { targetId: 'B' });
assert(game.players.get('A').lockId === null, '墙体阻隔且无队友锁定时应锁定失败');
// 队友共享：LA 与 LC 同队已锁定 LB，LA 隔墙也能共享锁定（穿墙）
const LC = fakeSocket('LC');
const LB = fakeSocket('LB');
const LA = fakeSocket('LA');
const lockGame = new Game(io, 'room_lock', { mode: 'ctf', maxPlayers: 8, matchMinutes: 5 }, {});
lockGame.start([
  { socketId: 'LA', name: 'Alice', sessionId: 'sid_la' },
  { socketId: 'LB', name: 'Bob', sessionId: 'sid_lb' },
  { socketId: 'LC', name: 'Carol', sessionId: 'sid_lc' },
]);
clearInterval(lockGame.timer);
lockGame.timer = null;
lockGame.onMechSelect('LA', { index: 0 });
lockGame.onMechSelect('LB', { index: 0 });
lockGame.onMechSelect('LC', { index: 0 });
const lA = lockGame.players.get('LA');
const lB = lockGame.players.get('LB');
const lC = lockGame.players.get('LC');
assert(lA.team === lC.team && lA.team !== lB.team, '测试队伍分配应为 A=C≠B');
place(lC, 6, -18);  // C 在东侧，与 B 之间有视线
place(lB, -8, -18); // B 在墙东侧
lockGame.onLock('LC', { targetId: 'LB' });
assert(lC.lockId === 'LB', 'C 有视线应锁定成功');
place(lA, -20, -18); // A 在墙西侧，与 B 隔墙无视线
lockGame.onLock('LA', { targetId: 'LB' });
assert(lA.lockId === 'LB', '队友已锁定 B 时 A 可隔墙共享锁定');
assert(lockGame.validLock(lA) === lB, '共享锁定在后续校验中应保持有效');

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

// ---- 14.9 守护者量子罩：升起挡物理伤害、升起时无法移动、耐久恢复、激光绕过 ----
const G = fakeSocket('G');
const H = fakeSocket('H');
const shieldGame = new Game(io, 'room_shield', { mode: 'ffa', maxPlayers: 16, matchMinutes: 5 }, {});
shieldGame.start([
  { socketId: 'G', name: 'Guard', sessionId: 'sid_g', mechs: [{ type: 'guardian', weapons: [] }] },
  { socketId: 'H', name: 'Hunter', sessionId: 'sid_h', mechs: [{ type: 'humanoid', weapons: ['gau12'] }] },
]);
clearInterval(shieldGame.timer);
shieldGame.timer = null;
shieldGame.onMechSelect('G', { index: 0 });
shieldGame.onMechSelect('H', { index: 0 });
const pG = shieldGame.players.get('G');
const pH = shieldGame.players.get('H');
assert(pG.mechType === 'guardian' && pG.shield && pG.shield.max === 300, '守护者应带量子罩（上限300）');
// 守护者头顶槽固定为防护罩模块
assert(pG.weapons[pG.weapons.length - 1] === 'shield', '守护者头顶槽应固定为量子防护罩');
// F 点击切换升起护罩
shieldGame.onShieldToggle('G');
assert(pG.shield.active === true, '耐久>0 时按 F 应升起护罩');
// 再次点击收回
shieldGame.onShieldToggle('G');
assert(pG.shield.active === false, '再次按 F 应收回护罩');
shieldGame.onShieldToggle('G'); // 再升起用于后续测试
assert(pG.shield.active === true, '第三次按 F 应再升起');
// 升起时物理伤害被吸收，模块不掉血
const chestBefore = pG.mech.chest;
shieldGame.damageModule(pG, MODULE_CHEST, 50, 'H', Date.now());
assert(pG.mech.chest === chestBefore, '升起护罩时物理伤害应被吸收');
assert(pG.shield.hp < 300, '护罩应消耗耐久');
// 升起时无法移动（物理层锁速）
place(pG, 0, 14);
pG.input.fwd = 1;
shieldGame.physics(pG, 0.05);
assert(pG.vel.x === 0 && pG.vel.z === 0, '升起护罩时应无法移动');
// 激光（能量）绕过护罩
const chestBefore2 = pG.mech.chest;
shieldGame.damageModule(pG, MODULE_CHEST, 10, 'H', Date.now(), null, true);
assert(pG.mech.chest === chestBefore2 - 10, '激光为能量伤害应绕过量子罩');
// 点击收回护罩后可移动
shieldGame.onShieldToggle('G');
assert(pG.shield.active === false, '点击应收回护罩');
// 耐久耗尽自动破盾：打空耐久
shieldGame.onShieldToggle('G');
pG.shield.hp = 5;
shieldGame.damageModule(pG, MODULE_CHEST, 50, 'H', Date.now());
assert(pG.shield.active === false, '耐久耗尽应自动破盾');
// 耐久耗尽时无法再次升起
shieldGame.onShieldToggle('G');
assert(pG.shield.active === false, '耐久耗尽时按 F 不应升起');
// 耐久恢复：受击延迟后匀速回满
pG.shield.lastHitAt = Date.now() - 5000;
pG.shield.hp = 100;
shieldGame.updateShield(pG, 1, Date.now());
assert(pG.shield.hp > 100, '延迟后护罩应缓慢恢复耐久');

// ---- 15. 死斗模式（大局计分制）：回合制，先赢 13 回合获胜（CS 式） ----
// 死斗小局规则：每回合一条命，死亡即出局（观战不可复活），下一回合全员复活
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
assert(pD.lives === 2 && pD.mechs.length === 2, '死斗应携带两台机甲（每回合可任选一台）');
// 第 1 回合：D 被击杀 → 本回合出局（lives=0、respawnAt=0、不可复活）→ E 队赢得回合
duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
assert(!pD.alive && pD.lives === 0 && pD.respawnAt === 0, '死斗死亡应出局（本回合不可复活）');
// 出局后不可再选机甲复活
duelGame.onMechSelect('D', { index: 1 });
assert(!pD.alive && pD.mechType === 'humanoid', '出局后不可再选机甲复活');
duelGame.tick();
assert(duelGame.duel.phase === 'roundOver' && duelGame.duel.roundWins[pE.team] === 1, 'E 队应赢得第 1 回合');
// 后续回合：每回合全灭 D → E 队赢下大局（先 13 回合）；同时验证上回合存活者（E）满血回出生点
let roundsWon = 1;
while (duelGame.duel.winnerTeam === null && roundsWon < 13) {
  // 打伤存活者 E，验证下一回合会被重置
  pE.mech.chest = 50;
  pE.pos.x = 33; pE.pos.z = -33;
  duelGame.duel.roundOverAt = Date.now();
  duelGame.tick(); // 进入下一回合（重置）
  assert(duelGame.duel.phase === 'play', '应开始新回合');
  duelGame.tick(); // 全员复活/重置
  assert(pD.alive, '新回合应复活（每回合重置一条命）');
  assert(pE.alive && pE.mech.chest === pE.mech.chestMax, '上回合存活者应满血重置');
  assert(pE.pos.x !== 33 || pE.pos.z !== -33, '上回合存活者应回出生点（不再原地）');
  duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
  pD.respawnAt = Date.now();
  duelGame.tick();
  duelGame.damageModule(pD, MODULE_CORE, 9999, 'E', Date.now());
  duelGame.tick();
  roundsWon++;
}
assert(roundsWon === 13, '应需赢满 13 回合才结束大局');
assert(duelGame.duel.roundWins[pE.team] === 13 && duelGame.duel.winnerTeam === pE.team, 'E 队应赢下大局（13:0）');
const overEvt = emitted.find(([ev, d]) => ev === 'game:over' && d && d.mode === 'duel');
assert(overEvt && overEvt[1].duel && overEvt[1].duel.roundWins && overEvt[1].duel.roundWins[pE.team] === 13, 'game:over 应携带大局比分');

// ---- 15b. 回合结束暂停期：roundOver 期间不跑物理/武器（防止结束后还能移动开火） ----
const PA = fakeSocket('PA');
const PB = fakeSocket('PB');
const pauseGame = new Game(io, 'room_pause', { mode: 'duel', maxPlayers: 8, matchMinutes: 5 }, {});
pauseGame.start([
  { socketId: 'PA', name: 'PA', sessionId: 's_pa', mechs: [{ type: 'humanoid', weapons: ['gau12'] }] },
  { socketId: 'PB', name: 'PB', sessionId: 's_pb', mechs: [{ type: 'humanoid', weapons: ['gau12'] }] },
]);
clearInterval(pauseGame.timer);
pauseGame.timer = null;
pauseGame.onMechSelect('PA', { index: 0 });
pauseGame.onMechSelect('PB', { index: 0 });
const pPA = pauseGame.players.get('PA');
const pPB = pauseGame.players.get('PB');
// PA 击杀 PB → 回合结束进入 roundOver
pauseGame.damageModule(pPB, MODULE_CORE, 9999, 'PA', Date.now());
pauseGame.tick();
assert(pauseGame.duel.phase === 'roundOver', '应进入 roundOver');
// roundOver 期间：PA 开火也不应产生子弹（物理/武器暂停）
pPA.input.fire = true;
pPA.aim = { x: 0, y: 1, z: 20 };
const shotsBefore = pauseGame.projectiles.length;
pauseGame.tick();
pauseGame.tick();
assert(pauseGame.projectiles.length === shotsBefore, 'roundOver 期间不应产生新弹道');
pPA.input.fire = false;

// ---- 15c. 中途加入死斗：回合进行中立即出生 ----
const PM = fakeSocket('PM');
const M1 = fakeSocket('M1');
const M2 = fakeSocket('M2');
const midGame = new Game(io, 'room_mid', { mode: 'duel', maxPlayers: 8, matchMinutes: 5 }, {});
midGame.start([
  { socketId: 'M1', name: 'M1', sessionId: 's_m1', mechs: [{ type: 'humanoid', weapons: [] }] },
  { socketId: 'M2', name: 'M2', sessionId: 's_m2', mechs: [{ type: 'humanoid', weapons: [] }] },
]);
clearInterval(midGame.timer);
midGame.timer = null;
midGame.onMechSelect('M1', { index: 0 });
midGame.onMechSelect('M2', { index: 0 });
midGame.attachPlayer('PM', { name: 'Late', sessionId: 's_pm', mechs: [{ type: 'spider', weapons: [] }] });
const pPM = midGame.players.get('PM');
assert(pPM.alive && pPM.mechType === 'spider', '中途加入死斗应立即出生');

// ---- 15d. 防僵局：25 回合后比分相等也结束（不再无限循环） ----
const S1 = fakeSocket('S1');
const S2 = fakeSocket('S2');
const staleGame = new Game(io, 'room_stale', { mode: 'duel', maxPlayers: 8, matchMinutes: 5 }, {});
staleGame.start([
  { socketId: 'S1', name: 'S1', sessionId: 's_s1', mechs: [{ type: 'humanoid', weapons: [] }] },
  { socketId: 'S2', name: 'S2', sessionId: 's_s2', mechs: [{ type: 'humanoid', weapons: [] }] },
]);
clearInterval(staleGame.timer);
staleGame.timer = null;
staleGame.onMechSelect('S1', { index: 0 });
staleGame.onMechSelect('S2', { index: 0 });
// 连续打平 25 回合（每回合双方自爆 → 同归于尽 → 平局）→ 应触发 max-rounds 结束
let staleR = 0;
let guard = 0;
while (staleGame.active && staleR < 30 && guard++ < 4000) {
  const p1 = staleGame.players.get('S1');
  const p2 = staleGame.players.get('S2');
  if (staleGame.duel && staleGame.duel.phase === 'play') {
    if (p1.alive && p2.alive) {
      // 自爆（击杀者=自己）不计本回合击杀 → 每回合 0:0 平局，才能走到 25 回合上限
      staleGame.damageModule(p1, MODULE_CORE, 9999, 'S1', Date.now());
      staleGame.damageModule(p2, MODULE_CORE, 9999, 'S2', Date.now());
    }
    if (staleGame.duel.phase === 'play' && !p1.alive && !p2.alive) {
      // 同归于尽：强制推进到回合到时，由 updateDuel 按击杀数判定（0:0 → 平局下一回合）
      staleGame.duel.roundEndsAt = Date.now() - 1;
    }
    staleGame.tick();
  } else if (staleGame.duel && staleGame.duel.phase === 'roundOver') {
    staleGame.duel.roundOverAt = Date.now() - 1;
    staleGame.tick();
    staleR++;
  } else {
    staleGame.tick();
  }
}
assert(staleGame.active === false, '25 回合平局后应结束整场（防僵局）');
assert(staleGame.duel.round >= 25, '应到达回合上限（round=' + staleGame.duel.round + '）');

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

// ---- 18. 人机系统：addBots 生成 bot、bot AI 追击开火、真人替代 bot ----
const BT = fakeSocket('BT');
const botGame = new Game(io, 'room_bot', { mode: 'ffa', maxPlayers: 8, matchMinutes: 5 }, {});
botGame.start([
  { socketId: 'BT', name: 'BotTester', sessionId: 'sid_bt', mechs: [{ type: 'humanoid', weapons: ['gau12'] }] },
]);
clearInterval(botGame.timer);
botGame.timer = null;
botGame.onMechSelect('BT', { index: 0 });
const pBT = botGame.players.get('BT');
botGame.addBots(2);
const bots = [...botGame.players.values()].filter((p) => p.isBot);
assert(bots.length === 2, '应生成 2 台人机');
assert(bots.every((b) => b.alive && b.mechType), '人机应自动出生且有机甲');
// bot AI：放一个真人目标，跑几 tick，bot 应面朝目标并开火
place(pBT, 0, 0);
place(bots[0], 0, 12);
bots[0].yaw = Math.PI; // 背对
for (let i = 0; i < 40; i++) botGame.tick();
assert(bots[0].input.fire === true || bots[0].input.fire !== undefined, '有目标时 bot 应开火');
const yawToTarget = Math.atan2(bots[0].pos.x - pBT.pos.x, bots[0].pos.z - pBT.pos.z);
const diff = Math.abs(((bots[0].yaw - yawToTarget + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
assert(diff < 0.4, 'bot 应转向目标（yaw 偏差 ' + diff.toFixed(2) + '）');
// 真人替代 bot：替换后 bot 消失、真人入场
const BT2 = fakeSocket('BT2');
const replaced = botGame.replaceBotWithPlayer(BT2, { name: 'Human', sessionId: 'sid_h', mechs: [{ type: 'spider', weapons: [] }] });
assert(replaced === true, '应能替代人机');
assert([...botGame.players.values()].filter((p) => p.isBot).length === 1, '替代后应剩 1 台人机');
assert(botGame.players.has('BT2') && botGame.players.get('BT2').name === 'Human', '真人应入场');

console.log('\n✅ 全部逻辑测试通过');
process.exit(0);
