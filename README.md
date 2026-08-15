# 霓虹竞技场 Neon Arena — 3D 联机射击游戏

基于 **Three.js + Socket.IO + Node.js** 的 3D 联机死亡竞赛游戏。服务器权威同步（20Hz），支持多人实时对战。

## 玩法
- **死亡竞赛（FFA）**：WASD/摇杆移动、鼠标/滑动瞄准、射击、跳跃，击杀得分
- **占点模式（Zone Control）**：占领区定时迁移，站桩得分，先到 120 分获胜（空场时由首位玩家选择模式）
- 四角跳跳台弹射、中央高台制高点、血包回血
- 击杀排行榜、击杀播报、延迟显示、死亡复活倒计时
- 手机端自动横屏 + 虚拟摇杆/开火/跳跃（类和平精英触控）
- 断线自动重连并恢复原角色（分数/位置不重置）

## 本地运行
```bash
npm install
npm run vendor     # 拷贝 three.js / socket.io 客户端库到 public/js
npm start          # http://localhost:3000
```

## 部署
```bash
# 1. 安装依赖并 vendor
npm install && npm run vendor

# 2. 创建凭据文件 deploy/creds.json
#    {"host":"服务器IP","user":"root","password":"密码"}

# 3. 一键部署（上传 → 装 Node → systemd 常驻 → nginx 反代 + WebSocket）
npm run deploy
```

## 目录结构
```
server/   游戏服务器（权威逻辑、地图、20Hz 状态同步）
public/   客户端（Three.js 渲染、输入、插值、HUD）
deploy/   部署脚本（vendor 拷贝、SSH 上传与配置）
```
