'use strict';
// 房间大厅系统 — RoomManager 管理多个房间，每房间一个 Game 实例（房间间广播隔离）
const { Game } = require('./game');
const { MAX_PLAYERS, clamp, sanitizeName, normalizeMech } = require('../public/js/neon-shared.js');

const MAX_ROOMS = 50;               // 单进程最大房间数
const ROOM_PALETTE = [
  '#ff3b5c', '#3b82f6', '#22d3ee', '#a855f7', '#f59e0b', '#10b981',
  '#ec4899', '#84cc16', '#fb923c', '#eab308', '#06b6d4', '#f472b6',
  '#60a5fa', '#34d399', '#facc15', '#fb7185',
];

class Room {
  constructor(manager, io, hostSocket, opts) {
    this.manager = manager;
    this.io = io;
    this.code = manager.genCode();
    this.id = 'room_' + this.code;             // 同时用作 socket.io room 名
    this.name = ((opts && opts.name) || '').trim().slice(0, 24) || ('霓虹混战 #' + this.code);
    this.password = (opts && typeof opts.password === 'string') ? opts.password : '';
    this.hostId = hostSocket.id;
    this.state = 'lobby';                       // lobby | playing
    this.settings = {
      mode: (opts && opts.mode === 'zone' || opts && opts.mode === 'ctf' || opts && opts.mode === 'duel') ? opts.mode : 'ffa',
      maxPlayers: clamp(parseInt(opts && opts.maxPlayers, 10) || MAX_PLAYERS, 2, MAX_PLAYERS),
      matchMinutes: clamp(parseInt(opts && opts.matchMinutes, 10) || 5, 1, 30),
      bots: clamp(parseInt(opts && opts.bots, 10) || 0, 0, 5), // 人机数量（房主开局前可选）
    };
    this.players = new Map();                   // socketId -> LobbyPlayer
    this.game = null;
    this.createdAt = Date.now();
  }

  // ---------- 成员管理 ----------
  // 机库配置清洗：最多 2 台机甲 {type, weapons}
  sanitizeMechs(raw) {
    const list = Array.isArray(raw) ? raw.slice(0, 3) : [];
    const out = list.map(normalizeMech);
    if (!out.length) out.push({ type: 'humanoid', weapons: [] });
    return out;
  }

  addPlayer(socket, opts) {
    if (this.players.size >= this.settings.maxPlayers) return false;
    if (this.players.has(socket.id)) return false;
    const idx = this.players.size % ROOM_PALETTE.length;
    const p = {
      socketId: socket.id,
      sessionId: (opts && typeof opts.sessionId === 'string') ? opts.sessionId.slice(0, 64) : '',
      name: sanitizeName(opts && opts.name),
      color: ROOM_PALETTE[idx],
      ready: false,
      isHost: socket.id === this.hostId,
      joinedAt: Date.now(),
      mechs: this.sanitizeMechs(opts && opts.mechs), // 机库配置（死斗=两次生命）
    };
    this.players.set(socket.id, p);
    socket.join(this.id);
    this.broadcastUpdate();
    return true;
  }

  // 移除成员（离开/踢出/大厅断线/对局结束未归队）
  removePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    this.players.delete(socketId);
    const sock = this.io.sockets.sockets.get(socketId);
    if (sock) sock.leave(this.id);
    if (this.hostId === socketId) this.transferHost();
    this.broadcastUpdate();
    if (this.players.size === 0 && this.state === 'lobby') this.manager.destroyRoom(this.id);
    return p;
  }

  transferHost() {
    if (this.players.size === 0) { this.hostId = null; return; }
    const next = this.players.values().next().value;
    this.hostId = next.socketId;
    next.isHost = true;
  }

  // 断线重连后的席位迁移：Game.resume 已把游戏内玩家 key 换成新 socketId，
  // 房间席位必须同步迁移，否则 roomOf(新id) 找不到房间、对局结束后留下幽灵席位
  migrateSeat(oldSocketId, newSocketId) {
    if (oldSocketId === newSocketId) return true;
    const p = this.players.get(oldSocketId);
    if (!p || this.players.has(newSocketId)) return false;
    const wasHost = this.hostId === oldSocketId;
    this.players.delete(oldSocketId);
    p.socketId = newSocketId;
    p.isHost = wasHost;
    this.players.set(newSocketId, p);
    if (wasHost) this.hostId = newSocketId;
    this.broadcastUpdate();
    return true;
  }

  setReady(socketId, ready) {
    const p = this.players.get(socketId);
    if (!p || this.state !== 'lobby') return false;
    p.ready = !!ready;
    this.broadcastUpdate();
    return true;
  }

  updateSettings(socketId, data) {
    const p = this.players.get(socketId);
    if (!p || !p.isHost || this.state !== 'lobby') return false;
    const d = data || {};
    if (d.mode === 'zone' || d.mode === 'ffa' || d.mode === 'ctf' || d.mode === 'duel') this.settings.mode = d.mode;
    const mp = clamp(parseInt(d.maxPlayers, 10) || this.settings.maxPlayers, 2, MAX_PLAYERS);
    if (mp >= this.players.size) this.settings.maxPlayers = mp;
    const mm = clamp(parseInt(d.matchMinutes, 10) || this.settings.matchMinutes, 1, 30);
    this.settings.matchMinutes = mm;
    this.settings.bots = clamp(parseInt(d.bots, 10) || 0, 0, 5);
    // 设置变更后重置准备状态
    for (const pl of this.players.values()) pl.ready = false;
    this.broadcastUpdate();
    return true;
  }

  // ---------- 对局生命周期 ----------
  startGame() {
    if (this.state !== 'lobby') return false;
    if (!this.players.has(this.hostId)) return false;
    if (this.players.size < 1) return false;
    this.state = 'playing';
    const seeds = [...this.players.values()].map((p) => ({
      socketId: p.socketId, name: p.name, sessionId: p.sessionId, mechs: p.mechs,
    }));
    for (const p of this.players.values()) p.ready = false;
    this.game = new Game(this.io, this.id, this.settings, {
      onPlayerGone: (socketId) => this.onPlayerGone(socketId),
      onGameOver: () => this.endGame(),
    });
    this.game.start(seeds);
    this.game.addBots(this.settings.bots || 0); // 房主选择的人机
    this.io.to(this.id).emit('game:start', {
      mode: this.settings.mode,
      maxPlayers: this.settings.maxPlayers,
      matchMinutes: this.settings.matchMinutes,
    });
    this.broadcastUpdate();
    return true;
  }

  // 对局中玩家超时未重连（或对局结束仍断线/中途离开）→ 从房间席位移除
  // 必须处理房主移交与空房销毁，否则 hostId 指向已删除玩家 → 房间永远无法再开局
  onPlayerGone(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    this.players.delete(socketId);
    if (this.hostId === socketId) this.transferHost();
    this.broadcastUpdate();
    if (this.players.size === 0 && this.state === 'lobby') this.manager.destroyRoom(this.id);
  }

  endGame() {
    if (this.state !== 'playing') return;
    this.state = 'lobby';
    this.game = null;
    // 回到大厅：重置准备状态，等待再来一局
    for (const p of this.players.values()) p.ready = false;
    this.broadcastUpdate();
    // 空房间直接销毁，避免泄漏占用房间名额
    if (this.players.size === 0) this.manager.destroyRoom(this.id);
  }

  // ---------- 序列化 ----------
  broadcastUpdate() {
    this.io.to(this.id).emit('room:update', { room: this.toJSON() });
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      hasPassword: !!this.password,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      players: [...this.players.values()].map((p) => ({
        socketId: p.socketId, name: p.name, color: p.color,
        ready: p.ready, isHost: p.isHost,
      })),
    };
  }

  toPublic() {
    const host = this.players.get(this.hostId);
    return {
      code: this.code,
      name: this.name,
      mode: this.settings.mode,
      maxPlayers: this.settings.maxPlayers,
      players: this.players.size,
      state: this.state,
      hasPassword: !!this.password,
      hostName: host ? host.name : '',
    };
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  genCode() {
    let code;
    do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (this.rooms.has('room_' + code));
    return code;
  }

  roomOf(socketId) {
    for (const r of this.rooms.values()) if (r.players.has(socketId)) return r;
    return null;
  }

  destroyRoom(id) {
    const r = this.rooms.get(id);
    if (!r) return;
    this.io.to(id).emit('room:left', { code: r.code, reason: 'closed' });
    this.rooms.delete(id);
  }

  // ---------- socket 事件 ----------
  handleConnection(socket) {
    socket.on('lobby:list', () => {
      // 展示所有未满的房间（含进行中），便于中途加入
      const rooms = [...this.rooms.values()]
        .filter((r) => r.players.size < r.settings.maxPlayers)
        .map((r) => r.toPublic());
      socket.emit('lobby:list', { rooms });
    });

    socket.on('room:create', (data) => {
      if (this.roomOf(socket.id)) return socket.emit('room:error', { code: 'ALREADY_IN_ROOM' });
      if (this.rooms.size >= MAX_ROOMS) return socket.emit('room:error', { code: 'ROOM_CAP' });
      const room = new Room(this, this.io, socket, data || {});
      this.rooms.set(room.id, room);
      room.addPlayer(socket, {
        name: (data && (data.playerName || data.name)) || '玩家',
        sessionId: data && data.sessionId,
        mechs: data && data.mechs,
      });
      socket.emit('room:joined', { room: room.toJSON() });
    });

    socket.on('room:join', (data) => {
      const d = data || {};
      if (this.roomOf(socket.id)) return socket.emit('room:error', { code: 'ALREADY_IN_ROOM' });
      const code = String(d.code || '').trim();
      const room = this.rooms.get('room_' + code);
      if (!room) return socket.emit('room:error', { code: 'NOT_FOUND' });
      if (room.password && room.password !== String(d.password || '')) {
        return socket.emit('room:error', { code: 'WRONG_PASSWORD' });
      }
      if (room.state === 'playing') {
        if (!room.game) return socket.emit('room:error', { code: 'NOT_FOUND' });
        // 断线重连：同 sessionId 恢复原玩家（分数/位置保留）
        const resumedFrom = room.game.resume(socket, d.sessionId);
        if (resumedFrom) {
          socket.join(room.id);
          // 席位迁移：旧 socketId → 新 socketId（否则留下幽灵席位，房间永远无法清空）
          room.migrateSeat(resumedFrom, socket.id);
          socket.emit('room:joined', { room: room.toJSON(), inGame: true });
          return;
        }
        // 中途加入：房间未满则直接进对局（新玩家入场）；房间满但有人机 → 替代人机
        if (room.players.size >= room.settings.maxPlayers) {
          // 先尝试替代人机（对局中真人加入替代 Bot）
          const rep = room.game && room.game.replaceBotWithPlayer(socket, {
            name: d.name, sessionId: d.sessionId, mechs: d.mechs,
          });
          if (rep) {
            socket.join(room.id);
            socket.emit('room:joined', { room: room.toJSON(), inGame: true });
            return;
          }
          return socket.emit('room:error', { code: 'FULL' });
        }
        room.addPlayer(socket, { name: d.name, sessionId: d.sessionId, mechs: d.mechs });
        room.game.attachPlayer(socket.id, { name: d.name, sessionId: d.sessionId, mechs: d.mechs });
        socket.emit('room:joined', { room: room.toJSON(), inGame: true });
        return;
      }
      if (room.players.size >= room.settings.maxPlayers) return socket.emit('room:error', { code: 'FULL' });
      room.addPlayer(socket, { name: d.name, sessionId: d.sessionId, mechs: d.mechs });
      socket.emit('room:joined', { room: room.toJSON() });
    });

    socket.on('room:leave', () => {
      const room = this.roomOf(socket.id);
      if (!room) return socket.emit('room:error', { code: 'NOT_IN_ROOM' });
      // 对局中离开：直接从游戏与房间移出（不再回场）
      if (room.state === 'playing' && room.game) {
        room.game.removePlayer(socket.id);
      }
      room.removePlayer(socket.id);
      socket.leave(room.id);
      socket.emit('room:left', { code: room.code });
    });

    socket.on('room:ready', (data) => {
      const room = this.roomOf(socket.id);
      if (room) room.setReady(socket.id, data && data.ready);
    });

    socket.on('room:kick', (data) => {
      const room = this.roomOf(socket.id);
      const host = room && room.players.get(socket.id);
      if (!room || !host || !host.isHost) return;
      const targetId = data && data.targetId;
      if (!targetId || targetId === socket.id) return;
      if (room.state === 'playing' && room.game) {
        room.game.removePlayer(targetId);
      }
      room.removePlayer(targetId);
    });

    socket.on('room:settings', (data) => {
      const room = this.roomOf(socket.id);
      if (room) room.updateSettings(socket.id, data);
    });

    socket.on('room:start', () => {
      const room = this.roomOf(socket.id);
      const host = room && room.players.get(socket.id);
      if (!room || !host || !host.isHost) return;
      room.startGame();
    });

    socket.on('disconnect', () => {
      const room = this.roomOf(socket.id);
      if (!room) return;
      // 大厅中直接移除；对局中交给 Game 的 15s 重连保留处理
      if (room.state === 'lobby') room.removePlayer(socket.id);
    });
  }
}

module.exports = { RoomManager, Room, MAX_ROOMS };
