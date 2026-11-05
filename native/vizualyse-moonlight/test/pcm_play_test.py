# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""pcm_play.py's live mode off the car, in real time: a stream at 48 kHz in
5 ms packets (as moonlight-core's), into a fake device that plays at 48 kHz
but blocks every write for 2 s once, as SmartXbar's first connect after boot
did on the car (the sound then stayed behind the picture). Every frame
carries its number, so the test knows how late each one plays.

    python3 test/pcm_play_test.py      (run by test/run_sunshine_test.sh)
"""
import array
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import pcm_play  # noqa: E402

RATE, CH = 48000, 2
fails = 0


def ok(what, cond, more=""):
    global fails
    print(("ok   " if cond else "FAIL ") + what + (": " + more if more else ""), flush=True)
    if not cond:
        fails += 1


class FakeDevice:
    """A 200 ms buffer drained at RATE once started; writes block during the stall."""

    def __init__(self, t0, stall_at, stall_s):
        self.size = RATE // 5
        self.t0, self.stall_at, self.stall_s = t0, stall_at, stall_s
        self.written = []           # the frame numbers, in the order written
        self.consumed = 0.0
        self.last = None
        self.lag = []               # (t, ms behind) while playing

    def _run(self):
        now = time.monotonic()
        if self.last is not None and len(self.written) > self.consumed:
            self.consumed = min(len(self.written), self.consumed + (now - self.last) * RATE)
            if self.consumed < len(self.written):
                playing = self.written[int(self.consumed)]
                made = (now - self.t0) * RATE
                self.lag.append((now - self.t0, (made - playing) * 1000 / RATE))
        self.last = now

    def avail(self):
        self._run()
        return self.size - (len(self.written) - int(self.consumed))

    def write(self, buf, off, frames):
        t = time.monotonic() - self.t0
        if self.stall_at <= t < self.stall_at + self.stall_s:
            time.sleep(self.stall_at + self.stall_s - t)
            self.last = time.monotonic()       # nothing played while it was stuck
        self._run()
        frames = min(frames, self.size - (len(self.written) - int(self.consumed)))
        for i in range(off, off + frames):
            self.written.append(buf[i * CH] & 0xffff | (buf[i * CH + 1] & 0xffff) << 16)
        return frames


def produce(wfd, t0, seconds):
    """5 ms packets in real time, each frame numbered (low 16 bits left, high right)."""
    n = 0
    per = RATE // 200
    while n < seconds * RATE:
        due = t0 + n / RATE
        d = due - time.monotonic()
        if d > 0:
            time.sleep(d)
        a = array.array("h")
        for i in range(n, n + per):
            lo, hi = i & 0xffff, i >> 16
            a.extend([lo - 65536 if lo > 32767 else lo, hi])
        os.write(wfd, a.tobytes())
        n += per
    os.close(wfd)


def main():
    r, w = os.pipe()
    t0 = time.monotonic()
    dev = FakeDevice(t0, stall_at=1.0, stall_s=2.0)
    th = threading.Thread(target=produce, args=(w, t0, 6.0))
    th.start()
    logs = []
    played, dropped = pcm_play.play_live(dev, r, RATE, CH, 60, 60, [False], logs.append)
    th.join()

    def worst(a, b):
        xs = [ms for t, ms in dev.lag if a <= t < b]
        return max(xs) if xs else None

    before, after = worst(0.3, 1.0), worst(3.5, 6.0)
    ok("before the stall: under 150 ms behind", before is not None and before < 150, "%s ms" % (before and round(before)))
    ok("a 2 s stall in the device: the backlog dropped, not played late", dropped >= RATE * 3 // 2, "%d ms dropped" % (dropped * 1000 // RATE))
    ok("after the stall: under 150 ms behind again", after is not None and after < 150, "%s ms" % (after and round(after)))
    ok("the frames played are in order", all(dev.written[i] < dev.written[i + 1] for i in range(len(dev.written) - 1)))
    ok("the drop was logged", any("ms dropped" in m and not m.endswith(" 0 ms dropped") for m in logs), logs[-1] if logs else "")
    print("pcm_play_test: " + ("%d failed" % fails if fails else "all passed"))
    sys.exit(1 if fails else 0)


main()
