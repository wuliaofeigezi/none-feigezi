'use strict';
// 霓虹竞技场 — 服务器权威游戏逻辑（20Hz 状态同步）
// 模式：ffa 死亡竞赛 | zone 占点 | ctf 夺旗卡牌赛 | duel 死斗（红蓝两队基地核心）
// 机甲系统全局生效：人形/蜘蛛两种机甲，腿部/胸部/核心模块血量，腿部损毁减速，核心被击即死
// 按房间作用域运行：每个房间一个 Game 实例，广播只发到本房间（io.to(roomId)）
const { MAP } = require('./map');
// 共享常量与工具（客户端/服务端唯一事实来源，禁止在本文件重复定义）
const {
  TICK_MS, GRAVITY, MOVE_SPEED, JUMP_VEL, MAX_FALL,
  PLAYER_R, PLAYER_H, EYE_H, MAX_HEALTH, RESPAWN_MS, MAX_PLAYERS,
  PICKUP_RANGE, PICKUP_RESPAWN_MS, PICKUP_HEAL, KILLFEED_MAX,
  ZONE_WIN, ZONE_R, VOTE_CHANGE_MS,
  MODULE_LEG, MODULE_CHEST, MODULE_CORE, CORE_HIT_CHANCE,
  MECHS, DEFAULT_MECH, WEAPONS,
  mechSpeedMul, normalizeMech, normalizeWeapons,
  clamp, sanitizeName, toAABB, moveAxis,
} = require('../public/js/neon-shared.js');

// ---------- 仅服务端参数 ----------
const RECONNECT_GRACE_MS = 15000; // 断线保留时间：站桩等待同 sessionId 重连

// 占点模式（Zone Control）（ZONE_R / ZONE_WIN 来自共享常量）
const ZONE_MOVE_MS = 15000;
const ZONE_SCORE_PER_TICK = 0.1;
const ZONE_SPOTS = [
  { x: 0, z: 0, y: 5 },
  { x: 14, z: 0, y: 0 },
  { x: 0, z: 14, y: 0 },
  { x: -14, z: 0, y: 0 },
  { x: 0, z: -14, y: 0 },
  { x: 22, z: 22, y: 0 },
];

// 夺旗卡牌赛（CTF）
const CTF_BASES = [
  { team: 0, x: -40, z: 0 },
  { team: 1, x: 40, z: 0 },
];
const CTF_BASE_R = 5;            // 基地判定半径
const CTF_FLAG_PICKUP_R = 2.2;   // 捡旗判定半径
const CTF_CAPTURE_TARGET = 3;    // 每回合先拿 3 分获胜
const CTF_ROUND_MS = 90 * 1000;  // 每回合时长上限
const CTF_VOTE_MS = 12000;       // 抽卡投票时间
const CTF_FLAG_RETURN_MS = 10000;// 旗落地后回基地时间
const CTF_ROUND_WINS = 2;        // 先赢 2 回合的队伍获胜
const CTF_MAX_ROUNDS = 5;        // 最多 5 回合（防僵局）
const CTF_ROUND_OVER_MS = 3500;  // 回合结束停留时间
const CTF_VOTE_CHANGE_MS = VOTE_CHANGE_MS; // 投票改选冷却（共享常量，每 3 秒可改一次票）

// 旗手惩罚（携带敌方旗帜时）
const CTF_CARRIER_SPEED_MUL = 0.5;    // 移速 -50%
const CTF_CARRIER_JUMP_MUL = 0.65;    // 跳跃 -35%
const CTF_CARRIER_NO_HEAL = true;     // 不能捡血包（旗手不可回血）

// 死斗模式（Duel）：红蓝两队基地核心，靠近部署装置 10 秒破坏核心直接获胜
const DUEL_BASES = [
  { team: 0, x: -40, z: 0 },
  { team: 1, x: 40, z: 0 },
];
const DUEL_CORE_RADIUS = 4.5;    // 核心判定半径
const DUEL_DEPLOY_SEC = 10;      // 部署装置所需秒数
const DUEL_ROUND_MS = 90 * 1000; // 每回合时长上限（到时按击杀数判定）
const DUEL_ROUND_WINS = 13;      // 大局计分：CS 式先赢 13 回合获胜
const DUEL_MAX_ROUNDS = 25;      // 回合数上限（防僵局：先到 13 的胜；25 回合后按回合胜场/击杀判定）

// 武器索敌（锁定）：无距离限制（全图可锁），仅墙体阻隔 + 队友未锁时失败

// FragPunk 式卡牌池：apply 修改本回合 cfg（数值已适配机甲武器系统）
const CARD_POOL = [
  { id: 'speed', name: '疾风', desc: '全体移速 +50%', apply: (g) => { g.cfg.moveSpeed *= 1.5; } },
  { id: 'jump', name: '弹跳', desc: '跳跃力 +60%', apply: (g) => { g.cfg.jumpVel *= 1.6; } },
  { id: 'rapid', name: '速射', desc: '机炮射速翻倍', apply: (g) => { g.cfg.weaponRpmMul *= 2; } },
  { id: 'pierce', name: '重弹', desc: '武器伤害翻倍', apply: (g) => { g.cfg.weaponDmgMul *= 2; } },
  { id: 'fragile', name: '纸甲', desc: '胸部血量上限减半', apply: (g) => { g.cfg.chestMul = Math.max(0.5, g.cfg.chestMul * 0.5); g.rescaleChest(); } },
  { id: 'tank', name: '铁壁', desc: '胸部血量上限 +50%', apply: (g) => { g.cfg.chestMul = Math.min(2, g.cfg.chestMul * 1.5); g.rescaleChest(); } },
  { id: 'moon', name: '月球', desc: '重力减半，跳得更远', apply: (g) => { g.cfg.gravity *= 0.5; } },
  { id: 'heavy', name: '重力场', desc: '重力 +60%', apply: (g) => { g.cfg.gravity *= 1.6; } },
  { id: 'spawn', name: '重生', desc: '复活缩短至 1 秒', apply: (g) => { g.cfg.respawnMs = 1000; } },
  { id: 'pickup', name: '丰收', desc: '血包回血翻倍', apply: (g) => { g.cfg.pickupHeal *= 2; } },
  { id: 'slow', name: '泥沼', desc: '全体移速 -25%', apply: (g) => { g.cfg.moveSpeed *= 0.75; } },
  { id: 'storm', name: '弹幕', desc: '巡飞弹速度 +40%，射程更长', apply: (g) => { g.cfg.loiterSpeedMul *= 1.4; } },
];

const COLORS = [
  '#ff3b5c', '#3b82f6', '#22d3ee', '#a855f7', '#f59e0b', '#10b981',
  '#ec4899', '#84cc16', '#fb923c', '#eab308', '#06b6d4', '#f472b6',
  '#60a5fa', '#34d399', '#facc15', '#fb7185',
];
const TEAM_COLORS = ['#ff3b5c', '#3b82f6']; // 红 / 蓝

const colliders = MAP.boxes.map(toAABB);

function defaultCfg(mode) {
  return {
    gravity: GRAVITY, moveSpeed: MOVE_SPEED, jumpVel: JUMP_VEL,
    maxHealth: MAX_HEALTH, respawnMs: RESPAWN_MS, pickupHeal: PICKUP_HEAL,
    weaponDmgMul: 1, weaponRpmMul: 1, chestMul: 1, loiterSpeedMul: 1,
    mode,
  };
}

function isTeamMode(mode) { return mode === 'ctf' || mode === 'duel'; }

class Game {
  constructor(io, roomId, settings, hooks) {
    this.io = io;
    this.roomId = roomId;
    this.settings = settings || {};
    this.hooks = hooks || {};
    // 房间作用域广播
    this.emit = (ev, data) => io.to(roomId).emit(ev, data);

    this.maxPlayers = clamp(parseInt(this.settings.maxPlayers, 10) || MAX_PLAYERS, 1, MAX_PLAYERS);
    this.mode = (this.settings.mode === 'zone' || this.settings.mode === 'ctf' || this.settings.mode === 'duel')
      ? this.settings.mode : 'ffa';
    this.durationMs = (parseInt(this.settings.matchMinutes, 10) || 5) * 60 * 1000;
    this.cfg = defaultCfg(this.mode);

    this.players = new Map();
    this.projectiles = [];   // 巡飞弹（带弧线轨迹）
    this.shots = [];         // 机炮曳光（本 tick 内累积，广播后清空）
    this.beams = [];         // 激光束（本 tick）
    this.explosions = [];    // 爆炸（本 tick）
    this.impacts = [];       // 弹着点（子弹撞墙/命中，本 tick）：{x,y,z}
    this.hits = [];          // 命中反馈（本 tick）：{shooterId, victimId, part, dmg}
    this.killfeed = [];
    this.pickups = MAP.pickups.map((p, i) => ({
      id: i, x: p.x, z: p.z, type: 'health', active: true, respawnAt: 0,
    }));
    this.timer = null;
    this.active = true;   // 对局进行中（结束后忽略后续输入）
    this.startedAt = 0;
    this._ended = false;
    this.zone = { spot: 0, x: ZONE_SPOTS[0].x, z: ZONE_SPOTS[0].z, y: ZONE_SPOTS[0].y, r: ZONE_R, nextMoveAt: 0 };

    // 死斗模式状态（大局计分制：回合制，先赢 DUEL_ROUND_WINS 回合获胜）
    this.duel = null;
    if (this.mode === 'duel') {
      this.duel = {
        phase: 'play',            // play | roundOver
        round: 1,
        roundWins: [0, 0],        // 大局计分（回合胜场）
        roundKills: [0, 0],       // 本回合击杀数（回合到时判定）
        roundEndsAt: 0,
        roundOverAt: 0,
        bases: DUEL_BASES.map((b) => ({ team: b.team, x: b.x, z: b.z, coreAlive: true, deploy: 0 })),
        coreRadius: DUEL_CORE_RADIUS,
        deployNeed: DUEL_DEPLOY_SEC,
        winnerTeam: null,         // 大局胜方
      };
    }

    // 夺旗卡牌赛状态
    this.ctf = null;
    if (this.mode === 'ctf') {
      this.ctf = {
        phase: 'vote',       // vote | play | roundOver
        round: 0,
        scores: [0, 0],      // 本回合红/蓝捕获数
        roundWins: [0, 0],   // 回合胜场
        cards: [],           // 本轮 3 张卡
        applied: null,       // 本轮生效卡
        votes: new Map(),    // sessionId -> 卡下标
        voteEndsAt: 0,
        roundEndsAt: 0,
        roundOverAt: 0,
        flags: CTF_BASES.map((b) => ({
          team: b.team, x: b.x, z: b.z, atBase: true,
          carrier: null, dropX: 0, dropZ: 0, returnAt: 0,
        })),
      };
    }
  }

  // ---------- 对局生命周期 ----------
  // seeds: [{ socketId, name, sessionId, mechs }]（来自房间成员）
  start(seeds) {
    for (let i = 0; i < seeds.length; i++) this.attachPlayer(seeds[i].socketId, seeds[i], i);
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.zone.nextMoveAt = Date.now() + ZONE_MOVE_MS;
    if (this.mode === 'ctf') this.startCtfRound();
    if (this.mode === 'duel') this.duel.roundEndsAt = Date.now() + DUEL_ROUND_MS;
    console.log(`[neon-arena][${this.roomId}] 对局开始 ${this.mode} 人数上限 ${this.maxPlayers} 时长 ${this.durationMs / 60000}min`);
  }

  // 对局开始时把房间成员接入游戏（seedIdx 用于轮流分边）
  attachPlayer(socketId, seed, seedIdx) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) return null;
    socket.join(this.roomId);
    const p = this.createPlayer(socketId, seed, seedIdx);
    this.players.set(socketId, p);
    this.bindSocket(socket, p);
    socket.emit('welcome', {
      id: p.id, name: p.name, color: p.color, team: p.team,
      map: MAP, self: this.pubMe(p), resumed: false, mode: this.mode,
    });
    this.sendMe(p);
    this.emit('playerJoined', { id: p.id, name: p.name, team: p.team });
    console.log(`[neon-arena][${this.roomId}] [+] ${p.name} joined (${this.players.size}/${this.maxPlayers})`);
    return p;
  }

  // 对局中断线重连：同 sessionId 恢复原玩家（分数/位置/模块血量全保留）
  resume(socket, sessionId) {
    if (!sessionId || !this.active) return false;
    for (const [oldId, p] of this.players) {
      if (p.sessionId !== sessionId || p.connected) continue;
      this.players.delete(oldId);
      const oldSock = this.io.sockets.sockets.get(oldId);
      if (oldSock && oldSock.id !== socket.id) oldSock.disconnect(true); // 踢掉旧连接
      p.id = socket.id;
      p.connected = true;
      p.leftAt = 0;
      p.input = { fwd: 0, strafe: 0, jump: false, fire: false };
      this.players.set(socket.id, p);
      socket.join(this.roomId);
      this.bindSocket(socket, p);
      socket.emit('welcome', {
        id: p.id, name: p.name, color: p.color, team: p.team,
        map: MAP, self: this.pubMe(p), resumed: true, mode: this.mode,
      });
      this.sendMe(p);
      console.log(`[neon-arena][${this.roomId}] [↻] ${p.name} 恢复连接`);
      return oldId; // 返回旧 socketId，供 RoomManager 迁移房间席位
    }
    return false;
  }

  bindSocket(socket, p) {
    // 同一 socket 可能跨多局（再来一局）：先摘掉上一局挂的处理器，避免重复监听
    if (socket._naGame) {
      socket.removeListener('input', socket._naGame.input);
      socket.removeListener('vote', socket._naGame.vote);
      socket.removeListener('ping', socket._naGame.ping);
      socket.removeListener('suicide', socket._naGame.suicide);
      socket.removeListener('lock', socket._naGame.lock);
      socket.removeListener('mech:select', socket._naGame.mechSelect);
      socket.removeListener('mech:config', socket._naGame.mechConfig);
      socket.removeListener('disconnect', socket._naGame.disconnect);
    }
    const h = {
      input: (d) => this.onInput(p.id, d),
      vote: (d) => this.onVote(p.id, d),
      ping: (cb) => { if (typeof cb === 'function') cb(Date.now()); },
      suicide: () => this.onSuicide(p.id),
      lock: (d) => this.onLock(p.id, d),
      mechSelect: (d) => this.onMechSelect(p.id, d),
      mechConfig: (d) => this.onMechConfig(p.id, d),
      disconnect: () => this.onLeave(p.id),
    };
    socket._naGame = h;
    socket.on('input', h.input);
    socket.on('vote', h.vote);
    socket.on('ping', h.ping);
    socket.on('suicide', h.suicide);
    socket.on('lock', h.lock);
    socket.on('mech:select', h.mechSelect);
    socket.on('mech:config', h.mechConfig);
    socket.on('disconnect', h.disconnect);
  }

  // 机甲配置列表（机库 2 个槽位），非法输入回退默认
  normalizeMechList(raw) {
    const list = Array.isArray(raw) ? raw.slice(0, 2) : [];
    const out = list.map(normalizeMech);
    if (!out.length) out.push({ type: DEFAULT_MECH, weapons: [] });
    return out;
  }

  createPlayer(socketId, seed, seedIdx) {
    const idx = this.players.size % COLORS.length;
    let team = 0;
    if (isTeamMode(this.mode)) {
      // 开局轮流分边；中途加入补进人数少的一边
      if (typeof seedIdx === 'number') team = seedIdx % 2;
      else {
        const counts = [0, 0];
        for (const p of this.players.values()) counts[p.team]++;
        team = counts[0] <= counts[1] ? 0 : 1;
      }
    }
    const spawn = this.pickSpawn(isTeamMode(this.mode) ? team : null);
    const color = isTeamMode(this.mode) ? TEAM_COLORS[team] : COLORS[idx];
    const mechs = this.normalizeMechList(seed && seed.mechs);
    const p = {
      id: socketId,
      name: sanitizeName(seed && seed.name),
      color,
      team,
      sessionId: (seed && typeof seed.sessionId === 'string') ? seed.sessionId : '',
      connected: true,
      leftAt: 0,
      pos: { x: spawn.x, y: 0, z: spawn.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: Math.random() * Math.PI * 2,
      pitch: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      assists: 0,        // 助攻（Tab KDA）
      recentHits: new Map(), // 助攻追踪：victimId 近期伤害来源
      alive: false,      // 开局先选择机甲（局内选择），选定后才出生
      respawnAt: 0,
      respawnIn: 0,
      grounded: true,
      input: { fwd: 0, strafe: 0, jump: false, fire: false },
      mechs,           // 机库配置 [{type, weapons}, ...]（死斗=两次生命）
      mechIndex: 0,    // 当前出战机甲下标
      usedMechs: this.mode === 'duel' ? new Set() : null, // 死斗：已损毁机甲下标
      lives: this.mode === 'duel' ? mechs.length : Infinity,
      burns: new Map(),// 激光灼烧：ownerId -> {dps, endsAt, part, legIndex}
      lockId: null,    // 武器索敌锁定目标 socketId（客户端上报，服务端校验）
    };
    this.applyMech(p, mechs[0]);
    return p;
  }

  // 给玩家套上一台机甲（重置模块血量与武器状态）
  applyMech(p, mechCfg) {
    const cfg = MECHS[mechCfg.type] || MECHS[DEFAULT_MECH];
    p.mechType = mechCfg.type;
    p.weapons = normalizeWeapons(mechCfg.weapons, cfg.mounts);
    p.mech = {
      legs: Array.from({ length: cfg.legs }, () => cfg.legHp),
      chest: Math.round(cfg.chestHp * this.cfg.chestMul),
      chestMax: Math.round(cfg.chestHp * this.cfg.chestMul),
      core: cfg.coreHp,
      chestBroken: false,
    };
    p.legsDestroyed = 0;
    p.weaponState = p.weapons.map((t) => {
      const w = WEAPONS[t];
      if (t === 'laser') return { type: t, charge: 1 };
      return { type: t, ammo: w.mag, reloading: false, reloadEndsAt: 0, fireCd: 0 };
    });
    p.burns = new Map();
  }

  // 卡牌改变胸部血量上限后，同步现有玩家（不补偿已损毁血量）
  rescaleChest() {
    for (const p of this.players.values()) {
      const base = MECHS[p.mechType].chestHp;
      p.mech.chestMax = Math.round(base * this.cfg.chestMul);
      p.mech.chest = Math.min(p.mech.chest, p.mech.chestMax);
    }
  }

  onLeave(id) {
    const p = this.players.get(id);
    if (!p) return;
    // 断线保留：站桩等待同 sessionId 重连（15s 内恢复则无缝回场）
    p.connected = false;
    p.leftAt = Date.now();
    p.input.fire = false;
    this.projectiles = this.projectiles.filter((pr) => pr.owner !== id);
    console.log(`[neon-arena][${this.roomId}] [-] ${p.name} 断线（保留 ${RECONNECT_GRACE_MS / 1000}s）`);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.projectiles = this.projectiles.filter((pr) => pr.owner !== id);
    this.clearLocksOn(id);
    this.emit('playerLeft', { id });
    console.log(`[neon-arena][${this.roomId}] [-] ${p.name} 移除`);
    if (this.hooks.onPlayerGone) this.hooks.onPlayerGone(id);
  }

  // 目标死亡/离开后，清除所有玩家对它的锁定
  clearLocksOn(targetId) {
    for (const p of this.players.values()) {
      if (p.lockId === targetId) p.lockId = null;
    }
  }

  pickSpawn(team) {
    let list;
    // CTF / 死斗：使用双方小队专属重生点
    if (isTeamMode(this.mode) && (team === 0 || team === 1)) {
      list = MAP.teamSpawns.filter((s) => s.team === team).map((s) => ({ x: s.x, z: s.z }));
    } else {
      list = MAP.spawns.slice();
    }
    if (!list.length) list = MAP.spawns.slice();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    for (const s of list) {
      let ok = true;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.pos.x - s.x, dz = p.pos.z - s.z;
        if (dx * dx + dz * dz < 4) { ok = false; break; }
      }
      if (ok) return s;
    }
    return list[0];
  }

  onInput(playerId, data) {
    const p = this.players.get(playerId);
    if (!this.active || !p || !p.connected || !data) return;
    if (p.alive) {
      p.input.fwd = clamp(Number(data.fwd) || 0, -1, 1);
      p.input.strafe = clamp(Number(data.strafe) || 0, -1, 1);
      p.input.jump = !!data.jump;
      // 夺旗者不能开枪
      p.input.fire = !!data.fire && !this.isFlagCarrier(p.id);
      if (Number.isFinite(data.yaw)) p.yaw = data.yaw;
      if (Number.isFinite(data.pitch)) p.pitch = clamp(data.pitch, -1.5, 1.5);
      // 准星瞄准点（第三人称下与相机视线一致），未索敌时武器朝它开火
      if (Number.isFinite(data.aimX) && Number.isFinite(data.aimY) && Number.isFinite(data.aimZ)) {
        p.aim = { x: data.aimX, y: data.aimY, z: data.aimZ };
      }
    }
  }

  // ---------- 自杀机制（ESC 菜单 / 长按 J 3 秒触发） ----------
  onSuicide(playerId) {
    const p = this.players.get(playerId);
    if (!this.active || !p || !p.connected || !p.alive) return;
    this.killPlayer(p, null, Date.now(), 'suicide');
  }

  // ---------- 武器索敌（锁定） ----------
  // 客户端瞄准敌人时上报锁定；锁定后武器即使不瞄向目标也能精准命中
  onLock(playerId, data) {
    const p = this.players.get(playerId);
    if (!this.active || !p || !p.connected || !p.alive || !data) return;
    const tid = data.targetId;
    if (tid === null || tid === undefined) { p.lockId = null; return; }
    if (typeof tid !== 'string' || tid === playerId) { p.lockId = null; return; }
    const t = this.players.get(tid);
    if (!t || !t.alive || !t.connected) { p.lockId = null; return; }
    if (isTeamMode(this.mode) && t.team === p.team) { p.lockId = null; return; }
    // 队友锁定共享：队友已锁定该目标则直接跟随锁定（可穿墙）
    if (isTeamMode(this.mode) && this.teammateLocked(p, tid)) { p.lockId = tid; return; }
    if (!this.hasLOS(p, t)) { p.lockId = null; return; } // 墙体阻隔
    p.lockId = tid;
  }

  // 两点间视线是否被墙体阻隔（瞄准高度）
  hasLOS(a, b) {
    const x0 = a.pos.x, y0 = a.pos.y + 1.2, z0 = a.pos.z;
    const x1 = b.pos.x, y1 = b.pos.y + 1.0, z1 = b.pos.z;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(len / 0.4));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (this.hitColliderAt(x0 + dx * f, y0 + dy * f, z0 + dz * f)) return false;
    }
    return true;
  }

  // 是否有队友正在锁定该目标（队友锁定可共享锁定）
  teammateLocked(p, tid) {
    for (const q of this.players.values()) {
      if (q !== p && q.team === p.team && q.lockId === tid) return true;
    }
    return false;
  }

  // 局内选择机甲（开局与死亡后均可）：选定即出生
  // 死斗：只能选未损毁的机甲；其他模式：可在机库机甲间任意切换
  onMechSelect(playerId, data) {
    const p = this.players.get(playerId);
    if (!this.active || !p || !p.connected || !data) return;
    const idx = parseInt(data.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.mechs.length) return;
    if (this.mode === 'duel' && p.usedMechs && p.usedMechs.has(idx)) return; // 已损毁的机甲不可再选
    if (p.alive) return; // 仅死亡等待复活时可换机甲
    p.mechIndex = idx;
    if (this.mode === 'duel') p.lives = Math.max(0, p.mechs.length - (p.usedMechs ? p.usedMechs.size : 0));
    this.respawn(p); // 直接以所选机甲出生
    this.sendMe(p);
    console.log(`[neon-arena][${this.roomId}] [mech] ${p.name} 选择机甲 ${p.mechIndex}（${p.mechs[idx].type}）`);
  }

  // 局内武器模块配置（机甲选择面板中调整武器，下次部署生效）
  onMechConfig(playerId, data) {
    const p = this.players.get(playerId);
    if (!this.active || !p || !p.connected || !data) return;
    const idx = parseInt(data.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.mechs.length) return;
    const cfg = MECHS[p.mechs[idx].type];
    p.mechs[idx].weapons = normalizeWeapons(data.weapons, cfg.mounts);
    this.sendMe(p);
  }

  // 返回当前有效锁定目标（或 null）；墙体阻隔且队友未锁则解锁（无距离限制：全图可锁）
  validLock(p) {
    if (!p.lockId) return null;
    const t = this.players.get(p.lockId);
    if (!t || !t.alive || !t.connected) { p.lockId = null; return null; }
    if (isTeamMode(this.mode) && t.team === p.team) { p.lockId = null; return null; }
    if (!this.hasLOS(p, t) && !(isTeamMode(this.mode) && this.teammateLocked(p, p.lockId))) {
      p.lockId = null; // 墙体阻隔且队友未锁 → 解锁
      return null;
    }
    return t;
  }

  // 锁定命中模块判定：优先可造成伤害的模块（无存活腿则打胸部）
  lockedModule(t) {
    let aliveLegs = 0;
    for (const h of t.mech.legs) if (h > 0) aliveLegs++;
    const part = (aliveLegs > 0 && Math.random() < 0.5) ? MODULE_LEG : MODULE_CHEST;
    return { part, legIndex: part === MODULE_LEG ? this.randomAliveLeg(t) : null };
  }

  // 准星模块判定：按射手瞄准射线落在目标上的高度决定打腿还是打胸
  // （准星对准目标腿部 → 弹道命中腿部模块；对准胸部 → 命中胸部）
  aimModulePart(shooter, target) {
    const cfg = MECHS[target.mechType] || MECHS[DEFAULT_MECH];
    if (!shooter.aim) return this.lockedModule(target);
    const ox = shooter.pos.x, oy = shooter.pos.y + EYE_H, oz = shooter.pos.z;
    const ax = shooter.aim.x - ox, ay = shooter.aim.y - oy, az = shooter.aim.z - oz;
    const al = Math.hypot(ax, ay, az) || 1;
    const dx = ax / al, dy = ay / al, dz = az / al;
    const horiz = Math.hypot(dx, dz) || 1;
    const tHoriz = Math.hypot(target.pos.x - ox, target.pos.z - oz);
    const yAt = oy + dy * (tHoriz / horiz);
    const relY = yAt - target.pos.y;
    if (relY <= cfg.legHeight) return { part: MODULE_LEG, legIndex: this.randomAliveLeg(target) };
    return { part: MODULE_CHEST, legIndex: null };
  }

  // ---------- CTF：卡牌投票 ----------
  onVote(playerId, data) {
    const p = this.players.get(playerId);
    if (!this.active || !p || this.mode !== 'ctf' || !this.ctf) return;
    if (this.ctf.phase !== 'vote') return;
    const card = data && data.card;
    if (!Number.isInteger(card) || card < 0 || card >= this.ctf.cards.length) return;
    // 以连接(playerId)为投票身份：同一浏览器多标签=多票（sessionId 会跨标签共享）
    const now = Date.now();
    const lastAt = this.ctf.voteAt.get(playerId) || 0;
    // 已投过且未过冷却：不可改选
    if (this.ctf.votes.has(playerId) && now - lastAt < CTF_VOTE_CHANGE_MS) return;
    this.ctf.votes.set(playerId, card);
    this.ctf.voteAt.set(playerId, now);
    // 广播每张卡当前票数（供客户端实时反馈）
    const tally = [0, 0, 0];
    for (const idx of this.ctf.votes.values()) tally[idx]++;
    this.emit('ctf:vote', { tally, voted: this.ctf.votes.size, total: this.players.size });
  }

  startCtfRound() {
    const c = this.ctf;
    c.round++;
    this.cfg = defaultCfg(this.mode); // 重置数值
    // 抽 3 张不重复的卡
    const pool = CARD_POOL.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    c.cards = pool.slice(0, 3).map((x) => ({ id: x.id, name: x.name, desc: x.desc }));
    c.applied = null;
    c.votes = new Map();
    c.voteAt = new Map();
    c.scores = [0, 0];
    c.phase = 'vote';
    c.voteEndsAt = Date.now() + CTF_VOTE_MS;
    for (const f of c.flags) this.resetFlag(f);
    this.emit('ctf:round', {
      round: c.round, cards: c.cards,
      roundWins: c.roundWins, scores: c.scores,
      voteEndsAt: c.voteEndsAt, voteMs: CTF_VOTE_MS,
    });
    console.log(`[neon-arena][${this.roomId}] [ctf] 第${c.round}回合 抽卡中`);
  }

  applyCtfCard() {
    const c = this.ctf;
    // 统计票数（平票随机）
    const tally = [0, 0, 0];
    for (const idx of c.votes.values()) tally[idx]++;
    let chosen = 0, best = -1;
    const top = [];
    for (let i = 0; i < tally.length; i++) {
      if (tally[i] > best) { best = tally[i]; top.length = 0; top.push(i); }
      else if (tally[i] === best) top.push(i);
    }
    chosen = top[Math.floor(Math.random() * top.length)];
    const card = CARD_POOL.find((x) => x.id === c.cards[chosen].id);
    if (card && card.apply) card.apply(this);
    c.applied = { id: card.id, name: card.name, desc: card.desc, votes: best, tally };
    c.phase = 'play';
    c.roundEndsAt = Date.now() + CTF_ROUND_MS;
    this.emit('ctf:card', { card: c.applied });
    this.emit('ctf:play', { roundEndsAt: c.roundEndsAt, roundMs: CTF_ROUND_MS });
    console.log(`[neon-arena][${this.roomId}] [ctf] 生效卡: ${card.name}（${best} 票）`);
  }

  endCtfRound(winnerTeam) {
    const c = this.ctf;
    if (c.phase === 'roundOver') return;
    c.phase = 'roundOver';
    c.roundOverAt = Date.now() + CTF_ROUND_OVER_MS;
    if (winnerTeam !== null && winnerTeam !== undefined) c.roundWins[winnerTeam]++;
    this.emit('ctf:roundEnd', { scores: c.scores, roundWins: c.roundWins, winnerTeam });
    console.log(`[neon-arena][${this.roomId}] [ctf] 第${c.round}回合结束 胜方=${winnerTeam === null ? '平局' : (winnerTeam === 0 ? '红' : '蓝')}`);
    // 胜负已分：结束整场对局
    if (winnerTeam !== null && c.roundWins[winnerTeam] >= CTF_ROUND_WINS) this.endGame();
  }

  // ---------- CTF：旗帜 ----------
  flagCarrierId() {
    for (const f of this.ctf.flags) if (f.carrier) return f.carrier;
    return null;
  }

  isFlagCarrier(playerId) {
    if (!this.ctf) return false;
    for (const f of this.ctf.flags) if (f.carrier === playerId) return true;
    return false;
  }

  resetFlag(f) {
    const base = CTF_BASES.find((b) => b.team === f.team);
    f.x = base.x; f.z = base.z;
    f.atBase = true;
    f.carrier = null;
    f.returnAt = 0;
    this.emit('ctf:flag', { team: f.team, atBase: true, carrier: null, x: f.x, z: f.z });
  }

  updateFlags(now) {
    const c = this.ctf;
    for (const f of c.flags) {
      if (f.carrier) {
        const carrier = this.players.get(f.carrier);
        // 携带者死亡/断线 → 旗落地
        if (!carrier || !carrier.connected || !carrier.alive) {
          f.dropX = carrier ? carrier.pos.x : f.x;
          f.dropZ = carrier ? carrier.pos.z : f.z;
          f.carrier = null;
          f.returnAt = now + CTF_FLAG_RETURN_MS;
          f.x = f.dropX; f.z = f.dropZ;
          this.emit('ctf:flag', { team: f.team, atBase: false, carrier: null, x: f.x, z: f.z });
        } else {
          // 携带者回到己方基地 → 得分
          const base = CTF_BASES[carrier.team];
          const dx = carrier.pos.x - base.x, dz = carrier.pos.z - base.z;
          if (dx * dx + dz * dz <= CTF_BASE_R * CTF_BASE_R) {
            this.ctfCapture(carrier);
          } else {
            f.x = carrier.pos.x; f.z = carrier.pos.z;
          }
        }
        continue;
      }
      // 无携带者：落地超时回基地
      if (!f.atBase && f.returnAt && now >= f.returnAt) {
        this.resetFlag(f);
        continue;
      }
      // 玩家交互：捡旗 / 队友碰旗送回
      for (const p of this.players.values()) {
        if (!p.alive || !p.connected) continue;
        const dx = p.pos.x - f.x, dz = p.pos.z - f.z;
        if (dx * dx + dz * dz > CTF_FLAG_PICKUP_R * CTF_FLAG_PICKUP_R) continue;
        if (p.team === f.team) {
          // 己方旗（掉落中）：碰一下送回基地
          if (!f.atBase) this.resetFlag(f);
          continue;
        }
        // 敌方旗：捡起
        f.carrier = p.id;
        f.atBase = false;
        f.x = p.pos.x; f.z = p.pos.z;
        this.emit('ctf:flag', { team: f.team, atBase: false, carrier: p.id, carrierName: p.name, x: f.x, z: f.z });
        break;
      }
    }
  }

  ctfCapture(carrier) {
    const c = this.ctf;
    c.scores[carrier.team]++;
    this.emit('ctf:capture', { team: carrier.team, scorerName: carrier.name, scores: c.scores, score: c.scores[carrier.team] });
    console.log(`[neon-arena][${this.roomId}] [ctf] ${carrier.name} 夺旗得分！红${c.scores[0]}-蓝${c.scores[1]}`);
    for (const f of c.flags) this.resetFlag(f);
    if (c.scores[carrier.team] >= CTF_CAPTURE_TARGET) this.endCtfRound(carrier.team);
  }

  // ---------- 死斗模式（大局计分制：回合制，先赢 2 回合获胜） ----------
  updateDuel(now) {
    const d = this.duel;
    if (!d || d.winnerTeam !== null) return;
    if (d.phase === 'roundOver') {
      // 回合数上限（防僵局）：超过上限直接按回合胜场结束整场，胜负由 endGame 依 roundWins 统计
      if (d.round >= DUEL_MAX_ROUNDS && d.roundWins[0] !== d.roundWins[1]) {
        const w = d.roundWins[0] > d.roundWins[1] ? 0 : 1;
        d.winnerTeam = w;
        this.endGame(w);
        return;
      }
      if (now >= d.roundOverAt) this.startNextDuelRound(now);
      return;
    }
    // 1) 回合到时：按本回合击杀数判定（平局无人得分，直接下一回合）
    if (now >= d.roundEndsAt) {
      const winner = d.roundKills[0] === d.roundKills[1] ? null : (d.roundKills[0] > d.roundKills[1] ? 0 : 1);
      this.duelRoundWin(winner, now, 'time');
      return;
    }
    // 2) 基地核心：敌方存活玩家靠近部署装置，累计 10 秒破坏核心 → 该队赢得回合
    for (const b of d.bases) {
      if (!b.coreAlive) continue;
      let enemyNear = false;
      for (const p of this.players.values()) {
        if (!p.alive || !p.connected || p.team === b.team) continue;
        const dx = p.pos.x - b.x, dz = p.pos.z - b.z;
        if (dx * dx + dz * dz <= d.coreRadius * d.coreRadius) { enemyNear = true; break; }
      }
      if (enemyNear) {
        b.deploy = Math.min(d.deployNeed, b.deploy + TICK_MS / 1000);
        if (b.deploy >= d.deployNeed) {
          b.coreAlive = false;
          this.emit('duel:core', { team: b.team, winnerTeam: 1 - b.team, x: b.x, z: b.z });
          this.duelRoundWin(1 - b.team, now, 'core');
          return;
        }
      } else {
        b.deploy = Math.max(0, b.deploy - (TICK_MS / 1000) * 2); // 离开则快速衰减
      }
    }
    // 3) 全灭判定：一方所有人都用完机甲（出局）→ 另一方赢得回合
    const teamActive = [false, false];
    for (const p of this.players.values()) {
      if (this.mode === 'duel') {
        if (p.usedMechs.size < p.mechs.length) teamActive[p.team] = true;
      } else {
        teamActive[p.team] = true;
      }
    }
    if (!teamActive[0] && !teamActive[1]) return; // 同归于尽：等回合到时按击杀判定
    if (!teamActive[0]) { this.duelRoundWin(1, now, 'elim'); return; }
    if (!teamActive[1]) { this.duelRoundWin(0, now, 'elim'); return; }
  }

  // 回合结束：计分 → 广播 → 判定大局胜负 / 准备下一回合
  duelRoundWin(winner, now, cause) {
    const d = this.duel;
    if (d.phase === 'roundOver') return;
    d.phase = 'roundOver';
    d.roundOverAt = now + 3500;
    if (winner === 0 || winner === 1) d.roundWins[winner]++;
    this.emit('duel:round', {
      round: d.round, roundWins: d.roundWins, winnerTeam: (winner === 0 || winner === 1) ? winner : null, cause,
    });
    console.log(`[neon-arena][${this.roomId}] [duel] 第${d.round}回合结束（${cause}）胜方=${winner === null ? '平局' : (winner === 0 ? '红' : '蓝')} 大局 ${d.roundWins[0]}:${d.roundWins[1]}`);
    // 大局胜负已分：先赢 DUEL_ROUND_WINS 回合的队伍获胜
    if ((winner === 0 || winner === 1) && d.roundWins[winner] >= DUEL_ROUND_WINS) {
      d.winnerTeam = winner;
      this.endGame(winner);
    }
  }

  // 下一回合：重置核心/玩家机甲，全员重新部署
  startNextDuelRound(now) {
    const d = this.duel;
    d.round++;
    d.phase = 'play';
    d.roundEndsAt = now + DUEL_ROUND_MS;
    d.roundKills = [0, 0];
    for (const b of d.bases) { b.coreAlive = true; b.deploy = 0; }
    for (const p of this.players.values()) {
      p.usedMechs.clear();
      p.lives = p.mechs.length;
      p.mechIndex = 0;
      p.respawnAt = now; // 下一 tick 自动复活（玩家也可在机甲选择面板换机甲）
      p.burns.clear();
    }
    this.emit('duel:round', { round: d.round, roundWins: d.roundWins, winnerTeam: null, cause: 'start' });
    console.log(`[neon-arena][${this.roomId}] [duel] 第${d.round}回合开始`);
  }

  // ---------- tick ----------
  tick() {
    if (!this.active) return;
    const now = Date.now();
    // 本 tick 的瞬态视觉数据（广播后即失效）
    this.shots = [];
    this.beams = [];
    this.explosions = [];
    this.impacts = [];
    this.hits = [];
    // 全员退出/断线超时 → 直接结束对局，避免空房间泄漏
    if (this.players.size === 0) { this.endGame(); return; }
    // 对局时长到点 → 结束（死斗除外：回合制由「先赢 13 回合」决定胜负，不受时间上限约束）
    if (this.mode !== 'duel' && now - this.startedAt >= this.durationMs) { this.endGame(); return; }

    if (this.mode === 'ctf') {
      const c = this.ctf;
      if (c.phase === 'vote' && now >= c.voteEndsAt) this.applyCtfCard();
      else if (c.phase === 'play') {
        if (now >= c.roundEndsAt) {
          // 回合到时：比分高者胜，平局则无人胜
          const winner = c.scores[0] === c.scores[1] ? null : (c.scores[0] > c.scores[1] ? 0 : 1);
          this.endCtfRound(winner);
        } else {
          this.updateFlags(now);
        }
      } else if (c.phase === 'roundOver') {
        if (now >= c.roundOverAt) {
          // 回合数上限（防僵局）：直接结束整场，胜负由 endGame 依 roundWins 统计
          if (c.round >= CTF_MAX_ROUNDS) {
            this.endGame();
            return;
          }
          this.startCtfRound();
        }
        return; // roundOver 期间不跑常规物理/广播（也可保留，简化：暂停）
      }
    }

    const dt = TICK_MS / 1000;
    for (const p of this.players.values()) {
      if (!p.connected) {
        if (now - p.leftAt > RECONNECT_GRACE_MS) this.removePlayer(p.id);
        continue;
      }
      if (!p.alive) {
        if (p.respawnAt && now >= p.respawnAt) this.respawn(p);
        // 开局选择机甲超时（8s）未选：自动以默认机甲出生
        else if (!p.respawnAt && now - this.startedAt > 8000) this.respawn(p);
        continue;
      }
      this.physics(p, dt);
      this.updateWeapons(p, dt, now);
      this.checkPickups(p, now);
    }
    this.updateProjectiles(dt, now);
    this.updatePickups(now);
    if (this.mode === 'zone') this.updateZone(now);
    if (this.mode === 'duel') this.updateDuel(now);
    this.broadcast(now);
  }

  // ---------- 机甲武器系统 ----------
  updateWeapons(p, dt, now) {
    for (let wi = 0; wi < p.weaponState.length; wi++) {
      const ws = p.weaponState[wi];
      if (ws.type === 'gau12') this.updateGau12(p, ws, wi, dt, now);
      else if (ws.type === 'laser') this.updateLaser(p, ws, wi, dt, now);
      else if (ws.type === 'loiter') this.updateLoiter(p, ws, wi, dt, now);
    }
  }

  // 各武器槽枪口位置：按机甲 muzzlePos（本地坐标绕 yaw 旋转）→ 每条弹幕从各自枪口射出
  muzzle(p, wi) {
    const cfg = MECHS[p.mechType] || MECHS[DEFAULT_MECH];
    if (cfg.muzzlePos && Number.isInteger(wi) && cfg.muzzlePos[wi]) {
      const m = cfg.muzzlePos[wi];
      const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
      return {
        x: p.pos.x + m.x * cos + m.z * sin,
        y: p.pos.y + m.y,
        z: p.pos.z - m.x * sin + m.z * cos,
      };
    }
    return { x: p.pos.x, y: p.pos.y + cfg.chestHeight * 0.8, z: p.pos.z };
  }

  // 视线射线：找第一个命中（墙壁 / 玩家模块），maxDist 米
  rayHit(origin, dir, maxDist, shooter) {
    const step = 0.25;
    for (let d = 0.5; d <= maxDist; d += step) {
      const x = origin.x + dir.x * d;
      const y = origin.y + dir.y * d;
      const z = origin.z + dir.z * d;
      if (this.hitColliderAt(x, y, z)) return { point: { x, y, z }, player: null, part: null, legIndex: null };
      for (const p of this.players.values()) {
        if (!p.alive || !p.connected || p.id === shooter.id) continue;
        if (isTeamMode(this.mode) && p.team === shooter.team) continue; // 团队模式不攻击同队
        const dx = p.pos.x - x, dz = p.pos.z - z;
        if (dx * dx + dz * dz > (PLAYER_R + 0.15) * (PLAYER_R + 0.15)) continue;
        const relY = y - p.pos.y;
        if (relY < -0.1 || relY > MECHS[p.mechType].chestHeight) continue;
        const part = relY <= MECHS[p.mechType].legHeight ? MODULE_LEG : MODULE_CHEST;
        return {
          point: { x, y, z }, player: p, part,
          legIndex: part === MODULE_LEG ? this.randomAliveLeg(p) : null,
        };
      }
    }
    return { point: { x: origin.x + dir.x * maxDist, y: origin.y + dir.y * maxDist, z: origin.z + dir.z * maxDist }, player: null, part: null, legIndex: null };
  }

  randomAliveLeg(p) {
    const alive = [];
    for (let i = 0; i < p.mech.legs.length; i++) if (p.mech.legs[i] > 0) alive.push(i);
    if (!alive.length) return 0;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  countLegsDestroyed(p) {
    let n = 0;
    for (const h of p.mech.legs) if (h <= 0) n++;
    return n;
  }

  // Gau12 破坏者：720 发/分，每发 1 伤害，弹体飞行（不穿墙），索敌锁定小幅强导
  updateGau12(p, ws, wi, dt, now) {
    const w = WEAPONS.gau12;
    if (ws.reloading) {
      if (now >= ws.reloadEndsAt) { ws.ammo = w.mag; ws.reloading = false; }
      return;
    }
    if (!p.input.fire || ws.ammo <= 0) return;
    ws.fireCd = (ws.fireCd || 0) - dt;
    if (ws.fireCd <= 0) {
      const rpmMul = this.cfg.weaponRpmMul || 1;
      ws.fireCd = 60 / w.rpm / rpmMul;
      const origin = this.muzzle(p, wi); // 各自枪口射出
      const locked = this.validLock(p);
      let dx, dy, dz;
      if (locked) {
        // 索敌锁定：弹道指向锁定目标的准星对应模块（腿/胸），即使玩家瞄向别处
        const lm = this.aimModulePart(p, locked);
        const cfg = MECHS[locked.mechType] || MECHS[DEFAULT_MECH];
        const aimY = locked.pos.y + (lm.part === MODULE_LEG ? cfg.legHeight * 0.5 : cfg.chestHeight * 0.72);
        const tx = locked.pos.x - origin.x, ty = aimY - origin.y, tz = locked.pos.z - origin.z;
        const tl = Math.hypot(tx, ty, tz) || 1;
        dx = tx / tl; dy = ty / tl; dz = tz / tl;
      } else if (p.aim) {
        // 未索敌：朝准星瞄准点开火（与第三人称准星一致）
        const tx = p.aim.x - origin.x, ty = p.aim.y - origin.y, tz = p.aim.z - origin.z;
        const tl = Math.hypot(tx, ty, tz) || 1;
        dx = tx / tl; dy = ty / tl; dz = tz / tl;
      } else {
        // 无瞄准点：各枪口收敛到瞄准线前方 15m 的共同目标点（多枪口弹幕合拢）
        const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
        const tx = p.pos.x - Math.sin(p.yaw) * cp * 15;
        const ty = p.pos.y + 1.5 + sp * 15;
        const tz = p.pos.z - Math.cos(p.yaw) * cp * 15;
        const ddx = tx - origin.x, ddy = ty - origin.y, ddz = tz - origin.z;
        const tl = Math.hypot(ddx, ddy, ddz) || 1;
        dx = ddx / tl; dy = ddy / tl; dz = ddz / tl;
      }
      this.projectiles.push({
        kind: 'bullet', owner: p.id,
        x: origin.x, y: origin.y, z: origin.z,
        dx, dy, dz,
        speed: 90, life: 1.1,
        lockedId: locked ? locked.id : null, // 飞行中温和修正
      });
      ws.ammo--;
      if (ws.ammo <= 0) { ws.reloading = true; ws.reloadEndsAt = now + w.reloadMs; }
    }
  }

  // 灼光镭射激光：持续光束，命中施加灼烧（每秒 15 伤害，持续 10 秒），30 秒满充能且可边打边充；索敌后光束指向锁定目标
  updateLaser(p, ws, wi, dt, now) {
    const w = WEAPONS.laser;
    // 始终充能（可边打边装填）
    ws.charge = Math.min(1, (ws.charge || 1) + dt / (w.chargeFullMs / 1000));
    if (!p.input.fire || ws.charge <= 0.01) { ws.beam = false; return; }
    ws.charge = Math.max(0, ws.charge - dt / (w.maxBeamMs / 1000));
    if (ws.charge <= 0.01) { ws.beam = false; return; }
    ws.beam = true;
    const origin = this.muzzle(p, wi); // 各自枪口射出光束
    const locked = this.validLock(p);
    let hit = null;
    if (locked) {
      const lm = this.aimModulePart(p, locked);
      hit = {
        point: { x: locked.pos.x, y: locked.pos.y + 0.9, z: locked.pos.z },
        player: locked, part: lm.part, legIndex: lm.legIndex,
      };
    } else {
      let dir;
      if (p.aim) {
        // 未索敌：光束朝准星瞄准点
        const tx = p.aim.x - origin.x, ty = p.aim.y - origin.y, tz = p.aim.z - origin.z;
        const tl = Math.hypot(tx, ty, tz) || 1;
        dir = { x: tx / tl, y: ty / tl, z: tz / tl };
      } else {
        // 无瞄准点：各枪口光束收敛到瞄准线前方 15m 的共同目标点
        const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
        const tx = p.pos.x - Math.sin(p.yaw) * cp * 15;
        const ty = p.pos.y + 1.5 + sp * 15;
        const tz = p.pos.z - Math.cos(p.yaw) * cp * 15;
        const ddx = tx - origin.x, ddy = ty - origin.y, ddz = tz - origin.z;
        const tl = Math.hypot(ddx, ddy, ddz) || 1;
        dir = { x: ddx / tl, y: ddy / tl, z: ddz / tl };
      }
      hit = this.rayHit(origin, dir, 60, p);
    }
    this.beams.push({
      owner: p.id,
      x1: origin.x, y1: origin.y, z1: origin.z,
      x2: hit.point.x, y2: hit.point.y, z2: hit.point.z,
      targetId: hit.player ? hit.player.id : null,
    });
    if (hit.player) {
      // 照射持续伤害（无残留灼烧）：光束接触期间每秒 dmgPerSec，停止照射即停止伤害
      this.damageModule(hit.player, hit.part, w.dmgPerSec * (this.cfg.weaponDmgMul || 1) * dt, p.id, now, hit.legIndex);
    }
  }

  updateBurns(dt, now) {
    for (const p of this.players.values()) {
      if (!p.alive || !p.connected) { p.burns.clear(); continue; }
      for (const [ownerId, burn] of [...p.burns]) {
        if (now >= burn.endsAt) { p.burns.delete(ownerId); continue; }
        this.damageModule(p, burn.part, burn.dps * dt, ownerId, now, burn.legIndex);
      }
    }
  }

  // 蜂群巡飞弹：弹夹 5 发一次性全部打出，15 秒装填，有散布，弧线越地形
  updateLoiter(p, ws, wi, dt, now) {
    const w = WEAPONS.loiter;
    if (ws.reloading) {
      if (now >= ws.reloadEndsAt) { ws.ammo = w.mag; ws.reloading = false; }
      return;
    }
    if (!p.input.fire || ws.ammo < w.volley) return;
    const origin = this.muzzle(p, wi); // 各自枪口射出
    const locked = this.validLock(p);
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const dir = { x: -Math.sin(p.yaw) * cp, y: sp, z: -Math.cos(p.yaw) * cp };
    for (let i = 0; i < w.volley; i++) {
      let gx, gz;
      if (locked) {
        // 索敌锁定：巡飞弹直接飞向锁定目标当前位置（仍带小散布）
        gx = locked.pos.x;
        gz = locked.pos.z;
      } else if (p.aim) {
        // 未索敌：朝准星瞄准点
        gx = p.aim.x;
        gz = p.aim.z;
      } else {
        // 瞄准点：视线与地面交点
        const tGround = (dir.y < -0.01) ? (-origin.y / dir.y) : 60;
        gx = origin.x + dir.x * tGround;
        gz = origin.z + dir.z * tGround;
      }
      const ang = Math.random() * Math.PI * 2;
      // 锁定时无散布（精准命中锁定目标）；未锁定时按比例散布
      const rad = locked ? 0 : Math.random() * w.spread * Math.max(5, Math.hypot(gx - origin.x, gz - origin.z));
      const tx = gx + Math.cos(ang) * rad;
      const tz = gz + Math.sin(ang) * rad;
      const dist = Math.hypot(tx - origin.x, tz - origin.z);
      const dur = Math.max(0.9, dist / (w.speed * (this.cfg.loiterSpeedMul || 1)));
      this.projectiles.push({
        kind: 'loiter', owner: p.id,
        x0: origin.x, y0: origin.y, z0: origin.z,
        tx, tz, arcH: w.arcHeight,
        lockedId: locked ? locked.id : null, // 追踪锁定目标
        t: 0, dur,
        x: origin.x, y: origin.y, z: origin.z,
      });
    }
    ws.ammo -= w.volley;
    if (ws.ammo <= 0) { ws.reloading = true; ws.reloadEndsAt = now + w.reloadMs; }
  }

  updateProjectiles(dt, now) {
    const next = [];
    for (const pr of this.projectiles) {
      if (pr.kind === 'loiter') {
        pr.t += dt;
        // 弹道追踪：锁定目标存活则持续修正落点（小幅强导）
        if (pr.lockedId) {
          const tgt = this.players.get(pr.lockedId);
          if (tgt && tgt.alive && tgt.connected) {
            const kk = Math.min(1, pr.t / pr.dur);
            const blend = 1 - kk; // 前期修正强，末端收敛
            pr.tx += (tgt.pos.x - pr.tx) * blend * 0.35;
            pr.tz += (tgt.pos.z - pr.tz) * blend * 0.35;
          } else {
            pr.lockedId = null;
          }
        }
        const k = Math.min(1, pr.t / pr.dur);
        pr.x = pr.x0 + (pr.tx - pr.x0) * k;
        pr.z = pr.z0 + (pr.tz - pr.z0) * k;
        pr.y = pr.y0 + pr.arcH * 4 * k * (1 - k); // 抛物线弧线，越过高地形
        if (k >= 1) {
          this.explodeLoiter(pr, now);
          this.explosions.push({ x: pr.x, y: pr.y, z: pr.z, owner: pr.owner, kind: 'loiter' });
          continue;
        }
        next.push(pr);
        continue;
      }
      if (pr.kind === 'bullet') {
        pr.life -= dt;
        if (pr.life <= 0) continue;
        const x0 = pr.x, y0 = pr.y, z0 = pr.z;
        // 索敌修正：温和转向锁定目标（初始已指向目标，仅追踪移动）
        if (pr.lockedId) {
          const tgt = this.players.get(pr.lockedId);
          if (tgt && tgt.alive && tgt.connected) {
            const tx = tgt.pos.x - pr.x, ty = tgt.pos.y + 0.9 - pr.y, tz = tgt.pos.z - pr.z;
            const tl = Math.hypot(tx, ty, tz) || 1;
            const steer = 0.15;
            pr.dx += (tx / tl - pr.dx) * steer;
            pr.dy += (ty / tl - pr.dy) * steer;
            pr.dz += (tz / tl - pr.dz) * steer;
            const dl = Math.hypot(pr.dx, pr.dy, pr.dz) || 1;
            pr.dx /= dl; pr.dy /= dl; pr.dz /= dl;
          } else {
            pr.lockedId = null;
          }
        }
        pr.x += pr.dx * pr.speed * dt;
        pr.y += pr.dy * pr.speed * dt;
        pr.z += pr.dz * pr.speed * dt;
        // 分段检测：撞墙消失（子弹不穿墙）/ 命中玩家模块
        const seg = Math.hypot(pr.x - x0, pr.y - y0, pr.z - z0);
        const steps = Math.max(1, Math.ceil(seg / 0.25));
        let dead = false;
        for (let i = 1; i <= steps; i++) {
          const f = i / steps;
          const x = x0 + (pr.x - x0) * f;
          const y = y0 + (pr.y - y0) * f;
          const z = z0 + (pr.z - z0) * f;
          if (this.hitColliderAt(x, y, z)) {
            if (this.impacts.length < 40) this.impacts.push({ x, y, z });
            dead = true;
            break;
          }
          for (const p of this.players.values()) {
            if (!p.alive || !p.connected || p.id === pr.owner) continue;
            const owner = this.players.get(pr.owner);
            if (owner && isTeamMode(this.mode) && p.team === owner.team) continue;
            const dx = x - p.pos.x, dz = z - p.pos.z;
            if (dx * dx + dz * dz > (PLAYER_R + 0.12) * (PLAYER_R + 0.12)) continue;
            const relY = y - p.pos.y;
            if (relY < -0.1 || relY > MECHS[p.mechType].chestHeight) continue;
            const part = relY <= MECHS[p.mechType].legHeight ? MODULE_LEG : MODULE_CHEST;
            const legIdx = part === MODULE_LEG ? this.randomAliveLeg(p) : null;
            this.damageModule(p, part, WEAPONS.gau12.dmg * (this.cfg.weaponDmgMul || 1), pr.owner, now, legIdx);
            if (this.impacts.length < 40) this.impacts.push({ x, y, z });
            dead = true;
            break;
          }
          if (dead) break;
        }
        if (!dead) next.push(pr);
        continue;
      }
    }
    this.projectiles = next;
  }

  explodeLoiter(pr, now) {
    const shooter = this.players.get(pr.owner);
    const w = WEAPONS.loiter;
    for (const p of this.players.values()) {
      if (!p.alive || !p.connected || p.id === pr.owner) continue;
      if (shooter && isTeamMode(this.mode) && p.team === shooter.team) continue;
      const dx = p.pos.x - pr.x, dz = p.pos.z - pr.z;
      if (dx * dx + dz * dz <= w.blastRadius * w.blastRadius) {
        // 爆炸命中随机模块：50% 腿（随机存活腿）/ 50% 胸部
        const part = Math.random() < 0.5 ? MODULE_LEG : MODULE_CHEST;
        const legIdx = part === MODULE_LEG ? this.randomAliveLeg(p) : null;
        this.damageModule(p, part, w.dmg * (this.cfg.weaponDmgMul || 1), pr.owner, now, legIdx);
      }
    }
  }

  hitColliderAt(x, y, z) {
    for (const c of colliders) {
      if (x > c.minX - 0.2 && x < c.maxX + 0.2 &&
        y > c.minY - 0.2 && y < c.maxY + 0.2 &&
        z > c.minZ - 0.2 && z < c.maxZ + 0.2) return true;
    }
    return false;
  }

  // ---------- 模块伤害与死亡 ----------
  // part: leg | chest | core；legIdx 可选（不传则随机存活腿）
  // 助攻：记录 10 秒内对目标造成过伤害的射手（击杀时结算）
  damageModule(victim, part, dmg, killerId, now, legIdx) {
    if (!victim || !victim.alive || !victim.connected || dmg <= 0) return false;
    // 助攻追踪：10 秒内对目标造成过伤害的玩家（排除自己）
    if (killerId && killerId !== victim.id) {
      if (!victim.recentHits) victim.recentHits = new Map();
      victim.recentHits.set(killerId, now);
    }
    // 命中反馈（限流，避免每 tick 数十条）
    if (this.hits.length < 40) {
      this.hits.push({ shooterId: killerId, victimId: victim.id, part, dmg: Math.round(dmg * 100) / 100 });
    }
    const m = victim.mech;
    if (part === MODULE_LEG) {
      const idx = (Number.isInteger(legIdx) && m.legs[legIdx] > 0)
        ? legIdx : this.randomAliveLeg(victim);
      if (idx == null) return false;
      m.legs[idx] = Math.max(0, m.legs[idx] - dmg);
      if (m.legs[idx] === 0) {
        const before = victim.legsDestroyed;
        victim.legsDestroyed = this.countLegsDestroyed(victim);
        this.emit('moduleBroken', { id: victim.id, part: MODULE_LEG, legIndex: idx, legsDestroyed: victim.legsDestroyed });
        if (before !== victim.legsDestroyed) this.sendMe(victim);
      }
      this.sendMe(victim);
      return false;
    }
    if (part === MODULE_CHEST) {
      m.chest = Math.max(0, m.chest - dmg);
      if (m.chest === 0 && !m.chestBroken) {
        m.chestBroken = true;
        this.emit('moduleBroken', { id: victim.id, part: MODULE_CHEST });
      }
      // 胸部血量耗尽后：子弹有概率直接伤害核心
      if (m.chestBroken && Math.random() < CORE_HIT_CHANCE) {
        this.sendMe(victim);
        return this.damageModule(victim, MODULE_CORE, dmg, killerId, now, null);
      }
      this.sendMe(victim);
      return false;
    }
    if (part === MODULE_CORE) {
      m.core = Math.max(0, m.core - dmg);
      if (m.core <= 0) {
        this.killPlayer(victim, killerId, now, 'core');
        return true;
      }
      this.sendMe(victim);
      return false;
    }
    return false;
  }

  killPlayer(victim, killerId, now, cause) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.deaths++;
    const killer = this.players.get(killerId);
    const validKill = killer && killer !== victim && killer.alive &&
      (!isTeamMode(this.mode) || killer.team !== victim.team);
    if (validKill) {
      killer.kills++;
      killer.score += (this.mode === 'zone') ? 10 : 100;
      if (this.mode === 'duel' && this.duel && this.duel.phase === 'play') {
        this.duel.roundKills[killer.team]++; // 大局计分：本回合击杀
      }
      this.sendMe(killer);
    }
    // 助攻结算：10 秒内对目标造成过伤害的其他玩家（排除击杀者）
    if (victim.recentHits) {
      for (const [aid, ts] of victim.recentHits) {
        if (aid === killerId || now - ts > 10000) continue;
        const ap = this.players.get(aid);
        if (!ap || !ap.connected) continue;
        if (isTeamMode(this.mode) && ap.team === victim.team) continue; // 同队伤害不算助攻
        ap.assists = (ap.assists || 0) + 1;
        this.sendMe(ap);
      }
      victim.recentHits.clear();
    }
    this.clearLocksOn(victim.id);
    victim.lockId = null;
    this.killfeed.unshift({
      id: Math.random().toString(36).slice(2, 8),
      killer: killer ? killer.name : (cause === 'suicide' ? '自爆' : '?'),
      victim: victim.name,
      ts: now,
    });
    if (this.killfeed.length > KILLFEED_MAX) this.killfeed.pop();
    this.emit('kill', {
      victimId: victim.id,
      killerId: killer ? killer.id : null,
      killerName: killer ? killer.name : (cause === 'suicide' ? '自爆' : '?'),
      victimName: victim.name,
      cause,
    });
    if (this.mode === 'duel') {
      // 死斗：标记该机甲已损毁；仍有剩余机甲则等待复活（可用局内选择换机甲），否则出局观战
      victim.usedMechs.add(victim.mechIndex);
      victim.lives = Math.max(0, victim.mechs.length - victim.usedMechs.size);
      victim.respawnAt = (victim.usedMechs.size < victim.mechs.length) ? now + this.cfg.respawnMs : 0;
      this.emit('duel:lives', { id: victim.id, lives: victim.lives, mechIndex: victim.mechIndex });
    } else {
      victim.respawnAt = now + this.cfg.respawnMs;
    }
    this.sendMe(victim);
  }

  respawn(p) {
    // 死斗：自动挑一台未损毁的机甲（局内选择可覆盖）
    if (this.mode === 'duel' && p.usedMechs) {
      for (let i = 0; i < p.mechs.length; i++) {
        if (!p.usedMechs.has(i)) { p.mechIndex = i; break; }
      }
    }
    const mechCfg = p.mechs[Math.min(p.mechIndex, p.mechs.length - 1)] || p.mechs[0];
    this.applyMech(p, mechCfg);
    const s = this.pickSpawn(isTeamMode(this.mode) ? p.team : null);
    p.pos.x = s.x; p.pos.y = 0; p.pos.z = s.z;
    p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
    p.alive = true;
    p.respawnAt = 0;
    p.input.fire = false; // 复活时重置开火，避免卡键连续射击
    this.sendMe(p);
  }

  // ---------- 物理 ----------
  physics(p, dt) {
    // 重力
    p.vel.y -= this.cfg.gravity * dt;
    if (p.vel.y < -MAX_FALL) p.vel.y = -MAX_FALL;
    // 腿部损毁减速 × 旗手惩罚 × 机甲基础移速倍率
    const legMul = mechSpeedMul(p.mechType, p.legsDestroyed);
    const baseMul = (MECHS[p.mechType] && MECHS[p.mechType].moveMul) || 1;
    const carrierMul = (this.mode === 'ctf' && this.isFlagCarrier(p.id)) ? CTF_CARRIER_SPEED_MUL : 1;
    const spd = this.cfg.moveSpeed * legMul * carrierMul * baseMul;
    // 水平速度（朝向由 yaw 决定）
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;
    if (spd <= 0) {
      p.vel.x = 0; p.vel.z = 0; // 蜘蛛 6 腿全毁：失去行动能力
    } else {
      p.vel.x = (fx * p.input.fwd + rx * p.input.strafe) * spd;
      p.vel.z = (fz * p.input.fwd + rz * p.input.strafe) * spd;
    }

    const wasGrounded = p.grounded;
    p.grounded = false;

    // 蜘蛛爬墙：贴墙且朝墙移动（或跳跃键）时垂直攀爬；超过墙顶自然脱离
    const canClimb = p.mechType === 'spider' && spd > 0 && p.mech.legs.some((h) => h > 0);
    let wallBlock = false;
    if (canClimb) {
      const vx0 = p.vel.x, vz0 = p.vel.z;
      moveAxis(p.pos, p.vel, 'x', dt, colliders);
      moveAxis(p.pos, p.vel, 'z', dt, colliders);
      wallBlock = (vx0 !== 0 && p.vel.x === 0) || (vz0 !== 0 && p.vel.z === 0);
    } else {
      moveAxis(p.pos, p.vel, 'x', dt, colliders);
      moveAxis(p.pos, p.vel, 'z', dt, colliders);
    }
    const wantClimb = canClimb && wallBlock && (p.input.fwd !== 0 || p.input.jump);
    p.climbing = wantClimb;
    if (wantClimb) p.vel.y = 7; // 攀爬速度（抵消重力后净上升 ~5.8m/s）

    if (moveAxis(p.pos, p.vel, 'y', dt, colliders)) p.grounded = true;

    if (p.pos.y <= 0 && p.vel.y <= 0) {
      p.pos.y = 0; p.vel.y = 0; p.grounded = true;
    }

    // 泰坦跳跃技能：可跳越部分墙体/低掩体；跳跃后需冷却（蜘蛛无跳跃，保留爬墙）
    // 受「弹跳」卡加成（cfg.jumpVel / JUMP_VEL 为卡牌倍率）；旗手跳跃 -35%
    const mechCfg = MECHS[p.mechType] || MECHS[DEFAULT_MECH];
    if (mechCfg.canJump && p.grounded && p.input.jump && (Date.now() - (p.lastJumpAt || 0)) >= mechCfg.jumpCooldownMs) {
      const carrierMul = (this.mode === 'ctf' && this.isFlagCarrier(p.id)) ? CTF_CARRIER_JUMP_MUL : 1;
      p.vel.y = mechCfg.jumpVel * (this.cfg.jumpVel / JUMP_VEL) * carrierMul;
      p.lastJumpAt = Date.now();
    }

    const half = MAP.size.x / 2 - PLAYER_R;
    p.pos.x = clamp(p.pos.x, -half, half);
    p.pos.z = clamp(p.pos.z, -half, half);

    for (const pad of MAP.jumpPads) {
      const dx = p.pos.x - pad.x, dz = p.pos.z - pad.z;
      if (dx * dx + dz * dz <= pad.radius * pad.radius && p.vel.y <= 0.5) {
        p.vel.y = pad.strength;
      }
    }
  }

  checkPickups(p, now) {
    // 旗手惩罚：不能捡血包
    if (this.mode === 'ctf' && this.isFlagCarrier(p.id) && CTF_CARRIER_NO_HEAL) return;
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      const dx = p.pos.x - pk.x, dz = p.pos.z - pk.z;
      if (dx * dx + dz * dz <= PICKUP_RANGE * PICKUP_RANGE) {
        pk.active = false;
        pk.respawnAt = now + PICKUP_RESPAWN_MS;
        const heal = this.cfg.pickupHeal;
        const m = p.mech;
        let healed = false;
        if (m.chest < m.chestMax) { m.chest = Math.min(m.chestMax, m.chest + heal); healed = true; }
        // 修复受损（未完全损毁）的腿部；损毁腿需重生才能恢复
        for (let i = 0; i < m.legs.length; i++) {
          if (m.legs[i] > 0 && m.legs[i] < MECHS[p.mechType].legHp) {
            m.legs[i] = Math.min(MECHS[p.mechType].legHp, m.legs[i] + heal);
            healed = true;
          }
        }
        if (healed) this.sendMe(p);
      }
    }
  }

  updatePickups(now) {
    for (const pk of this.pickups) {
      if (!pk.active && pk.respawnAt && now >= pk.respawnAt) {
        pk.active = true;
        pk.respawnAt = 0;
      }
    }
  }

  // ---------- 占点 ----------
  updateZone(now) {
    if (now >= this.zone.nextMoveAt) {
      let next;
      do { next = Math.floor(Math.random() * ZONE_SPOTS.length); } while (next === this.zone.spot);
      this.zone.spot = next;
      this.zone.x = ZONE_SPOTS[next].x;
      this.zone.z = ZONE_SPOTS[next].z;
      this.zone.y = ZONE_SPOTS[next].y;
      this.zone.nextMoveAt = now + ZONE_MOVE_MS;
      this.emit('zoneMove', { x: this.zone.x, z: this.zone.z, y: this.zone.y });
    }
    for (const p of this.players.values()) {
      if (!p.connected || !p.alive) continue;
      const dx = p.pos.x - this.zone.x, dz = p.pos.z - this.zone.z;
      if (dx * dx + dz * dz <= ZONE_R * ZONE_R) {
        p.score += ZONE_SCORE_PER_TICK;
        if (p.score >= ZONE_WIN) {
          this.endRound(p, now);
          break;
        }
      }
    }
  }

  endRound(winner, now) {
    this.emit('roundEnd', { winnerId: winner.id, winnerName: winner.name });
    for (const p of this.players.values()) p.score = 0;
    this.zone.nextMoveAt = now + 3000;
    console.log(`[neon-arena][${this.roomId}] [🏆] ${winner.name} 赢得占点回合`);
  }

  // 对局结束：统计 → 广播 → 通知房间管理器回大厅
  endGame(winnerTeam) {
    if (this._ended || !this.active) return;
    this._ended = true;
    this.active = false;
    clearInterval(this.timer);
    for (const p of this.players.values()) {
      if (!p.connected && this.hooks.onPlayerGone) this.hooks.onPlayerGone(p.id);
    }
    const stats = [];
    for (const p of this.players.values()) {
      stats.push({
        id: p.id, name: p.name, team: p.team, mechType: p.mechType,
        kills: p.kills, deaths: p.deaths, score: Math.floor(p.score),
      });
    }
    stats.sort((a, b) => (b.kills + b.score) - (a.kills + a.score));
    let ctfResult = null;
    if (this.mode === 'ctf' && this.ctf) {
      ctfResult = { roundWins: this.ctf.roundWins, winnerTeam: this.ctf.roundWins[0] === this.ctf.roundWins[1] ? null : (this.ctf.roundWins[0] > this.ctf.roundWins[1] ? 0 : 1) };
    }
    let duelResult = null;
    if (this.mode === 'duel' && this.duel) {
      // 大局计分：按回合胜场判定（到时无胜方则按总击杀）
      let wt = this.duel.winnerTeam;
      if (wt !== 0 && wt !== 1) {
        const k = [0, 0];
        for (const p of this.players.values()) k[p.team] += p.kills;
        wt = k[0] === k[1] ? null : (k[0] > k[1] ? 0 : 1);
      }
      duelResult = { roundWins: this.duel.roundWins, winnerTeam: wt };
    }
    this.emit('game:over', { stats, durationMs: this.durationMs, mode: this.mode, ctf: ctfResult, duel: duelResult });
    console.log(`[neon-arena][${this.roomId}] 对局结束`);
    if (this.hooks.onGameOver) this.hooks.onGameOver(stats);
  }

  // ---------- broadcast ----------
  weaponStateToJSON(p, now) {
    return p.weaponState.map((ws) => {
      const def = WEAPONS[ws.type];
      return {
        type: ws.type,
        ammo: (ws.ammo !== undefined) ? ws.ammo : null,
        reloading: !!ws.reloading,
        reloadLeft: ws.reloading ? Math.max(0, Math.ceil((ws.reloadEndsAt - now) / 100) / 10) : 0,
        reloadPct: ws.reloading
          ? clamp(1 - (ws.reloadEndsAt - now) / def.reloadMs, 0, 1)
          : (ws.ammo !== undefined ? ws.ammo / def.mag : 1),
        charge: (ws.charge !== undefined) ? ws.charge : 1,
      };
    });
  }

  pubMe(p) {
    const now = Date.now();
    return {
      id: p.id, name: p.name, color: p.color, team: p.team,
      carrying: this.mode === 'ctf' && this.isFlagCarrier(p.id),
      x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw,
      mechType: p.mechType,
      climbing: !!p.climbing,
      mech: {
        legs: p.mech.legs, chest: p.mech.chest, chestMax: p.mech.chestMax, core: p.mech.core,
        chestBroken: p.mech.chestBroken, legsDestroyed: p.legsDestroyed,
      },
      weapons: this.weaponStateToJSON(p, now),
      lives: this.mode === 'duel' ? p.lives : null,
      mechIndex: this.mode === 'duel' ? p.mechIndex : null,
      lockId: p.lockId,
      mechChoices: p.mechs.map((m, i) => ({ type: m.type, index: i, weapons: m.weapons.slice() }))
        .filter((c) => !(this.mode === 'duel' && p.usedMechs && p.usedMechs.has(c.index))),
      score: Math.floor(p.score), kills: p.kills, deaths: p.deaths, assists: p.assists || 0,
      alive: p.alive, respawnIn: Math.max(0, p.respawnAt - now),
    };
  }

  sendMe(p) {
    const sock = this.io.sockets.sockets.get(p.id);
    if (sock) sock.emit('me', this.pubMe(p));
  }

  broadcast(now) {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id, name: p.name, color: p.color, team: p.team,
        carrying: this.mode === 'ctf' && this.isFlagCarrier(p.id),
        x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw,
        mechType: p.mechType,
        weapons: p.weapons,
        weaponState: this.weaponStateToJSON(p, now),
        climbing: !!p.climbing,
        lockId: p.lockId,
        mech: {
          legs: p.mech.legs, chest: p.mech.chest, core: p.mech.core,
          chestBroken: p.mech.chestBroken, legsDestroyed: p.legsDestroyed,
        },
        lives: this.mode === 'duel' ? p.lives : null,
        mechIndex: this.mode === 'duel' ? p.mechIndex : null,
        alive: p.alive, connected: p.connected, kills: p.kills, deaths: p.deaths, score: p.score,
        assists: p.assists || 0,
      });
    }
    const projs = this.projectiles.map((pr) => ({ kind: pr.kind, x: pr.x, y: pr.y, z: pr.z, owner: pr.owner }));
    const pickups = this.pickups.map((pk) => ({ id: pk.id, x: pk.x, z: pk.z, active: pk.active }));
    let ctf = null;
    if (this.mode === 'ctf' && this.ctf) {
      const c = this.ctf;
      ctf = {
        phase: c.phase,
        round: c.round,
        cards: c.cards,
        scores: c.scores,
        roundWins: c.roundWins,
        voteEndsAt: c.voteEndsAt,
        roundEndsAt: c.roundEndsAt,
        applied: c.applied,
        flags: c.flags.map((f) => ({
          team: f.team, atBase: f.atBase,
          carrier: f.carrier, carrierName: f.carrier ? (this.players.get(f.carrier) || {}).name : null,
          x: f.x, z: f.z,
        })),
      };
    }
    let duel = null;
    if (this.mode === 'duel' && this.duel) {
      duel = {
        phase: this.duel.phase,
        round: this.duel.round,
        roundWins: this.duel.roundWins,
        roundEndsAt: this.duel.roundEndsAt,
        bases: this.duel.bases.map((b) => ({
          team: b.team, x: b.x, z: b.z, coreAlive: b.coreAlive, deploy: b.deploy,
        })),
        deployNeed: this.duel.deployNeed,
        winnerTeam: this.duel.winnerTeam,
      };
    }
    this.emit('state', {
      t: now, mode: this.mode,
      zone: { x: this.zone.x, z: this.zone.z, y: this.zone.y, r: ZONE_R, nextMoveAt: this.zone.nextMoveAt },
      players, projectiles: projs, pickups, killfeed: this.killfeed, ctf, duel,
      shots: this.shots, beams: this.beams, explosions: this.explosions, impacts: this.impacts, hits: this.hits,
    });
  }
}

module.exports = { Game, MAX_PLAYERS, CARD_POOL };
