'use strict';
// 霓虹竞技场 Neon Arena — 地图定义（Y 轴向上，box 为中心坐标 + 尺寸）
const MAP = {
  name: 'Neon Arena',
  size: { x: 90, z: 90 }, // 可活动范围 -45..45
  wallHeight: 6,
  // 静态障碍物 {x,y,z,sx,sy,sz}
  boxes: [
    // 中央高台
    { x: 0, y: 2.5, z: 0, sx: 12, sy: 5, sz: 12 },
    // 四角立柱
    { x: -28, y: 2.5, z: -28, sx: 5, sy: 5, sz: 5 },
    { x: 28, y: 2.5, z: -28, sx: 5, sy: 5, sz: 5 },
    { x: -28, y: 2.5, z: 28, sx: 5, sy: 5, sz: 5 },
    { x: 28, y: 2.5, z: 28, sx: 5, sy: 5, sz: 5 },
    // 四个方向的台阶
    { x: -20, y: 1, z: 0, sx: 4, sy: 2, sz: 4 },
    { x: 20, y: 1, z: 0, sx: 4, sy: 2, sz: 4 },
    { x: 0, y: 1, z: -20, sx: 4, sy: 2, sz: 4 },
    { x: 0, y: 1, z: 20, sx: 4, sy: 2, sz: 4 },
    // 低矮掩体
    { x: -12, y: 1, z: -30, sx: 14, sy: 2, sz: 2 },
    { x: 12, y: 1, z: 30, sx: 14, sy: 2, sz: 2 },
    { x: -30, y: 1, z: 12, sx: 2, sy: 2, sz: 14 },
    { x: 30, y: 1, z: -12, sx: 2, sy: 2, sz: 14 },
  ],
  // 跳跳台（踩上去弹起）
  jumpPads: [
    { x: -38, z: -38, radius: 2.2, strength: 20 },
    { x: 38, z: 38, radius: 2.2, strength: 20 },
    { x: -38, z: 38, radius: 2.2, strength: 15 },
    { x: 38, z: -38, radius: 2.2, strength: 15 },
  ],
  // 出生点
  spawns: [
    { x: -40, z: -10 }, { x: 40, z: -10 },
    { x: -40, z: 10 }, { x: 40, z: 10 },
    { x: -10, z: -40 }, { x: 10, z: -40 },
    { x: -10, z: 40 }, { x: 10, z: 40 },
  ],
  // 血包刷新点
  pickups: [
    { x: 0, z: -14 },
    { x: -22, z: -22 }, { x: 22, z: 22 },
    { x: -22, z: 22 }, { x: 22, z: -22 },
  ],
};

module.exports = { MAP };
