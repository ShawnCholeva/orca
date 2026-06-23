import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
import search as search_mod

HOST = "127.0.0.1"
PORT = int(os.environ.get("ORCA_PAPER_PORT", "8787"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            try:
                search_mod.collection()
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"ok": False, "error": str(e)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/search":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        query = body.get("query", "")
        k = int(body.get("k", 3))
        results = search_mod.search(query, k) if query else []
        self._send(200, {"results": results})


def main():
    search_mod.collection()  # warm before accepting requests
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
