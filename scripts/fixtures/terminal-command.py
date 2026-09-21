"""Run a command with terminal streams for interactive CLI tests."""
import errno
import os
import pty
import select
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
readers = [master, 0]
try:
    while True:
        ready, _, _ = select.select(readers, [], [], 1)
        for descriptor in ready:
            try:
                data = os.read(descriptor, 4096)
            except OSError as error:
                if descriptor == master and error.errno == errno.EIO:
                    sys.exit(child.wait())
                raise
            if not data:
                readers.remove(descriptor)
                continue
            os.write(1 if descriptor == master else master, data)
        if master not in readers:
            sys.exit(child.wait())
finally:
    os.close(master)
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=2)
