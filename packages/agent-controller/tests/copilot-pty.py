"""Bounded native terminal fixture; commands and terminal output use JSON lines."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))


def setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)


child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup)
os.close(slave)
deadline = time.monotonic() + 35
pending = b''
trusted = False
try:
    while child.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            print(json.dumps({'output': data.decode('utf8', errors='replace')}), flush=True)
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(master, b'\x1b[?1;2c')
            if not trusted and b'Confirm folder trust' in data:
                trusted = True
                os.write(master, b'\r')
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                command = json.loads(line)
                os.write(master, command['write'].encode('utf8'))
    if child.poll() is None:
        try:
            child.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
    print(json.dumps({'exit': child.poll()}), flush=True)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    os.close(master)
