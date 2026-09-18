#!/usr/bin/env python3
"""Deterministic "data outage" for the receipt-durability kill harness.

Sits between the emulator and the dev CAS API (adb reverse maps the device's
port here; this forwards to the real API). While the block flag file exists, requests to the handset receipt endpoint
(/device-receipt) are refused with 503 and every other request is proxied
untouched — so the app's own receipt POST genuinely fails (receipt kept for
retry) while the trigger that created the incident succeeds. Removing the
flag file "restores data" without re-mapping any tunnels. The optional hang
flag file is a second, harsher outage: the receipt POST connection is
accepted but never answered, so the harness can force-stop the app while its
receipt POST is still in flight (the kill-inside-the-window scenario)
instead of after the POST already completed. The moment a hanging receipt
POST is accepted, the proxy writes "<hang-flag>.seen" — the harness waits
for that marker before force-stopping, so the kill provably lands while the
POST is on the wire rather than racing the posting thread's startup.

Usage: cas-receipt-gate-proxy.py <listen-port> <target-port> <block-flag> [hang-flag]
"""
import os
import socket
import sys
import threading

LISTEN_PORT = int(sys.argv[1])
TARGET_PORT = int(sys.argv[2])
FLAG = sys.argv[3]
HANG_FLAG = sys.argv[4] if len(sys.argv) > 4 else None


def pipe(src, dst):
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def force_connection_close(head: bytes) -> bytes:
    """Rewrite the request head to `Connection: close`.

    The gate is evaluated per TCP connection, but HttpURLConnection pools
    keep-alive connections: the receipt POST would otherwise ride the same
    connection as the (unblocked) trigger and bypass the flag check entirely.
    Forcing close makes every request a fresh connection so the flag is
    consulted for each one. The upstream honors the header and closes after
    the response, which also ends the pipes below.
    """
    lines = head.split(b"\r\n")
    kept = [lines[0]] + [
        line for line in lines[1:] if not line.lower().startswith(b"connection:")
    ]
    kept.append(b"Connection: close")
    return b"\r\n".join(kept)


def handle(client):
    upstream = None
    try:
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 65536:
            chunk = client.recv(4096)
            if not chunk:
                client.close()
                return
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        request_line = head.split(b"\r\n", 1)[0]
        if b"/device-receipt" in request_line:
            if HANG_FLAG and os.path.exists(HANG_FLAG):
                # Hang mode: accept the connection and never answer. The
                # harness force-stops the app while this POST is in flight,
                # so process death lands inside the send->receipt window.
                # The blocked read returns when the killed app's socket dies.
                # Write the .seen marker BEFORE hanging so the harness can
                # prove the kill happened with the POST on the wire (the app
                # persists the receipt before posting, so a seen-marker kill
                # guarantees durable state survived).
                try:
                    with open(HANG_FLAG + ".seen", "w") as marker:
                        marker.write(request_line.decode("latin-1"))
                except OSError:
                    pass
                try:
                    while client.recv(4096):
                        pass
                except OSError:
                    pass
                return
            if os.path.exists(FLAG):
                client.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                client.close()
                return
        upstream = socket.create_connection(("127.0.0.1", TARGET_PORT))
        upstream.sendall(force_connection_close(head) + b"\r\n\r\n" + rest)
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        pipe(upstream, client)  # returns when upstream closes (Connection: close)
    except OSError:
        pass
    finally:
        for sock in (client, upstream):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", LISTEN_PORT))
server.listen(50)
print(f"receipt-gate proxy :{LISTEN_PORT} -> :{TARGET_PORT}, flag {FLAG}", flush=True)
while True:
    conn, _ = server.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
