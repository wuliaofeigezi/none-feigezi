'use strict';
/* 一键部署脚本：上传代码 → 安装 Node → npm install → systemd 常驻 → nginx 反代
   依赖：npm i ssh2（已在 devDependencies）
   凭据：deploy/creds.json  { "host": "...", "user": "root", "password": "..." }
*/
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const REMOTE_DIR = '/opt/neon-arena';

const credsFile = path.join(__dirname, 'creds.json');
if (!fs.existsSync(credsFile)) {
  console.error('缺少 ' + credsFile + '，请创建：{"host":"IP","user":"root","password":"密码"}');
  process.exit(1);
}
const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));

const EXCLUDE = new Set(['node_modules', '.git', '.gitignore', 'creds.json', '.npm-cache', 'test', 'debug']);

// ---------- 收集要上传的文件 ----------
function collect(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, base, out);
    else out.push({ abs: full, rel: path.relative(base, full).replace(/\\/g, '/') });
  }
}
const files = [];
collect(ROOT, ROOT, files);
console.log('待上传文件数:', files.length);

const client = new Client();

function exec(cmd) {
  return new Promise((resolve) => {
    client.exec(cmd, (err, stream) => {
      if (err) return resolve({ code: -1, out: String(err) });
      let out = '';
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { out += d.toString(); });
      stream.on('close', (code) => resolve({ code, out }));
    });
  });
}

async function sftpMkdir(sftp, dir) {
  return new Promise((resolve) => {
    sftp.mkdir(dir, (err) => resolve(!err));
  });
}

async function uploadAll(sftp) {
  // 先确保根目录存在（父目录 /opt 已存在）
  await new Promise((resolve) => sftp.mkdir(REMOTE_DIR, (err) => resolve()));
  // 创建子目录
  const dirs = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    parts.pop();
    let cur = REMOTE_DIR;
    for (const p of parts) {
      cur += '/' + p;
      dirs.add(cur);
    }
  }
  for (const d of dirs) await sftpMkdir(sftp, d);

  // 上传文件（并发 6）
  let idx = 0;
  async function worker() {
    while (idx < files.length) {
      const f = files[idx++];
      await new Promise((resolve) => {
        sftp.fastPut(f.abs, REMOTE_DIR + '/' + f.rel, (err) => {
          if (err) console.error('上传失败:', f.rel, err.message);
          resolve();
        });
      });
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log('✅ 上传完成');
}

async function ensureNode() {
  const nodeCheck = await exec('command -v node && node -v 2>/dev/null || echo NO_NODE');
  if (nodeCheck.out.includes('NO_NODE')) {
    console.log('未检测到 Node.js，开始安装 LTS …');
    const arch = (await exec('uname -m')).out.includes('aarch64') ? 'arm64' : 'x64';
    // 从 SHASUMS256.txt 精确提取最新 v20 LTS 包名，URL 需带版本子目录
    const fn = (await exec(
      'curl -fsSL https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt | grep -o "node-v20\\.[0-9.]*-linux-' + arch + '\\.tar\\.xz" | head -1'
    )).out.trim();
    const vdir = fn.replace(/^node-(v[0-9.]+)-.*$/, '$1');
    console.log('安装包:', vdir + '/' + fn);
    if (!fn) { console.error('获取 Node 版本失败'); process.exit(1); }
    const r = await exec(
      'curl -fsSL https://nodejs.org/dist/' + vdir + '/' + fn + ' -o /tmp/node.tar.xz && ' +
      'mkdir -p /usr/local/lib/nodejs && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1 && ' +
      'ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node && ' +
      'ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm && node -v'
    );
    console.log('Node 安装结果:', r.code === 0 ? r.out.trim() : r.out);
  } else {
    console.log('已存在 Node:', nodeCheck.out.trim().split('\n').pop());
  }
  return (await exec('command -v node')).out.trim();
}

async function npmInstall() {
  console.log('npm install（可能需要 1-2 分钟）…');
  let r = await exec('cd ' + REMOTE_DIR + ' && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5');
  if (r.code !== 0 || /error/i.test(r.out)) {
    console.log('默认源失败，改用 npmmirror …');
    r = await exec('cd ' + REMOTE_DIR + ' && npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | tail -5');
  }
  console.log('npm:', r.out.trim());
}

async function setupSystemd(nodeBin) {
  const unit = `[Unit]
Description=Neon Arena 3D Multiplayer Game
After=network.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
ExecStart=${nodeBin} server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
  await new Promise((resolve) => {
    client.sftp((err, sftp) => {
      if (err) return resolve();
      sftp.writeFile('/etc/systemd/system/neon-arena.service', unit, (e) => resolve());
    });
  });
  await exec('systemctl daemon-reload && systemctl enable neon-arena 2>&1 | tail -1 && systemctl restart neon-arena && sleep 1 && systemctl is-active neon-arena');
  const st = await exec('systemctl is-active neon-arena');
  console.log('systemd 状态:', st.out.trim());
}

async function setupNginx() {
  // 该服务器为宝塔面板版 nginx（--prefix=/www/server/nginx），vhost 目录会被 include
  const VHOST_DIR = '/www/server/panel/vhost/nginx';
  const conf = `# Neon Arena 反向代理 + WebSocket
server {
    listen 80 default_server;
    server_name _;

    gzip on;
    gzip_types text/css application/javascript application/json;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
`;
  await new Promise((resolve) => {
    client.sftp((err, sftp) => {
      if (err) return resolve();
      sftp.writeFile(VHOST_DIR + '/neon-arena.conf', conf, (e) => resolve());
    });
  });

  const t = await exec('nginx -t 2>&1');
  console.log('nginx -t:', t.out.trim().split('\n').join(' | '));
  if (t.code !== 0) {
    console.error('nginx 配置测试失败，请人工检查');
    return;
  }
  await exec('nginx -s reload 2>&1');
  console.log('nginx 已重载');
}

async function verify() {
  const r1 = await exec('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/');
  console.log('本机 HTTP /:', r1.out);
  const r2 = await exec('curl -s "http://127.0.0.1/socket.io/?EIO=4&transport=polling" | head -c 100');
  console.log('本机 socket.io 握手:', r2.out.trim());
}

client.on('ready', async () => {
  console.log('✅ 已连接 ' + creds.host);
  try {
    await new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        uploadAll(sftp).then(resolve).catch(reject);
      });
    });
    const nodeBin = await ensureNode();
    await npmInstall();
    await setupSystemd(nodeBin);
    await setupNginx();
    await verify();
    console.log('\n🎮 部署完成！浏览器访问 http://' + creds.host + ' 开玩！');
  } catch (e) {
    console.error('部署出错:', e);
  } finally {
    client.end();
  }
});

client.on('error', (err) => {
  console.error('SSH 连接失败:', err.message);
  process.exit(1);
});

client.connect({
  host: creds.host,
  port: creds.port || 22,
  username: creds.user,
  password: creds.password,
  readyTimeout: 30000,
});
