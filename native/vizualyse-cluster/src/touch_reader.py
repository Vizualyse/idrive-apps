# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""The centre display's touches, while the theme picker is shown (picker.js).

    touch_reader.py [--iface vlan73 --src 160.48.199.115 | --file F]

stdout: one JSON event a line: {"ev":"ready",...}, {"ev":"touch","p":1|2|3,
"x":..,"y":..} (down / move / up, screen pixels 1920x720 on the car),
{"ev":"error",...}. It ends when its stdin closes (picker.js hides).

Touch is read passively (an AF_PACKET copy of the display's UDP PDUs on
vlan73; the HMI still gets every one, nothing is claimed: a claim through
mgu-render restarted the head unit, knowledge/central-screen.md). The socket
needs root; once it is open the reader drops to nobody. The PDU is the
platform's native/touch decoder's (touch.c), the loop vizualyse-steam's
steam-touch, in Python so the tool needs nothing compiled (mgu-python 3.12).
--file replays a capture (the tests: "t src len hex" lines, t in ms), then
deletes it and waits for the next.
"""
import json
import os
import select
import socket
import struct
import sys
import threading
import time

ETH_P_IP = 0x0800
PDU_ID = 0xB0048002
PORT = 30567
DOWN, MOVE, UP = 1, 2, 3

out_lock = threading.Lock()
done = threading.Event()


def event(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
        sys.stdout.flush()


def now_ms():
    return int(time.monotonic() * 1000)


def decode(p):
    """(phase, x, y) of an iDrive 7 touch PDU, or None (touch.c touch_decode)."""
    if len(p) < 64 or struct.unpack('>I', p[0:4])[0] != PDU_ID:
        return None
    ev = p[63] >> 4
    if ev < DOWN or ev > UP:
        return None
    return ev, struct.unpack('>H', p[54:56])[0], struct.unpack('>H', p[60:62])[0]


class Touches:
    def __init__(self):
        self.last_phase = UP
        self.last_touch = 0

    def feed(self, udp):
        d = decode(udp)
        if not d:
            return
        ph, x, y = d
        # a move without its down (it went down before we listened) starts a touch
        if ph == MOVE and self.last_phase == UP:
            ph = DOWN
        if ph == UP and self.last_phase == UP:
            return
        self.last_phase = ph
        self.last_touch = now_ms()
        event({'ev': 'touch', 'p': ph, 'x': x, 'y': y})

    def lost(self):
        # a finger "down" with no PDU for a second: its up was lost
        if self.last_phase != UP and now_ms() - self.last_touch > 1000:
            self.last_phase = UP
            event({'ev': 'touch', 'p': UP, 'x': -1, 'y': -1, 'lost': True})


def udp_payload(pkt, saddr):
    """The UDP payload of an IPv4 packet from saddr to PORT, or None."""
    if len(pkt) < 28 or pkt[0] >> 4 != 4 or pkt[9] != 17:
        return None
    ihl = (pkt[0] & 15) * 4
    if len(pkt) < ihl + 8:
        return None
    if saddr and pkt[12:16] != saddr:
        return None
    if struct.unpack('>H', pkt[ihl + 2:ihl + 4])[0] != PORT:
        return None
    return pkt[ihl + 8:]


def read_socket(sock, saddr, t):
    while not done.is_set():
        r, _, _ = select.select([sock], [], [], 0.1)
        if r:
            while True:
                try:
                    pkt = sock.recv(2048)
                except (BlockingIOError, InterruptedError):
                    break
                p = udp_payload(pkt, saddr)
                if p is not None:
                    t.feed(p)
        t.lost()


def read_file(path, t):
    while not done.is_set():
        try:
            f = open(path)
        except OSError:
            time.sleep(0.1)
            continue
        with f:
            start, first = now_ms(), None
            for line in f:
                parts = line.split()
                if len(parts) != 4 or done.is_set():
                    continue
                ts = int(parts[0])
                if first is None:
                    first = ts
                due = start + ts - first
                while now_ms() < due:
                    time.sleep(0.002)
                t.feed(bytes.fromhex(parts[3]))
                t.lost()
        try:
            os.unlink(path)
        except OSError:
            pass
        # the last up of a capture that ends with a finger down
        deadline = now_ms() + 1200
        while not done.is_set() and now_ms() < deadline:
            time.sleep(0.05)
            t.lost()


def drop_root():
    if os.getuid() != 0:
        return
    try:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
    except OSError as e:
        event({'ev': 'error', 'error': 'cannot drop to nobody: %s' % e})
        sys.exit(1)


def main(argv):
    opts, i = {}, 0
    while i < len(argv):
        if argv[i] in ('--iface', '--src', '--file') and i + 1 < len(argv):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            sys.stderr.write('usage: touch_reader.py [--iface I --src IP | --file F]\n')
            return 2
    t = Touches()
    work = None
    if opts.get('iface'):
        try:
            sock = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(ETH_P_IP))
            sock.bind((opts['iface'], ETH_P_IP))
            sock.setblocking(False)
            saddr = socket.inet_aton(opts['src']) if opts.get('src') else None
            work = threading.Thread(target=read_socket, args=(sock, saddr, t), daemon=True)
        except (OSError, AttributeError) as e:
            event({'ev': 'error', 'error': 'touch: %s: %s' % (opts['iface'], e)})
    elif opts.get('file'):
        work = threading.Thread(target=read_file, args=(opts['file'], t), daemon=True)
    drop_root()
    if work:
        work.start()
    event({'ev': 'ready', 'touch': work is not None, 'uid': os.getuid()})
    # until picker.js closes stdin
    try:
        while sys.stdin.buffer.read(256):
            pass
    except (OSError, KeyboardInterrupt):
        pass
    done.set()
    if work:
        work.join(1)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
