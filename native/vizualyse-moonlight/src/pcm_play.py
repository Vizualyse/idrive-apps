# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Plays raw S16LE PCM from stdin (or a file) into an ALSA/SmartXbar device on
the iDrive 7 head unit, through libasound with ctypes: nothing to compile.
The head unit's audio manager decides which SmartXbar source reaches the
speakers; CarPlayMain does while CarPlay (or nothing else) is the source.

    python3 pcm_play.py [--device smartx:CarPlayMain_CF_48_STEREO] [--rate 48000]
                        [--channels 2] [--file PATH | -] [--tone HZ --seconds N]
"""
import argparse
import array
import ctypes
import math
import signal
import sys

SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="smartx:CarPlayMain_CF_48_STEREO")
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--file", default="-")
    ap.add_argument("--tone", type=float)
    ap.add_argument("--seconds", type=float, default=2)
    a = ap.parse_args()

    lib = ctypes.CDLL("libasound.so.2")
    lib.snd_strerror.restype = ctypes.c_char_p
    lib.snd_pcm_writei.restype = ctypes.c_long
    lib.snd_pcm_writei.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]

    def check(rc, what):
        if rc < 0:
            sys.exit("pcm: %s: %s" % (what, lib.snd_strerror(rc).decode()))

    pcm = ctypes.c_void_p()
    check(lib.snd_pcm_open(ctypes.byref(pcm), a.device.encode(), 0, 0), "open " + a.device)
    check(lib.snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
                                 a.channels, a.rate, 1, 200000), "set params")
    print("pcm: %s open, %d Hz, %d ch" % (a.device, a.rate, a.channels), flush=True)

    stop = [False]
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__(0, True))

    frame_bytes = 2 * a.channels
    chunk = (a.rate // 20) * frame_bytes          # 50 ms
    src = None if a.tone else (sys.stdin.buffer if a.file == "-" else open(a.file, "rb"))
    left = int(a.seconds * a.rate) if a.tone else None
    phase, pending, played = 0.0, b"", 0

    def write(buf):
        nonlocal played
        frames = len(buf) // a.channels
        off = 0
        while off < frames and not stop[0]:
            addr = buf.buffer_info()[0] + off * frame_bytes
            rc = lib.snd_pcm_writei(pcm, addr, frames - off)
            if rc < 0:
                check(lib.snd_pcm_recover(pcm, int(rc), 1), "write")
                continue
            off += rc
        played += off

    try:
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
                write(buf)
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
                write(buf)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        if not stop[0]:
            lib.snd_pcm_drain(pcm)
        lib.snd_pcm_close(pcm)
    print("pcm: played %.1f s" % (played / a.rate), flush=True)


if __name__ == "__main__":
    main()
