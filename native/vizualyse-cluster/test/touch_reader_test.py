# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""touch_reader.py off the car (Python 3.8 or later; mgu-python is 3.12):
the PDU decoder and the packet filter, then the reader replaying a capture
(--file): down / move / up in order, a move with no down starts a touch, a
second up is dropped, a finger whose up never comes is let go after a
second, and the reader ends when its stdin closes.

    python3 test/touch_reader_test.py
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src')
sys.path.insert(0, SRC)
import touch_reader as tr  # noqa: E402


def pdu(ev, x, y):
    """An iDrive 7 touch PDU (knowledge/input.md): 112 bytes."""
    p = bytearray(112)
    p[0:4] = struct.pack('>I', 0xB0048002)
    p[4:8] = struct.pack('>I', 96)
    p[28] = 0x80
    p[53] = 1
    p[54:56] = struct.pack('>H', x)
    p[60:62] = struct.pack('>H', y)
    p[62] = 50
    p[63] = ev << 4
    return bytes(p)


def ipv4_udp(payload, src='160.48.199.115', dport=30567):
    ihl = 20
    h = bytearray(ihl)
    h[0] = 0x45
    h[9] = 17
    h[12:16] = bytes(int(b) for b in src.split('.'))
    udp = struct.pack('>HHHH', 40000, dport, 8 + len(payload), 0)
    return bytes(h) + udp + payload


def check(cond, what):
    if not cond:
        raise SystemExit('FAIL ' + what)


# the decoder and the filter
check(tr.decode(pdu(1, 900, 300)) == (1, 900, 300), 'a down decodes')
check(tr.decode(pdu(5, 1, 1)) is None, 'an unknown event is not a touch')
check(tr.decode(b'\0' * 112) is None, 'another PDU is not a touch')
src = bytes([160, 48, 199, 115])
check(tr.udp_payload(ipv4_udp(pdu(2, 5, 6)), src) == pdu(2, 5, 6), 'the display\'s packet is read')
check(tr.udp_payload(ipv4_udp(pdu(2, 5, 6), src='10.0.0.1'), src) is None, 'another sender is not')
check(tr.udp_payload(ipv4_udp(pdu(2, 5, 6), dport=30570), src) is None, 'another port is not')
print('ok   the PDU decoder and the packet filter')

# the reader, replaying a capture
d = tempfile.mkdtemp()
# run as root, the reader drops to nobody before it reads the capture
os.chmod(d, 0o777)
cap = os.path.join(d, 'touch.txt')
rows = [(0, pdu(2, 500, 300)),      # a move with no down: a down
        (20, pdu(2, 520, 310)),
        (40, pdu(3, 520, 310)),
        (60, pdu(3, 520, 310)),     # a second up: dropped
        (80, pdu(1, 700, 400))]     # a down whose up never comes
with open(cap, 'w') as f:
    for t, p in rows:
        f.write('%d 160.48.199.115 %d %s\n' % (t, len(p), p.hex()))
os.chmod(cap, 0o666)
r = subprocess.Popen([sys.executable, os.path.join(SRC, 'touch_reader.py'), '--file', cap],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
events, t0 = [], time.time()
while time.time() - t0 < 5:
    line = r.stdout.readline()
    if not line:
        break
    e = json.loads(line)
    events.append(e)
    if e.get('lost'):
        break
r.stdin.close()
code = r.wait(5)
check(events[0]['ev'] == 'ready' and events[0]['touch'] is True, 'ready, reading: %r' % events[:1])
touches = [(e['p'], e['x'], e['y']) for e in events if e['ev'] == 'touch']
check(touches == [(1, 500, 300), (2, 520, 310), (3, 520, 310), (1, 700, 400), (3, -1, -1)], 'the touches: %r' % touches)
check(not os.path.exists(cap), 'the capture is deleted once read')
check(code == 0, 'ends when stdin closes (%r)' % code)
print('ok   the reader: down / move / up, a lone move starts a touch, a second up dropped, a lost up let go, ends with stdin')
