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
  const RESPAWN_MS = 30000;       // 重生倒计时 30 秒
  const MAX_PLAYERS = 16;
  const PICKUP_RANGE = 1.1;
  const PICKUP_RESPAWN_MS = 8000;
  const PICKUP_HEAL = 25;
  const KILLFEED_MAX = 8;
  const ZONE_WIN = 120;           // 占点模式获胜积分
  const ZONE_R = 4.5;             // 占领区半径
  const VOTE_CHANGE_MS = 3000;    // CTF 投票改选冷却
  const STEP_HEIGHT = 1.1;        // 台阶自动攀爬最大高度（斜坡/阶梯用）

  // ---------- 机甲定义（War Robots 风格） ----------
  const MODULE_LEG = 'leg';
  const MODULE_CHEST = 'chest';
  const MODULE_CORE = 'core';

  // 胸部血量耗尽后，命中胸部的子弹伤害核心的概率
  const CORE_HIT_CHANCE = 0.5;

  const MECHS = {
    // 人形「泰坦」：双腿 + 胸部 + 藏于胸部的核心，肩部 4 战斗模块槽（上下分布）
    // 专属技能：跳跃（可越过部分墙体/低掩体），跳跃后需冷却
    humanoid: {
      name: '泰坦',
      legs: 2, legHp: 100, chestHp: 250, coreHp: 100,
      mounts: 4,
      moveMul: 0.5, // 重型机甲：移速减半（翻倍后）
      canJump: true, jumpVel: 16.5, jumpCooldownMs: 2500, // 跳跃技能：初速 16.5（约 5.6m 高），冷却 2.5s
      // 各武器槽枪口位置（本地坐标，绕 yaw 旋转后为世界位置）
      muzzlePos: [
        { x: -0.72, y: 1.68, z: 0.14 }, // 左上（落于肩膀上）
        { x: 0.72, y: 1.68, z: 0.14 },  // 右上
        { x: -0.35, y: 2.0, z: 0.05 },  // 头顶左（从肩侧移到头顶）
        { x: 0.35, y: 2.0, z: 0.05 },   // 头顶右
      ],
      // 损毁 0/1/2 条腿的移速倍率：-0% / -50% / -80%
      legSpeedMul: [1, 0.5, 0.2],
      // 模块命中高度分段（腿部 / 胸部），用于弹道命中判定
      legHeight: 0.95, chestHeight: 1.75,
    },
    // 蜘蛛「猎蛛」：六条腿(各50) + 胸部(100) + 核心，胸部两侧 + 顶部共 3 战斗模块槽
    spider: {
      name: '猎蛛',
      legs: 6, legHp: 50, chestHp: 100, coreHp: 100,
      mounts: 3,
      moveMul: 1.0, // 移速（翻倍后）
      muzzlePos: [
        { x: -0.95, y: 1.02, z: 0.1 }, // 左侧
        { x: 0.95, y: 1.02, z: 0.1 },  // 右侧
        { x: 0, y: 1.5, z: 0 },        // 顶部
      ],
      // 损毁 0..6 条腿：-0%/-5%/-25%/-50%/-80%/-95%/-100%（失去行动能力）
      legSpeedMul: [1, 0.95, 0.75, 0.5, 0.2, 0.05, 0],
      legHeight: 0.7, chestHeight: 1.3,
    },
    // 守护者「壁垒」：双腿(各120) + 胸部(320) + 核心，肩部 3 战斗模块槽
    // 专属技能：量子防护罩（按 Q 升起，阻挡所有物理伤害；升起期间无法移动；
    // 防护罩有耐久上限，随时间缓慢恢复，耐久耗尽自动破盾）
    guardian: {
      name: '守护者',
      legs: 2, legHp: 120, chestHp: 320, coreHp: 120,
      mounts: 3,
      moveMul: 0.45, // 重型机甲：移速很慢（塔盾型）
      // 量子防护罩参数
      shieldMax: 300,           // 耐久上限
      shieldRegen: 12,          // 每秒恢复
      shieldRegenDelayMs: 2000, // 受击后延迟开始恢复
      muzzlePos: [
        { x: -0.72, y: 1.62, z: 0.18 }, // 左肩
        { x: 0.72, y: 1.62, z: 0.18 },  // 右肩
        { x: 0, y: 2.0, z: 0.1 },       // 头顶
      ],
      // 损毁 0/1/2 条腿的移速倍率：-0% / -50% / -85%
      legSpeedMul: [1, 0.5, 0.15],
      legHeight: 1.0, chestHeight: 1.85,
    },
  };
  const DEFAULT_MECH = 'humanoid';

  // ---------- 战斗模块（武器）定义 ----------
  const WEAPONS = {
    // Gau12“破坏者”30mm 机炮：720 发/分，480 备弹，装填 15s，不可边打边装填，每发 2 伤害
    gau12: {
      name: 'Gau12 破坏者', type: 'bullet',
      rpm: 720, mag: 480, reloadMs: 15000,
      dmg: 2, canReloadWhileFire: false,
    },
    // “灼光”镭射激光：光束接触期间每秒 15 伤害，满装填 30s，可边打边装填
    laser: {
      name: '灼光', type: 'laser',
      dmgPerSec: 15, burnMs: 10000,
      chargeFullMs: 30000, maxBeamMs: 10000,
      canReloadWhileFire: true,
    },
    // “蜂群”巡飞弹：弹夹 5 发一次性全部打出，装填 15s，追踪锁定目标，每发命中模块 12 伤害
    // 削弱：单发 20→12 伤、爆炸半径 3.2→2.4（更依赖精准命中，不再大范围溅射）
    loiter: {
      name: '蜂群', type: 'loiter',
      mag: 5, volley: 5, reloadMs: 15000, dmg: 12,
      spread: 0.07, speed: 26, arcHeight: 16, blastRadius: 2.4,
    },
  };
  const DEFAULT_WEAPON = 'gau12';

  // 依据机甲类型与损毁腿数返回移速倍率
  function mechSpeedMul(type, legsDestroyed) {
    const m = MECHS[type] || MECHS[DEFAULT_MECH];
    const i = Math.max(0, Math.min(legsDestroyed, m.legSpeedMul.length - 1));
    return m.legSpeedMul[i];
  }

  // 规范化武器槽：长度对齐 mounts，非法值回退默认武器
  function normalizeWeapons(raw, mounts) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (let i = 0; i < mounts; i++) {
      const w = list[i];
      out.push(WEAPONS[w] ? w : DEFAULT_WEAPON);
    }
    return out;
  }

  // 规范化机甲配置 { type, weapons } → { type, weapons }
  function normalizeMech(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const type = MECHS[r.type] ? r.type : DEFAULT_MECH;
    return { type, weapons: normalizeWeapons(r.weapons, MECHS[type].mounts) };
  }

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
        if (pos.y >= c.maxY - 0.001) continue; // 已站在顶上
        // 台阶/斜坡：顶部高于脚底不超过 STEP_HEIGHT 且未在上升 → 自动迈上台阶
        if (c.maxY - pos.y <= STEP_HEIGHT + 0.001 && vel.y <= 0.5) {
          pos.y = c.maxY;
          continue;
        }
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
    ZONE_WIN, ZONE_R, VOTE_CHANGE_MS, STEP_HEIGHT,
    MODULE_LEG, MODULE_CHEST, MODULE_CORE, CORE_HIT_CHANCE,
    MECHS, DEFAULT_MECH, WEAPONS, DEFAULT_WEAPON,
    mechSpeedMul, normalizeWeapons, normalizeMech,
    clamp, sanitizeName, lerpAngle, toAABB, overlapAABB, moveAxis,
  };
});
