'use strict';
// 霓虹竞技场 — 服务器权威游戏逻辑（20Hz 状态同步）
// 按房间作用域运行：每个房间一个 Game 实例，广播只发到本房间（io.to(roomId)）
const { MAP } = require('./map');

const TICK_MS = 50; // 20 Hz
const GRAVITY = 24;
const MOVE_SPEED = 9.5;
const JUMP_VEL = 9.8;
const MAX_FALL = 40;
const PLAYER_R = 0.45;
const PLAYER_H = 1.8;
const EYE_H = 1.6;
const MAX_HEALTH = 100;
const FIRE_CD = 0.3;
const PROJ_SPEED = 44;
const PROJ_R = 0.3;
const PROJ_LIFE = 1.5;
const DMG = 20;
const RESPAWN_MS = 3000;
const MAX_PLAYERS = 16;
const RECONNECT_GRACE_MS = 15000; // 断线保留时间：站桩等待同 sessionId 重连

// 占点模式（Zone Control）
const ZONE_R = 4.5;                 // 占领区半径
const ZONE_WIN = 120;               // 先到 120 分获胜
const ZONE_MOVE_MS = 15000;         // 占领区每 15s 迁移
const ZONE_SCORE_PER_TICK = 0.1;    // 站桩得分速率（2 分/秒）
const ZONE_SPOTS = [
  { x: 0, z: 0, y: 5 },     // 中央高台顶（制高点）
  { x: 14, z: 0, y: 0 },
  { x: 0, z: 14, y: 0 },
  { x: -14, z: 0, y: 0 },
  { x: 0, z: -14, y: 0 },
  { x: 22, z: 22, y: 0 },
];
const KILLFEED_MAX = 8;
const PICKUP_RANGE = 1.1;
const PICKUP_RESPAWN_MS = 8000;
const PICKUP_HEAL = 25;

const COLORS = [
  '#ff3b5c', '#3b82f6', '#22d3ee', '#a855f7', '#f59e0b', '#10b981',
  '#ec4899', '#84cc16', '#fb923c', '#eab308', '#06b6d4', '#f472b6',
  '#60a5fa', '#34d399', '#facc15', '#fb7185',
];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function toAABB(b) {
  return {
    minX: b.x - b.sx / 2, maxX: b.x + b.sx / 2,
    minY: b.y - b.sy / 2, maxY: b.y + b.sy / 2,
    minZ: b.z - b.sz / 2, maxZ: b.z + b.sz / 2,
  };
}
const colliders = MAP.boxes.map(toAABB);

function overlapAABB(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX &&
    a.minY < b.maxY && a.maxY > b.minY &&
    a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '玩家';
  const s = raw.trim().replace(/[\u0000-\u001f<>/\\]/g, '').slice(0, 16);
  return s.length ? s : '玩家';
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
    this.mode = this.settings.mode === 'zone' ? 'zone' : 'ffa';
    this.durationMs = (parseInt(this.settings.matchMinutes, 10) || 5) * 60 * 1000;

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
  }

  // ---------- 对局生命周期 ----------
  // seeds: [{ socketId, name, sessionId }]（来自房间成员）
  start(seeds) {
    for (const s of seeds) this.attachPlayer(s.socketId, s);
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.zone.nextMoveAt = Date.now() + ZONE_MOVE_MS;
    console.log(`[neon-arena][${this.roomId}] 对局开始 ${this.mode} 人数上限 ${this.maxPlayers} 时长 ${this.durationMs / 60000}min`);
  }

  // 对局开始时把房间成员接入游戏
  attachPlayer(socketId, seed) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) return null;
    socket.join(this.roomId);
    const p = this.createPlayer(socketId, seed);
    this.players.set(socketId, p);
    this.bindSocket(socket, p);
    socket.emit('welcome', {
      id: p.id, name: p.name, color: p.color,
      map: MAP, self: this.pubMe(p), resumed: false, mode: this.mode,
    });
    this.sendMe(p);
    this.emit('playerJoined', { id: p.id, name: p.name });
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
        id: p.id, name: p.name, color: p.color,
        map: MAP, self: this.pubMe(p), resumed: true, mode: this.mode,
      });
      this.sendMe(p);
      console.log(`[neon-arena][${this.roomId}] [↻] ${p.name} 恢复连接`);
      return true;
    }
    return false;
  }

  bindSocket(socket, p) {
    // 同一 socket 可能跨多局（再来一局）：先摘掉上一局挂的处理器，避免重复监听
    if (socket._naGame) {
      socket.removeListener('input', socket._naGame.input);
      socket.removeListener('ping', socket._naGame.ping);
      socket.removeListener('disconnect', socket._naGame.disconnect);
    }
    const h = {
      input: (d) => this.onInput(p.id, d),
      ping: (cb) => { if (typeof cb === 'function') cb(Date.now()); },
      disconnect: () => this.onLeave(p.id),
    };
    socket._naGame = h;
    socket.on('input', h.input);
    socket.on('ping', h.ping);
    socket.on('disconnect', h.disconnect);
  }

  createPlayer(socketId, seed) {
    const idx = this.players.size % COLORS.length;
    const spawn = this.pickSpawn();
    return {
      id: socketId,
      name: sanitizeName(seed && seed.name),
      color: COLORS[idx],
      sessionId: (seed && typeof seed.sessionId === 'string') ? seed.sessionId : '',
      connected: true,
      leftAt: 0,
      pos: { x: spawn.x, y: 0, z: spawn.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: Math.random() * Math.PI * 2,
      pitch: 0,
      health: MAX_HEALTH,
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

  onInput(playerId, data) {
    const p = this.players.get(playerId);
    if (!this.active || !p || !p.connected || !data) return;
    if (p.alive) {
      p.input.fwd = clamp(Number(data.fwd) || 0, -1, 1);
      p.input.strafe = clamp(Number(data.strafe) || 0, -1, 1);
      p.input.jump = !!data.jump;
      p.input.fire = !!data.fire;
      if (Number.isFinite(data.yaw)) p.yaw = data.yaw;
      if (Number.isFinite(data.pitch)) p.pitch = clamp(data.pitch, -1.5, 1.5);
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
    this.emit('playerLeft', { id });
    console.log(`[neon-arena][${this.roomId}] [-] ${p.name} 移除`);
    if (this.hooks.onPlayerGone) this.hooks.onPlayerGone(id);
  }

  pickSpawn() {
    const list = MAP.spawns.slice();
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

  // ---------- tick ----------
  tick() {
    if (!this.active) return;
    const now = Date.now();
    // 全员退出/断线超时 → 直接结束对局，避免空房间泄漏
    if (this.players.size === 0) { this.endGame(); return; }
    // 对局时长到点 → 结束
    if (now - this.startedAt >= this.durationMs) { this.endGame(); return; }
    const dt = TICK_MS / 1000;
    for (const p of this.players.values()) {
      if (!p.connected) {
        // 断线保留期：站桩等待重连，超时后移除
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
    // 占领区定时迁移
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
    // 站桩得分
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
    // 仍断线未归队的玩家：从房间席位移除
    for (const p of this.players.values()) {
      if (!p.connected && this.hooks.onPlayerGone) this.hooks.onPlayerGone(p.id);
    }
    const stats = [];
    for (const p of this.players.values()) {
      stats.push({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, score: Math.floor(p.score) });
    }
    stats.sort((a, b) => (b.kills + b.score) - (a.kills + a.score));
    this.emit('game:over', { stats, durationMs: this.durationMs, mode: this.mode });
    console.log(`[neon-arena][${this.roomId}] 对局结束`);
    if (this.hooks.onGameOver) this.hooks.onGameOver(stats);
  }

  respawn(p) {
    const s = this.pickSpawn();
    p.pos.x = s.x; p.pos.y = 0; p.pos.z = s.z;
    p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
    p.health = MAX_HEALTH;
    p.alive = true;
    p.respawnAt = 0;
    p.fireCd = 0.5;
    this.sendMe(p);
  }

  physics(p, dt) {
    // 重力
    p.vel.y -= GRAVITY * dt;
    if (p.vel.y < -MAX_FALL) p.vel.y = -MAX_FALL;
    // 水平速度（朝向由 yaw 决定）
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const fx = -sin, fz = -cos;          // 前
    const rx = cos, rz = -sin;           // 右
    p.vel.x = (fx * p.input.fwd + rx * p.input.strafe) * MOVE_SPEED;
    p.vel.z = (fz * p.input.fwd + rz * p.input.strafe) * MOVE_SPEED;

    const wasGrounded = p.grounded;
    p.grounded = false;

    this.moveAxis(p, 'x', dt);
    this.moveAxis(p, 'z', dt);
    this.moveAxis(p, 'y', dt);

    // 地面
    if (p.pos.y <= 0 && p.vel.y <= 0) {
      p.pos.y = 0; p.vel.y = 0; p.grounded = true;
    }
    // 边界
    const half = MAP.size.x / 2 - PLAYER_R;
    p.pos.x = clamp(p.pos.x, -half, half);
    p.pos.z = clamp(p.pos.z, -half, half);

    // 跳跳台
    for (const pad of MAP.jumpPads) {
      const dx = p.pos.x - pad.x, dz = p.pos.z - pad.z;
      if (dx * dx + dz * dz <= pad.radius * pad.radius && p.vel.y <= 0.5) {
        p.vel.y = pad.strength;
      }
    }

    // 跳跃
    if (p.input.jump && (p.grounded || wasGrounded)) {
      p.vel.y = JUMP_VEL;
      p.grounded = false;
    }
  }

  moveAxis(p, axis, dt) {
    const prevPos = p.pos[axis];
    p.pos[axis] += p.vel[axis] * dt;
    const aabb = {
      minX: p.pos.x - PLAYER_R, maxX: p.pos.x + PLAYER_R,
      minY: p.pos.y, maxY: p.pos.y + PLAYER_H,
      minZ: p.pos.z - PLAYER_R, maxZ: p.pos.z + PLAYER_R,
    };
    if (axis === 'x' || axis === 'z') {
      for (const c of colliders) {
        if (!overlapAABB(aabb, c)) continue;
        // 站在该箱顶部（或更高）时，水平方向放行（可在箱顶自由行走）
        if (p.pos.y >= c.maxY - 0.001) continue;
        if (axis === 'x') {
          if (p.vel.x > 0) { p.pos.x = c.minX - PLAYER_R - 0.001; p.vel.x = 0; }
          else if (p.vel.x < 0) { p.pos.x = c.maxX + PLAYER_R + 0.001; p.vel.x = 0; }
        } else {
          if (p.vel.z > 0) { p.pos.z = c.minZ - PLAYER_R - 0.001; p.vel.z = 0; }
          else if (p.vel.z < 0) { p.pos.z = c.maxZ + PLAYER_R + 0.001; p.vel.z = 0; }
        }
      }
    } else {
      // y 轴：区分“从上方落在箱顶”与“从下方撞到箱底”
      const prevY = prevPos;
      for (const c of colliders) {
        if (!overlapAABB(aabb, c)) continue;
        if (p.vel.y < 0 && prevY >= c.maxY - 0.001) {
          p.pos.y = c.maxY;
          p.grounded = true;
          p.vel.y = 0;
        } else if (p.vel.y > 0 && prevY + PLAYER_H <= c.minY + 0.001) {
          p.pos.y = c.minY - PLAYER_H;
          p.vel.y = 0;
        }
      }
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
      life: PROJ_LIFE,
    });
    p.fireCd = FIRE_CD;
  }

  updateProjectiles(dt, now) {
    const next = [];
    for (const pr of this.projectiles) {
      const x0 = pr.x, y0 = pr.y, z0 = pr.z;
      pr.x += pr.dx * PROJ_SPEED * dt;
      pr.y += pr.dy * PROJ_SPEED * dt;
      pr.z += pr.dz * PROJ_SPEED * dt;
      pr.life -= dt;
      if (pr.life <= 0) continue;
      // 细分步进检测，避免高速弹丸隧穿
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
    victim.health -= DMG;
    const killer = this.players.get(killerId);
    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = now + RESPAWN_MS;
      if (killer && killer !== victim && killer.alive) {
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
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      const dx = p.pos.x - pk.x, dz = p.pos.z - pk.z;
      if (dx * dx + dz * dz <= PICKUP_RANGE * PICKUP_RANGE) {
        pk.active = false;
        pk.respawnAt = now + PICKUP_RESPAWN_MS;
        if (p.health < MAX_HEALTH) {
          p.health = Math.min(MAX_HEALTH, p.health + PICKUP_HEAL);
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
      id: p.id, name: p.name, color: p.color,
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
        id: p.id, name: p.name, color: p.color,
        x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw,
        alive: p.alive, connected: p.connected, kills: p.kills, deaths: p.deaths, score: p.score,
      });
    }
    const projs = this.projectiles.map((pr) => ({ x: pr.x, y: pr.y, z: pr.z }));
    const pickups = this.pickups.map((pk) => ({ id: pk.id, x: pk.x, z: pk.z, active: pk.active }));
    this.emit('state', {
      t: now, mode: this.mode,
      zone: { x: this.zone.x, z: this.zone.z, y: this.zone.y, r: ZONE_R, nextMoveAt: this.zone.nextMoveAt },
      players, projectiles: projs, pickups, killfeed: this.killfeed,
    });
  }
}

module.exports = { Game, MAX_PLAYERS };
