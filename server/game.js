'use strict';
// 霓虹竞技场 — 服务器权威游戏逻辑（20Hz 状态同步）
// 模式：ffa 死亡竞赛 | zone 占点 | ctf 夺旗卡牌赛（每回合抽卡投票 + 夺旗）
// 按房间作用域运行：每个房间一个 Game 实例，广播只发到本房间（io.to(roomId)）
const { MAP } = require('./map');
// 共享常量与工具（客户端/服务端唯一事实来源，禁止在本文件重复定义）
const {
  TICK_MS, GRAVITY, MOVE_SPEED, JUMP_VEL, MAX_FALL,
  PLAYER_R, PLAYER_H, EYE_H, MAX_HEALTH, FIRE_CD, PROJ_SPEED, PROJ_R, PROJ_LIFE,
  DMG, RESPAWN_MS, MAX_PLAYERS, PICKUP_RANGE, PICKUP_RESPAWN_MS, PICKUP_HEAL,
  KILLFEED_MAX, ZONE_WIN, ZONE_R, VOTE_CHANGE_MS,
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
const CTF_CARRIER_DMG_MUL = 1.5;      // 受击伤害 +50%
const CTF_CARRIER_NO_HEAL = true;     // 不能捡血包（旗手不可回血）

// FragPunk 式卡牌池：apply 修改本回合 cfg
const CARD_POOL = [
  { id: 'speed', name: '疾风', desc: '全体移速 +50%', apply: (g) => { g.cfg.moveSpeed *= 1.5; } },
  { id: 'jump', name: '弹跳', desc: '跳跃力 +60%', apply: (g) => { g.cfg.jumpVel *= 1.6; } },
  { id: 'rapid', name: '速射', desc: '射速翻倍', apply: (g) => { g.cfg.fireCd *= 0.5; } },
  { id: 'pierce', name: '重弹', desc: '伤害翻倍', apply: (g) => { g.cfg.dmg *= 2; } },
  { id: 'fragile', name: '纸甲', desc: '血量上限减半', apply: (g) => { g.cfg.maxHealth = Math.max(30, Math.floor(g.cfg.maxHealth * 0.5)); } },
  { id: 'tank', name: '铁壁', desc: '血量上限 +50%', apply: (g) => { g.cfg.maxHealth = Math.min(200, Math.floor(g.cfg.maxHealth * 1.5)); } },
  { id: 'moon', name: '月球', desc: '重力减半，跳得更远', apply: (g) => { g.cfg.gravity *= 0.5; } },
  { id: 'heavy', name: '重力场', desc: '重力 +60%', apply: (g) => { g.cfg.gravity *= 1.6; } },
  { id: 'spawn', name: '重生', desc: '复活缩短至 1 秒', apply: (g) => { g.cfg.respawnMs = 1000; } },
  { id: 'pickup', name: '丰收', desc: '血包回血翻倍', apply: (g) => { g.cfg.pickupHeal *= 2; } },
  { id: 'slow', name: '泥沼', desc: '全体移速 -25%', apply: (g) => { g.cfg.moveSpeed *= 0.75; } },
  { id: 'storm', name: '弹幕', desc: '弹丸速度 +40%，射程更长', apply: (g) => { g.cfg.projSpeed *= 1.4; g.cfg.projLife *= 1.3; } },
];

// KILLFEED_MAX / PICKUP_RANGE / PICKUP_RESPAWN_MS / PICKUP_HEAL 来自共享常量

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
    maxHealth: MAX_HEALTH, fireCd: FIRE_CD, projSpeed: PROJ_SPEED, projLife: PROJ_LIFE,
    dmg: DMG, respawnMs: RESPAWN_MS, pickupHeal: PICKUP_HEAL,
    mode,
  };
}

class Game {
  constructor(io, roomId, settings, hooks) {
    this.io = io;
    this.roomId = roomId;
    this.settings = settings || {};
    this.hooks = hooks || {};
    // 房间作用域广播
    this.emit = (ev, data) => io.to(roomId).emit(ev, data);

    this.maxPlayers = clamp(parseInt(this.settings.maxPlayers, 10) || MAX_PLAYERS, 1, MAX_PLAYERS);
    this.mode = (this.settings.mode === 'zone' || this.settings.mode === 'ctf') ? this.settings.mode : 'ffa';
    this.durationMs = (parseInt(this.settings.matchMinutes, 10) || 5) * 60 * 1000;
    this.cfg = defaultCfg(this.mode);

    this.players = new Map();
    this.projectiles = [];
    this.killfeed = [];
    this.pickups = MAP.pickups.map((p, i) => ({
      id: i, x: p.x, z: p.z, type: 'health', active: true, respawnAt: 0,
    }));
    this.timer = null;
    this.active = true;   // 对局进行中（结束后忽略后续输入）
    this.startedAt = 0;
    this._ended = false;
    this.zone = { spot: 0, x: ZONE_SPOTS[0].x, z: ZONE_SPOTS[0].z, y: ZONE_SPOTS[0].y, r: ZONE_R, nextMoveAt: 0 };

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
  // seeds: [{ socketId, name, sessionId }]（来自房间成员）
  start(seeds) {
    for (let i = 0; i < seeds.length; i++) this.attachPlayer(seeds[i].socketId, seeds[i], i);
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.zone.nextMoveAt = Date.now() + ZONE_MOVE_MS;
    if (this.mode === 'ctf') this.startCtfRound();
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

  // 对局中断线重连：同 sessionId 恢复原玩家（分数/位置/血量全保留）
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
      socket.removeListener('disconnect', socket._naGame.disconnect);
    }
    const h = {
      input: (d) => this.onInput(p.id, d),
      vote: (d) => this.onVote(p.id, d),
      ping: (cb) => { if (typeof cb === 'function') cb(Date.now()); },
      disconnect: () => this.onLeave(p.id),
    };
    socket._naGame = h;
    socket.on('input', h.input);
    socket.on('vote', h.vote);
    socket.on('ping', h.ping);
    socket.on('disconnect', h.disconnect);
  }

  createPlayer(socketId, seed, seedIdx) {
    const idx = this.players.size % COLORS.length;
    let team = 0;
    if (this.mode === 'ctf') {
      // 开局轮流分边；中途加入补进人数少的一边
      if (typeof seedIdx === 'number') team = seedIdx % 2;
      else {
        const counts = [0, 0];
        for (const p of this.players.values()) counts[p.team]++;
        team = counts[0] <= counts[1] ? 0 : 1;
      }
    }
    const spawn = this.pickSpawn(this.mode === 'ctf' ? team : null);
    const color = (this.mode === 'ctf') ? TEAM_COLORS[team] : COLORS[idx];
    return {
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
      health: this.cfg.maxHealth,
      score: 0,
      kills: 0,
      deaths: 0,
      alive: true,
      respawnAt: 0,
      respawnIn: 0,
      fireCd: 0,
      grounded: true,
      input: { fwd: 0, strafe: 0, jump: false, fire: false },
    };
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
    this.emit('playerLeft', { id });
    console.log(`[neon-arena][${this.roomId}] [-] ${p.name} 移除`);
    if (this.hooks.onPlayerGone) this.hooks.onPlayerGone(id);
  }

  pickSpawn(team) {
    let list = MAP.spawns.slice();
    // CTF：按队伍出生在己方一侧
    if (this.mode === 'ctf' && (team === 0 || team === 1)) {
      list = list.filter((s) => (team === 0 ? s.x < 0 : s.x > 0));
    }
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
    }
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

  // ---------- tick ----------
  tick() {
    if (!this.active) return;
    const now = Date.now();
    // 全员退出/断线超时 → 直接结束对局，避免空房间泄漏
    if (this.players.size === 0) { this.endGame(); return; }
    // 对局时长到点 → 结束
    if (now - this.startedAt >= this.durationMs) { this.endGame(); return; }

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
        continue;
      }
      this.physics(p, dt);
      if (p.fireCd > 0) p.fireCd -= dt;
      if (p.input.fire && p.fireCd <= 0) this.shoot(p);
      this.checkPickups(p, now);
    }
    this.updateProjectiles(dt, now);
    this.updatePickups(now);
    if (this.mode === 'zone') this.updateZone(now);
    this.broadcast(now);
  }

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
  endGame() {
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
        id: p.id, name: p.name, team: p.team,
        kills: p.kills, deaths: p.deaths, score: Math.floor(p.score),
      });
    }
    stats.sort((a, b) => (b.kills + b.score) - (a.kills + a.score));
    let ctfResult = null;
    if (this.mode === 'ctf' && this.ctf) {
      ctfResult = { roundWins: this.ctf.roundWins, winnerTeam: this.ctf.roundWins[0] === this.ctf.roundWins[1] ? null : (this.ctf.roundWins[0] > this.ctf.roundWins[1] ? 0 : 1) };
    }
    this.emit('game:over', { stats, durationMs: this.durationMs, mode: this.mode, ctf: ctfResult });
    console.log(`[neon-arena][${this.roomId}] 对局结束`);
    if (this.hooks.onGameOver) this.hooks.onGameOver(stats);
  }

  respawn(p) {
    const s = this.pickSpawn(this.mode === 'ctf' ? p.team : null);
    p.pos.x = s.x; p.pos.y = 0; p.pos.z = s.z;
    p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
    p.health = this.cfg.maxHealth;
    p.alive = true;
    p.respawnAt = 0;
    p.fireCd = 0.5;
    this.sendMe(p);
  }

  physics(p, dt) {
    // 重力
    p.vel.y -= this.cfg.gravity * dt;
    if (p.vel.y < -MAX_FALL) p.vel.y = -MAX_FALL;
    // 旗手惩罚：移速降低
    const carrierMul = (this.mode === 'ctf' && this.isFlagCarrier(p.id)) ? CTF_CARRIER_SPEED_MUL : 1;
    // 水平速度（朝向由 yaw 决定）
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;
    p.vel.x = (fx * p.input.fwd + rx * p.input.strafe) * this.cfg.moveSpeed * carrierMul;
    p.vel.z = (fz * p.input.fwd + rz * p.input.strafe) * this.cfg.moveSpeed * carrierMul;

    const wasGrounded = p.grounded;
    p.grounded = false;

    moveAxis(p.pos, p.vel, 'x', dt, colliders);
    moveAxis(p.pos, p.vel, 'z', dt, colliders);
    if (moveAxis(p.pos, p.vel, 'y', dt, colliders)) p.grounded = true;

    if (p.pos.y <= 0 && p.vel.y <= 0) {
      p.pos.y = 0; p.vel.y = 0; p.grounded = true;
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

    if (p.input.jump && (p.grounded || wasGrounded)) {
      // 旗手惩罚：跳跃降低
      p.vel.y = this.cfg.jumpVel * ((this.mode === 'ctf' && this.isFlagCarrier(p.id)) ? CTF_CARRIER_JUMP_MUL : 1);
      p.grounded = false;
    }
  }

  shoot(p) {
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    this.projectiles.push({
      owner: p.id,
      x: p.pos.x, y: p.pos.y + EYE_H, z: p.pos.z,
      dx: -Math.sin(p.yaw) * cp,
      dy: sp,
      dz: -Math.cos(p.yaw) * cp,
      life: this.cfg.projLife,
    });
    p.fireCd = this.cfg.fireCd;
  }

  updateProjectiles(dt, now) {
    const next = [];
    for (const pr of this.projectiles) {
      const x0 = pr.x, y0 = pr.y, z0 = pr.z;
      pr.x += pr.dx * this.cfg.projSpeed * dt;
      pr.y += pr.dy * this.cfg.projSpeed * dt;
      pr.z += pr.dz * this.cfg.projSpeed * dt;
      pr.life -= dt;
      if (pr.life <= 0) continue;
      const seg = Math.hypot(pr.x - x0, pr.y - y0, pr.z - z0);
      const steps = Math.max(1, Math.ceil(seg / 0.3));
      let dead = false;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const x = x0 + (pr.x - x0) * f;
        const y = y0 + (pr.y - y0) * f;
        const z = z0 + (pr.z - z0) * f;
        if (this.hitColliderAt(x, y, z)) { dead = true; break; }
        for (const p of this.players.values()) {
          if (!p.alive || !p.connected || p.id === pr.owner) continue;
          // CTF：不攻击同队
          if (this.mode === 'ctf' && p.team === this.players.get(pr.owner).team) continue;
          const cx = p.pos.x, cy = p.pos.y + 0.9, cz = p.pos.z;
          const dx = x - cx, dy = y - cy, dz = z - cz;
          if (dx * dx + dy * dy + dz * dz < 0.8 * 0.8) {
            this.damage(p, pr.owner, now);
            dead = true;
            break;
          }
        }
        if (dead) break;
      }
      if (!dead) next.push(pr);
    }
    this.projectiles = next;
  }

  hitColliderAt(x, y, z) {
    for (const c of colliders) {
      if (x > c.minX - PROJ_R && x < c.maxX + PROJ_R &&
        y > c.minY - PROJ_R && y < c.maxY + PROJ_R &&
        z > c.minZ - PROJ_R && z < c.maxZ + PROJ_R) return true;
    }
    return false;
  }

  damage(victim, killerId, now) {
    // 旗手惩罚：受击伤害 +50%
    const dmg = this.cfg.dmg * ((this.mode === 'ctf' && this.isFlagCarrier(victim.id)) ? CTF_CARRIER_DMG_MUL : 1);
    victim.health -= dmg;
    const killer = this.players.get(killerId);
    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = now + this.cfg.respawnMs;
      if (killer && killer !== victim && killer.alive && (this.mode !== 'ctf' || killer.team !== victim.team)) {
        killer.kills++;
        killer.score += (this.mode === 'zone') ? 10 : 100;
        this.sendMe(killer);
      }
      this.killfeed.unshift({
        id: Math.random().toString(36).slice(2, 8),
        killer: killer ? killer.name : '?',
        victim: victim.name,
        ts: now,
      });
      if (this.killfeed.length > KILLFEED_MAX) this.killfeed.pop();
      this.emit('kill', {
        victimId: victim.id,
        killerId: killer ? killer.id : null,
        killerName: killer ? killer.name : '?',
        victimName: victim.name,
      });
    }
    this.sendMe(victim);
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
        if (p.health < this.cfg.maxHealth) {
          p.health = Math.min(this.cfg.maxHealth, p.health + this.cfg.pickupHeal);
          this.sendMe(p);
        }
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

  // ---------- broadcast ----------
  pubMe(p) {
    return {
      id: p.id, name: p.name, color: p.color, team: p.team,
      carrying: this.mode === 'ctf' && this.isFlagCarrier(p.id),
      x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw,
      health: p.health, score: Math.floor(p.score), kills: p.kills, deaths: p.deaths,
      alive: p.alive, respawnIn: Math.max(0, p.respawnAt - Date.now()),
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
        alive: p.alive, connected: p.connected, kills: p.kills, deaths: p.deaths, score: p.score,
      });
    }
    const projs = this.projectiles.map((pr) => ({ x: pr.x, y: pr.y, z: pr.z }));
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
    this.emit('state', {
      t: now, mode: this.mode,
      zone: { x: this.zone.x, z: this.zone.z, y: this.zone.y, r: ZONE_R, nextMoveAt: this.zone.nextMoveAt },
      players, projectiles: projs, pickups, killfeed: this.killfeed, ctf,
    });
  }
}

module.exports = { Game, MAX_PLAYERS, CARD_POOL };
