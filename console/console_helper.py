#!/usr/bin/env python3
"""Server console helper for the Nulldex admin panel.

Runs as root (systemd: nulldex-console.service) and owns ONE persistent shell session in a pseudo-terminal,
like a tiny tmux. The admin web app (unprivileged user `nulldex`) connects over a unix socket that only
root and the nulldex group can open. The web app does all authentication (login + 2FA); this helper trusts
whoever can open the socket, so the socket permissions are the security boundary.

Frames on the socket, both directions:  1 byte type | 4 bytes big-endian length | payload
  client -> helper:  0 = keyboard input, 1 = resize (payload: "cols,rows")
  helper -> client:  0 = terminal output
A newly connected client first receives the recent output (scrollback) so the screen can be rebuilt.
Standard library only.
"""
import asyncio, fcntl, grp, os, pty, signal, struct, sys, termios

SOCK_DIR = "/run/nulldex-console"
SOCK = os.path.join(SOCK_DIR, "console.sock")
GROUP = "nulldex"
SCROLLBACK = 256 * 1024
SHELL = ["/bin/bash", "-l"]

session = None  # the one shared shell
clients = set()


class Session:
    def __init__(self, cols=120, rows=32):
        self.buf = bytearray()
        pid, fd = pty.fork()
        if pid == 0:  # child: become the shell
            os.chdir("/root")
            env = {"TERM": "xterm-256color", "HOME": "/root", "USER": "root", "LOGNAME": "root", "SHELL": "/bin/bash",
                   "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
                   "COLORTERM": "truecolor"}
            os.execve(SHELL[0], SHELL, env)
        self.pid, self.fd = pid, fd
        self.alive = True
        self.resize(cols, rows)
        os.set_blocking(fd, False)
        asyncio.get_running_loop().add_reader(fd, self.on_output)
        log(f"shell started (pid {pid})")

    def resize(self, cols, rows):
        cols, rows = max(20, min(cols, 500)), max(5, min(rows, 200))
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def write(self, data):
        if self.alive:
            try:
                os.write(self.fd, data)
            except OSError:
                pass

    def on_output(self):
        try:
            data = os.read(self.fd, 65536)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b""
        if not data:  # shell exited
            self.close()
            broadcast(b"\r\n\x1b[2m[session ended - press any key for a new shell]\x1b[0m\r\n")
            return
        self.buf += data
        if len(self.buf) > SCROLLBACK:
            del self.buf[: len(self.buf) - SCROLLBACK]
        broadcast(data)

    def close(self):
        if not self.alive:
            return
        self.alive = False
        try:
            asyncio.get_running_loop().remove_reader(self.fd)
        except Exception:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pass
        log(f"shell ended (pid {self.pid})")


def log(msg):
    print(msg, flush=True)


def frame(kind, payload):
    return struct.pack(">BI", kind, len(payload)) + payload


def broadcast(data):
    for w in list(clients):
        try:
            w.write(frame(0, data))
        except Exception:
            clients.discard(w)


def ensure_session():
    global session
    if session is None or not session.alive:
        session = Session()
    return session


async def handle(reader, writer):
    s = ensure_session()
    writer.write(frame(0, bytes(s.buf)))
    clients.add(writer)
    try:
        while True:
            head = await reader.readexactly(5)
            kind, size = struct.unpack(">BI", head)
            if size > 1024 * 1024:
                break
            payload = await reader.readexactly(size) if size else b""
            if kind == 0:
                s = session if session and session.alive else None
                if s is None:  # the shell exited: any key starts a new one
                    s = ensure_session()
                    broadcast(b"\x1b[2J\x1b[H")
                    continue
                s.write(payload)
            elif kind == 1:
                try:
                    cols, rows = (int(x) for x in payload.decode().split(","))
                    if session and session.alive:
                        session.resize(cols, rows)
                except ValueError:
                    pass
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        clients.discard(writer)
        writer.close()


async def main():
    os.makedirs(SOCK_DIR, exist_ok=True)
    gid = grp.getgrnam(GROUP).gr_gid
    os.chown(SOCK_DIR, 0, gid)
    os.chmod(SOCK_DIR, 0o750)
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    old = os.umask(0o117)
    server = await asyncio.start_unix_server(handle, path=SOCK)
    os.umask(old)
    os.chown(SOCK, 0, gid)
    os.chmod(SOCK, 0o660)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    log(f"listening on {SOCK}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
