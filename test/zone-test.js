'use strict';
// 占点模式（Zone Control）逻辑测试：投票切模式、得分、离开不计分、占领区迁移、获胜重置、多数切换
const assert = require('assert');
const { Game } = require('../server/game');

function fakeSocket(id) {
  const h = {};
  const s = { id, emit() {}, on(ev, fn) { h[ev] = fn; }, trigger(ev, d) { if (h[ev]) h[ev](d); }, disconnect() {} };
  return s;
}
const emitted = [];
const io = { sockets: { sockets: new Map() }, emit(ev, data) { emitted.push([ev, data]); }, on() {} };
const game = new Game(io);

const A = fakeSocket('A');
game.onConnect(A);
A.trigger('join', { name: 'Alice', mode: 'zone', sessionId: 'sid_alice' });

assert(game.mode === 'zone', '单人选择应切换到占点模式');
assert(game.zone.r === 4.5, '占领区半径 4.5');

const p = game.players.get('A');

// 1. 站桩得分
p.pos.x = game.zone.x; p.pos.z = game.zone.z; p.pos.y = 0;
const s0 = p.score;
game.tick();
assert(p.score > s0, '站桩应得分');

// 2. 离开占领区不计分
p.pos.x = 40; p.pos.z = 40;
const s1 = p.score;
for (let i = 0; i < 3; i++) game.tick();
assert(p.score === s1, '离开占领区不应得分');

// 3. 占领区定时迁移
game.zone.nextMoveAt = Date.now() - 1;
const oldSpot = game.zone.spot;
game.tick();
assert(game.zone.spot !== oldSpot, '占领区应迁移');

// 4. 广播包含 mode 与 zone
const stateEvt = emitted.find(([ev]) => ev === 'state');
assert(stateEvt && stateEvt[1].mode === 'zone' && stateEvt[1].zone && typeof stateEvt[1].zone.x === 'number', 'state 应包含 mode 与 zone');

// 5. 获胜判定
p.pos.x = game.zone.x; p.pos.z = game.zone.z; p.pos.y = 0;
p.score = 119.95;
game.tick();
assert(p.score === 0, '获胜后积分应重置为 0');
assert(emitted.some(([ev]) => ev === 'roundEnd'), '应广播 roundEnd');

// 6. 投票切换：多数通过（绕过冷却）
game.lastModeSwitch = 0;
const B = fakeSocket('B');
game.onConnect(B);
B.trigger('join', { name: 'Bob', mode: 'ffa', sessionId: 'sid_bob' });
assert(game.mode === 'zone', '1:1 平票应保持当前模式');
A.trigger('vote', { mode: 'ffa' }); // Alice 改投 ffa → 2:0
assert(game.mode === 'ffa', '多数投票应切换到死亡竞赛');

console.log('\n✅ 占点模式逻辑测试全部通过');
process.exit(0);
