# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""A recorder that survives the head unit restarting: the journal (journalctl -f), the kernel log (/dev/kmsg)
and a stats line every 5 s (load, memory, the busiest processes, nftables rules), into
/var/opt/crashwatch/<boot>-*.log, each fsynced every second. The journal is in RAM on the unit (Learnings), so
after a restart this is what is left of the moments before it. Read-only towards the system.

    /var/opt/mgu-python/current/bin/python3 crashwatch.py [dir]
"""
import os
import subprocess
import sys
import threading
import time

OUT = sys.argv[1] if len(sys.argv) > 1 else '/var/opt/crashwatch'
CAP = 40 << 20          # per file
KEEP_BOOTS = 6

os.makedirs(OUT, exist_ok=True)
boot = open('/proc/sys/kernel/random/boot_id').read().strip()[:8]
started = time.strftime('%Y%m%d-%H%M%S', time.gmtime())
prefix = os.path.join(OUT, '%s-%s' % (started, boot))

# keep the last KEEP_BOOTS boots' files
sets = sorted({f.rsplit('-', 1)[0] for f in os.listdir(OUT) if f.endswith('.log')})
for old in sets[:-KEEP_BOOTS]:
    for f in os.listdir(OUT):
        if f.startswith(old):
            os.unlink(os.path.join(OUT, f))


class Sink:
    def __init__(self, name):
        self.f = open(prefix + '-' + name + '.log', 'a', buffering=1)
        self.size = 0
        self.lock = threading.Lock()

    def line(self, s):
        with self.lock:
            if self.size > CAP:
                return
            self.size += len(s) + 1
            self.f.write(s.rstrip('\n') + '\n')

    def sync(self):
        with self.lock:
            self.f.flush()
            os.fsync(self.f.fileno())


journal, kmsg, stats = Sink('journal'), Sink('kmsg'), Sink('stats')


def follow_journal():
    while True:
        try:
            p = subprocess.Popen(['journalctl', '-f', '-n', '200', '-o', 'short-precise', '--no-pager'],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, errors='replace')
            for l in p.stdout:
                journal.line(l)
            journal.line('%s crashwatch: journalctl ended (%s), again' % (time.strftime('%H:%M:%S'), p.wait()))
        except OSError as e:
            journal.line('%s crashwatch: journalctl: %s' % (time.strftime('%H:%M:%S'), e))
        time.sleep(2)


def follow_kmsg():
    with open('/dev/kmsg', 'rb', buffering=0) as k:
        while True:
            try:
                rec = k.read(8192).decode('utf-8', 'replace')
            except OSError:      # EPIPE: overwritten records
                continue
            head, _, msg = rec.partition(';')
            f = head.split(',')
            us = int(f[2]) if len(f) > 2 and f[2].isdigit() else 0
            kmsg.line('[%9.3f] <%s> %s' % (us / 1e6, f[0] if f else '?', msg.strip()))


def snapshot():
    load = open('/proc/loadavg').read().split()[:3]
    mem = {}
    for l in open('/proc/meminfo'):
        k, v = l.split(':', 1)
        if k in ('MemAvailable', 'MemFree', 'Shmem', 'SwapFree'):
            mem[k] = v.split()[0]
    procs = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            st = open('/proc/%s/stat' % pid).read()
            name = st[st.index('(') + 1:st.rindex(')')]
            rest = st[st.rindex(')') + 2:].split()
            procs.append((int(rest[11]) + int(rest[12]), int(rest[21]) * 4, pid, name))
        except (OSError, ValueError, IndexError):
            pass
    by_rss = sorted(procs, key=lambda p: -p[1])[:6]
    try:
        rules = subprocess.run(['nft', 'list', 'ruleset'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               universal_newlines=True, timeout=3).stdout.count('\n')
    except Exception:
        rules = -1
    return 'load %s mem avail %s kB free %s shm %s | procs %d | nft lines %d  | rss: %s' % (
        ' '.join(load), mem.get('MemAvailable'), mem.get('MemFree'), mem.get('Shmem'), len(procs), rules,
        ', '.join('%s(%s) %dMB' % (n, p, r >> 10) for _, r, p, n in by_rss))



def stats_loop():
    while True:
        try:
            stats.line('%s %s' % (time.strftime('%H:%M:%S', time.gmtime()), snapshot()))
        except Exception as e:
            stats.line('%s crashwatch: stats failed: %s' % (time.strftime('%H:%M:%S'), e))
        time.sleep(5)


for fn in (follow_journal, follow_kmsg, stats_loop):
    threading.Thread(target=fn, daemon=True).start()
stats.line('crashwatch: boot %s, started %s UTC' % (boot, started))
while True:
    time.sleep(1)
    for s in (journal, kmsg, stats):
        try:
            s.sync()
        except OSError:
            pass
