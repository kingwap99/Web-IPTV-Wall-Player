#!/usr/bin/env python3
"""OpenCast Grid 共用資料伺服器（純 Python 標準程式庫，無第三方依賴）

職責：
  1. 提供站台靜態檔案（index.html、js、css、圖示、Service Worker…）
  2. 保存全站共用的播放清單與我的最愛，讓所有 client 看到同一份資料：
       GET /api/state              -> { "playlists": [...], "meta": {...} }
       PUT /api/state              -> 以相同結構覆寫資料檔（204）

資料存放在 data/wall.json（不會進 git）。寫入採用暫時檔 + 原子改名，避免半寫。

用法：
    python3 server.py                  # 0.0.0.0:8080
    OC_DATA_FILE=/tmp/wall.json python3 server.py
"""

import argparse
import json
import os
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("OC_DATA_DIR", os.path.join(ROOT, "data"))
DATA_FILE = os.environ.get("OC_DATA_FILE", os.path.join(DATA_DIR, "wall.json"))
LOCK = threading.Lock()

# catalog-meta（iptv-org 探索器的本機快取）不屬於共用資料。
LOCAL_META_KEYS = ("catalog-meta",)


def normalize(doc):
    out = {"playlists": [], "meta": {}}
    if isinstance(doc, dict):
        if isinstance(doc.get("playlists"), list):
            out["playlists"] = [
                item for item in doc["playlists"]
                if isinstance(item, dict) and item.get("id")
            ]
        if isinstance(doc.get("meta"), dict):
            out["meta"] = {
                str(key): value
                for key, value in doc["meta"].items()
                if key not in LOCAL_META_KEYS
            }
    return out


def load_doc():
    with LOCK:
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as handle:
                doc = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return {"playlists": [], "meta": {}}
    return normalize(doc)


def save_doc(doc):
    normalized = normalize(doc)
    os.makedirs(DATA_DIR, exist_ok=True)
    with LOCK:
        fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(normalized, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, DATA_FILE)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


class OpenCastGridHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api/state":
            self._send_json(200, load_doc())
            return
        super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/state":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON body")
            return
        if not isinstance(payload, dict):
            self.send_error(400, "Body must be a JSON object")
            return
        save_doc(payload)
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[opencast-grid] %s\n" % (fmt % args))
        sys.stderr.flush()


def main():
    parser = argparse.ArgumentParser(description="OpenCast Grid 共用資料伺服器")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    print("OpenCast Grid — 共用資料伺服器")
    print("資料檔案： %s" % DATA_FILE)
    print("網址：     http://%s:%s/" % (args.host, args.port))
    try:
        ThreadingHTTPServer((args.host, args.port), OpenCastGridHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
