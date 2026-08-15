'use strict';
// 房间大厅系统 — RoomManager 管理多个房间，每房间一个 Game 实例（房间间广播隔离）
const { Game, MAX_PLAYERS } = require('./game');

const MAX_ROOMS = 50;               // 单进程最大房间数
const DEFAULT_MAX_PLAYERS = 16;
const ROOM_PALETTE = [
  '#ff3b5c', '#3b82f6', '#22d3ee', '#a855f7', '#f59e0b', '#10b981',
  '#ec4899', '#84cc16', '#fb923c', '#eab308', '#06b6d4', '#f472b6',
  '#60a5fa', '#34d399', '#facc15', '#fb7185',
];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '玩家';
  const s = raw.trim().replace(/[\u0000-\u001f<>/\\]/g, '').slice(0, 16);
  return s.length ? s : '玩家';
}

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
      mode: (opts && opts.mode === 'zone') ? 'zone' : 'ffa',
      maxPlayers: clamp(parseInt(opts && opts.maxPlayers, 10) || DEFAULT_MAX_PLAYERS, 2, MAX_PLAYERS),
      matchMinutes: clamp(parseInt(opts && opts.matchMinutes, 10) || 5, 1, 30),
    };
    this.players = new Map();                   // socketId -> LobbyPlayer
    this.game = null;
    this.createdAt = Date.now();
  }

  // ---------- 成员管理 ----------
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
    if (d.mode === 'zone' || d.mode === 'ffa') this.settings.mode = d.mode;
    const mp = clamp(parseInt(d.maxPlayers, 10) || this.settings.maxPlayers, 2, MAX_PLAYERS);
    if (mp >= this.players.size) this.settings.maxPlayers = mp;
    const mm = clamp(parseInt(d.matchMinutes, 10) || this.settings.matchMinutes, 1, 30);
    this.settings.matchMinutes = mm;
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
      socketId: p.socketId, name: p.name, sessionId: p.sessionId,
    }));
    for (const p of this.players.values()) p.ready = false;
    this.game = new Game(this.io, this.id, this.settings, {
      onPlayerGone: (socketId) => this.onPlayerGone(socketId),
      onGameOver: () => this.endGame(),
    });
    this.game.start(seeds);
    this.io.to(this.id).emit('game:start', {
      mode: this.settings.mode,
      maxPlayers: this.settings.maxPlayers,
      matchMinutes: this.settings.matchMinutes,
    });
    this.broadcastUpdate();
    return true;
  }

  // 对局中玩家超时未重连（或对局结束仍断线）→ 从房间席位移除
  onPlayerGone(socketId) {
    if (this.players.has(socketId)) {
      this.players.delete(socketId);
      this.broadcastUpdate();
    }
  }

  endGame() {
    if (this.state !== 'playing') return;
    this.state = 'lobby';
    this.game = null;
    // 回到大厅：重置准备状态，等待再来一局
    for (const p of this.players.values()) p.ready = false;
    this.broadcastUpdate();
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
      const rooms = [...this.rooms.values()]
        .filter((r) => r.state === 'lobby' && r.players.size < r.settings.maxPlayers)
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
        // 对局中：仅允许同 sessionId 的断线重连
        if (room.game && room.game.resume(socket, d.sessionId)) {
          socket.join(room.id);
          socket.emit('room:joined', { room: room.toJSON(), inGame: true });
          return;
        }
        return socket.emit('room:error', { code: 'IN_GAME' });
      }
      if (room.players.size >= room.settings.maxPlayers) return socket.emit('room:error', { code: 'FULL' });
      room.addPlayer(socket, { name: d.name, sessionId: d.sessionId });
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
