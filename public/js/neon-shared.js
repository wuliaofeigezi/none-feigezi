/* 霓虹竞技场 Neon Arena — 客户端/服务端共享常量与工具（单一事实来源）
   两边的物理常量与工具函数必须从这里取，禁止在 game.js / main.js / rooms.js 里重复定义，
   否则数值漂移会导致客户端预测与服务端权威不一致（闪回/抖动）。
   浏览器：<script src="js/neon-shared.js"> → window.NeonShared
   Node：require('../public/js/neon-shared.js')（CommonJS 导出）
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NeonShared = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础参数（20Hz tick） ----------
  const TICK_MS = 50;             // 20 Hz
  const GRAVITY = 24;
  const MOVE_SPEED = 9.5;
  const JUMP_VEL = 9.8;
  const MAX_FALL = 40;
  const PLAYER_R = 0.45;
  const PLAYER_H = 1.8;
  const EYE_H = 1.6;
  const MAX_HEALTH = 100;
  const FIRE_CD = 0.3;            // 秒
  const PROJ_SPEED = 44;
  const PROJ_R = 0.3;
  const PROJ_LIFE = 1.5;
  const DMG = 20;
  const RESPAWN_MS = 3000;
  const MAX_PLAYERS = 16;
  const PICKUP_RANGE = 1.1;
  const PICKUP_RESPAWN_MS = 8000;
  const PICKUP_HEAL = 25;
  const KILLFEED_MAX = 8;
  const ZONE_WIN = 120;           // 占点模式获胜积分
  const ZONE_R = 4.5;             // 占领区半径
  const VOTE_CHANGE_MS = 3000;    // CTF 投票改选冷却

  // ---------- 工具函数 ----------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function sanitizeName(raw) {
    if (typeof raw !== 'string') return '玩家';
    const s = raw.trim().replace(/[\u0000-\u001f<>/\\]/g, '').slice(0, 16);
    return s.length ? s : '玩家';
  }

  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // box 中心坐标 + 尺寸 → AABB
  function toAABB(b) {
    return {
      minX: b.x - b.sx / 2, maxX: b.x + b.sx / 2,
      minY: b.y - b.sy / 2, maxY: b.y + b.sy / 2,
      minZ: b.z - b.sz / 2, maxZ: b.z + b.sz / 2,
    };
  }

  function overlapAABB(a, b) {
    return a.minX < b.maxX && a.maxX > b.minX &&
      a.minY < b.maxY && a.maxY > b.minY &&
      a.minZ < b.maxZ && a.maxZ > b.minZ;
  }

  // 单轴移动 + AABB 碰撞解析（服务端/客户端共用，必须保持行为一致）
  // 返回 true 表示本轴发生了「落到箱顶」事件（y 轴落地时由调用方置 grounded）
  function moveAxis(pos, vel, axis, dt, colliders) {
    const prevPos = pos[axis];
    pos[axis] += vel[axis] * dt;
    const aabb = {
      minX: pos.x - PLAYER_R, maxX: pos.x + PLAYER_R,
      minY: pos.y, maxY: pos.y + PLAYER_H,
      minZ: pos.z - PLAYER_R, maxZ: pos.z + PLAYER_R,
    };
    let landed = false;
    if (axis === 'x' || axis === 'z') {
      for (const c of colliders) {
        if (!overlapAABB(aabb, c)) continue;
        if (pos.y >= c.maxY - 0.001) continue;
        if (axis === 'x') {
          if (vel.x > 0) { pos.x = c.minX - PLAYER_R - 0.001; vel.x = 0; }
          else if (vel.x < 0) { pos.x = c.maxX + PLAYER_R + 0.001; vel.x = 0; }
        } else {
          if (vel.z > 0) { pos.z = c.minZ - PLAYER_R - 0.001; vel.z = 0; }
          else if (vel.z < 0) { pos.z = c.maxZ + PLAYER_R + 0.001; vel.z = 0; }
        }
      }
    } else {
      const prevY = prevPos;
      for (const c of colliders) {
        if (!overlapAABB(aabb, c)) continue;
        if (vel.y < 0 && prevY >= c.maxY - 0.001) {
          pos.y = c.maxY;
          vel.y = 0;
          landed = true;
        } else if (vel.y > 0 && prevY + PLAYER_H <= c.minY + 0.001) {
          pos.y = c.minY - PLAYER_H;
          vel.y = 0;
        }
      }
    }
    return landed;
  }

  return {
    TICK_MS, GRAVITY, MOVE_SPEED, JUMP_VEL, MAX_FALL,
    PLAYER_R, PLAYER_H, EYE_H, MAX_HEALTH, FIRE_CD,
    PROJ_SPEED, PROJ_R, PROJ_LIFE, DMG, RESPAWN_MS, MAX_PLAYERS,
    PICKUP_RANGE, PICKUP_RESPAWN_MS, PICKUP_HEAL, KILLFEED_MAX,
    ZONE_WIN, ZONE_R, VOTE_CHANGE_MS,
    clamp, sanitizeName, lerpAngle, toAABB, overlapAABB, moveAxis,
  };
});
