#!/usr/bin/env python3
"""TCP drip-feed sink: accepts connections, reads the request, then answers
one byte at a time — slower than the client's read timeout, forever.

Used by verify-send-outcome-line.sh (phase D, the double-tap guard). The
pixeltest app's alert POST sets a 10s socket read timeout; a silent server
would let the attempt fail after ~10s, and a closed port would fail it
instantly — both leave a timing race between the in-flight window and the
harness's next UI dump (uiautomator dumps take ~1s on CI's KVM emulator but
can take minutes on a software-emulated host). Drip-feeding one byte every
5s keeps every individual read() under the 10s timeout without ever
completing an HTTP status line, so the attempt stays in flight for exactly
as long as the harness keeps this process alive — making the "Already
sending" guard assertion deterministic at any host speed. When the harness
kills the process the sockets close, the read fails, and the attempt
settles to FAILED, which is how the harness proves the guard released.

Runs until killed (the harness kills by PID; SO_REUSEADDR frees the port
for the next run). Prints READY once listening so the harness does not
race the bind.
"""

import socket
import sys
import threading

DRIP_INTERVAL_S = 5


def hold(conn: socket.socket) -> None:
    try:
        # Consume the request (bounded: headers + small JSON body), then
        # start dripping. A short read timeout ends the consume phase when
        # the client goes quiet waiting for a response.
        conn.settimeout(3)
        try:
            while conn.recv(4096):
                pass
        except (socket.timeout, OSError):
            pass
        while True:
            conn.sendall(b"X")
            conn.settimeout(None)
            threading.Event().wait(DRIP_INTERVAL_S)
    except OSError:
        pass
    finally:
        conn.close()


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: hold_connection_server.py PORT", file=sys.stderr)
        sys.exit(2)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", int(sys.argv[1])))
    server.listen(8)
    print(f"READY {sys.argv[1]}", flush=True)
    while True:
        conn, _ = server.accept()
        threading.Thread(target=hold, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
