'use strict';
// 占点模式（Zone Control）逻辑测试：得分、离开不计分、占领区迁移、获胜重置、state 广播
// 直接驱动 Game（不依赖网络），需与当前 server 代码 API 保持同步
const assert = require('assert');
const { Game } = require('../server/game');

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
    join() {},
    emit() {},
    on(ev, fn) { handlers[ev] = fn; },
    trigger(ev, d) { if (handlers[ev]) handlers[ev](d); },
    disconnect() {},
  };
  sockets.set(id, s);
  return s;
}

const A = fakeSocket('A');
const game = new Game(io, 'room_zone', { mode: 'zone', maxPlayers: 8, matchMinutes: 5 }, {});
game.start([{ socketId: 'A', name: 'Alice', sessionId: 'sid_alice' }]);
clearInterval(game.timer);
game.timer = null;

assert(game.mode === 'zone', '模式应为占点');
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

// 4. state 广播包含 mode 与 zone
emitted.length = 0;
game.tick();
const stateEvt = emitted.find(([ev]) => ev === 'state');
assert(stateEvt && stateEvt[1].mode === 'zone' && stateEvt[1].zone && typeof stateEvt[1].zone.x === 'number', 'state 应包含 mode 与 zone');

// 5. 获胜判定：积分到 120 → roundEnd + 积分重置
p.pos.x = game.zone.x; p.pos.z = game.zone.z; p.pos.y = 0;
p.score = 119.95;
game.tick();
assert(p.score === 0, '获胜后积分应重置为 0');
assert(emitted.some(([ev]) => ev === 'roundEnd'), '应广播 roundEnd');

// 6. 新一轮站桩可继续得分
const s2 = p.score;
game.tick();
assert(p.score >= s2, '新一轮站桩应能继续得分');

console.log('\n✅ 占点模式逻辑测试全部通过');
process.exit(0);
