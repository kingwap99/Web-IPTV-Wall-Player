# OpenCast Grid

Web 版多頻道 IPTV Wall 播放器，互動規格以 IPTV Wall Player macOS 版為準。

## 目前功能

- 中央 Hero + 外圈頻道牆
- 4×4 與 5×5 版面
- 小頻道切換成中央大頻道，沿用同一個 HLS player session
- Hero 切換時音訊淡出／淡入
- Hero 單按進入全螢幕，再按恢復原本版面與頁數
- Hero 右鍵選單：最愛、頻道資訊、暫停、音量、翻頁、分類、版面、頻道庫、移除
- 小頻道右鍵／長按選單：最愛、頻道資訊、調整位置、移除
- 頻道排序的開始、交換、完成與取消還原
- 全部頻道／我的最愛分類
- 國家篩選與頻道數量
- iptv-org 探索器：搜尋、國家篩選、頻道加入播放牆
- M3U 匯入與頻道庫管理
- 鍵盤：←／→ 翻頁、F 全螢幕、Space 全部暫停、Esc 返回
- PWA manifest 與 Service Worker

## 本地執行

```bash
cd opencast-grid
python3 -m http.server 8080
```

瀏覽器開啟：`http://localhost:8080`

## 部署

這是純靜態網站，可直接部署到 Cloudflare Pages、Vercel、Netlify 或其他靜態主機。頻道、收藏、排序與播放清單資料保存在使用者瀏覽器的 IndexedDB；目前不需要後端或自己的資料庫。

## 內容來源

OpenCast Grid 不代管或轉播影音內容。串流來源來自使用者匯入的 M3U，或 iptv-org 提供的公開索引資料；使用者應自行確認來源的使用權限。
