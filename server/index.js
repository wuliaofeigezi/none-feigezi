'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
// 禁用 js/html/css 缓存：每次更新部署后浏览器必须拉到最新代码（配合 index.html 里的 ?v= 版本号）
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
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
