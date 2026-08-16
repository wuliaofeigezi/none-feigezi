/* 霓虹竞技场 Neon Arena — 客户端主逻辑 */
import * as THREE from './three.module.min.js';

(function () {
  'use strict';

  // =========================================================
  // 音频（WebAudio 程序化合成：背景音乐 + 武器/命中音效，无需外部文件）
  // =========================================================
  const AUDIO = {
    ctx: null, musicOn: true, sfxOn: true,
    musicTimer: null, nextT: 0, step: 0,
    laserSnd: null, // 激光持续音节点
    lastOwnLoiter: 0,
  };
  // 音乐：合成波风格循环（Am-F-C-G），120BPM，八分音符步进
  const MUSIC_CHORDS = [
    [220.0, 261.63, 329.63, 440.0],   // Am
    [174.61, 220.0, 261.63, 349.23],  // F
    [130.81, 196.0, 261.63, 329.63],  // C
    [196.0, 246.94, 293.66, 392.0],   // G
  ];
  const MUSIC_STEP = 60 / 120 / 2; // 八分音符时长

  function ensureAudio() {
    if (!AUDIO.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        AUDIO.ctx = new AC();
      } catch (e) { return null; }
    }
    if (AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume().catch(() => {});
    return AUDIO.ctx;
  }

  function tone(freq, dur, type, vol, freqEnd, lp) {
    const ctx = AUDIO.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(vol || 0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    if (lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = lp;
      o.connect(g); g.connect(f); f.connect(ctx.destination);
    } else { o.connect(g); g.connect(ctx.destination); }
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  function noiseAt(t, dur, vol, fType, fFreq) {
    const ctx = AUDIO.ctx;
    if (!ctx) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = fType || 'lowpass';
    f.frequency.value = fFreq || 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol || 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start(t);
  }

  // 背景音乐调度器
  function startMusic() {
    const ctx = ensureAudio();
    if (!ctx || !AUDIO.musicOn || AUDIO.musicTimer) return;
    AUDIO.nextT = ctx.currentTime + 0.1;
    AUDIO.step = 0;
    AUDIO.musicTimer = setInterval(() => {
      if (!AUDIO.ctx || !AUDIO.musicOn) return;
      while (AUDIO.nextT < AUDIO.ctx.currentTime + 0.15) {
        scheduleMusicStep(AUDIO.step, AUDIO.nextT);
        AUDIO.nextT += MUSIC_STEP;
        AUDIO.step = (AUDIO.step + 1) % 64;
      }
    }, 50);
  }
  function stopMusic() {
    clearInterval(AUDIO.musicTimer);
    AUDIO.musicTimer = null;
  }
  function scheduleMusicStep(step, t) {
    const ctx = AUDIO.ctx;
    const bar = Math.floor(step / 16) % 4;
    const s = step % 16;
    const chord = MUSIC_CHORDS[bar];
    // 贝斯（每拍根音）
    if (s % 4 === 0) tone(chord[0] / 2, MUSIC_STEP * 2, 'square', 0.05, null, 320);
    // 琶音（八分音符）
    const note = chord[s % chord.length] * (s === 4 || s === 12 ? 2 : 1);
    tone(note, MUSIC_STEP * 0.9, 'triangle', 0.035, null, 2600);
    // 鼓
    if (s === 0 || s === 8) tone(120, 0.12, 'sine', 0.09, 42);           // Kick
    if (s === 4 || s === 12) noiseAt(t, 0.1, 0.05, 'highpass', 1500);    // 军鼓
    if (s % 2 === 1) noiseAt(t, 0.03, 0.02, 'highpass', 6000);           // 踩镲
  }

  // ---- 武器/战斗音效 ----
  function sfxGau12() {
    if (!AUDIO.sfxOn || !AUDIO.ctx) return;
    noiseAt(AUDIO.ctx.currentTime, 0.05, 0.045, 'lowpass', 2800);
    tone(150 + Math.random() * 40, 0.06, 'square', 0.018, 80, 800);
  }
  function updateLaserSound(active) {
    const ctx = ensureAudio();
    if (!ctx || !AUDIO.sfxOn) { if (laserCleanup) laserCleanup(); return; }
    if (active && !AUDIO.laserSnd) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.value = 640 + Math.random() * 80;
      f.type = 'lowpass'; f.frequency.value = 1000;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.08);
      o.connect(g); g.connect(f); f.connect(ctx.destination);
      o.start();
      AUDIO.laserSnd = { o, g };
    } else if (!active && AUDIO.laserSnd) {
      const t = ctx.currentTime;
      AUDIO.laserSnd.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      AUDIO.laserSnd.o.stop(t + 0.12);
      AUDIO.laserSnd = null;
    }
  }
  function laserCleanup() {
    if (AUDIO.laserSnd) {
      try { AUDIO.laserSnd.o.stop(); } catch (e) { /* ignore */ }
      AUDIO.laserSnd = null;
    }
  }
  function sfxLoiter() {
    if (!AUDIO.sfxOn || !AUDIO.ctx) return;
    const t = AUDIO.ctx.currentTime;
    noiseAt(t, 0.4, 0.06, 'lowpass', 900);
    tone(300, 0.35, 'sawtooth', 0.03, 1400, 1200); // 升调哨声
  }
  function sfxExplosion() {
    if (!AUDIO.sfxOn || !AUDIO.ctx) return;
    noiseAt(AUDIO.ctx.currentTime, 0.5, 0.12, 'lowpass', 600);
    tone(90, 0.4, 'sine', 0.12, 35);
  }
  function toggleMusic() {
    AUDIO.musicOn = !AUDIO.musicOn;
    if (AUDIO.musicOn) startMusic(); else stopMusic();
    return AUDIO.musicOn;
  }
  function toggleSfx() {
    AUDIO.sfxOn = !AUDIO.sfxOn;
    if (!AUDIO.sfxOn) laserCleanup();
    return AUDIO.sfxOn;
  }

  // ===== 启动版本标记（浏览器控制台可确认加载到哪一版） =====
  console.log('[NeonArena] build 20260823 · 修复激光束崩溃/锁定重发 · 如加载旧版请强制刷新/清除缓存');

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const hud = $('hud'),
    lobbyPage = $('lobbyPage'), roomPage = $('roomPage'), gameOverPage = $('gameOverPage'),
    lobbyName = $('lobbyName'), connStatus = $('connStatus'),
    roomListEl = $('roomList'),
    battleBtn = $('battleBtn'), modeBtns = $('modeBtns'), musicBtn = $('musicBtn'),
    mechPreview0 = $('mechPreview0'), mechPreview1 = $('mechPreview1'),
    weaponSlots0 = $('weaponSlots0'), weaponSlots1 = $('weaponSlots1'),
    quickJoinBtn = $('quickJoinBtn'), refreshRoomsBtn = $('refreshRoomsBtn'),
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
    banner = $('banner'),
    // 机甲模块 HUD
    moduleHudEl = $('moduleHud'), mhLegs = $('mhLegs'),
    mhChest = $('mhChest'), mhChestTxt = $('mhChestTxt'),
    mhCore = $('mhCore'), mhCoreTxt = $('mhCoreTxt'),
    weaponHud = $('weaponHud'),
    // 死斗 HUD
    duelHud = $('duelHud'), duelLives = $('duelLives'),
    duelCore0 = $('duelCore0'), duelCore1 = $('duelCore1'),
    // 暂停 / 自杀
    pauseMenu = $('pauseMenu'), pauseContinueBtn = $('pauseContinueBtn'),
    pauseSuicideBtn = $('pauseSuicideBtn'), pauseLeaveBtn = $('pauseLeaveBtn'),
    pauseMusicBtn = $('pauseMusicBtn'), pauseSfxBtn = $('pauseSfxBtn'),
    suicideBar = $('suicideBar'), suicideFill = $('suicideFill'),
    lockBox = $('lockBox'), lockDist = $('lockDist'), dmgFlash = $('dmgFlash'),
    teamAlive = $('teamAlive'), taRed = $('taRed'), taBlue = $('taBlue'), taScore = $('taScore'),
    mechSelect = $('mechSelect'), msButtons = $('msButtons'),
    msWeapons = $('msWeapons'), msCountdown = $('msCountdown'), msConfirm = $('msConfirm');

  // ===== 常量（单一事实来源：public/js/neon-shared.js，禁止在此重复定义） =====
  const NS = window.NeonShared;
  const {
    TICK_MS, GRAVITY, MOVE_SPEED, JUMP_VEL, MAX_FALL, PLAYER_R,
    clamp, lerpAngle, toAABB, moveAxis,
  } = NS;
  const SENS = 0.0022;
  const FIRE_CD = Math.round(NS.FIRE_CD * 1000); // 300ms（与服务端 FIRE_CD=0.3s 同一来源）
  const FIXED_DT = TICK_MS / 1000; // 固定物理步长（与服务器 20Hz tick 完全一致）
  const ZONE_WIN_CLIENT = NS.ZONE_WIN; // 占点模式获胜积分（与服务器一致）

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
  const VOTE_CHANGE_MS = NS.VOTE_CHANGE_MS; // 投票改选冷却（与服务端一致，来自共享常量）
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
  let corrX = 0, corrZ = 0; // 平滑位置纠正量（渲染帧按帧衰减应用，避免闪回）
  let grounded = true;
  let yaw = 0, pitch = 0;
  const keys = {};
  let fire = false;
  let started = false;
  let lastKiller = '';
  let respawnIn = 0, respawnAtLocal = 0;
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

  // ===== 机库状态 =====
  let hangarRenderers = [];      // 机库 3D 预览 renderer
  let hangarModels = [null, null];
  let selectedMode = 'duel';     // duel(死斗) | ctf(战旗) | zone(占点)
  let mechConfigs = [
    { type: 'humanoid', weapons: ['gau12', 'gau12', 'gau12', 'gau12'] },
    { type: 'spider', weapons: ['gau12', 'gau12', 'gau12'] },
  ];
  // ===== 武器视觉状态 =====
  let tracerPool = [];           // 机炮曳光
  let beamMeshes = [];           // 激光束
  let loiterMeshes = [];         // 巡飞弹（带轨迹）
  let explosionPool = [];        // 爆炸闪光
  let duelState = null;          // 死斗 HUD 状态
  // ===== 暂停 / 自杀 =====
  let pauseOpen = false;
  let suicideHeldAt = 0;         // 长按 J 起始时间
  let suicideTimer = null;
  // ===== 第三人称 / 自机模型 / 受击反馈 =====
  let selfModel = null;          // 自机机甲模型（第三人称可见）
  let selfLastX = 0, selfLastZ = 0;
  let camShake = 0;              // 受击镜头震动
  let myClimbing = false;        // 本地预测：蜘蛛爬墙
  // ===== 索敌锁定 =====
  let lockTargetId = null;       // 当前锁定目标 id
  let lockEl = null;             // 锁定框 DOM
  let lockElDist = null;
  let lockSentAt = 0;

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

    // ---------- 机甲模块 / 死斗 ----------
    socket.on('moduleBroken', (d) => {
      if (d && d.id === (me && me.id)) {
        if (d.part === 'leg') showBanner('🦿 腿部模块损毁！移动速度降低！', 2200);
        else if (d.part === 'chest') showBanner('💔 胸部装甲耗尽！核心暴露！', 2500);
        beep(300, 0.15, 'square', 0.08);
      }
    });
    socket.on('duel:core', (d) => {
      showBanner('💥 基地核心被摧毁！' + (d && d.winnerTeam === 0 ? '🔴红队' : '🔵蓝队') + ' 获胜！', 4000);
      beep(220, 0.5, 'sawtooth', 0.12);
    });
    socket.on('duel:lives', (d) => {
      if (d && d.id === (me && me.id) && d.lives === 0) {
        showBanner('💥 你的机甲已全部损毁，出局！', 3000);
      }
    });
    socket.on('duel:round', (d) => {
      if (!d) return;
      if (d.cause === 'start') {
        showBanner('⚔ 第 ' + d.round + ' 回合开始！', 2000);
      } else if (d.winnerTeam !== null && d.winnerTeam !== undefined) {
        showBanner('🏁 第 ' + d.round + ' 回合：' + (d.winnerTeam === 0 ? '🔴红队' : '🔵蓝队') + ' 获胜！大局 ' + d.roundWins[0] + ':' + d.roundWins[1], 3000);
        beep(660, 0.2, 'triangle', 0.08);
      } else {
        showBanner('🏁 第 ' + d.round + ' 回合平局', 2500);
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
    roomListEl.innerHTML = roomList.map((r) => {
      const modeTxt = r.mode === 'zone' ? '🚩占点' : r.mode === 'ctf' ? '🏳️战旗' : r.mode === 'duel' ? '⚔死斗' : '🔫死竞';
      return `
      <div class="room-row" data-code="${esc(r.code)}">
        <span class="code">${esc(r.code)}</span>
        <span class="meta"><b>${esc(r.name)}</b> · ${modeTxt}
          ${r.state === 'playing' ? '<span class="in-game">⚔ 进行中</span>' : ''}
          ${r.hasPassword ? '<span class="lock">🔒</span>' : ''} · 房主 ${esc(r.hostName || '?')}</span>
        <span class="count">${r.players}/${r.maxPlayers}</span>
      </div>`;
    }).join('');
    roomListEl.querySelectorAll('.room-row').forEach((el) => {
      el.addEventListener('click', () => {
        myName = (lobbyName.value || '玩家').trim().slice(0, 16);
        socket.emit('room:join', { code: el.dataset.code, name: myName, sessionId: getSessionId(), mechs: mechConfigs });
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

  // ---------- 机库（原大厅） ----------
  const WEAPON_ORDER = ['gau12', 'laser', 'loiter'];
  const WEAPON_LABEL = { gau12: ['Gau12', '机炮'], laser: ['灼光', '镭射'], loiter: ['蜂群', '巡飞'] };
  function mechDisplayName(type) {
    return type === 'spider' ? '🕷 猎蛛' : '🤖 泰坦';
  }

  function initHangar() {
    if (modeBtns) {
      modeBtns.querySelectorAll('.mode-btn').forEach((b) => {
        b.addEventListener('click', () => {
          selectedMode = b.dataset.mode || 'duel';
          modeBtns.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
        });
      });
    }
    // 主战机甲选择已移除：机甲改为局内选择（开局/死亡后弹出选择面板）
    renderWeaponSlots(0);
    renderWeaponSlots(1);
    setupHangarPreviews();
    if (battleBtn) battleBtn.addEventListener('click', () => {
      myName = (lobbyName.value || '玩家').trim().slice(0, 16);
      socket.emit('room:create', {
        name: myName + ' 的房间',
        playerName: myName,
        sessionId: getSessionId(),
        mode: selectedMode,
        mechs: mechConfigs,
      });
    });
    // 机库预览独立渲染循环（修复电脑端预览不显示：不再依赖对局内 frame 循环）
    (function hangarLoop() {
      requestAnimationFrame(hangarLoop);
      if (uiState === 'lobby') renderHangarPreviews(0.016);
    })();
  }

  function renderWeaponSlots(slotIdx) {
    const el = slotIdx === 0 ? weaponSlots0 : weaponSlots1;
    if (!el) return;
    const cfg = mechConfigs[slotIdx];
    el.innerHTML = cfg.weapons.map((w, i) =>
      '<button class="weapon-slot w-' + w + '" data-i="' + i + '" title="点击切换武器">' +
      '<span class="ws-name">' + WEAPON_LABEL[w][0] + '</span>' +
      '<span class="ws-type">' + WEAPON_LABEL[w][1] + '</span></button>').join('');
    el.querySelectorAll('.weapon-slot').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        cfg.weapons[i] = WEAPON_ORDER[(WEAPON_ORDER.indexOf(cfg.weapons[i]) + 1) % WEAPON_ORDER.length];
        renderWeaponSlots(slotIdx);
        if (hangarModels[slotIdx] && hangarModels[slotIdx].userData.mounts) {
          // 刷新预览上的武器挂载
          const mounts = hangarModels[slotIdx].userData.mounts;
          mounts.forEach((m) => { for (let c = m.children.length - 1; c >= 0; c--) m.remove(m.children[c]); });
          cfg.weapons.forEach((w, i) => { if (mounts[i]) mountWeaponVisual(mounts[i], w); });
        }
      });
    });
  }

  function setupHangarPreviews() {
    const hosts = [mechPreview0, mechPreview1];
    hosts.forEach((host, idx) => {
      if (!host || hangarRenderers[idx]) return;
      const w = host.clientWidth || 320, h = host.clientHeight || 170;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(w, h);
      host.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0x8899ff, 0x0a0f1e, 0.9));
      const dir = new THREE.DirectionalLight(0xffffff, 0.6);
      dir.position.set(30, 50, 20);
      scene.add(dir);
      const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
      camera.position.set(idx === 0 ? 3.0 : 3.4, 2.0, 3.8);
      camera.lookAt(0, 0.85, 0);
      const model = buildMechModel(mechConfigs[idx].type, { color: idx === 0 ? 0x22d3ee : 0xa855f7 });
      scene.add(model);
      hangarModels[idx] = model;
      const mounts = model.userData.mounts;
      mechConfigs[idx].weapons.forEach((w, i) => { if (mounts[i]) mountWeaponVisual(mounts[i], w); });
      hangarRenderers.push({ renderer, scene, camera, spin: 0 });
    });
  }

  function renderHangarPreviews(dt) {
    for (const r of hangarRenderers) {
      r.spin += dt * 0.5;
      if (hangarModels[0] && r === hangarRenderers[0]) hangarModels[0].rotation.y = r.spin;
      if (hangarModels[1] && r === hangarRenderers[1]) hangarModels[1].rotation.y = r.spin;
      r.renderer.render(r.scene, r.camera);
    }
  }

  // ---------- 机甲模型（人形 / 蜘蛛） ----------
  function stdMat(color, emissive, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({
      color: color || 0x888888, emissive: emissive || 0x000000,
      roughness: 0.5, metalness: 0.35,
    }, opts || {}));
  }
  function box(w, h, d, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }

  function buildMechModel(type, opts) {
    const g = new THREE.Group();
    if (type === 'spider') buildSpiderModel(g, opts || {});
    else buildHumanoidModel(g, opts || {});
    return g;
  }

  // 人形战斗机器人（精细化）：髋/膝两段式双腿、肩甲、胸部装甲板、背部背包、核心、天线
  function buildHumanoidModel(g, o) {
    const color = o.color || 0x3b82f6;
    const dark = new THREE.Color(color).multiplyScalar(0.55);
    const mBody = stdMat(color, 0x0d2a4a);
    const mDark = stdMat(dark, 0x000000);
    const mSteel = stdMat(0x8899bb, 0x000000, { metalness: 0.6 });
    const mAccent = stdMat(0x22d3ee, 0x0e5a66, { metalness: 0.5 });
    const legs = [];
    for (let i = 0; i < 2; i++) {
      const pivot = new THREE.Group();
      pivot.position.set(i === 0 ? -0.24 : 0.24, 0.9, 0);
      // 大腿
      const thigh = box(0.3, 0.42, 0.3, mSteel); thigh.position.y = -0.21;
      // 膝关节护甲
      const knee = box(0.34, 0.14, 0.34, mAccent); knee.position.y = -0.44;
      // 小腿
      const shin = box(0.24, 0.42, 0.24, mDark); shin.position.y = -0.68;
      // 脚掌
      const foot = box(0.3, 0.12, 0.46, mSteel); foot.position.set(0, -0.9, 0.08);
      pivot.add(thigh, knee, shin, foot);
      g.add(pivot);
      legs.push(pivot);
    }
    // 胸部主装甲
    const chest = box(1.0, 0.72, 0.62, mBody);
    chest.position.y = 1.42;
    g.add(chest);
    // 胸甲中线装甲条
    const plate = box(0.5, 0.6, 0.05, mAccent);
    plate.position.set(0, 1.42, 0.32);
    g.add(plate);
    // 侧面散热口
    for (const s of [-1, 1]) {
      const vent = box(0.05, 0.28, 0.3, mDark);
      vent.position.set(s * 0.53, 1.4, 0);
      g.add(vent);
    }
    // 背部背包（动力单元）
    const pack = box(0.7, 0.5, 0.28, mDark);
    pack.position.set(0, 1.35, -0.44);
    g.add(pack);
    const packGlow = box(0.5, 0.12, 0.1, stdMat(0x22d3ee, 0x22d3ee, { emissiveIntensity: 0.8 }));
    packGlow.position.set(0, 1.35, -0.56);
    g.add(packGlow);
    // 核心（藏于胸部，发光；胸部破碎后外露脉动）
    const core = box(0.34, 0.22, 0.1, new THREE.MeshStandardMaterial({
      color: 0xff3355, emissive: 0xff2244, emissiveIntensity: 0.95,
    }));
    core.position.set(0, 1.4, 0.34);
    g.add(core);
    // 无头部：顶部观察窗
    const dome = box(0.5, 0.14, 0.4, mDark);
    dome.position.y = 1.8;
    g.add(dome);
    const visor = box(0.3, 0.08, 0.05, stdMat(0x7df9ff, 0x22d3ee, { emissiveIntensity: 0.9 }));
    visor.position.set(0, 1.8, 0.21);
    g.add(visor);
    // 肩部装甲 + 4 战斗模块槽：两侧各上下两个（上部落于肩膀上，下部落于肩膀侧）
    const mounts = [];
    const mountPos = [
      [-0.72, 1.68, 0.14], [0.72, 1.68, 0.14],  // 上部：落于肩膀上
      [-0.9, 1.38, 0], [0.9, 1.38, 0],          // 下部：落于肩膀侧
    ];
    for (let i = 0; i < mountPos.length; i++) {
      const [mx, my, mz] = mountPos[i];
      const pad = box(0.42, 0.1, 0.32, mSteel);
      pad.position.set(mx, my - 0.09, mz);
      g.add(pad);
      const pivot = new THREE.Group();
      pivot.position.set(mx, my, mz);
      g.add(pivot);
      mounts.push(pivot);
    }
    g.userData = { type: 'humanoid', legs, chest, core, mounts, gait: 0 };
  }

  // 蜘蛛机器人（精细化）：六条腿 60° 均匀环绕胸部、腹部隆起、核心、3 战斗模块槽
  function buildSpiderModel(g, o) {
    const color = o.color || 0xa855f7;
    const dark = new THREE.Color(color).multiplyScalar(0.55);
    const mBody = stdMat(color, 0x1a0d2a);
    const mDark = stdMat(dark, 0x000000);
    const mSteel = stdMat(0xbb99dd, 0x000000, { metalness: 0.6 });
    const mAccent = stdMat(0xff9db8, 0x5a0e2a, { metalness: 0.4 });
    // 胸部主舱（略扁的六边形舱体：用盒体近似）
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.62, 1.15), mBody);
    chest.position.y = 0.82;
    g.add(chest);
    // 腹部（尾部隆起）
    const abdomen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 1.0), mDark);
    abdomen.position.set(0, 0.6, -0.95);
    abdomen.rotation.x = 0.35;
    g.add(abdomen);
    // 头部传感器
    const head = box(0.4, 0.24, 0.4, mDark);
    head.position.set(0, 1.05, 0.75);
    g.add(head);
    const eye = box(0.22, 0.08, 0.08, stdMat(0x7df9ff, 0x22d3ee, { emissiveIntensity: 0.9 }));
    eye.position.set(0, 1.05, 0.96);
    g.add(eye);
    // 核心（胸部前上方）
    const core = box(0.36, 0.18, 0.1, new THREE.MeshStandardMaterial({
      color: 0xff3355, emissive: 0xff2244, emissiveIntensity: 0.95,
    }));
    core.position.set(0, 0.95, 0.55);
    core.rotation.x = -0.2;
    g.add(core);
    // 六条腿：60° 均匀环绕胸部（两段式 + 足尖）
    const legs = [];
    for (let i = 0; i < 6; i++) {
      const ang = (i * 60 - 90) * Math.PI / 180; // -90° 起顺时针
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(ang) * 0.8, 0.74, Math.sin(ang) * 0.8);
      pivot.rotation.y = ang;
      const thigh = box(0.1, 0.55, 0.1, mSteel);
      thigh.position.set(0.34, -0.26, 0);
      thigh.rotation.z = -0.62;
      const knee = box(0.12, 0.1, 0.12, mAccent);
      knee.position.set(0.56, -0.52, 0);
      const shin = box(0.08, 0.46, 0.08, mDark);
      shin.position.set(0.72, -0.72, 0);
      shin.rotation.z = 0.3;
      const foot = box(0.1, 0.06, 0.24, mSteel);
      foot.position.set(0.86, -0.94, 0);
      pivot.add(thigh, knee, shin, foot);
      g.add(pivot);
      legs.push(pivot);
    }
    // 胸部两侧 + 顶部 3 战斗模块槽
    const mounts = [];
    const mountPos = [[-0.95, 1.02, 0.1], [0.95, 1.02, 0.1], [0, 1.5, 0]];
    for (const [mx, my, mz] of mountPos) {
      const pad = box(0.4, 0.08, 0.3, mSteel);
      pad.position.set(mx, my - 0.06, mz);
      g.add(pad);
      const pivot = new THREE.Group();
      pivot.position.set(mx, my, mz);
      g.add(pivot);
      mounts.push(pivot);
    }
    g.userData = { type: 'spider', legs, chest, core, mounts, gait: 0 };
  }

  // 武器挂载到战斗模块槽（精细化）
  function mountWeaponVisual(mount, type) {
    if (type === 'gau12') {
      // 30mm 机炮：炮管 + 制退器 + 弹箱
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x33415e, metalness: 0.7, roughness: 0.3 }));
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = -0.3;
      const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8), new THREE.MeshStandardMaterial({ color: 0x7df9ff, metalness: 0.8, roughness: 0.2 }));
      muzzle.rotation.x = Math.PI / 2;
      muzzle.position.z = -0.6;
      const ammo = box(0.22, 0.12, 0.16, new THREE.MeshStandardMaterial({ color: 0x5a3a10, roughness: 0.6 }));
      ammo.position.set(0, 0.1, -0.2);
      mount.add(barrel, muzzle, ammo);
    } else if (type === 'laser') {
      // 镭射：发射器球头 + 聚焦环
      const emitter = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), new THREE.MeshStandardMaterial({ color: 0xff5c7a, emissive: 0xff2244, emissiveIntensity: 0.9 }));
      emitter.position.z = -0.26;
      const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.02, 6, 12), new THREE.MeshStandardMaterial({ color: 0x8899bb, metalness: 0.7 }));
      ring1.position.z = -0.4;
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.015, 6, 12), new THREE.MeshStandardMaterial({ color: 0x8899bb, metalness: 0.7 }));
      ring2.position.z = -0.52;
      const body = box(0.2, 0.14, 0.3, new THREE.MeshStandardMaterial({ color: 0x5a1030 }));
      body.position.z = -0.1;
      mount.add(body, emitter, ring1, ring2);
    } else {
      // 巡飞弹：5 管发射巢
      const launcher = box(0.34, 0.2, 0.4, new THREE.MeshStandardMaterial({ color: 0x4a3a10, roughness: 0.5 }));
      launcher.position.z = -0.2;
      mount.add(launcher);
      for (let r = -1; r <= 1; r++) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 6), new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.6 }));
        tube.rotation.x = Math.PI / 2;
        tube.position.set(r * 0.11, 0.04, -0.2);
        mount.add(tube);
      }
    }
  }

  // 腿部步行/瘸腿动画（按损毁腿数）
  function animateMechLegs(rp, dt) {
    const ud = rp.group.userData || {};
    const legs = ud.legs || [];
    if (!legs.length) return;
    // 移动速度 → 步频
    const spd = rp.target ? Math.hypot(rp.target.x - rp.lastX, rp.target.z - rp.lastZ) / Math.max(dt, 0.001) : 0;
    rp.lastX = rp.target.x; rp.lastZ = rp.target.z;
    ud.gait += Math.min(spd, 12) * dt * 3.2;
    const alive = rp.alive !== false;
    if (ud.type === 'spider') {
      // 蜘蛛：六腿环绕交替步态；损毁腿收起拖行；爬墙时六腿向上攀爬
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const destroyed = rp.legs && rp.legs[i] <= 0;
        if (!alive) { leg.rotation.z = 0; leg.rotation.x = 0; continue; }
        if (rp.climbing) {
          // 爬墙：腿交替向上够
          leg.rotation.z = -0.6 - Math.abs(Math.sin(ud.gait + i * 1.05)) * 0.55;
          leg.rotation.x = Math.sin(ud.gait * 0.7 + i * 1.05) * 0.3;
          continue;
        }
        if (destroyed) {
          leg.rotation.z = -0.95 - (i % 2) * 0.2; // 收起拖行
          leg.rotation.x = 0.35;
        } else {
          leg.rotation.z = -0.62 + Math.sin(ud.gait * 0.5 + i * 1.05) * 0.16;
          leg.rotation.x = Math.sin(ud.gait + i * 1.1) * 0.2;
        }
      }
    } else {
      // 人形：双腿交替摆动；损毁腿后拖
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const destroyed = rp.legs && rp.legs[i] <= 0;
        if (!alive) { leg.rotation.x = 0.05; continue; }
        if (destroyed) {
          leg.rotation.x = -1.0; // 拖行
          leg.position.x = (i === 0 ? -0.22 : 0.22) + (i === 0 ? -0.06 : 0.06); // 外撇
        } else {
          leg.rotation.x = Math.sin(ud.gait + i * Math.PI) * 0.55 * Math.min(spd, 12) / 12;
          leg.position.x = i === 0 ? -0.22 : 0.22;
        }
      }
    }
    // 胸部破碎 → 核心脉冲
    if (ud.core) {
      const pulse = rp.chestBroken ? (1 + 0.35 * Math.sin(performance.now() * 0.008)) : 1;
      ud.core.scale.setScalar(pulse);
    }
  }

  // ---------- 第三人称相机辅助 / 索敌锁定 / 受击反馈 ----------
  // 相机到玩家的线段与地形求交：撞墙时把相机拉回
  function collideCamera(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    const out = new THREE.Vector3(x1, y1, z1);
    if (len < 0.01) return out;
    const steps = Math.max(1, Math.ceil(len / 0.2));
    let last = new THREE.Vector3(x0, y0, z0);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const x = x0 + dx * f, y = y0 + dy * f, z = z0 + dz * f;
      for (const c of colliders) {
        if (x > c.minX && x < c.maxX && y > c.minY && y < c.maxY && z > c.minZ && z < c.maxZ) {
          return last;
        }
      }
      last.set(x, y, z);
    }
    return out;
  }

  function projectToScreen(v) {
    const vec = v.clone().project(camera);
    const s = gameSize();
    return { x: (vec.x * 0.5 + 0.5) * s.w, y: (-vec.y * 0.5 + 0.5) * s.h, behind: vec.z > 1 };
  }

  function sendLock(targetId) {
    if (socket && socket.connected) socket.emit('lock', { targetId: targetId || null });
  }

  // 索敌：准星附近（屏幕 70px 内）最近的可锁定敌人；未瞄到敌人时保持当前锁定
  // 索敌：准星附近（屏幕 110px 内）最近的可锁定敌人；未瞄到敌人时保持当前锁定；
  // 每 400ms 重发一次锁定请求（墙体/距离短暂受阻后自动重新获取）
  function updateLockTarget() {
    if (!started || !me || !me.alive || pauseOpen || ctfVoting() || mechSelecting()) {
      if (lockTargetId) { lockTargetId = null; sendLock(null); }
      return;
    }
    const s = gameSize();
    const cx0 = s.w / 2, cy0 = s.h / 2;
    const center = new THREE.Vector3();
    let best = null, bestD3 = Infinity;
    for (const [id, rp] of remotePlayers) {
      if (!rp.visible || rp.alive === false) continue;
      if ((gameMode === 'duel' || gameMode === 'ctf') && rp.team === me.team) continue; // 不锁队友
      center.copy(rp.target).add({ x: 0, y: 1.1, z: 0 });
      const v = projectToScreen(center);
      if (v.behind) continue;
      if (Math.hypot(v.x - cx0, v.y - cy0) > 110) continue;
      const d3 = Math.hypot(rp.target.x - myPos.x, rp.target.y - myPos.y, rp.target.z - myPos.z);
      if (d3 > 60 || d3 >= bestD3) continue;
      bestD3 = d3;
      best = id;
    }
    const now = performance.now();
    if (best) {
      if (best !== lockTargetId || now - lockSentAt > 400) {
        lockTargetId = best;
        lockSentAt = now;
        sendLock(best);
      }
    } else if (lockTargetId && !remotePlayers.has(lockTargetId)) {
      lockTargetId = null;
      sendLock(null);
    }
  }

  // 锁定框跟随服务端确认的锁定（距离过远/墙阻隔时服务端自动解锁）
  function updateLockBox() {
    if (!lockBox || !lockDist) return;
    const tid = me && me.lockId;
    const show = started && tid && me.alive && remotePlayers.has(tid);
    if (!show) { lockBox.classList.add('hidden'); return; }
    const rp = remotePlayers.get(tid);
    const center = new THREE.Vector3().copy(rp.target).add({ x: 0, y: 1.1, z: 0 });
    const v = projectToScreen(center);
    if (v.behind) { lockBox.classList.add('hidden'); return; }
    lockBox.classList.remove('hidden');
    lockBox.style.margin = '0';
    lockBox.style.left = (v.x - 65) + 'px';
    lockBox.style.top = (v.y - 65) + 'px';
    const d = Math.hypot(rp.target.x - myPos.x, rp.target.y - myPos.y, rp.target.z - myPos.z);
    lockDist.textContent = Math.round(d) + 'm';
  }

  // 命中反馈（我方命中敌人）
  function showHitmarker(part) {
    if (!hitmark) return;
    hitmark.classList.remove('hidden');
    if (part === 'core') hitmark.style.background = '#ff3355';
    else hitmark.style.background = '';
    clearTimeout(showHitmarker._t);
    showHitmarker._t = setTimeout(() => {
      hitmark.classList.add('hidden');
      hitmark.style.background = '';
    }, 100);
  }

  // 受击反馈（我被击中）：红闪 + 镜头震动 + 音效
  function onDamaged(part, dmg) {
    if (dmgFlash) {
      dmgFlash.style.opacity = 1;
      clearTimeout(onDamaged._t);
      onDamaged._t = setTimeout(() => { dmgFlash.style.opacity = 0; }, 110);
    }
    camShake = Math.min(0.9, camShake + 0.18 + (dmg || 0) * 0.004);
    beep(520, 0.08, 'sawtooth', 0.05);
  }

  // ---------- 命中火花（弹着点粒子） ----------
  let sparkPool = [];
  function getSpark() {
    for (const s of sparkPool) if (!s.active) { s.active = true; s.mesh.visible = true; return s; }
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, 0.07),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 1 })
    );
    const s = { mesh, active: true, life: 0, vx: 0, vy: 0, vz: 0 };
    scene.add(mesh);
    sparkPool.push(s);
    return s;
  }
  function spawnSparks(x, y, z, n) {
    for (let i = 0; i < (n || 4); i++) {
      const s = getSpark();
      s.life = 0.3;
      s.mesh.position.set(x, y, z);
      s.vx = (Math.random() - 0.5) * 3;
      s.vy = Math.random() * 3.2;
      s.vz = (Math.random() - 0.5) * 3;
    }
  }
  function updateSparks(dt) {
    for (const s of sparkPool) {
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) { s.active = false; s.mesh.visible = false; continue; }
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.material.opacity = Math.max(0, s.life / 0.3);
    }
  }

  // ---------- 观战模式（死斗出局） ----------
  let spectateId = null;
  function spectateCamera(dt) {
    if (!spectateId || !remotePlayers.has(spectateId) || remotePlayers.get(spectateId).alive === false) {
      spectateId = null;
      let best = null, bd = Infinity;
      for (const [id, rp] of remotePlayers) {
        if (rp.alive === false || !rp.visible) continue;
        const d = Math.hypot(rp.target.x - myPos.x, rp.target.y - myPos.y, rp.target.z - myPos.z);
        if (d < bd) { bd = d; best = id; }
      }
      spectateId = best;
    }
    const rp = spectateId && remotePlayers.get(spectateId);
    if (!rp) return;
    const cpc = Math.cos(pitch), spc = Math.sin(pitch);
    const camPos = new THREE.Vector3(
      rp.target.x + Math.sin(yaw) * cpc * 6, rp.target.y + 2.6 - spc * 4, rp.target.z + Math.cos(yaw) * cpc * 6
    );
    camera.position.lerp(camPos, Math.min(1, 10 * dt));
    camera.lookAt(rp.target.x, rp.target.y + 1.3, rp.target.z);
    if (lockBox) lockBox.classList.add('hidden');
  }

  // ---------- 局内选择机甲（开局/死亡后可换机甲再部署；选择期间不可移动攻击） ----------
  let msSelected = -1;           // 当前选中机甲 index
  let mechChoicesCache = [];     // 最近一次 me 事件携带的机甲选择列表
  let msWeaponEdits = {};        // 武器模块编辑缓存：index -> weapons[]
  let msCountdownTimer = null;
  let msRespawnEndsAt = 0;

  function mechSelecting() {
    return !!(mechSelect && !mechSelect.classList.contains('hidden'));
  }

  // 30s 重生倒计时（选择面板内显示；倒计时结束自动确认当前选择）
  function startMsCountdown(respawnIn) {
    msRespawnEndsAt = performance.now() + (respawnIn || 0);
    clearInterval(msCountdownTimer);
    msCountdownTimer = setInterval(() => {
      const left = (msRespawnEndsAt - performance.now()) / 1000;
      if (msCountdown) {
        msCountdown.textContent = respawnIn > 0
          ? (left > 0 ? Math.ceil(left) + ' 秒后自动重生' : '即将自动重生…')
          : '选择机甲出击';
      }
      if (respawnIn > 0 && left <= 0 && msSelected >= 0) {
        socket.emit('mech:select', { index: msSelected });
        if (mechSelect) mechSelect.classList.add('hidden');
        clearInterval(msCountdownTimer);
      }
    }, 200);
  }

  function renderMsWeapons() {
    const el = msWeapons;
    if (!el) return;
    const choice = mechChoicesCache.find((c) => c.index === msSelected);
    if (!choice) { el.innerHTML = ''; return; }
    const weapons = msWeaponEdits[choice.index] || choice.weapons;
    el.innerHTML = weapons.map((w, i) =>
      '<button class="ms-weapon w-' + w + '" data-i="' + i + '">' +
      '<span class="ws-name">' + WEAPON_LABEL[w][0] + '</span>' +
      '<span class="ws-type">' + WEAPON_LABEL[w][1] + '</span></button>').join('');
    el.querySelectorAll('.ms-weapon').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        const list = (msWeaponEdits[choice.index] || choice.weapons.slice());
        list[i] = WEAPON_ORDER[(WEAPON_ORDER.indexOf(list[i]) + 1) % WEAPON_ORDER.length];
        msWeaponEdits[choice.index] = list;
        renderMsWeapons();
        socket.emit('mech:config', { index: choice.index, weapons: list }); // 立即保存到服务器
        beep(660, 0.05, 'square', 0.04); // 点击反馈
      });
    });
  }

  function updateMechSelect(m) {
    const el = mechSelect, btns = msButtons;
    if (!el || !btns) return;
    if (m.alive) {
      el.classList.add('hidden');
      clearInterval(msCountdownTimer);
      msWeaponEdits = {};
      return;
    }
    const list = (m.mechChoices || []).slice(); // 服务端已过滤死斗中已损毁的机甲
    if (!list.length) { el.classList.add('hidden'); clearInterval(msCountdownTimer); return; }
    mechChoicesCache = list;
    if (msSelected < 0 || !list.some((c) => c.index === msSelected)) msSelected = list[0].index;
    el.classList.remove('hidden');
    btns.innerHTML = list.map((c) =>
      '<button class="ms-btn' + (c.index === msSelected ? ' selected' : '') + '" data-i="' + c.index + '">' +
      mechDisplayName(c.type) + '</button>').join('');
    btns.querySelectorAll('.ms-btn').forEach((b) => {
      b.addEventListener('click', () => {
        msSelected = parseInt(b.dataset.i, 10);
        btns.querySelectorAll('.ms-btn').forEach((x) => x.classList.toggle('selected', x === b));
        renderMsWeapons();
        beep(700, 0.05, 'triangle', 0.05); // 点击反馈
      });
    });
    renderMsWeapons();
    startMsCountdown(m.respawnIn || 0);
  }

  // ---------- 武器视觉（曳光/激光束/巡飞弹/爆炸） ----------
  function getTracer() {
    for (const t of tracerPool) if (!t.active) { t.active = true; t.mesh.visible = true; return t; }
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 1, 5),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95 })
    );
    const t = { mesh, active: true, life: 0 };
    scene.add(mesh);
    tracerPool.push(t);
    return t;
  }
  function updateTracers(shots, dt) {
    const now = performance.now();
    for (const t of tracerPool) {
      if (t.active) {
        t.life -= dt;
        if (t.life <= 0) { t.active = false; t.mesh.visible = false; }
      }
    }
    for (const s of shots || []) {
      const t = getTracer();
      t.life = 0.12;
      const a = new THREE.Vector3(s.x1, s.y1, s.z1);
      const b = new THREE.Vector3(s.x2, s.y2, s.z2);
      const len = a.distanceTo(b) || 0.01;
      t.mesh.position.copy(a).add(b).multiplyScalar(0.5);
      t.mesh.scale.set(1, len, 1);
      t.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      t.mesh.material.color.setHex(s.hit ? 0xffe9a8 : 0x9ffcff);
      if (s.hit) spawnSparks(s.x2, s.y2, s.z2, 3); // 命中火花
    }
  }
  // 激光束渲染：核心亮芯 + 外层辉光（索引与列表一一对应，杜绝池复用崩溃）
  function updateBeams(beams) {
    const list = beams || [];
    for (const g of beamMeshes) g.visible = false;
    for (let i = 0; i < list.length; i++) {
      let g = beamMeshes[i];
      if (!g) {
        g = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.13, 1, 10),
          new THREE.MeshBasicMaterial({ color: 0xfff1f5, transparent: true, opacity: 0.95 })
        );
        const glow = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.3, 1, 10),
          new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.35 })
        );
        g.add(core, glow);
        g.visible = false;
        scene.add(g);
        beamMeshes.push(g);
      }
      g.visible = true;
      const b = list[i];
      const a = new THREE.Vector3(b.x1, b.y1, b.z1);
      const c = new THREE.Vector3(b.x2, b.y2, b.z2);
      const len = a.distanceTo(c) || 0.01;
      g.position.copy(a).add(c).multiplyScalar(0.5);
      g.scale.set(1, len, 1);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
      g.children[0].material.opacity = 0.85 + 0.15 * Math.sin(performance.now() * 0.03);
      g.children[1].material.opacity = 0.3 + 0.15 * Math.sin(performance.now() * 0.03);
    }
  }
  function getLoiterMesh() {
    for (const m of loiterMeshes) if (!m.active) { m.active = true; m.mesh.visible = true; m.trail.visible = true; return m; }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb84a })
    );
    const trailGeo = new THREE.BufferGeometry();
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffb84a, transparent: true, opacity: 0.7 }));
    const o = { mesh, trail, active: true, history: [] };
    scene.add(mesh);
    scene.add(trail);
    loiterMeshes.push(o);
    return o;
  }
  function updateLoiterMeshes(projectiles) {
    const list = (projectiles || []).filter((p) => p.kind !== 'bullet'); // 仅巡飞弹
    for (let i = 0; i < loiterMeshes.length; i++) {
      if (i >= list.length) { loiterMeshes[i].active = false; loiterMeshes[i].mesh.visible = false; loiterMeshes[i].trail.visible = false; continue; }
      const o = getLoiterMesh();
      const p = list[i];
      o.mesh.position.set(p.x, p.y, p.z);
      o.history.push({ x: p.x, y: p.y, z: p.z });
      if (o.history.length > 8) o.history.shift();
      if (o.history.length > 1) {
        const pos = new Float32Array(o.history.length * 3);
        o.history.forEach((h, j) => { pos[j * 3] = h.x; pos[j * 3 + 1] = h.y; pos[j * 3 + 2] = h.z; });
        o.trail.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        o.trail.geometry.setDrawRange(0, o.history.length);
        o.trail.geometry.computeBoundingSphere();
      }
    }
    for (let i = list.length; i < loiterMeshes.length; i++) { loiterMeshes[i].active = false; loiterMeshes[i].mesh.visible = false; loiterMeshes[i].trail.visible = false; }
  }

  // 机炮子弹（小型弹体，不穿墙）
  let bulletPool = [];
  function getBulletMesh() {
    for (const m of bulletPool) if (!m.visible) { m.visible = true; return m; }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
    );
    mesh.visible = false;
    scene.add(mesh);
    bulletPool.push(mesh);
    return mesh;
  }
  function updateBullets(projectiles) {
    const list = (projectiles || []).filter((p) => p.kind === 'bullet');
    for (let i = 0; i < list.length; i++) {
      const m = getBulletMesh();
      m.position.set(list[i].x, list[i].y, list[i].z);
    }
    for (let i = list.length; i < bulletPool.length; i++) bulletPool[i].visible = false;
  }
  function getExplosion() {
    for (const e of explosionPool) if (!e.active) { e.active = true; e.mesh.visible = true; return e; }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb84a, transparent: true, opacity: 0.9 })
    );
    const o = { mesh, active: true, life: 0 };
    scene.add(mesh);
    explosionPool.push(o);
    return o;
  }
  function updateExplosions(list, dt) {
    for (const e of explosionPool) {
      if (e.active) {
        e.life -= dt;
        if (e.life <= 0) { e.active = false; e.mesh.visible = false; }
        else {
          const s = 1.6 - e.life * 2;
          e.mesh.scale.setScalar(Math.max(0.3, s));
          e.mesh.material.opacity = Math.max(0, e.life / 0.45);
        }
      }
    }
    for (const x of list || []) {
      const e = getExplosion();
      e.life = 0.45;
      e.mesh.position.set(x.x, x.y, x.z);
      e.mesh.scale.setScalar(0.3);
      e.mesh.material.opacity = 0.9;
    }
  }

  // ---------- 模块 / 武器 / 死斗 HUD ----------
  function updateModuleHud(m) {
    if (!moduleHudEl || !m || !m.mech) return;
    const cfg = NS.MECHS[m.mechType] || NS.MECHS.humanoid;
    const mech = m.mech;
    // 腿部
    let html = '';
    mech.legs.forEach((hp, i) => {
      const destroyed = hp <= 0;
      html += '<div class="mh-leg' + (destroyed ? ' destroyed' : '') + '">' +
        '<span>腿' + (i + 1) + '</span>' +
        '<div class="mh-track"><div style="width:' + clamp((hp / cfg.legHp) * 100, 0, 100) + '%"></div></div></div>';
    });
    if (mhLegs) mhLegs.innerHTML = html;
    if (mhChest) mhChest.style.width = clamp((mech.chest / mech.chestMax) * 100, 0, 100) + '%';
    if (mhChestTxt) mhChestTxt.textContent = Math.max(0, Math.ceil(mech.chest));
    if (mhCore) mhCore.style.width = clamp((mech.core / cfg.coreHp) * 100, 0, 100) + '%';
    if (mhCoreTxt) mhCoreTxt.textContent = Math.max(0, Math.ceil(mech.core));
  }

  function updateWeaponHud(m) {
    if (!weaponHud || !m || !m.weapons) return;
    const rows = m.weapons.map((w) => {
      const def = NS.WEAPONS[w.type];
      let status, cls = '';
      if (w.type === 'laser') {
        status = '充能 ' + Math.round((w.charge || 0) * 100) + '%';
        cls = (w.charge || 0) < 0.3 ? 'low' : '';
      } else if (w.reloading) {
        status = '装填 ' + ((w.reloadLeft || 0)).toFixed(1) + 's';
        cls = 'reloading';
      } else {
        status = '备弹 ' + (w.ammo || 0) + ' / ' + def.mag;
        cls = (w.ammo || 0) <= def.mag * 0.25 ? 'low' : '';
      }
      return '<div class="w-row ' + cls + '"><span class="wn">' + def.name + '</span>' +
        '<span class="ws' + (w.reloading ? ' big' : '') + '">' + status + '</span></div>';
    }).join('');
    weaponHud.innerHTML = rows;
  }

  function updateDuelHud(state) {
    if (!duelHud || !state) return;
    duelHud.classList.remove('hidden');
    duelLives.textContent = me ? ('剩余机甲 ' + (me.lives || 0) + ' 台') : '';
    const b0 = state.bases && state.bases[0], b1 = state.bases && state.bases[1];
    if (b0) {
      duelCore0.style.width = b0.coreAlive ? (b0.deploy / state.deployNeed) * 100 + '%' : '100%';
      duelCore0.parentElement.classList.toggle('down', !b0.coreAlive);
    }
    if (b1) {
      duelCore1.style.width = b1.coreAlive ? (b1.deploy / state.deployNeed) * 100 + '%' : '100%';
      duelCore1.parentElement.classList.toggle('down', !b1.coreAlive);
    }
  }

  // 顶部每方存活人数：一个小人 = 一个玩家；熄灭 = 无法复活（出局）
  function updateTeamAlive(players, duel) {
    if (!teamAlive || !taRed || !taBlue || !taScore) return;
    if (gameMode !== 'duel' && gameMode !== 'ctf') { teamAlive.classList.add('hidden'); return; }
    teamAlive.classList.remove('hidden');
    const groups = [taRed, taBlue];
    for (let t = 0; t < 2; t++) {
      const list = (players || []).filter((p) => p.team === t);
      groups[t].innerHTML = list.map((p) => {
        // 无法复活：死斗出局（lives<=0）或断线
        const dead = (gameMode === 'duel' && p.lives <= 0) || !p.connected;
        return '<span class="ta-icon' + (dead ? ' dead' : '') + '" title="' + (p.name || '') + '">🧍</span>';
      }).join('');
    }
    if (duel && duel.roundWins) taScore.textContent = duel.roundWins[0] + ' : ' + duel.roundWins[1];
  }

  // ---------- 暂停 / 自杀 ----------
  function setPause(open) {
    pauseOpen = open;
    if (pauseMenu) pauseMenu.classList.toggle('hidden', !open);
    if (open) {
      document.exitPointerLock && document.exitPointerLock();
      fire = false;
      touchFire = false;
    }
    if (!open) stopSuicideHold();
  }
  function startSuicideHold() {
    if (!started || !me || !me.alive || pauseOpen || ctfVoting() || mechSelecting()) return;
    suicideHeldAt = performance.now();
    suicideBar.classList.remove('hidden');
    clearInterval(suicideTimer);
    suicideTimer = setInterval(() => {
      const pct = Math.min(100, ((performance.now() - suicideHeldAt) / 3000) * 100);
      suicideFill.style.width = pct + '%';
      if (pct >= 100) {
        socket.emit('suicide');
        stopSuicideHold();
      }
    }, 50);
  }
  function stopSuicideHold() {
    suicideHeldAt = 0;
    clearInterval(suicideTimer);
    suicideTimer = null;
    if (suicideBar) suicideBar.classList.add('hidden');
    if (suicideFill) suicideFill.style.width = '0%';
  }

  function showGameOver(data) {
    uiState = 'over';
    const myId = me && me.id;
    const stats = (data && data.stats) || [];
    const ctfRes = data && data.ctf;
    const duelRes = data && data.duel;
    resetGame();
    roomPage.classList.add('hidden');
    hud.classList.add('hidden');
    let head = '';
    if (ctfRes) {
      head = '<div class="ctf-match-result">' + (ctfRes.winnerTeam === null ? '🤝 平局' : (ctfRes.winnerTeam === 0 ? '🔴 红队' : '🔵 蓝队') + ' 获胜！')
        + '（' + ctfRes.roundWins[0] + ' : ' + ctfRes.roundWins[1] + '）</div>';
    } else if (duelRes) {
      head = '<div class="ctf-match-result">' + (duelRes.winnerTeam === null ? '🤝 平局' : (duelRes.winnerTeam === 0 ? '🔴 红队' : '🔵 蓝队') + ' 获胜！')
        + '（基地核心战）</div>';
    }
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
    AUDIO.lastOwnLoiter = 0;
    laserCleanup();
    if (selfModel) { scene.remove(selfModel); selfModel = null; }
    lockTargetId = null;
    spectateId = null;
    if (lockBox) lockBox.classList.add('hidden');
    if (teamAlive) teamAlive.classList.add('hidden');
    if (mechSelect) mechSelect.classList.add('hidden');
    if (socket && socket.connected) sendLock(null);
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
      ctfFlagStatus.textContent = '🚩 你正扛着敌方旗帜！减速 50% · 受击+50% · 不能回血';
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

  // 第三人称自机模型（缩小 + 半透明，避免遮挡视野）
  function buildSelfModel() {
    if (selfModel) { scene.remove(selfModel); selfModel = null; }
    if (!me) return;
    selfModel = buildMechModel(me.mechType, { color: new THREE.Color(me.color) });
    selfModel.scale.setScalar(0.92);
    selfModel.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = 0.88;
        }
      }
    });
    scene.add(selfModel);
    selfLastX = myPos.x; selfLastZ = myPos.z;
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
    uiState = 'game';
    lobbyPage.classList.add('hidden');
    roomPage.classList.add('hidden');
    gameOverPage.classList.add('hidden');
    hud.classList.remove('hidden');
    deathOverlay.classList.add('hidden');
    started = true;
    updateHud(me);
    updateModuleHud(me);   // 首次进入即显示模块血量
    updateWeaponHud(me);
    buildSelfModel();      // 第三人称自机机甲模型
    myClimbing = false;
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
    // 远端玩家（跳过自己：自机由 selfModel 渲染，否则会出现两个重叠模型）
    const seen = new Set();
    for (const sp of payload.players) {
      if (sp.id === me.id) continue;
      seen.add(sp.id);
      let rp = remotePlayers.get(sp.id);
      if (!rp) rp = createRemotePlayer(sp);
      rp.target.set(sp.x, sp.y, sp.z);
      rp.yawT = sp.yaw;
      rp.group.visible = true;
      // 机甲模块损伤状态（驱动瘸腿动画/核心脉冲）
      rp.mechType = sp.mechType || rp.mechType;
      rp.team = sp.team;
      rp.climbing = !!sp.climbing;
      rp.legs = (sp.mech && sp.mech.legs) || rp.legs;
      rp.legsDestroyed = (sp.mech && sp.mech.legsDestroyed) || 0;
      rp.chestBroken = !!(sp.mech && sp.mech.chestBroken);
      rp.alive = sp.alive !== false;
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
        me.carrying = !!sp.carrying; me.team = sp.team; // 同步旗手状态（本地预测需用它减速）
        // 每 tick 同步武器状态（装填倒计时实时更新）与模块血量
        if (sp.weaponState) { me.weapons = sp.weaponState; updateWeaponHud(me); }
        if (sp.mech) {
          me.mech = me.mech || {};
          me.mech.legs = sp.mech.legs; me.mech.chest = sp.mech.chest; me.mech.core = sp.mech.core;
          me.mech.chestBroken = sp.mech.chestBroken; me.mech.legsDestroyed = sp.mech.legsDestroyed;
          me.mechType = sp.mechType;
          updateModuleHud(me);
        }
        me.lives = sp.lives; me.mechIndex = sp.mechIndex; me.lockId = sp.lockId;
        if (me.alive) {
          serverTarget.set(sp.x, sp.y, sp.z);
          const dx = sp.x - myPos.x, dy = sp.y - myPos.y, dz = sp.z - myPos.z;
          const distXZ = Math.hypot(dx, dz);
          const distY = Math.abs(dy);
          const speed3d = Math.hypot(myVel.x, myVel.y, myVel.z);
          const airborne = myPos.y > 0.02 || myVel.y > 0.5 || sp.y > 0.02;
          if (distXZ > 2.5 || distY > 3.0) {
            // 真实大偏差（重生/掉崖/跳台）：硬贴合
            myPos.x = sp.x; myPos.y = sp.y; myPos.z = sp.z;
            prevStep.x = myPos.x; prevStep.y = myPos.y; prevStep.z = myPos.z;
            curStep.x = myPos.x; curStep.y = myPos.y; curStep.z = myPos.z;
            if (!airborne) { myVel.x = 0; myVel.y = 0; myVel.z = 0; grounded = true; }
            corrX = 0; corrZ = 0;
          } else if (!airborne && speed3d < 0.8 && distXZ > 0.35) {
            // 贴地小漂移：平滑拉回（渲染帧衰减应用，不硬传送不闪回；空中不做，落地自然收敛）
            corrX = dx;
            corrZ = dz;
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
    // 武器视觉：机炮子弹 / 激光束 / 巡飞弹轨迹 / 爆炸 / 弹着火花
    updateTracers(payload.shots, TICK_MS / 1000);
    updateBullets(payload.projectiles);
    updateBeams(payload.beams);
    updateLoiterMeshes(payload.projectiles);
    updateExplosions(payload.explosions, TICK_MS / 1000);
    if (payload.impacts) {
      for (const im of payload.impacts) spawnSparks(im.x, im.y, im.z, 3);
    }
    // 音效：激光束持续音 / 巡飞弹齐射哨声 / 爆炸轰鸣
    if (me) {
      updateLaserSound((payload.beams || []).some((b) => b.owner === me.id));
      const ownLoiters = (payload.projectiles || []).filter((p) => p.kind === 'loiter' && p.owner === me.id).length;
      if (ownLoiters > AUDIO.lastOwnLoiter) sfxLoiter();
      AUDIO.lastOwnLoiter = ownLoiters;
      if (payload.explosions && payload.explosions.length > 0) sfxExplosion();
    }
    // 死斗 HUD（基地核心部署进度 / 剩余机甲）
    if (gameMode === 'duel' && payload.duel) updateDuelHud(payload.duel);
    // 顶部每方存活人数 + 大局比分
    updateTeamAlive(payload.players, payload.duel);
    // 命中 / 受击反馈
    if (payload.hits && me) {
      for (const h of payload.hits) {
        if (h.shooterId === me.id && h.victimId !== me.id) showHitmarker(h.part);
        else if (h.victimId === me.id && h.shooterId !== me.id) onDamaged(h.part, h.dmg);
      }
    }
  }

  function onMe(m) {
    const wasAlive = me ? me.alive : true;
    me = Object.assign(me || {}, m);
    updateHud(m);
    updateModuleHud(m);   // 模块血量 HUD（腿/胸/核心）
    updateWeaponHud(m);   // 武器备弹/装填/充能 HUD
    if (!m.alive) stopSuicideHold();
    if (m.alive) {
      deathOverlay.classList.add('hidden');
      updateMechSelect(m);
    } else {
      if (gameMode === 'duel' && m.lives === 0) {
        deathText.textContent = '💥 机甲全部损毁，进入观战';
        respawnText.textContent = '鼠标移动环视战场';
      } else if (!m.respawnIn) {
        // 开局选择机甲阶段
        deathText.textContent = '选择出战机甲';
        respawnText.textContent = '';
      } else {
        deathText.textContent = '你被 ' + (lastKiller || '???') + ' 击杀';
        respawnIn = m.respawnIn || 3000;
        respawnAtLocal = performance.now() + respawnIn;
      }
      deathOverlay.classList.remove('hidden');
      updateMechSelect(m); // 死亡/开局可选择机甲
    }
    if (!wasAlive && m.alive) {
      myPos.x = m.x; myPos.y = m.y; myPos.z = m.z;
      myVel.x = 0; myVel.y = 0; myVel.z = 0;
      physAcc = 0;
      prevStep.x = myPos.x; prevStep.y = myPos.y; prevStep.z = myPos.z;
      curStep.x = myPos.x; curStep.y = myPos.y; curStep.z = myPos.z;
      beep(660, 0.15, 'triangle', 0.08);
    }
    // 换机甲时重建自机模型（死斗第二台/重连）
    if (m.mechType && selfModel && selfModel.userData && selfModel.userData.type !== m.mechType) {
      buildSelfModel();
    }
  }

  function onKill(k) {
    if (k.victimId === me.id) {
      lastKiller = k.killerName;
      beep(180, 0.4, 'sawtooth', 0.08);
    }
  }

  function updateHud(m) {
    const hp = m.mech ? m.mech.chest : 100; // 血量条显示胸部模块
    healthBar.style.width = hp + '%';
    healthText.textContent = Math.ceil(hp);
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
    modeLabel.textContent = gameMode === 'zone' ? '🚩 占点模式'
      : gameMode === 'duel' ? '⚔ 死斗模式'
        : gameMode === 'ctf' ? '🏳️ 战旗模式' : '🔫 死亡竞赛';
    zoneUI.classList.toggle('hidden', gameMode !== 'zone');
    if (duelHud) duelHud.classList.toggle('hidden', gameMode !== 'duel');
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
    colliders = mapData.boxes.map(toAABB);

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
      if (isTouch || !started || ctfVoting() || pauseOpen || mechSelecting() || document.pointerLockElement === renderer.domElement) return;
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
    const group = buildMechModel(sp.mechType || 'humanoid', { color: new THREE.Color(sp.color) });
    const label = makeNameSprite(sp.name);
    label.position.set(0, (sp.mechType === 'spider' ? 2.2 : 2.6), 0);
    group.add(label);

    group.position.set(sp.x, sp.y, sp.z);
    group.visible = true;
    scene.add(group);

    // 按玩家武器配置挂载战斗模块
    const mounts = (group.userData && group.userData.mounts) || [];
    (sp.weapons || []).forEach((w, i) => { if (mounts[i]) mountWeaponVisual(mounts[i], w); });

    const rp = {
      id: sp.id, group, label,
      target: new THREE.Vector3(sp.x, sp.y, sp.z),
      cur: new THREE.Vector3(sp.x, sp.y, sp.z),
      yawT: sp.yaw, yawCur: sp.yaw,
      name: sp.name, visible: true, ghost: false,
      mechType: sp.mechType || 'humanoid',
      team: sp.team,
      climbing: !!sp.climbing,
      legs: (sp.mech && sp.mech.legs) || [],
      legsDestroyed: (sp.mech && sp.mech.legsDestroyed) || 0,
      chestBroken: !!(sp.mech && sp.mech.chestBroken),
      alive: sp.alive !== false,
      lastX: sp.x, lastZ: sp.z,
    };
    remotePlayers.set(sp.id, rp);
    setGhost(rp, sp.alive === false);
    return rp;
  }

  // 死亡/断线玩家显示为半透明幽灵（遍历所有材质）
  function setGhost(rp, ghost) {
    rp.ghost = ghost;
    rp.group.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.transparent !== false) m.transparent = true;
          m.opacity = ghost ? 0.35 : 1;
        }
      }
    });
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
  // 本地物理（客户端预测，与服务器一致；碰撞解析用共享 moveAxis）
  // =========================================================

  // 统一输入来源（键盘 + 触屏摇杆）
  function inputFwd() { return clamp((keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0) + joy.fwd, -1, 1); }
  function inputStrafe() { return clamp((keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0) + joy.strafe, -1, 1); }
  function inputJump() { return !!keys['Space'] || (jumpQueuedAt && performance.now() - jumpQueuedAt < 200); }

  // 本地预测倍率（与服务端 cfg/旗手惩罚/机甲基础移速保持一致，避免预测漂移导致视角闪回）
  function localMoveMul() {
    let m = 1;
    if (me && me.carrying) m *= 0.5;                    // 旗手移速减半
    if (me && me.mechType && NS.MECHS[me.mechType]) {
      m *= NS.MECHS[me.mechType].moveMul || 1;          // 机甲基础移速（人形减缓75%）
    }
    const card = ctfState && ctfState.applied;
    if (card && card.id === 'speed') m *= 1.5;          // 疾风
    else if (card && card.id === 'slow') m *= 0.75;     // 泥沼
    return m;
  }
  function localJumpMul() {
    let m = 1;
    if (me && me.carrying) m *= 0.65;                   // 旗手降跳
    const card = ctfState && ctfState.applied;
    if (card && card.id === 'jump') m *= 1.6;           // 弹跳
    return m;
  }
  function localGravityMul() {
    let m = 1;
    const card = ctfState && ctfState.applied;
    if (card && card.id === 'moon') m *= 0.5;           // 月球
    else if (card && card.id === 'heavy') m *= 1.6;     // 重力场
    return m;
  }

  function localPhysics(dt) {
    myVel.y -= GRAVITY * localGravityMul() * dt;
    if (myVel.y < -MAX_FALL) myVel.y = -MAX_FALL;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const fx = -sin, fz = -cos, rx = cos, rz = -sin;
    const fwd = inputFwd();
    const strafe = inputStrafe();
    myVel.x = (fx * fwd + rx * strafe) * MOVE_SPEED * localMoveMul();
    myVel.z = (fz * fwd + rz * strafe) * MOVE_SPEED * localMoveMul();

    grounded = false;
    // 蜘蛛爬墙本地预测（与服务端一致）
    const canClimbSelf = me && me.mechType === 'spider' && me.mech && me.mech.legs.some((h) => h > 0);
    let wallBlockSelf = false;
    if (canClimbSelf) {
      const vx0 = myVel.x, vz0 = myVel.z;
      moveAxis(myPos, myVel, 'x', dt, colliders);
      moveAxis(myPos, myVel, 'z', dt, colliders);
      wallBlockSelf = (vx0 !== 0 && myVel.x === 0) || (vz0 !== 0 && myVel.z === 0);
    } else {
      moveAxis(myPos, myVel, 'x', dt, colliders);
      moveAxis(myPos, myVel, 'z', dt, colliders);
    }
    myClimbing = canClimbSelf && wallBlockSelf && (inputFwd() !== 0 || inputJump());
    if (myClimbing) myVel.y = 7;
    if (moveAxis(myPos, myVel, 'y', dt, colliders)) grounded = true;
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
    // 已禁用跳跃（跳跳台弹射保留）
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
    if (uiState === 'lobby') return; // 机库预览由独立 hangarLoop 渲染
    if (!scene) return;

    // 平滑位置纠正：状态同步的小偏差按帧衰减应用，消除闪回/抖动
    if (corrX !== 0 || corrZ !== 0) {
      const ck = Math.min(1, 6 * dt);
      myPos.x += corrX * ck;
      myPos.z += corrZ * ck;
      corrX -= corrX * ck;
      corrZ -= corrZ * ck;
      if (Math.abs(corrX) < 0.02 && Math.abs(corrZ) < 0.02) { corrX = 0; corrZ = 0; }
    }

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
    const px = prevStep.x + (curStep.x - prevStep.x) * alpha;
    const py = prevStep.y + (curStep.y - prevStep.y) * alpha;
    const pz = prevStep.z + (curStep.z - prevStep.z) * alpha;

    // ===== 相机：第三人称 / 观战 =====
    const spectating = started && me && !me.alive && gameMode === 'duel' && me.lives === 0;
    if (spectating) {
      spectateCamera(dt);
      if (selfModel) selfModel.visible = false;
    } else {
      // 第三人称：相机高 2.5/距 6.6，平视（pitch=0）时视线水平，
      // 完整机甲（0~1.72m）落在画面中下方、约占屏幕高度 1/5
      const camDist = 6.6, camHgt = 2.5;
      const cpc = Math.cos(pitch), spc = Math.sin(pitch);
      let camPos = collideCamera(
        px + Math.sin(yaw) * cpc * camDist, py + camHgt, pz + Math.cos(yaw) * cpc * camDist,
        px, py + 1.2, pz
      );
      // 相机被地形挡住拉近时：轻微抬高越过障碍（保持目标高度附近）
      if (Math.hypot(camPos.x - px, camPos.z - pz) < 3.0) {
        camPos.y = py + 3.1;
        camPos.x = px + Math.sin(yaw) * cpc * 2.0;
        camPos.z = pz + Math.cos(yaw) * cpc * 2.0;
      }
      camera.position.lerp(camPos, Math.min(1, 14 * dt));
      if (camShake > 0) {
        camera.position.x += (Math.random() - 0.5) * camShake * 0.5;
        camera.position.y += (Math.random() - 0.5) * camShake * 0.5;
        camShake = Math.max(0, camShake - dt * 10);
      }
      // 平视时视线与相机同高（水平）；俯仰绕机甲旋转视线
      camera.lookAt(px - Math.sin(yaw) * 10, py + camHgt + spc * 10, pz - Math.cos(yaw) * 10);

      // ===== 自机机甲模型（第三人称可见） =====
      if (selfModel) {
        selfModel.position.set(px, py, pz);
        selfModel.rotation.y = yaw;
        selfModel.visible = me && me.alive !== false;
        const srp = {
          group: selfModel,
          legs: (me && me.mech && me.mech.legs) || [],
          chestBroken: !!(me && me.mech && me.mech.chestBroken),
          alive: !!(me && me.alive),
          climbing: myClimbing,
          target: { x: px, y: py, z: pz },
          lastX: selfLastX, lastZ: selfLastZ,
        };
        animateMechLegs(srp, dt);
        selfLastX = px; selfLastZ = pz;
      }
    }

    // ===== 索敌锁定（观战时不锁定不上报） =====
    if (!spectating) updateLockTarget();
    updateLockBox();
    updateSparks(dt);

    const k = 1 - Math.exp(-16 * dt);
    for (const rp of remotePlayers.values()) {
      rp.group.position.lerp(rp.target, k);
      rp.yawCur = lerpAngle(rp.yawCur, rp.yawT, k);
      rp.group.rotation.y = rp.yawCur;
      rp.label.position.set(0, (rp.mechType === 'spider' ? 2.2 : 2.6), 0);
      rp.label.lookAt(camera.position);
      animateMechLegs(rp, dt); // 步行/瘸腿动画
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

    if (me && !me.alive && !(gameMode === 'duel' && me.lives === 0)) {
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
    if (e.code === 'Escape' && started) {
      e.preventDefault();
      setPause(!pauseOpen);
    }
    if (e.code === 'KeyJ' && started && !pauseOpen) startSuicideHold();
  });
  document.addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'KeyJ') stopSuicideHold();
  });
  document.addEventListener('mousedown', (e) => {
    if (isTouch || e.button !== 0 || !started || ctfVoting() || pauseOpen || mechSelecting()) return;
    fire = true;
    if (performance.now() - lastShotAt >= FIRE_CD) {
      lastShotAt = performance.now();
      beep(880, 0.06, 'square', 0.04);
    }
  });
  document.addEventListener('mouseup', (e) => { if (!isTouch && e.button === 0) fire = false; });
  document.addEventListener('mousemove', (e) => {
    if (isTouch || !started || ctfVoting() || pauseOpen || mechSelecting()) return;
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
    // 即时保存，下次登录自动恢复
    try { localStorage.setItem('neon_arena_name', myName); } catch (e) { /* ignore */ }
  });
  quickJoinBtn.addEventListener('click', () => {
    myName = (lobbyName.value || '玩家').trim().slice(0, 16);
    // 优先进等待中的房间，其次可中途加入进行中的房间
    const open = roomList.find((r) => r.state === 'lobby' && !r.hasPassword)
      || roomList.find((r) => !r.hasPassword);
    if (open) {
      socket.emit('room:join', { code: open.code, name: myName, sessionId: getSessionId(), mechs: mechConfigs });
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

  // ---------- 暂停菜单按钮 ----------
  if (pauseContinueBtn) pauseContinueBtn.addEventListener('click', () => setPause(false));
  if (pauseSuicideBtn) pauseSuicideBtn.addEventListener('click', () => {
    if (socket) socket.emit('suicide');
    setPause(false);
  });
  if (pauseLeaveBtn) pauseLeaveBtn.addEventListener('click', () => {
    if (socket) socket.emit('room:leave');
    setPause(false);
  });
  // 机甲选择：确定重生按钮
  if (msConfirm) msConfirm.addEventListener('click', () => {
    if (msSelected >= 0 && socket) {
      socket.emit('mech:select', { index: msSelected });
      beep(880, 0.08, 'triangle', 0.07); // 点击反馈
    }
    if (mechSelect) mechSelect.classList.add('hidden');
    clearInterval(msCountdownTimer);
  });
  // 音乐 / 音效开关
  if (pauseMusicBtn) pauseMusicBtn.addEventListener('click', () => {
    const on = toggleMusic();
    pauseMusicBtn.textContent = '🎵 音乐：' + (on ? '开' : '关');
  });
  if (pauseSfxBtn) pauseSfxBtn.addEventListener('click', () => {
    const on = toggleSfx();
    pauseSfxBtn.textContent = '🔊 音效：' + (on ? '开' : '关');
  });
  if (musicBtn) musicBtn.addEventListener('click', () => {
    const on = toggleMusic();
    musicBtn.textContent = '🎵 音乐' + (on ? '' : '：关');
  });

  // 准星瞄准点：相机视线（屏幕中心）延伸 20m 的世界坐标，随输入上报给服务器
  // 20m 使多枪口弹幕更早合拢命中；方向与更远距离一致（都在准星射线上）
  function computeAimPoint() {
    if (!camera) {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      return { x: myPos.x - Math.sin(yaw) * cp * 20, y: myPos.y + 1.6 + sp * 20, z: myPos.z - Math.cos(yaw) * cp * 20 };
    }
    const v = new THREE.Vector3();
    camera.getWorldDirection(v);
    return { x: camera.position.x + v.x * 20, y: camera.position.y + v.y * 20, z: camera.position.z + v.z * 20 };
  }

  // 输入上报（死亡/投票/暂停/选择机甲期间持续上报零输入；复活瞬间输入立即生效）
  setInterval(() => {
    if (!socket || !started || !me) return;
    if (ctfVoting() || pauseOpen || mechSelecting()) {
      // 投票/暂停/选择机甲期间：人物静止、不可移动/开火/跳跃
      socket.emit('input', { fwd: 0, strafe: 0, jump: false, fire: false, yaw, pitch });
      return;
    }
    const aim = computeAimPoint();
    socket.emit('input', {
      fwd: inputFwd(),
      strafe: inputStrafe(),
      jump: inputJump(),
      fire: fire || touchFire,
      yaw, pitch,
      aimX: aim.x, aimY: aim.y, aimZ: aim.z,
    });
    // 开火音效：按住开火且有机关炮时播放短促枪声（约 20 发/秒）
    if ((fire || touchFire) && me && me.weapons && me.weapons.some((w) => w.type === 'gau12')) {
      sfxGau12();
    }
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
    initHangar();       // 机库：模式选择 / 机甲预览 / 模块安装
    // 首次用户交互后启动背景音乐（浏览器自动播放策略要求用户手势）
    const startMusicOnce = () => { ensureAudio(); startMusic(); };
    document.addEventListener('click', startMusicOnce, { once: true });
    document.addEventListener('keydown', startMusicOnce, { once: true });
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
    // 恢复上次保存的名字
    try {
      const saved = localStorage.getItem('neon_arena_name');
      if (saved && typeof saved === 'string' && saved.trim()) {
        myName = saved.trim().slice(0, 16);
        if (lobbyName) lobbyName.value = myName;
      }
    } catch (e) { /* ignore */ }
    const host = location.hostname || 'localhost';
    const port = location.port ? ':' + location.port : '';
    connStatus.textContent = '正在连接 ' + host + port + ' …';
    lobbyPage.classList.remove('hidden');
    connect();
  }
  init();
})();
