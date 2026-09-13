# OpenCast Grid

Web 版多頻道 IPTV Wall 播放器，互動規格以 IPTV Wall Player macOS 版為準。

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
cd opencast-grid
python3 server.py
```

本機瀏覽器開啟 `http://localhost:8080`，網內其他裝置用 `http://<本機IP>:8080`。
`server.py` 同時提供靜態檔案與共用資料 API（`/api/state`）；播放清單、我的最愛與排序存到 `data/wall.json`，所有 client 共用同一份。

## 部署

自架站台請直接執行 `python3 server.py`，共用資料會存入站台的 `data/wall.json`（已加入 .gitignore，不會推上 GitHub）。

也可以部署到 Cloudflare Pages、Vercel、Netlify 等靜態主機；這種模式下共用 API 不存在，每個瀏覽器退回各自本機的 IndexedDB，功能照常可用，只是不會跨裝置共享。

## 內容來源

OpenCast Grid 不代管或轉播影音內容。串流來源來自使用者匯入的 M3U，或 iptv-org 提供的公開索引資料；使用者應自行確認來源的使用權限。
