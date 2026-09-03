#!/usr/bin/env python3
import http.server
import os

STATUS_FILE = "/backup-cache/status.prom"
PORT = 9101


class MetricsHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path not in ("/", "/metrics"):
            self.send_error(404)
            return
        try:
            with open(STATUS_FILE, encoding="utf-8") as status:
                body = status.read().encode("utf-8")
        except FileNotFoundError:
            body = b"signara_backup_last_status 0\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), MetricsHandler)
    server.serve_forever()
