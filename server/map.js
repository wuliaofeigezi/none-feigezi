'use strict';
// 霓虹竞技场 Neon Arena — 地图定义（Y 轴向上，box 为中心坐标 + 尺寸）
// 第一张地图「霓虹都市」：箱庭结构（可进入楼房 + 街巷），高围墙(14m)、中央高台、纵向分隔高墙、低掩体
const MAP = {
  name: '霓虹都市',
  size: { x: 90, z: 90 }, // 可活动范围 -45..45
  wallHeight: 14,         // 外圈围墙高度（蜘蛛可攀爬）
  theme: 'city',          // 城市主题（客户端贴图/背景）

  // 楼房（客户端渲染为贴图建筑；墙+门洞生成碰撞盒加入 boxes）
  // enterable: true=有门洞可进入；false=全封闭不可进入（外墙贴图+屋顶）
  // doorSide: north/south/east/west 开门的方位（仅 enterable 时有效，避开出生点/测试走廊）
  buildings: [
    { x: -16, z: 24, w: 10, d: 8, h: 6, enterable: true, doorSide: 'south', color: 0x3a5a9a },
    { x: 16, z: 28, w: 10, d: 8, h: 6, enterable: true, doorSide: 'north', color: 0x9a5a3a },
    { x: -16, z: -30, w: 10, d: 8, h: 6, enterable: true, doorSide: 'east', color: 0x3a9a7a },
    { x: 16, z: -30, w: 10, d: 8, h: 6, enterable: true, doorSide: 'west', color: 0x7a3a9a },
    { x: 0, z: -34, w: 12, d: 7, h: 7, enterable: false, color: 0x5a5a9a },
    { x: 0, z: 34, w: 12, d: 7, h: 7, enterable: false, color: 0x9a9a5a },
    { x: -36, z: 0, w: 6, d: 12, h: 8, enterable: false, color: 0x4a7a7a },
    { x: 36, z: 0, w: 6, d: 12, h: 8, enterable: false, color: 0x7a4a7a },
  ],

  // 静态障碍物 {x,y,z,sx,sy,sz}（buildings 的墙也会追加进来）
  boxes: [
    // ---- 中央区域 ----
    // 中央高台（制高点）
    { x: 0, y: 2.5, z: 0, sx: 12, sy: 5, sz: 12 },
    // 中央高台四角小立柱（登台垫脚）
    { x: -7.5, y: 1, z: -7.5, sx: 1.5, sy: 2, sz: 1.5 },
    { x: 7.5, y: 1, z: -7.5, sx: 1.5, sy: 2, sz: 1.5 },
    { x: -7.5, y: 1, z: 7.5, sx: 1.5, sy: 2, sz: 1.5 },
    { x: 7.5, y: 1, z: 7.5, sx: 1.5, sy: 2, sz: 1.5 },
    // ---- 四角区域 ----
    // 四角高塔（14m 高，蜘蛛可爬，跳台可跃至塔腰）
    { x: -30, y: 7, z: -30, sx: 6, sy: 14, sz: 6 },
    { x: 30, y: 7, z: -30, sx: 6, sy: 14, sz: 6 },
    { x: -30, y: 7, z: 30, sx: 6, sy: 14, sz: 6 },
    { x: 30, y: 7, z: 30, sx: 6, sy: 14, sz: 6 },
    // 四角立柱（原有低柱）
    { x: -28, y: 2.5, z: -28, sx: 5, sy: 5, sz: 5 },
    { x: 28, y: 2.5, z: -28, sx: 5, sy: 5, sz: 5 },
    { x: -28, y: 2.5, z: 28, sx: 5, sy: 5, sz: 5 },
    { x: 28, y: 2.5, z: 28, sx: 5, sy: 5, sz: 5 },
    // ---- 纵向分隔高墙（中间留缺口） ----
    { x: -14, y: 5, z: -22, sx: 1, sy: 10, sz: 16 },
    { x: -14, y: 5, z: 14, sx: 1, sy: 10, sz: 16 },
    { x: 14, y: 5, z: -22, sx: 1, sy: 10, sz: 16 },
    { x: 14, y: 5, z: 14, sx: 1, sy: 10, sz: 16 },
    // 横向分隔高墙（中间缺口，错位布置）
    { x: -30, y: 5, z: -14, sx: 16, sy: 10, sz: 1 },
    { x: 22, y: 5, z: -14, sx: 16, sy: 10, sz: 1 },
    { x: -22, y: 5, z: 14, sx: 16, sy: 10, sz: 1 },
    { x: 30, y: 5, z: 14, sx: 16, sy: 10, sz: 1 },
    // ---- 二层平台（蜘蛛可爬、跳台可达） ----
    { x: 0, y: 3, z: -24, sx: 8, sy: 6, sz: 5 },
    { x: 0, y: 3, z: 24, sx: 8, sy: 6, sz: 5 },
    // ---- 低矮掩体 ----
    { x: -12, y: 1, z: -30, sx: 14, sy: 2, sz: 2 },
    { x: 12, y: 1, z: 30, sx: 14, sy: 2, sz: 2 },
    { x: -30, y: 1, z: 12, sx: 2, sy: 2, sz: 14 },
    { x: 30, y: 1, z: -12, sx: 2, sy: 2, sz: 14 },
    { x: -8, y: 1, z: 8, sx: 4, sy: 2, sz: 4 },
    { x: 8, y: 1, z: -8, sx: 4, sy: 2, sz: 4 },
    // ---- 斜坡/阶梯（禁用跳跃后可走上去；台阶高 1.0 逐级抬升） ----
    // 中央高台北侧阶梯（登上 y=5 高台）
    { x: 0, y: 0.5, z: -7.2, sx: 3, sy: 1, sz: 0.24 },
    { x: 0, y: 1.5, z: -6.96, sx: 3, sy: 1, sz: 0.24 },
    { x: 0, y: 2.5, z: -6.72, sx: 3, sy: 1, sz: 0.24 },
    { x: 0, y: 3.5, z: -6.48, sx: 3, sy: 1, sz: 0.24 },
    { x: 0, y: 4.5, z: -6.24, sx: 3, sy: 1, sz: 0.24 },
    // 二层平台（-24）南侧阶梯（低端朝外、高端贴平台，登上 y=6 平台）
    { x: 0, y: 0.5, z: -20.2, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 1.5, z: -20.44, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 2.5, z: -20.68, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 3.5, z: -20.92, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 4.5, z: -21.16, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 5.5, z: -21.4, sx: 3.5, sy: 1, sz: 0.24 },
    // 二层平台（+24）南侧阶梯（低端朝外、高端贴平台，登上 y=6 平台）
    { x: 0, y: 0.5, z: 20.2, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 1.5, z: 20.44, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 2.5, z: 20.68, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 3.5, z: 20.92, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 4.5, z: 21.16, sx: 3.5, sy: 1, sz: 0.24 },
    { x: 0, y: 5.5, z: 21.4, sx: 3.5, sy: 1, sz: 0.24 },
    // 纵向高墙（x=-14，z -30..-14）西侧斜坡（登上 10m 墙顶）
    { x: -16.1, y: 0.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -15.94, y: 1.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -15.78, y: 2.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -15.62, y: 3.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -15.46, y: 4.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -15.3, y: 5.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -15.14, y: 6.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -14.98, y: 7.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -14.82, y: 8.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    { x: -14.66, y: 9.5, z: -22, sx: 0.32, sy: 1, sz: 4 },
    // 横向高墙（z=14，x 22..38）北侧斜坡（登上 10m 墙顶）
    { x: 30, y: 0.5, z: 16.1, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 1.5, z: 15.94, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 2.5, z: 15.78, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 3.5, z: 15.62, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 4.5, z: 15.46, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 5.5, z: 15.3, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 6.5, z: 15.14, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 7.5, z: 14.98, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 8.5, z: 14.82, sx: 4, sy: 1, sz: 0.32 },
    { x: 30, y: 9.5, z: 14.66, sx: 4, sy: 1, sz: 0.32 },
  ],
  // 跳跳台（踩上去弹起）
  jumpPads: [
    { x: -38, z: -38, radius: 2.2, strength: 26 },
    { x: 38, z: 38, radius: 2.2, strength: 26 },
    { x: -38, z: 38, radius: 2.2, strength: 18 },
    { x: 38, z: -38, radius: 2.2, strength: 18 },
  ],
  // 出生点
  spawns: [
    { x: -40, z: -10 }, { x: 40, z: -10 },
    { x: -40, z: 10 }, { x: 40, z: 10 },
    { x: -10, z: -40 }, { x: 10, z: -40 },
    { x: -10, z: 40 }, { x: 10, z: 40 },
  ],
  // 双方小队专属重生点（红队=左半场 / 蓝队=右半场，用于死斗/战旗等团队模式）
  teamSpawns: [
    // 红队（team 0，x<0 区域）
    { team: 0, x: -40, z: -8 }, { team: 0, x: -40, z: 8 },
    { team: 0, x: -34, z: -20 }, { team: 0, x: -34, z: 20 },
    { team: 0, x: -22, z: -40 }, { team: 0, x: -22, z: 40 },
    // 蓝队（team 1，x>0 区域）
    { team: 1, x: 40, z: -8 }, { team: 1, x: 40, z: 8 },
    { team: 1, x: 34, z: -20 }, { team: 1, x: 34, z: 20 },
    { team: 1, x: 22, z: -40 }, { team: 1, x: 22, z: 40 },
  ],
  // 血包刷新点（已移除血包系统）
  pickups: [],
};

// 由楼房生成墙体碰撞盒：每栋楼四面薄墙，门的一侧留门洞（墙厚 0.5，门宽 2.6）
// 生成结果带 building 标记，追加进 boxes 供服务器碰撞 / 客户端渲染跳过（楼房单独绘制贴图）
(function genBuildingWalls() {
  const T = 0.5;            // 墙厚
  const DOOR_W = 2.6;       // 门洞宽
  MAP.buildings.forEach((b, bi) => {
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const y = b.h / 2;
    const push = (bx, bz, sx, sz) => MAP.boxes.push({ x: bx, y, z: bz, sx, sy: b.h, sz, building: bi });
    // 不可进入楼房：四面实墙 + 屋顶（防止跳跃/爬墙进入）
    if (b.enterable === false) {
      push(b.x, z0, b.w, T);   // 北
      push(b.x, z1, b.w, T);   // 南
      push(x0, b.z, T, b.d);   // 西
      push(x1, b.z, T, b.d);   // 东
      MAP.boxes.push({ x: b.x, y: b.h + 0.25, z: b.z, sx: b.w + T * 2, sy: 0.5, sz: b.d + T * 2, building: bi, roof: true });
      return;
    }
    // 北墙（z0）
    if (b.doorSide === 'north') {
      const l = (b.w - DOOR_W) / 2;
      if (l > 0.1) { push(x0 + l / 2, z0, l, T); push(x1 - l / 2, z0, l, T); }
    } else push(b.x, z0, b.w, T);
    // 南墙（z1）
    if (b.doorSide === 'south') {
      const l = (b.w - DOOR_W) / 2;
      if (l > 0.1) { push(x0 + l / 2, z1, l, T); push(x1 - l / 2, z1, l, T); }
    } else push(b.x, z1, b.w, T);
    // 西墙（x0）
    if (b.doorSide === 'west') {
      const l = (b.d - DOOR_W) / 2;
      if (l > 0.1) { push(x0, z0 + l / 2, T, l); push(x0, z1 - l / 2, T, l); }
    } else push(x0, b.z, T, b.d);
    // 东墙（x1）
    if (b.doorSide === 'east') {
      const l = (b.d - DOOR_W) / 2;
      if (l > 0.1) { push(x1, z0 + l / 2, T, l); push(x1, z1 - l / 2, T, l); }
    } else push(x1, b.z, T, b.d);
  });
})();

module.exports = { MAP };
