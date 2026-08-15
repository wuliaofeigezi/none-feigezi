'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, game: 'neon-arena' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 10000,
});

// 房间大厅：连接全部交给 RoomManager 按房间分发
const manager = new RoomManager(io);
io.on('connection', (socket) => manager.handleConnection(socket));

server.listen(PORT, HOST, () => {
  console.log(`[neon-arena] listening on http://${HOST}:${PORT}`);
});
