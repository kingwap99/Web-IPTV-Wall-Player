#!/usr/bin/env python3
"""Web IPTV Wall player — 站台健康檢查

用途：揪出「行程還活著、卻已經無法正常提供網站」的殭屍狀態並自動重啟。

背景：server.py 由 LaunchAgent（KeepAlive）常駐。若在行程存活期間 Homebrew 升級了
      python@3.14，舊版 Cellar 目錄會被刪除，行程不會自己結束，但執行環境已被抽掉，
      結果是 /api/state 仍回 200、所有靜態檔（/、/js/app.js…）卻一律 404。
      光看行程存不存在看不出來，一定要實際發 HTTP 請求才會發現。

由 com.neo.web-iptv-wall.healthcheck 這個 LaunchAgent 定期執行。
可用環境變數覆寫：OC_LABEL、OC_PORT、OC_ATTEMPTS、OC_RETRY_DELAY、OC_HEALTHCHECK_LOG。

註：刻意用 Python 而非 shell script。launchd 啟動的 /bin/bash 讀不到 ~/Documents
    （macOS 隱私保護會回 Operation not permitted），python3 則不受影響。
"""

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

LABEL = os.environ.get("OC_LABEL", "com.neo.web-iptv-wall")
PORT = os.environ.get("OC_PORT", "8080")
BASE = "http://127.0.0.1:%s" % PORT
PROBES = ("/", "/js/app.js", "/api/state")
ATTEMPTS = int(os.environ.get("OC_ATTEMPTS", "3"))
RETRY_DELAY = float(os.environ.get("OC_RETRY_DELAY", "3"))
LOG = os.environ.get("OC_HEALTHCHECK_LOG", "/tmp/web-iptv-wall-healthcheck.log")


def log(message):
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write("%s %s\n" % (stamp, message))
    except OSError:
        pass


def check_once():
    """全部探測點都回 200 才算正常；失敗時回傳「路徑 (狀態)」說明字串。"""
    for path in PROBES:
        try:
            with urllib.request.urlopen(BASE + path, timeout=8) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        except Exception as error:  # 連不上、逾時…
            return "%s (%s)" % (path, type(error).__name__)
        if status != 200:
            return "%s (%s)" % (path, status)
    return None


def main():
    failure = None
    for attempt in range(1, ATTEMPTS + 1):
        failure = check_once()
        if failure is None:
            return 0
        if attempt < ATTEMPTS:
            time.sleep(RETRY_DELAY)

    log("連續 %d 次檢查失敗（%s），重啟 %s…" % (ATTEMPTS, failure, LABEL))
    restart = subprocess.run(
        ["launchctl", "kickstart", "-k", "gui/%d/%s" % (os.getuid(), LABEL)],
        capture_output=True, text=True
    )
    if restart.returncode != 0:
        detail = (restart.stderr or restart.stdout).strip() or "exit %d" % restart.returncode
        log("無法重啟 %s：%s" % (LABEL, detail))
        return 1

    time.sleep(5)
    failure = check_once()
    if failure is None:
        log("重啟後恢復正常。")
        return 0
    log("重啟後仍異常（%s），需要手動檢查。" % failure)
    return 1


if __name__ == "__main__":
    sys.exit(main())
