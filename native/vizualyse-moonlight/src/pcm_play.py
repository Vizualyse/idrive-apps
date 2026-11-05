# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Plays raw S16LE PCM from stdin (or a file) into an ALSA/SmartXbar device on
the iDrive 7 head unit, through libasound with ctypes: nothing to compile.
The head unit's audio manager decides which SmartXbar source reaches the
speakers; CarPlayMain does while CarPlay (or nothing else) is the source.

    python3 pcm_play.py [--device smartx:CarPlayMain_CF_48_STEREO] [--rate 48000]
                        [--channels 2] [--file PATH | -] [--tone HZ --seconds N]
                        [--live] [--latency-ms 60] [--max-queue-ms 60]

--live (a stream, e.g. a game's sound): the sound may never fall behind.
stdin is always read empty, the device is kept only --latency-ms full, and
what waits beyond --max-queue-ms is dropped, oldest first. Without it, a
stall stays for good: SmartXbar's first connect after boot can block writes
for many seconds (52 s seen), and everything sent meanwhile would be played
late. Every 10 s (and on a drop) it logs the latency and what it dropped.
"""
import argparse
import array
import ctypes
import math
import os
import select
import signal
import sys
import time

SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3


class Alsa:
    """A libasound playback PCM: open (may block a long time on SmartXbar),
    avail (frames writable now), size (the buffer, frames), write (up to
    avail frames, never blocking for long), drain, close."""

    def __init__(self, device, rate, channels, buffer_us, start_frames=0):
        self.lib = lib = ctypes.CDLL("libasound.so.2")
        lib.snd_strerror.restype = ctypes.c_char_p
        lib.snd_pcm_writei.restype = ctypes.c_long
        lib.snd_pcm_writei.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        lib.snd_pcm_avail_update.restype = ctypes.c_long
        lib.snd_pcm_avail_update.argtypes = [ctypes.c_void_p]
        self.pcm = ctypes.c_void_p()
        self.channels = channels
        self._check(lib.snd_pcm_open(ctypes.byref(self.pcm), device.encode(), 0, 0), "open " + device)
        self._check(lib.snd_pcm_set_params(self.pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
                                           channels, rate, 1, buffer_us), "set params")
        bsize, psize = ctypes.c_ulong(), ctypes.c_ulong()
        if lib.snd_pcm_get_params(self.pcm, ctypes.byref(bsize), ctypes.byref(psize)) == 0 and bsize.value:
            self.size = bsize.value
        else:
            self.size = rate * buffer_us // 1000000
        if start_frames:
            # set_params starts playing only once the whole buffer is full; a
            # live stream keeps it far from full, so start at start_frames
            sw = ctypes.c_void_p()
            if lib.snd_pcm_sw_params_malloc(ctypes.byref(sw)) == 0:
                ok = (lib.snd_pcm_sw_params_current(self.pcm, sw) == 0 and
                      lib.snd_pcm_sw_params_set_start_threshold(self.pcm, sw, ctypes.c_ulong(start_frames)) == 0 and
                      lib.snd_pcm_sw_params(self.pcm, sw) == 0)
                lib.snd_pcm_sw_params_free(sw)
                if not ok:
                    print("pcm: could not lower the start threshold", flush=True)

    def _check(self, rc, what):
        if rc < 0:
            sys.exit("pcm: %s: %s" % (what, self.lib.snd_strerror(rc).decode()))

    def avail(self):
        n = self.lib.snd_pcm_avail_update(self.pcm)
        if n < 0:
            self._check(self.lib.snd_pcm_recover(self.pcm, int(n), 1), "avail")
            n = self.lib.snd_pcm_avail_update(self.pcm)
        return max(0, min(n, self.size))

    def write(self, buf, off, frames):
        """frames from buf (an array of int16) at frame off: frames written."""
        addr = buf.buffer_info()[0] + off * 2 * self.channels
        rc = self.lib.snd_pcm_writei(self.pcm, addr, frames)
        if rc < 0:
            self._check(self.lib.snd_pcm_recover(self.pcm, int(rc), 1), "write")
            return 0
        return rc

    def drain(self):
        self.lib.snd_pcm_drain(self.pcm)

    def close(self):
        self.lib.snd_pcm_close(self.pcm)


def play_live(sink, fd, rate, channels, latency_ms, max_queue_ms, stop, log, clock=time.monotonic):
    """The stream from fd into sink, never more than about latency_ms +
    max_queue_ms behind. Returns (frames played, frames dropped)."""
    fb = 2 * channels
    target = rate * latency_ms // 1000           # frames kept in the device
    max_queue = rate * max_queue_ms // 1000      # frames allowed to wait here
    queue = bytearray()
    played = dropped = 0
    since_log = dropped_logged = 0
    last_log = clock()
    eof = False
    os.set_blocking(fd, False)
    while not stop[0]:
        # 1. read everything there is
        try:
            while True:
                d = os.read(fd, 65536)
                if not d:
                    eof = True
                    break
                queue += d
        except BlockingIOError:
            pass
        # 2. too much waiting: drop the oldest, keep the newest
        frames = len(queue) // fb
        if frames > max_queue:
            cut = (frames - max_queue // 2) * fb
            del queue[:cut]
            dropped += cut // fb
        # 3. keep the device about `target` full, no more
        queued_dev = sink.size - sink.avail()
        room = target - queued_dev
        n = min(room, len(queue) // fb)
        if n > 0:
            buf = array.array("h")
            buf.frombytes(bytes(queue[:n * fb]))
            w = sink.write(buf, 0, n)
            del queue[:w * fb]
            played += w
        if eof and len(queue) < fb:
            break
        now = clock()
        if dropped != dropped_logged and now - since_log >= 1 or now - last_log >= 10:
            log("pcm: %d ms behind (%d in the device, %d waiting), %.1f s played, %d ms dropped" % (
                (queued_dev + len(queue) // fb) * 1000 // rate, queued_dev * 1000 // rate,
                len(queue) // fb * 1000 // rate, played / rate, dropped * 1000 // rate))
            since_log = last_log = now
            dropped_logged = dropped
        if n <= 0 and not eof:
            # nothing to do until more sound comes or the device plays some
            select.select([fd], [], [], 0.005)
    return played, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="smartx:CarPlayMain_CF_48_STEREO")
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--file", default="-")
    ap.add_argument("--tone", type=float)
    ap.add_argument("--seconds", type=float, default=2)
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--latency-ms", type=int, default=60)
    ap.add_argument("--max-queue-ms", type=int, default=60)
    a = ap.parse_args()

    stop = [False]
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__(0, True))
    sink = Alsa(a.device, a.rate, a.channels, 200000, a.rate * a.latency_ms // 2000 if a.live else 0)
    print("pcm: %s open, %d Hz, %d ch, buffer %d ms" % (a.device, a.rate, a.channels, sink.size * 1000 // a.rate), flush=True)

    played = 0
    try:
        if a.live:
            fd = sys.stdin.fileno() if a.file == "-" else os.open(a.file, os.O_RDONLY)
            played, _ = play_live(sink, fd, a.rate, a.channels, a.latency_ms, a.max_queue_ms, stop,
                                  lambda m: print(m, flush=True))
        else:
            played = play_all(sink, a, stop)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        if not stop[0]:
            sink.drain()
        sink.close()
    print("pcm: played %.1f s" % (played / a.rate), flush=True)


def play_all(sink, a, stop):
    """Every sample, however late (a file, a tone): frames played."""
    frame_bytes = 2 * a.channels
    chunk = (a.rate // 20) * frame_bytes          # 50 ms
    src = None if a.tone else (sys.stdin.buffer if a.file == "-" else open(a.file, "rb"))
    left = int(a.seconds * a.rate) if a.tone else None
    phase, pending, played = 0.0, b"", 0

    def write(buf):
        frames = len(buf) // a.channels
        off = 0
        while off < frames and not stop[0]:
            off += sink.write(buf, off, frames - off)
        return off

    while not stop[0]:
        if src is None:
            if left <= 0:
                break
            n = min(a.rate // 20, left)
            left -= n
            buf = array.array("h")
            for _ in range(n):
                s = int(32767 * 0.15 * math.sin(phase))
                phase += 2 * math.pi * a.tone / a.rate
                buf.extend([s] * a.channels)
            played += write(buf)
            continue
        data = src.read(chunk)
        if not data:
            break
        data = pending + data
        whole = len(data) // frame_bytes * frame_bytes
        pending = data[whole:]
        if whole:
            buf = array.array("h")
            buf.frombytes(data[:whole])
            played += write(buf)
    return played


if __name__ == "__main__":
    main()
