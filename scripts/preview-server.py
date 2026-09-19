"""The sandbox side of the Docker smoke test's preview check.

Serves the marker file the smoke writes, and sends a cookie and a
Content-Security-Policy of its own: the preview's origin is the sandbox
server's, so both must arrive at the browser untouched.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer

MARKER = "/workspace/preview-marker.txt"
PORT = 3123


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with open(MARKER, "rb") as marker:
            body = marker.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Set-Cookie", "sandbox=1")
        self.send_header("Content-Security-Policy", "default-src 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
