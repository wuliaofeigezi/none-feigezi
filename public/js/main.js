/* 霓虹竞技场 Neon Arena — 客户端主逻辑 */
import * as THREE from './three.module.min.js';

(function () {
  'use strict';

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const hud = $('hud'),
    lobbyPage = $('lobbyPage'), roomPage = $('roomPage'), gameOverPage = $('gameOverPage'),
    lobbyName = $('lobbyName'), connStatus = $('connStatus'),
    roomListEl = $('roomList'),
    createRoomBtn = $('createRoomBtn'), quickJoinBtn = $('quickJoinBtn'), refreshRoomsBtn = $('refreshRoomsBtn'),
    roomTitle = $('roomTitle'), roomCode = $('roomCode'), copyCodeBtn = $('copyCodeBtn'),
    leaveRoomBtn = $('leaveRoomBtn'), roomSettings = $('roomSettings'),
    modeSelect = $('modeSelect'), maxSelect = $('maxSelect'), minutesSelect = $('minutesSelect'),
    roomPlayers = $('roomPlayers'), readyBtn = $('readyBtn'), startBtn = $('startBtn'),
    backToRoomBtn = $('backToRoomBtn'), gameOverStats = $('gameOverStats'),
    deathOverlay = $('deathOverlay'), deathText = $('deathText'), respawnText = $('respawnText'),
    healthBar = $('healthBar'), healthText = $('healthText'),
    killsEl = $('kills'), deathsEl = $('deaths'), pingEl = $('ping'),
    lbList = $('lbList'), killfeedEl = $('killfeed'),
    cooldown = $('cooldown'), hitmark = $('hitmark'), lookHint = $('lookHint'),
    helpText = $('helpText'), appEl = $('app'),
    joyBaseEl = $('joyBase'), joyKnobEl = $('joyKnob'),
    fireBtn = $('fireBtn'), jumpBtn = $('jumpBtn'), touchUI = $('touchUI'),
    zoneUI = $('zoneUI'), modeLabel = $('modeLabel'),
    zonePts = $('zonePts'), zoneBarFill = $('zoneBarFill'), zoneStatus = $('zoneStatus'),
    ctfUI = $('ctfUI'), ctfRedScore = $('ctfRedScore'), ctfBlueScore = $('ctfBlueScore'),
    ctfRoundInfo = $('ctfRoundInfo'), ctfFlagStatus = $('ctfFlagStatus'), ctfCardInfo = $('ctfCardInfo'),
    votePanel = $('votePanel'), voteCountdown = $('voteCountdown'), voteCards = $('voteCards'), voteStatus = $('voteStatus'),
    banner = $('banner');

  // ===== 常量（与服务器一致） =====
  const TICK_MS = 50;
  const GRAVITY = 24, MOVE_SPEED = 9.5, JUMP_VEL = 9.8;
  const PLAYER_R = 0.45, PLAYER_H = 1.8, EYE_H = 1.6;
  const SENS = 0.0022;
  const FIRE_CD = 300;
  const FIXED_DT = TICK_MS / 1000; // 固定物理步长（与服务器 20Hz tick 完全一致）
  const ZONE_WIN_CLIENT = 120;      // 占点模式获胜积分（与服务器一致）

  // ===== 触屏（手机端，类和平精英） =====
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const JOY_RADIUS = 60;           // 摇杆最大半径(px)
  const TOUCH_SENS = SENS * 2.4;   // 触摸转视角灵敏度
  let joyTouchId = null;           // 摇杆触点 id
  let joy = { fwd: 0, strafe: 0 }; // 摇杆向量（归一化 -1..1）
  let lookTouchId = null;          // 转视角触点 id
  let fireTouchId = null;          // 开火触点 id
  const lookLast = new Map();      // 视角触点 id -> {x,y}（开火/视角共用，独立追踪）
  let touchFire = false;           // 开火键按住
  let jumpQueuedAt = 0;            // 跳跃键按下时间戳
  let rotated = false;             // 手机端竖屏时是否已旋转为横屏渲染
  let myName = '玩家';             // 玩家名（断线重连时复用）
  // 持久会话 ID：断线重连时服务器据此恢复同一玩家（分数/位置不重置）
  let mySessionId = null;
  let gameMode = 'ffa';            // 服务器当前模式
  let zone = null;                 // 占领区状态 {x,z,y,r,nextMoveAt}
  // ===== 房间大厅状态 =====
  let uiState = 'lobby';           // lobby | room | game | over
  let myRoom = null;               // 当前房间数据（room:joined/room:update 推送）
  let lastRoomCode = null;         // 断线重连时回到的房间
  let roomList = [];               // 大厅房间列表
  let myReady = false;             // 我是否已准备
  // ===== CTF 夺旗卡牌赛 =====
  const VOTE_CHANGE_MS = 3000;     // 投票改选冷却（与服务端一致）
  let ctfState = null;             // 最新 state 里的 ctf 数据
  let myVote = -1;                 // 我投的卡下标
  let myVoteAt = 0;                // 我上次改选时间戳（冷却用）
  let voteEndsAt = 0;              // 投票截止时间戳
  let flagBeacons = [];            // 旗帜 3D 标记
  let voteTimer = null;            // 投票倒计时定时器

  // ===== 游戏状态 =====
  let socket = null;
  let me = null;
  let mapData = null;
  let colliders = [];
  let myPos = { x: 0, y: 0, z: 0 };
  let myVel = { x: 0, y: 0, z: 0 };
  let grounded = true;
  let yaw = 0, pitch = 0;
  const keys = {};
  let fire = false;
  let started = false;
  let lastKiller = '';
  let respawnIn = 0, respawnAtLocal = 0;
  let lastHealth = 100;
  let lastShotAt = 0;
  let lastLockFail = 0; // 指针锁定失败时间戳（限流重试）
  let physAcc = 0; // 固定步长物理累计器
  const prevStep = { x: 0, y: 0, z: 0 }; // 上一物理步位置（渲染插值）
  const curStep = { x: 0, y: 0, z: 0 };  // 当前物理步位置（渲染插值）
  const remotePlayers = new Map();
  const projMeshes = [];
  let pickupMeshes = [];
  let padMeshes = [];
  let audioCtx = null;
  let scoreRows = [];

  // ===== Three.js =====
  let renderer, scene, camera;
  const tmpVec = new THREE.Vector3();
  const serverTarget = new THREE.Vector3(); // 服务器权威位置（用于摄像机贴合人物）
  let zoneMesh = null, zoneRing = null;     // 占领区视觉

  // =========================================================
  // 基础工具
  // =========================================================
  function getSessionId() {
    if (mySessionId) return mySessionId;
    try {
      // 用 sessionStorage：每个标签页独立身份（同浏览器多标签测试=多玩家），刷新同标签仍保留
      let s = sessionStorage.getItem('neon_arena_sid');
      if (!s) {
        s = 'sid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('neon_arena_sid', s);
      }
      mySessionId = s;
    } catch (e) {
      mySessionId = 'sid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    return mySessionId;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function beep(freq, dur, type, vol) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0008, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* ignore */ }
  }
  function showHint(text, ms) {
    if (!lookHint) return;
    lookHint.textContent = text;
    lookHint.classList.remove('hidden');
    clearTimeout(showHint._t);
    if (ms) showHint._t = setTimeout(() => lookHint.classList.add('hidden'), ms);
  }

  // =========================================================
  // 网络
  // =========================================================
  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      connStatus.textContent = '已连接服务器';
      socket.emit('lobby:list');
      // 断线重连：回到之前的房间（大厅直接回席位；对局中同 sessionId 恢复角色）
      if (lastRoomCode) {
        connStatus.textContent = '已重连，正在返回房间 ' + lastRoomCode + ' …';
        socket.emit('room:join', { code: lastRoomCode, name: myName, sessionId: getSessionId() });
      }
    });
    socket.on('connect_error', () => {
      connStatus.textContent = '连接失败，正在重试…';
    });

    // ---------- 大厅 / 房间 ----------
    socket.on('lobby:list', (d) => {
      roomList = (d && d.rooms) || [];
      renderRoomList();
    });
    socket.on('room:joined', (d) => {
      myRoom = d.room;
      lastRoomCode = d.room.code;
      myReady = false;
      // 对局中重连（inGame=true）：保持游戏画面，等待 welcome(resumed)
      if (d.inGame) { uiState = 'game'; return; }
      enterRoom();
    });
    socket.on('room:update', (d) => {
      if (!myRoom) return;
      myRoom = d.room;
      renderRoom();
    });
    socket.on('room:left', () => {
      backToLobby();
    });
    socket.on('room:error', (d) => {
      const msg = {
        FULL: '房间已满', NOT_FOUND: '房间不存在', WRONG_PASSWORD: '密码错误',
        ALREADY_IN_ROOM: '你已在房间中', NOT_IN_ROOM: '你不在任何房间',
        ROOM_CAP: '服务器房间已满', IN_GAME: '对局进行中，无法加入',
      }[d && d.code] || '操作失败';
      showToast(msg);
      // 自动重连失败（房间没了/进不去）：清掉记忆回到大厅
      if (d && (d.code === 'NOT_FOUND' || d.code === 'IN_GAME' || d.code === 'FULL') && !myRoom) {
        lastRoomCode = null;
        socket.emit('lobby:list');
      }
    });
    socket.on('game:start', (d) => {
      uiState = 'game';
      roomPage.classList.add('hidden');
      gameOverPage.classList.add('hidden');
    });
    socket.on('game:over', (d) => {
      showGameOver(d);
    });

    // ---------- CTF 夺旗卡牌赛 ----------
    socket.on('ctf:round', (d) => {
      showCtfVote(d);
    });
    socket.on('ctf:vote', (d) => {
      const tally = (d && d.tally) || [];
      if (voteCards) {
        voteCards.querySelectorAll('.vp-card').forEach((b, i) => {
          const span = b.querySelector('.vp-votes');
          if (span) span.textContent = (tally[i] || 0) + ' 票';
        });
      }
      if (voteStatus) voteStatus.textContent = '已投票 ' + ((d && d.voted) || 0) + '/' + ((d && d.total) || 0) + ' 人';
    });
    socket.on('ctf:card', (d) => {
      hideVote();
      if (d && d.card) {
        showBanner('🃏 生效卡：' + d.card.name + ' — ' + d.card.desc, 4000);
        beep(700, 0.2, 'triangle', 0.08);
      }
    });
    socket.on('ctf:play', () => {
      showBanner('⚔ 夺旗回合开始！带回敌方旗帜到己方基地', 2500);
    });
    socket.on('ctf:capture', (d) => {
      showBanner((d && d.team === 0 ? '🔴红队' : '🔵蓝队') + ' ' + ((d && d.scorerName) || '') + ' 夺旗得分！', 3000);
      beep(880, 0.25, 'triangle', 0.1);
    });
    socket.on('ctf:roundEnd', (d) => {
      const w = (d && d.winnerTeam === null) ? '本回合平局'
        : ((d && d.winnerTeam === 0) ? '🔴红队' : '🔵蓝队') + ' 赢得本回合！';
      showBanner(w, 3000);
      beep(660, 0.2, 'triangle', 0.08);
    });
    socket.on('ctf:flag', (d) => {
      if (d && d.carrier && d.carrier === (me && me.id)) {
        showBanner('🚩 你扛起了敌方旗帜！减速·易伤·不能回血，快回基地！', 4000);
        beep(500, 0.25, 'sawtooth', 0.1);
      }
    });

    // ---------- 游戏内 ----------
    socket.on('welcome', onWelcome);
    socket.on('state', onState);
    socket.on('me', onMe);
    socket.on('kill', onKill);
    socket.on('playerLeft', (d) => removeRemotePlayer(d.id));
    socket.on('roundEnd', (d) => {
      showBanner((me && d.winnerId === me.id ? '🏆 你获胜了！' : d.winnerName + ' 获胜！') + ' 新一轮开始', 3500);
      beep(880, 0.3, 'triangle', 0.1);
    });
    socket.on('disconnect', () => {
      connStatus.textContent = '与服务器断开连接，正在重连…';
      if (started) showHint('连接断开，正在自动重连…', 3000);
      resetTouchInputs();
    });
  }

  // ---------- 大厅 ----------
  function renderRoomList() {
    if (!roomListEl) return;
    if (!roomList.length) {
      roomListEl.innerHTML = '<div class="empty-tip">暂无房间，点「＋ 创建房间」开一局吧</div>';
      return;
    }
    roomListEl.innerHTML = roomList.map((r) => `
      <div class="room-row" data-code="${esc(r.code)}">
        <span class="code">${esc(r.code)}</span>
        <span class="meta"><b>${esc(r.name)}</b> · ${r.mode === 'zone' ? '🚩占点' : '🔫死斗'}
          ${r.state === 'playing' ? '<span class="in-game">⚔ 进行中</span>' : ''}
          ${r.hasPassword ? '<span class="lock">🔒</span>' : ''} · 房主 ${esc(r.hostName || '?')}</span>
        <span class="count">${r.players}/${r.maxPlayers}</span>
      </div>`).join('');
    roomListEl.querySelectorAll('.room-row').forEach((el) => {
      el.addEventListener('click', () => {
        socket.emit('room:join', { code: el.dataset.code, name: myName, sessionId: getSessionId() });
      });
    });
  }

  function enterRoom() {
    uiState = 'room';
    lobbyPage.classList.add('hidden');
    roomPage.classList.remove('hidden');
    gameOverPage.classList.add('hidden');
    renderRoom();
  }

  function renderRoom() {
    if (!myRoom) return;
    roomTitle.textContent = myRoom.name;
    roomCode.textContent = myRoom.code;
    // 玩家列表
    roomPlayers.innerHTML = myRoom.players.map((p) => `
      <li>
        <span class="dot" style="color:${esc(p.color)};background:${esc(p.color)}"></span>
        <span class="name">${esc(p.name)}</span>
        ${p.socketId === socket.id ? '<span class="tag tag-me">我</span>' : ''}
        ${p.isHost ? '<span class="tag tag-host">房主</span>' : ''}
        ${p.isHost ? '' : (p.ready ? '<span class="tag tag-ready">已准备</span>' : '<span class="tag tag-notready">未准备</span>')}
        ${myRoom.hostId === socket.id && p.socketId !== socket.id
          ? '<button class="btn kick-btn" data-id="' + esc(p.socketId) + '">✕ 踢</button>' : ''}
      </li>`).join('');
    roomPlayers.querySelectorAll('.kick-btn').forEach((el) => {
      el.addEventListener('click', () => socket.emit('room:kick', { targetId: el.dataset.id }));
    });
    // 我的准备状态
    const meP = myRoom.players.find((p) => p.socketId === socket.id);
    myReady = !!(meP && meP.ready);
    readyBtn.textContent = myReady ? '✋ 取消准备' : '✔ 准备';
    // 房主控制区
    const isHost = myRoom.hostId === socket.id;
    roomSettings.classList.toggle('hidden', !isHost);
    startBtn.classList.toggle('hidden', !isHost);
    if (isHost) {
      modeSelect.value = myRoom.settings.mode;
      maxSelect.value = String(myRoom.settings.maxPlayers);
      minutesSelect.value = String(myRoom.settings.matchMinutes);
    }
  }

  function backToLobby() {
    myRoom = null;
    lastRoomCode = null;
    myReady = false;
    uiState = 'lobby';
    roomPage.classList.add('hidden');
    gameOverPage.classList.add('hidden');
    lobbyPage.classList.remove('hidden');
    socket.emit('lobby:list');
  }

  function showGameOver(data) {
    uiState = 'over';
    const myId = me && me.id;
    const stats = (data && data.stats) || [];
    const ctfRes = data && data.ctf;
    resetGame();
    roomPage.classList.add('hidden');
    hud.classList.add('hidden');
    const head = ctfRes
      ? '<div class="ctf-match-result">' + (ctfRes.winnerTeam === null ? '🤝 平局' : (ctfRes.winnerTeam === 0 ? '🔴 红队' : '🔵 蓝队') + ' 获胜！')
        + '（' + ctfRes.roundWins[0] + ' : ' + ctfRes.roundWins[1] + '）</div>'
      : '';
    gameOverStats.innerHTML = head + stats.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(s.name)}${ctfRes ? ' <span class="ctf-team-tag" style="color:' + (s.team === 0 ? '#ff5c7a' : '#5c9cff') + '">' + (s.team === 0 ? '🔴红' : '🔵蓝') + '</span>' : ''}${s.id === myId ? '（我）' : ''}</td>
        <td>${s.kills}</td><td>${s.deaths}</td><td>${s.score}</td>
      </tr>`).join('');
    gameOverPage.classList.remove('hidden');
  }

  function resetGame() {
    started = false;
    me = null;
    for (const id of [...remotePlayers.keys()]) removeRemotePlayer(id);
    for (const m of projMeshes) { m.visible = false; }
    killfeedEl.innerHTML = '';
    lbList.innerHTML = '';
    deathOverlay.classList.add('hidden');
    document.exitPointerLock && document.exitPointerLock();
    // CTF 清理
    hideVote();
    ctfState = null;
    ctfUI.classList.add('hidden');
    for (const g of flagBeacons) scene.remove(g);
    flagBeacons = [];
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------- CTF 夺旗卡牌赛 ----------
  // 投票面板可见时（UI 覆盖层），暂停游戏鼠标/触摸控制，避免与点卡片冲突
  function ctfVoting() {
    return !!(votePanel && !votePanel.classList.contains('hidden'));
  }
  function showCtfVote(d) {
    if (!d || !d.cards || !voteCards) return;
    myVote = -1;
    myVoteAt = 0;
    voteEndsAt = d.voteEndsAt || 0;
    // 释放鼠标指针锁定，让玩家能自由点击卡片投票
    document.exitPointerLock && document.exitPointerLock();
    voteCards.innerHTML = d.cards.map((c, i) => `
      <button class="vp-card" data-i="${i}">
        <span class="vp-name">${esc(c.name)}</span>
        <span class="vp-desc">${esc(c.desc)}</span>
        <span class="vp-votes" data-votes="${i}">0 票</span>
      </button>`).join('');
    voteCards.querySelectorAll('.vp-card').forEach((el) => {
      el.addEventListener('click', () => {
        const now = Date.now();
        // 已投票且冷却未过：提示剩余时间
        if (myVote !== -1 && now - myVoteAt < VOTE_CHANGE_MS) {
          const left = Math.ceil((VOTE_CHANGE_MS - (now - myVoteAt)) / 1000);
          if (voteStatus) voteStatus.textContent = '⏳ 改选冷却中，' + left + ' 秒后可换卡';
          el.classList.add('vp-shake');
          setTimeout(() => el.classList.remove('vp-shake'), 400);
          return;
        }
        myVote = parseInt(el.dataset.i, 10);
        myVoteAt = now;
        socket.emit('vote', { card: myVote });
        voteCards.querySelectorAll('.vp-card').forEach((b) => {
          b.classList.toggle('vp-picked', b === el);
          if (b !== el) b.classList.add('vp-dim');
          else b.classList.remove('vp-dim');
        });
        el.classList.add('vp-pop'); // 点击弹跳反馈
        setTimeout(() => el.classList.remove('vp-pop'), 320);
        const cardName = el.querySelector('.vp-name');
        if (voteStatus) voteStatus.textContent = '已投「' + (cardName ? cardName.textContent : myVote) + '」，' + (VOTE_CHANGE_MS / 1000) + ' 秒后可改选';
      });
    });
    if (voteStatus) voteStatus.textContent = '点击一张卡片投票（每 3 秒可改选）';
    votePanel.classList.remove('hidden');
    clearInterval(voteTimer);
    voteTimer = setInterval(updateVoteCountdown, 200);
    updateVoteCountdown();
  }
  function updateVoteCountdown() {
    if (!voteCountdown) return;
    const left = Math.max(0, Math.ceil((voteEndsAt - Date.now()) / 1000));
    voteCountdown.textContent = left + 's';
    if (left <= 0) hideVote();
  }
  function hideVote() {
    votePanel.classList.add('hidden');
    clearInterval(voteTimer);
    fire = false;
    touchFire = false;
  }
  function renderCtfHud() {
    if (!ctfState || !ctfUI) return;
    ctfUI.classList.remove('hidden');
    ctfRedScore.textContent = '🔴 红 ' + (ctfState.scores[0] || 0) + ' · 胜' + (ctfState.roundWins[0] || 0);
    ctfBlueScore.textContent = '🔵 蓝 ' + (ctfState.scores[1] || 0) + ' · 胜' + (ctfState.roundWins[1] || 0);
    ctfRoundInfo.textContent = '第 ' + (ctfState.round || 0) + ' 回合';
    const myTeam = me ? me.team : null;
    const myCarry = !!(me && ctfState.flags && ctfState.flags.some((f) => f.carrier === me.id));
    if (myCarry) {
      ctfFlagStatus.textContent = '🚩 你正扛着敌方旗帜！减速 25% · 受击+50% · 不能回血';
      ctfFlagStatus.classList.add('carrying');
    } else {
      ctfFlagStatus.classList.remove('carrying');
      const enemy = ctfState.flags && myTeam !== null ? ctfState.flags.find((f) => f.team !== myTeam) : null;
      if (enemy) {
        ctfFlagStatus.textContent = enemy.atBase ? '🏳️ 敌方旗帜：在基地'
          : enemy.carrier ? '🚩 敌方旗帜：被 ' + (enemy.carrierName || '?') + ' 夺取！'
            : '🏳️ 敌方旗帜：掉落在地';
      }
    }
    ctfCardInfo.textContent = ctfState.applied
      ? '🃏 本回合卡：' + ctfState.applied.name + ' — ' + ctfState.applied.desc
      : '🃏 本回合卡：抽卡中…';
    updateFlagBeacons();
  }
  function buildFlagBeacons() {
    if (flagBeacons.length || !scene) return;
    const colors = [0xff3b5c, 0x3b82f6];
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 3.4, 6),
        new THREE.MeshBasicMaterial({ color: 0xdddddd })
      );
      pole.position.y = 1.7;
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.55),
        new THREE.MeshBasicMaterial({ color: colors[i], side: THREE.DoubleSide })
      );
      flag.position.set(0.45, 3.1, 0);
      const glow = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.55, 0.06, 16),
        new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.55 })
      );
      glow.position.y = 0.12;
      g.add(pole, flag, glow);
      scene.add(g);
      flagBeacons.push(g);
    }
  }
  function updateFlagBeacons() {
    if (!ctfState || !ctfState.flags) return;
    buildFlagBeacons();
    ctfState.flags.forEach((f, i) => {
      const g = flagBeacons[i];
      if (!g) return;
      g.visible = true;
      g.position.set(f.x, 0, f.z);
    });
  }

  function onWelcome(data) {
    me = data.self;
    gameMode = data.mode || 'ffa';
    applyModeUI();
    if (!mapData) {
      mapData = data.map;
      buildWorld(); // 世界只构建一次，重连时复用
    }
    myPos = { x: me.x, y: me.y, z: me.z };
    myVel = { x: 0, y: 0, z: 0 };
    prevStep.x = myPos.x; prevStep.y = myPos.y; prevStep.z = myPos.z;
    curStep.x = myPos.x; curStep.y = myPos.y; curStep.z = myPos.z;
    if (!data.resumed) { yaw = me.yaw; pitch = 0; } // 恢复连接时保留当前视角，避免跳变
    grounded = true;
    physAcc = 0;
    lastHealth = me.health;
    uiState = 'game';
    lobbyPage.classList.add('hidden');
    roomPage.classList.add('hidden');
    gameOverPage.classList.add('hidden');
    hud.classList.remove('hidden');
    deathOverlay.classList.add('hidden');
    started = true;
    updateHud(me);
    if (isTouch) {
      showHint('左侧摇杆移动 · 右侧滑动转视角 · 右下开火 · 跳跃', 5000);
    } else {
      showHint('点击画面锁定鼠标（CS:GO 视角）· 右键拖拽也可转视角', 5000);
    }
  }

  function onState(payload) {
    if (!started) return;
    if (payload.mode) { gameMode = payload.mode; applyModeUI(); }
    zone = payload.zone || zone;
    updateZoneMesh();
    updateZoneUI();
    // CTF：更新 HUD 与旗帜标记；投票阶段迟到玩家补出投票面板
    if (payload.ctf) {
      ctfState = payload.ctf;
      renderCtfHud();
      if (ctfState.phase === 'vote' && ctfState.cards && votePanel.classList.contains('hidden')) {
        showCtfVote({ cards: ctfState.cards, voteEndsAt: ctfState.voteEndsAt });
      }
    }
    // 远端玩家
    const seen = new Set();
    for (const sp of payload.players) {
      seen.add(sp.id);
      let rp = remotePlayers.get(sp.id);
      if (!rp) rp = createRemotePlayer(sp);
      rp.target.set(sp.x, sp.y, sp.z);
      rp.yawT = sp.yaw;
      rp.group.visible = true;
      // 死亡或断线玩家显示为半透明幽灵（不再直接消失）
      setGhost(rp, !sp.alive || sp.connected === false);
      // 旗手高亮（全图暴露位置）
      if (sp.carrying) { ensureCarrierRing(rp); rp.carrierRing.visible = true; }
      else if (rp.carrierRing) rp.carrierRing.visible = false;
    }
    for (const [id, rp] of remotePlayers) {
      if (!seen.has(id)) { removeRemotePlayer(id); }
    }
    // 同步自身分数/战绩 + 服务器权威校正
    if (me) {
      for (const sp of payload.players) {
        if (sp.id !== me.id) continue;
        me.score = sp.score; me.kills = sp.kills; me.deaths = sp.deaths;
        if (me.alive) {
          serverTarget.set(sp.x, sp.y, sp.z);
          const dx = sp.x - myPos.x, dy = sp.y - myPos.y, dz = sp.z - myPos.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const speed3d = Math.hypot(myVel.x, myVel.y, myVel.z);
          // 移动中（含竖直方向：跳台弹射/下落）保留延迟余量，避免抖动；
          // 仅接近静止时做小偏差贴合，大幅偏差才硬贴合
          const needSnap = dist > 2.5 || (speed3d < 0.8 && dist > 0.35);
          if (needSnap) {
            myPos.x = sp.x; myPos.y = sp.y; myPos.z = sp.z;
            myVel.x = 0; myVel.y = 0; myVel.z = 0;
            grounded = true;
            prevStep.x = myPos.x; prevStep.y = myPos.y; prevStep.z = myPos.z;
            curStep.x = myPos.x; curStep.y = myPos.y; curStep.z = myPos.z;
          }
        }
        break;
      }
      killsEl.textContent = me.kills;
      deathsEl.textContent = me.deaths;
    }
    // 弹道
    for (let i = 0; i < payload.projectiles.length; i++) {
      const pr = payload.projectiles[i];
      let m = projMeshes[i];
      if (!m) m = spawnProjMesh();
      m.position.set(pr.x, pr.y, pr.z);
      m.visible = true;
    }
    for (let i = payload.projectiles.length; i < projMeshes.length; i++) {
      if (projMeshes[i]) projMeshes[i].visible = false;
    }
    // 血包
    payload.pickups.forEach((pk, i) => {
      if (pickupMeshes[i]) pickupMeshes[i].visible = pk.active;
    });
    // 排行榜
    updateLeaderboard(payload.players);
    // 击杀播报（用服务器时间戳过滤，内容未变不重渲染，避免闪烁）
    renderKillfeed(payload.killfeed, payload.t);
  }

  function onMe(m) {
    const wasAlive = me ? me.alive : true;
    me = Object.assign(me || {}, m);
    updateHud(m);
    if (m.alive) {
      deathOverlay.classList.add('hidden');
    } else {
      deathText.textContent = '你被 ' + (lastKiller || '???') + ' 击杀';
      respawnIn = m.respawnIn || 3000;
      respawnAtLocal = performance.now() + respawnIn;
      deathOverlay.classList.remove('hidden');
    }
    if (m.health < lastHealth) {
      hitmark.classList.remove('hidden');
      setTimeout(() => hitmark.classList.add('hidden'), 120);
      beep(520, 0.08, 'sawtooth', 0.05);
    }
    if (!wasAlive && m.alive) {
      myPos.x = m.x; myPos.y = m.y; myPos.z = m.z;
      myVel.x = 0; myVel.y = 0; myVel.z = 0;
      physAcc = 0;
      prevStep.x = myPos.x; prevStep.y = myPos.y; prevStep.z = myPos.z;
      curStep.x = myPos.x; curStep.y = myPos.y; curStep.z = myPos.z;
      beep(660, 0.15, 'triangle', 0.08);
    }
    lastHealth = m.health;
  }

  function onKill(k) {
    if (k.victimId === me.id) {
      lastKiller = k.killerName;
      beep(180, 0.4, 'sawtooth', 0.08);
    }
  }

  function updateHud(m) {
    healthBar.style.width = m.health + '%';
    healthText.textContent = Math.ceil(m.health);
    killsEl.textContent = m.kills;
    deathsEl.textContent = m.deaths;
  }

  function updateLeaderboard(players) {
    const list = players.slice().sort((a, b) =>
      gameMode === 'zone'
        ? (b.score - a.score) || (a.deaths - b.deaths)
        : (b.kills - a.kills) || (a.deaths - b.deaths)
    ).slice(0, 8);
    let html = '';
    list.forEach((p, i) => {
      const isMe = me && p.id === me.id;
      const right = gameMode === 'zone'
        ? Math.floor(p.score) + '分'
        : p.kills + '杀/' + p.deaths + '死';
      html += '<div class="row' + (isMe ? ' me' : '') + '">' +
        '<span class="nm">' + (i + 1) + '. ' + esc(p.name) + '</span>' +
        '<span class="kd">' + right + '</span></div>';
    });
    if (html !== scoreRows) {
      scoreRows = html;
      lbList.innerHTML = html;
    }
  }

  function renderKillfeed(list, refTs) {
    const now = refTs || Date.now();
    // 只显示最近 6 秒的播报
    const visible = list.filter((k) => now - k.ts < 6000);
    // 移除已过期的条目
    const ids = new Set(visible.map((k) => k.id));
    for (const el of Array.from(killfeedEl.querySelectorAll('.kf-item'))) {
      if (!ids.has(el.dataset.id)) el.remove();
    }
    // 只追加新条目：旧条目 DOM 不重写、不重播动画，杜绝闪烁
    for (const k of visible) {
      if (killfeedEl.querySelector('.kf-item[data-id="' + k.id + '"]')) continue;
      const div = document.createElement('div');
      div.className = 'kf-item';
      div.dataset.id = k.id;
      div.innerHTML = '<span class="k">' + esc(k.killer) + '</span> 击杀了 <span class="v">' + esc(k.victim) + '</span>';
      killfeedEl.appendChild(div);
    }
    while (killfeedEl.children.length > 8) killfeedEl.firstChild.remove();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- 模式 / 占点 UI ----------
  function applyModeUI() {
    modeLabel.textContent = gameMode === 'zone' ? '🚩 占点模式' : '🔫 死亡竞赛';
    zoneUI.classList.toggle('hidden', gameMode !== 'zone');
  }
  function updateZoneMesh() {
    if (!zoneMesh) return;
    const on = gameMode === 'zone' && !!zone;
    zoneMesh.visible = on; zoneRing.visible = on;
    if (on) {
      zoneMesh.position.set(zone.x, (zone.y || 0) + 4, zone.z);
      zoneRing.position.set(zone.x, (zone.y || 0) + 0.06, zone.z);
    }
  }
  function updateZoneUI() {
    if (gameMode !== 'zone' || !me) return;
    zonePts.textContent = Math.floor(me.score || 0);
    zoneBarFill.style.width = Math.min(100, ((me.score || 0) / ZONE_WIN_CLIENT) * 100) + '%';
    if (zone && me.alive) {
      const dx = myPos.x - zone.x, dz = myPos.z - zone.z;
      const inside = dx * dx + dz * dz <= zone.r * zone.r;
      zoneStatus.textContent = inside ? '📍 正在占点！' : '前往占领区';
      zoneStatus.classList.toggle('own', inside);
    } else {
      zoneStatus.textContent = '复活后回到占领区';
      zoneStatus.classList.remove('own');
    }
  }
  function showBanner(text, ms) {
    banner.textContent = text;
    banner.classList.remove('hidden');
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => banner.classList.add('hidden'), ms);
  }

  // =========================================================
  // 世界构建
  // =========================================================
  function buildWorld() {
    colliders = mapData.boxes.map((b) => ({
      minX: b.x - b.sx / 2, maxX: b.x + b.sx / 2,
      minY: b.y - b.sy / 2, maxY: b.y + b.sy / 2,
      minZ: b.z - b.sz / 2, maxZ: b.z + b.sz / 2,
    }));

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070f);
    scene.fog = new THREE.FogExp2(0x05070f, 0.007);

    const s = gameSize();
    camera = new THREE.PerspectiveCamera(75, s.w / s.h, 0.1, 500);
    camera.rotation.order = 'YXZ';

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(s.w, s.h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    $('game').appendChild(renderer.domElement);

    // 灯光
    scene.add(new THREE.HemisphereLight(0x8899ff, 0x0a0f1e, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(40, 70, 30);
    scene.add(dir);
    const pl1 = new THREE.PointLight(0x22d3ee, 500, 120);
    pl1.position.set(0, 14, 0);
    scene.add(pl1);
    const pl2 = new THREE.PointLight(0xa855f7, 300, 100);
    pl2.position.set(-35, 10, -35);
    scene.add(pl2);

    // 地面（霓虹网格）
    const size = mapData.size.x;
    const gridTex = makeGridTexture();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.9, metalness: 0.1 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 外圈墙壁
    const wallMat = new THREE.MeshBasicMaterial({ color: 0x14224a, transparent: true, opacity: 0.85 });
    const wallEdge = new THREE.LineBasicMaterial({ color: 0x7df9ff });
    const half = size / 2, wh = mapData.wallHeight;
    const wallBoxes = [
      [0, wh / 2, -half, size, wh, 1],
      [0, wh / 2, half, size, wh, 1],
      [-half, wh / 2, 0, 1, wh, size],
      [half, wh / 2, 0, 1, wh, size],
    ];
    wallBoxes.forEach(([x, y, z, sx, sy, sz]) => {
      const w = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
      w.position.set(x, y, z);
      scene.add(w);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(w.geometry), wallEdge);
      edges.position.copy(w.position);
      scene.add(edges);
    });

    // 障碍物盒子
    const boxColors = [0x1e2a5e, 0x2a1e5e, 0x1e5e4a, 0x5e1e3a, 0x3a1e5e];
    mapData.boxes.forEach((b, i) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(b.sx, b.sy, b.sz),
        new THREE.MeshStandardMaterial({
          color: 0x18224a, emissive: boxColors[i % boxColors.length],
          emissiveIntensity: 0.25, roughness: 0.6, metalness: 0.4,
        })
      );
      m.position.set(b.x, b.y, b.z);
      scene.add(m);
    });

    // 跳跳台
    padMeshes = mapData.jumpPads.map((pad) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(pad.radius * 0.55, pad.radius, 32),
        new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pad.x, 0.06, pad.z);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(pad.radius * 0.55, pad.radius * 0.55, 10, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
      );
      pillar.position.set(pad.x, 5, pad.z);
      scene.add(ring);
      scene.add(pillar);
      return ring;
    });

    // 血包
    pickupMeshes = mapData.pickups.map((pk) => {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.5),
        new THREE.MeshStandardMaterial({
          color: 0xff5b6e, emissive: 0xff2d55, emissiveIntensity: 0.9,
          roughness: 0.2, metalness: 0.6,
        })
      );
      m.position.set(pk.x, 1.0, pk.z);
      m.userData.baseY = 1.0;
      const glow = new THREE.PointLight(0xff2d55, 40, 12);
      glow.position.set(pk.x, 1.0, pk.z);
      scene.add(m);
      scene.add(glow);
      return m;
    });

    // 占领区（占点模式）
    zoneMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 4.5, 8, 48, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd65a, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })
    );
    zoneMesh.visible = false;
    scene.add(zoneMesh);
    zoneRing = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 4.5, 48),
      new THREE.MeshBasicMaterial({ color: 0xffd65a, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    zoneRing.rotation.x = -Math.PI / 2;
    zoneRing.visible = false;
    scene.add(zoneRing);

    renderer.domElement.addEventListener('click', () => {
      if (isTouch || !started || ctfVoting() || document.pointerLockElement === renderer.domElement) return;
      if (performance.now() - lastLockFail < 2000) return;
      try { renderer.domElement.requestPointerLock(); } catch (e) { /* ignore */ }
    });
    requestAnimationFrame(frame);
  }

  function makeGridTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#0a0f1e';
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(34,211,238,0.28)';
    g.lineWidth = 2;
    const step = 32;
    for (let i = 0; i <= 512; i += step) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(90 / 4, 90 / 4);
    return tex;
  }

  function onResize() {
    if (!camera) return;
    const s = gameSize();
    camera.aspect = s.w / s.h;
    camera.updateProjectionMatrix();
    renderer.setSize(s.w, s.h);
  }

  // 手机端自动横屏：竖屏时整体旋转 90°，始终以横屏视角渲染
  function applyOrientation() {
    rotated = isTouch && window.innerHeight > window.innerWidth;
    appEl.classList.toggle('rotated', rotated);
    // 用精确像素尺寸，规避 iOS 上 vh/vw 与 innerHeight 不一致的问题
    if (rotated) {
      appEl.style.width = window.innerHeight + 'px';
      appEl.style.height = window.innerWidth + 'px';
    } else {
      appEl.style.width = '';
      appEl.style.height = '';
    }
    onResize();
  }
  function gameSize() {
    return rotated ? { w: window.innerHeight, h: window.innerWidth }
                   : { w: window.innerWidth, h: window.innerHeight };
  }
  // 视口触摸坐标 → 游戏坐标（旋转时换算）
  function toGame(clientX, clientY) {
    if (!rotated) return { x: clientX, y: clientY };
    return { x: clientY, y: window.innerWidth - clientX };
  }
  window.addEventListener('resize', applyOrientation);
  window.addEventListener('orientationchange', () => setTimeout(applyOrientation, 300));

  // =========================================================
  // 远端玩家 & 弹道
  // =========================================================
  function createRemotePlayer(sp) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 1.1, 0.5),
      new THREE.MeshStandardMaterial({ color: sp.color, roughness: 0.5, metalness: 0.2, transparent: true })
    );
    body.position.y = 0.55;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.4, 0.4),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(sp.color).multiplyScalar(0.65), roughness: 0.5, transparent: true })
    );
    head.position.y = 1.42;
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.9),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true })
    );
    gun.position.set(0.2, 0.85, -0.55);
    group.add(body, head, gun);

    const label = makeNameSprite(sp.name);
    group.add(label);

    group.position.set(sp.x, sp.y, sp.z);
    group.visible = true;
    scene.add(group);

    const rp = {
      id: sp.id, group, label,
      target: new THREE.Vector3(sp.x, sp.y, sp.z),
      cur: new THREE.Vector3(sp.x, sp.y, sp.z),
      yawT: sp.yaw, yawCur: sp.yaw,
      name: sp.name, visible: true, ghost: false,
    };
    remotePlayers.set(sp.id, rp);
    setGhost(rp, sp.alive === false);
    return rp;
  }

  // 死亡玩家显示为半透明幽灵（不再直接消失）
  function setGhost(rp, ghost) {
    rp.ghost = ghost;
    for (let i = 0; i < 3; i++) {
      const child = rp.group.children[i];
      if (child && child.material) child.material.opacity = ghost ? 0.35 : 1;
    }
  }

  // 旗手头顶发光环（全图可辨）
  function ensureCarrierRing(rp) {
    if (rp.carrierRing) return;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.06, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.3;
    rp.group.add(ring);
    rp.carrierRing = ring;
  }

  function removeRemotePlayer(id) {
    const rp = remotePlayers.get(id);
    if (rp) {
      scene.remove(rp.group);
      rp.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      remotePlayers.delete(id);
    }
  }

  function makeNameSprite(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 30px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.9)';
    g.shadowBlur = 10;
    g.fillStyle = '#ffffff';
    g.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(2.2, 0.55, 1);
    return sp;
  }

  function spawnProjMesh() {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x9ffcff })
    );
    m.visible = false;
    scene.add(m);
    projMeshes.push(m);
    return m;
  }

  // =========================================================
  // 本地物理（客户端预测，与服务器一致）
  // =========================================================
  function moveAxis(axis, dt) {
    const prevPos = myPos[axis];
    myPos[axis] += myVel[axis] * dt;
    const aabb = {
      minX: myPos.x - PLAYER_R, maxX: myPos.x + PLAYER_R,
      minY: myPos.y, maxY: myPos.y + PLAYER_H,
      minZ: myPos.z - PLAYER_R, maxZ: myPos.z + PLAYER_R,
    };
    if (axis === 'x' || axis === 'z') {
      for (const c of colliders) {
        if (!(aabb.minX < c.maxX && aabb.maxX > c.minX &&
          aabb.minY < c.maxY && aabb.maxY > c.minY &&
          aabb.minZ < c.maxZ && aabb.maxZ > c.minZ)) continue;
        if (myPos.y >= c.maxY - 0.001) continue;
        if (axis === 'x') {
          if (myVel.x > 0) { myPos.x = c.minX - PLAYER_R - 0.001; myVel.x = 0; }
          else if (myVel.x < 0) { myPos.x = c.maxX + PLAYER_R + 0.001; myVel.x = 0; }
        } else {
          if (myVel.z > 0) { myPos.z = c.minZ - PLAYER_R - 0.001; myVel.z = 0; }
          else if (myVel.z < 0) { myPos.z = c.maxZ + PLAYER_R + 0.001; myVel.z = 0; }
        }
      }
    } else {
      const prevY = prevPos;
      for (const c of colliders) {
        if (!(aabb.minX < c.maxX && aabb.maxX > c.minX &&
          aabb.minY < c.maxY && aabb.maxY > c.minY &&
          aabb.minZ < c.maxZ && aabb.maxZ > c.minZ)) continue;
        if (myVel.y < 0 && prevY >= c.maxY - 0.001) {
          myPos.y = c.maxY;
          grounded = true;
          myVel.y = 0;
        } else if (myVel.y > 0 && prevY + PLAYER_H <= c.minY + 0.001) {
          myPos.y = c.minY - PLAYER_H;
          myVel.y = 0;
        }
      }
    }
  }

  // 统一输入来源（键盘 + 触屏摇杆）
  function inputFwd() { return clamp((keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0) + joy.fwd, -1, 1); }
  function inputStrafe() { return clamp((keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0) + joy.strafe, -1, 1); }
  function inputJump() { return !!keys['Space'] || (jumpQueuedAt && performance.now() - jumpQueuedAt < 200); }

  function localPhysics(dt) {
    myVel.y -= GRAVITY * dt;
    if (myVel.y < -40) myVel.y = -40;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const fx = -sin, fz = -cos, rx = cos, rz = -sin;
    const fwd = inputFwd();
    const strafe = inputStrafe();
    myVel.x = (fx * fwd + rx * strafe) * MOVE_SPEED;
    myVel.z = (fz * fwd + rz * strafe) * MOVE_SPEED;

    const wasGrounded = grounded;
    grounded = false;
    moveAxis('x', dt);
    moveAxis('z', dt);
    moveAxis('y', dt);
    if (myPos.y <= 0 && myVel.y <= 0) { myPos.y = 0; myVel.y = 0; grounded = true; }
    const half = mapData.size.x / 2 - PLAYER_R;
    myPos.x = clamp(myPos.x, -half, half);
    myPos.z = clamp(myPos.z, -half, half);
    for (const pad of mapData.jumpPads) {
      const dx = myPos.x - pad.x, dz = myPos.z - pad.z;
      if (dx * dx + dz * dz <= pad.radius * pad.radius && myVel.y <= 0.5) {
        myVel.y = pad.strength;
      }
    }
    if (inputJump() && (grounded || wasGrounded)) {
      myVel.y = JUMP_VEL;
      grounded = false;
    }
  }

  // =========================================================
  // 主循环
  // =========================================================
  let lastT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.25) dt = 0.25; // 防止卡顿/切页造成大步长
    if (!scene) return;

    if (started && me && me.alive) {
      // 固定步长物理：与服务器 20Hz 完全一致，避免模拟漂移
      physAcc += dt;
      let steps = 0;
      while (physAcc >= FIXED_DT && steps < 6) {
        prevStep.x = myPos.x; prevStep.y = myPos.y; prevStep.z = myPos.z;
        localPhysics(FIXED_DT);
        curStep.x = myPos.x; curStep.y = myPos.y; curStep.z = myPos.z;
        physAcc -= FIXED_DT;
        steps++;
      }
      if (steps >= 6) physAcc = 0; // 追赶封顶，残余偏差由服务器校正
    } else {
      physAcc = 0;
    }
    // 物理步之间线性插值渲染：60fps 平滑移动，消除 20Hz 步进卡顿
    const alpha = Math.min(1, physAcc / FIXED_DT);
    camera.position.set(
      prevStep.x + (curStep.x - prevStep.x) * alpha,
      prevStep.y + (curStep.y - prevStep.y) * alpha + EYE_H,
      prevStep.z + (curStep.z - prevStep.z) * alpha
    );
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    const k = 1 - Math.exp(-16 * dt);
    for (const rp of remotePlayers.values()) {
      rp.group.position.lerp(rp.target, k);
      rp.yawCur = lerpAngle(rp.yawCur, rp.yawT, k);
      rp.group.rotation.y = rp.yawCur;
      rp.label.position.set(0, 2.35, 0);
      rp.label.lookAt(camera.position);
    }

    const t = now * 0.001;
    padMeshes.forEach((m, i) => {
      const s = 1 + 0.15 * Math.sin(t * 3 + i * 1.7);
      m.scale.set(s, 1, s);
    });
    if (zoneMesh && zoneMesh.visible) {
      zoneMesh.material.opacity = 0.15 + 0.08 * Math.sin(t * 2.2);
      zoneRing.material.opacity = 0.6 + 0.3 * Math.sin(t * 2.2);
    }
    pickupMeshes.forEach((m, i) => {
      m.rotation.y = t * 2 + i;
      m.position.y = m.userData.baseY + Math.sin(t * 2 + i) * 0.15;
    });

    const sinceShot = now - lastShotAt;
    if (sinceShot < FIRE_CD) {
      cooldown.classList.remove('hidden');
      cooldown.style.transform = 'translateX(-50%) scale(' + (1 - sinceShot / FIRE_CD) + ')';
    } else {
      cooldown.classList.add('hidden');
    }

    if (me && !me.alive) {
      const left = Math.max(0, Math.ceil((respawnAtLocal - now) / 1000));
      respawnText.textContent = left + ' 秒后复活';
    }

    renderer.render(scene, camera);
  }

  // =========================================================
  // 输入
  // =========================================================
  document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  });
  document.addEventListener('keyup', (e) => { keys[e.code] = false; });
  document.addEventListener('mousedown', (e) => {
    if (isTouch || e.button !== 0 || !started || ctfVoting()) return;
    fire = true;
    if (performance.now() - lastShotAt >= FIRE_CD) {
      lastShotAt = performance.now();
      beep(880, 0.06, 'square', 0.04);
    }
  });
  document.addEventListener('mouseup', (e) => { if (!isTouch && e.button === 0) fire = false; });
  document.addEventListener('mousemove', (e) => {
    if (isTouch || !started || ctfVoting()) return;
    let dx = 0, dy = 0;
    if (document.pointerLockElement === renderer.domElement) {
      // CS:GO 模式：指针锁定，原始位移增量，指哪转哪
      dx = e.movementX; dy = e.movementY;
    } else if (e.buttons & 2) {
      // 无锁降级：按住鼠标右键拖拽旋转
      dx = e.movementX; dy = e.movementY;
    } else {
      return;
    }
    yaw -= dx * SENS;
    pitch -= dy * SENS;
    pitch = clamp(pitch, -1.45, 1.45);
  });
  document.addEventListener('contextmenu', (e) => { if (started) e.preventDefault(); });
  document.addEventListener('pointerlockchange', () => {
    if (!started || isTouch || ctfVoting()) return;
    const locked = document.pointerLockElement === renderer.domElement;
    if (locked) showHint('已锁定鼠标 · 移动鼠标旋转视角 · ESC 解锁', 2000);
    else showHint('点击画面重新锁定（CS:GO 视角）· 右键拖拽也可转视角', 4000);
  });
  document.addEventListener('pointerlockerror', () => {
    if (isTouch) return;
    lastLockFail = performance.now();
    showHint('此环境点击锁定不可用，请按住鼠标右键拖拽旋转视角 · 左键射击', 4000);
  });

  // ---------- 触屏操作（类和平精英，统一触摸状态机） ----------
  document.addEventListener('touchstart', (e) => {
    if (!started || ctfVoting()) return; // 投票时让 UI 按钮可点，不拦截触摸
    e.preventDefault();
    const gw = gameSize().w, gh = gameSize().h;
    for (const t of e.changedTouches) {
      const g = toGame(t.clientX, t.clientY);
      // 开火键区域（右下角）
      const inFire = g.x > gw - 114 && g.x < gw - 26 && g.y > gh - 132 && g.y < gh - 44;
      // 跳跃键区域（开火键左上方）
      const inJump = g.x > gw - 198 && g.x < gw - 132 && g.y > gh - 184 && g.y < gh - 118;
      if (inFire && fireTouchId === null) {
        fireTouchId = t.identifier;
        touchFire = true;
        lastShotAt = performance.now();
        lookLast.set(t.identifier, { x: t.clientX, y: t.clientY });
        beep(880, 0.06, 'square', 0.04);
      } else if (inJump) {
        jumpQueuedAt = performance.now();
        lookLast.set(t.identifier, { x: t.clientX, y: t.clientY });
      } else if (g.x < gw * 0.42 && joyTouchId === null) {
        // 左半屏：虚拟摇杆（悬浮式）
        joyTouchId = t.identifier;
        joy.fwd = 0; joy.strafe = 0;
        joyBaseEl.style.left = g.x + 'px';
        joyBaseEl.style.top = g.y + 'px';
        joyBaseEl.style.display = 'block';
        joyKnobEl.style.transform = 'translate(-50%, -50%)';
      } else if (g.x >= gw * 0.42 && lookTouchId === null) {
        // 右半屏：滑动转视角
        lookTouchId = t.identifier;
        lookLast.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!started) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        const g = toGame(t.clientX, t.clientY);
        let dx = g.x - (joyBaseEl.offsetLeft + 66);
        let dy = g.y - (joyBaseEl.offsetTop + 66);
        const len = Math.hypot(dx, dy);
        if (len > JOY_RADIUS) { dx = dx / len * JOY_RADIUS; dy = dy / len * JOY_RADIUS; }
        joyKnobEl.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
        joy.fwd = clamp(-dy / JOY_RADIUS, -1, 1);
        joy.strafe = clamp(dx / JOY_RADIUS, -1, 1);
      } else if (t.identifier === lookTouchId || t.identifier === fireTouchId) {
        // 转视角（按住开火时同一手指也可滑动瞄准）
        const prev = lookLast.get(t.identifier);
        if (!prev) { lookLast.set(t.identifier, { x: t.clientX, y: t.clientY }); continue; }
        let dgx, dgy;
        if (rotated) { dgx = t.clientY - prev.y; dgy = -(t.clientX - prev.x); }
        else { dgx = t.clientX - prev.x; dgy = t.clientY - prev.y; }
        lookLast.set(t.identifier, { x: t.clientX, y: t.clientY });
        yaw -= dgx * TOUCH_SENS;
        pitch -= dgy * TOUCH_SENS;
        pitch = clamp(pitch, -1.45, 1.45);
      }
    }
  }, { passive: false });
  function endTouch(e) {
    if (!started) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        joyTouchId = null;
        joy.fwd = 0; joy.strafe = 0;
        joyBaseEl.style.display = 'none';
      } else if (t.identifier === lookTouchId) {
        lookTouchId = null;
      } else if (t.identifier === fireTouchId) {
        fireTouchId = null;
        touchFire = false;
      }
      lookLast.delete(t.identifier);
    }
    // 兜底：所有手指都抬起时清理按键状态
    if (e.touches.length === 0) touchFire = false;
  }
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  // 页面失焦/隐藏时清理触控输入，防止状态卡死
  function resetTouchInputs() {
    touchFire = false;
    fire = false;
    joy.fwd = 0; joy.strafe = 0;
    joyTouchId = null; lookTouchId = null; fireTouchId = null;
    lookLast.clear();
    if (joyBaseEl) joyBaseEl.style.display = 'none';
  }
  window.addEventListener('blur', () => { if (started) resetTouchInputs(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && started) resetTouchInputs(); });

  // ---------- 大厅 / 房间按钮 ----------
  lobbyName.addEventListener('input', () => {
    myName = (lobbyName.value || '玩家').trim().slice(0, 16);
  });
  createRoomBtn.addEventListener('click', () => {
    myName = (lobbyName.value || '玩家').trim().slice(0, 16);
    socket.emit('room:create', { name: myName + ' 的房间', playerName: myName, sessionId: getSessionId() });
  });
  quickJoinBtn.addEventListener('click', () => {
    // 优先进等待中的房间，其次可中途加入进行中的房间
    const open = roomList.find((r) => r.state === 'lobby' && !r.hasPassword)
      || roomList.find((r) => !r.hasPassword);
    if (open) {
      socket.emit('room:join', { code: open.code, name: myName, sessionId: getSessionId() });
    } else {
      showToast('暂无可加入的房间，试试创建一个');
    }
  });
  refreshRoomsBtn.addEventListener('click', () => {
    socket.emit('lobby:list');
    showToast('已刷新房间列表');
  });
  copyCodeBtn.addEventListener('click', () => {
    if (myRoom) {
      const ok = navigator.clipboard && navigator.clipboard.writeText(myRoom.code);
      if (ok) ok.then(() => showToast('房间码已复制：' + myRoom.code)).catch(() => showToast('房间码：' + myRoom.code));
      else showToast('房间码：' + myRoom.code);
    }
  });
  leaveRoomBtn.addEventListener('click', () => {
    socket.emit('room:leave');
  });
  readyBtn.addEventListener('click', () => {
    myReady = !myReady;
    socket.emit('room:ready', { ready: myReady });
  });
  startBtn.addEventListener('click', () => {
    socket.emit('room:start');
  });
  backToRoomBtn.addEventListener('click', () => {
    gameOverPage.classList.add('hidden');
    if (myRoom) enterRoom();
    else backToLobby();
  });
  // 房主改设置
  [modeSelect, maxSelect, minutesSelect].forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!myRoom || myRoom.hostId !== socket.id) return;
      socket.emit('room:settings', {
        mode: modeSelect.value,
        maxPlayers: parseInt(maxSelect.value, 10),
        matchMinutes: parseInt(minutesSelect.value, 10),
      });
    });
  });

  // 输入上报（死亡期间也持续上报，服务器自动忽略；复活瞬间输入立即生效）
  setInterval(() => {
    if (!socket || !started || !me) return;
    if (ctfVoting()) {
      // 投票期间：人物静止、不可移动/开火/跳跃
      socket.emit('input', { fwd: 0, strafe: 0, jump: false, fire: false, yaw, pitch });
      return;
    }
    socket.emit('input', {
      fwd: inputFwd(),
      strafe: inputStrafe(),
      jump: inputJump(),
      fire: fire || touchFire,
      yaw, pitch,
    });
  }, TICK_MS);

  // 延迟
  setInterval(() => {
    if (!socket || !socket.connected) return;
    const t0 = performance.now();
    socket.emit('ping', () => {
      pingEl.textContent = Math.round(performance.now() - t0);
    });
  }, 3000);

  // =========================================================
  // 启动
  // =========================================================
  function init() {
    applyOrientation(); // 手机端竖屏自动旋转为横屏
    if (isTouch) {
      // 手机端：显示触控 UI 并替换操作说明
      touchUI.classList.remove('hidden');
      if (helpText) {
        helpText.innerHTML =
          '<b>操作</b>：<b>左侧摇杆</b>移动 · <b>右侧滑动</b>旋转视角 · 右下<b>开火</b> · <b>跳跃</b>按钮<br/>' +
          '💡 四角发光传送台可弹射上天，中央高台是制高点；已自动横屏';
      }
    }
    myName = (lobbyName.value || '玩家').trim().slice(0, 16);
    const host = location.hostname || 'localhost';
    const port = location.port ? ':' + location.port : '';
    connStatus.textContent = '正在连接 ' + host + port + ' …';
    lobbyPage.classList.remove('hidden');
    connect();
  }
  init();
})();
