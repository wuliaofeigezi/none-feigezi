# 霓虹竞技场 Neon Arena — 3D 联机射击游戏

基于 **Three.js + Socket.IO + Node.js** 的 3D 联机射击游戏。服务器权威同步（20Hz），支持多人实时对战。

## 玩法
- **死亡竞赛（FFA）**：WASD/摇杆移动、鼠标/滑动瞄准、射击、跳跃，击杀得分
- **占点模式（Zone Control）**：占领区定时迁移，站桩得分，先到 120 分获胜
- **夺旗卡牌赛（CTF）**：红蓝两队轮流分边，每回合抽 3 张效果卡全员投票（每 3 秒可改选，平票随机），生效卡改变本回合数值；带回敌方旗帜到己方基地得分，先拿 3 分赢回合、先赢 2 回合赢整场（最多 5 回合防僵局）；旗手减速 50%、降跳 35%、受击 +50%、不能回血、全图标记
- 四角跳跳台弹射、中央高台制高点、血包回血
- 击杀排行榜、击杀播报、延迟显示、死亡复活倒计时
- 手机端自动横屏 + 虚拟摇杆/开火/跳跃（类和平精英触控）
- 断线自动重连并恢复原角色（分数/位置不重置，15 秒内同 sessionId 无缝回场）

## 房间流程
创建房间获得 6 位房间码 → 分享给好友加入（可设密码）→ 房主选择模式/人数/时长 → 开局；对局中可中途加入，断线后同 sessionId 重连恢复角色（房间席位自动迁移）。

## 本地运行
```bash
npm install
npm run vendor     # 拷贝 three.js / socket.io 客户端库到 public/js
npm start          # http://localhost:3000
```

## 测试
```bash
npm test           # 确定性逻辑测试（物理/射击/占点/房间席位迁移），无需启动服务器
npm run test:smoke # 冒烟测试（完整房间流程 + 断线重连 + 席位迁移），需先 npm start
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
server/      游戏服务器（权威逻辑、地图、20Hz 状态同步、房间大厅）
  index.js   入口（Express 静态托管 + Socket.IO）
  rooms.js   房间大厅（RoomManager / Room，席位迁移、断线重连分发）
  game.js    核心对局逻辑（FFA / 占点 / CTF 卡牌，20Hz 权威 tick）
  map.js     地图数据（障碍物、跳跳台、出生点、血包）
public/      客户端（Three.js 渲染、输入、插值、HUD）
  js/main.js         客户端主逻辑（本地预测物理、渲染插值、触屏/键鼠）
  js/neon-shared.js  客户端/服务端共享常量与工具（唯一事实来源，两边都从这里取）
deploy/      部署脚本（vendor 拷贝、SSH 上传与配置）
test/        逻辑测试（npm test）与冒烟测试（npm run test:smoke）
```
