# Web IPTV Wall player

多頻道 IPTV Wall 的 Web 版播放器，對應 macOS 版 [IPTV-Wall-Player](https://github.com/kingwap99/IPTV-Wall-Player)。
互動規格與視覺設計（圖示、色系）沿用 macOS 版。

## 目前功能

- 中央 Hero + 外圈頻道牆
- 4×4 / 5×5 / 6×6 / 7×7 版面
- 小頻道切換成中央大頻道，沿用同一個 HLS player session
- Hero 切換時音訊淡出／淡入
- Hero 單按進入全螢幕，再按恢復原本版面與頁數
- Hero 右鍵選單：加入最愛、頻道資訊、暫停、音量、翻頁、分類、版面、頻道庫、移除
- 小頻道右鍵／長按選單：加入最愛、頻道資訊、調整位置、移除
- 頻道排序的開始、交換、完成與取消還原
- 多份可自訂名稱的最愛清單：工具列的 ★ 按鈕切換、＋ 新增清單
- 頻道庫可新增／改名／刪除最愛清單，並管理清單內頻道
- 全部頻道與各最愛清單分類切換
- 站台共用資料：播放清單與我的最愛存在 server（data/wall.json），所有 client 共用同一份複本
- 每份清單各自記住版面（4×4 / 5×5 / 6×6 / 7×7）：切換清單時自動套用該清單的視窗排列
- 國家篩選與頻道數量
- iptv-org 探索器：搜尋、國家篩選、頻道加入播放牆
- M3U 匯入與頻道庫管理
- 鍵盤：←／→ 翻頁、F 全螢幕、Space 全部暫停、Esc 返回
- PWA manifest 與 Service Worker

## 本地執行

```bash
cd web-iptv-wall-player
python3 server.py
```

本機瀏覽器開啟 `http://localhost:8080`，網內其他裝置用 `http://<本機IP>:8080`。
`server.py` 同時提供靜態檔案與共用資料 API（`/api/state`）；播放清單、我的最愛與排序存到 `data/wall.json`，所有 client 共用同一份。

## 常駐與自動重啟（macOS）

macOS 上可用兩個 LaunchAgent 讓站台常駐並自我修復：

- `com.neo.web-iptv-wall`：服務本體，`KeepAlive` 讓它結束後自動重啟。
- `com.neo.web-iptv-wall.healthcheck`：每 5 分鐘執行 `scripts/healthcheck.py`，依序探測 `/`、`/js/app.js`、`/api/state`；連續失敗就 `launchctl kickstart -k` 重啟服務。

為什麼需要健康檢查：`KeepAlive` 只看「行程還在不在」。如果行程存活期間 Homebrew 升級了 `python@3.14`，舊版 Cellar 目錄會被刪除，行程不會結束、但執行環境已被抽掉，結果 `/api/state` 仍回 200、所有靜態檔卻一律 404。這種半死狀態只有實際發 HTTP 請求才偵測得到。

手動執行檢查：

```bash
python3 scripts/healthcheck.py
```

檢查紀錄寫在 `/tmp/web-iptv-wall-healthcheck.log`（正常時不會有任何紀錄）。

安裝、還原與停用：

```bash
bash scripts/restore-local-server.sh    # 安裝（或還原）本機的兩個 LaunchAgent
```

停用（例如把站台搬到別台機器後）：

```bash
U=$(id -u)
launchctl bootout gui/$U/com.neo.web-iptv-wall.healthcheck
launchctl bootout gui/$U/com.neo.web-iptv-wall
mv ~/Library/LaunchAgents/com.neo.web-iptv-wall.plist{,.disabled}
mv ~/Library/LaunchAgents/com.neo.web-iptv-wall.healthcheck.plist{,.disabled}
```

注意：每台機器的 `data/wall.json` 各自獨立。兩台同時開著的話，播放清單與我的最愛會各寫各的、不會同步，所以同時間只該有一台在跑。

## 部署

自架站台請直接執行 `python3 server.py`，共用資料會存入站台的 `data/wall.json`（已加入 .gitignore，不會推上 GitHub）。

也可以部署到 Cloudflare Pages、Vercel、Netlify 等靜態主機；這種模式下共用 API 不存在，每個瀏覽器退回各自本機的 IndexedDB，功能照常可用，只是不會跨裝置共享。

## 內容來源

本播放器不代管或轉播影音內容。串流來源來自使用者匯入的 M3U，或 iptv-org 提供的公開索引資料；使用者應自行確認來源的使用權限。
