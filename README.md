# SITCON 大地遊戲

大地遊戲後端 API 與管理後台。Flutter 玩家 App 位於獨立的 `2027-game-app` 專案。

## 專案結構

- `frontend/`：Next.js 管理後台
- `backend/gateway/`：TypeScript + Fastify API，透過 Prisma 存取 PostgreSQL

## 快速開始

需要 Node.js 26、npm，以及 macOS 或 Linux（arm64／x64）。在專案根目錄執行：

```bash
npm run dev
```

首次啟動會安裝依賴、建立本機 PostgreSQL 並初始化資料，不需要 Docker、`.env` 或手動執行 SQL。

- 管理後台：[http://127.0.0.1:4173](http://127.0.0.1:4173)
- API：[http://127.0.0.1:8787/api/health](http://127.0.0.1:8787/api/health)

按 `Ctrl+C` 停止。資料保存在 `.sitcon-dev/`，下次啟動會沿用。所有服務只接受本機連線。

## 綁定 NTAG

在管理後台的「發卡站」或「打卡小石」，選擇目標並輸入 7 位元組 NTAG UID（14 個十六進位字元）。已被使用或保留的 UID 不會被覆蓋。綁定後可在表格確認 UID；發卡站還需要開放領取才會發放卡包。

在玩家名牌、發卡站或打卡小石的 UID 旁按「解除綁定」。解除後可以將 UID 加到其他目標，不會清除玩家進度或已領取的獎勵。

## 常用指令

- `backend/gateway/`：`npm run typecheck`、`npm test`
- `frontend/`：`npm run build`、`npm test`

## 補充

- Dokploy 使用兩個獨立的 Dockerfile Applications：後端用 `backend/Dockerfile`（context：`.`），前端用 `frontend/Dockerfile`（context：`frontend`）。
- 部署時在後端與管理後台設定相同的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD_FILE`。用唯讀掛載提供至少 16 字元的密碼，不要把密碼提交到 Git。管理後台與 API 之間使用 HTTPS；本機 loopback 開發不需設定。
