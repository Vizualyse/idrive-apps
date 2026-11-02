# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Plays raw S16LE PCM (or a test tone) into an ALSA/SmartXbar device on the
iDrive 7 head unit, through libasound with ctypes: nothing to compile.

The head unit's audio manager decides which SmartXbar source reaches the
speakers; a device it has not connected plays silently. Make the audio on a
PC to match a clip from play.js, for example:
    ffmpeg -ss 150 -t 30 -i input.mkv -vn -ac 2 -ar 48000 -f s16le clip.pcm

usage (mgu-python 3):
    python3 pcm_play.py [--device smartx:CarPlayMain_CF_48_STEREO] [--rate 48000] [--channels 2]
                        [--gain 0.5] (--file clip.pcm | --tone 440) [--seconds N]
"""
import argparse
import array
import ctypes
import math
import sys
import time

SND_PCM_STREAM_PLAYBACK = 0
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3


def alsa():
    lib = ctypes.CDLL("libasound.so.2")
    lib.snd_strerror.restype = ctypes.c_char_p
    lib.snd_pcm_writei.restype = ctypes.c_long
    lib.snd_pcm_writei.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    return lib


def check(lib, rc, what):
    if rc < 0:
        sys.exit("%s: %s" % (what, lib.snd_strerror(rc).decode()))
    return rc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="smartx:CarPlayMain_CF_48_STEREO")
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--gain", type=float, default=0.5, help="0..1, applied to the samples")
    ap.add_argument("--seconds", type=float, default=30)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--file")
    src.add_argument("--tone", type=float, help="a sine of this many Hz")
    a = ap.parse_args()
    gain = max(0.0, min(1.0, a.gain))

    lib = alsa()
    pcm = ctypes.c_void_p()
    check(lib, lib.snd_pcm_open(ctypes.byref(pcm), a.device.encode(), SND_PCM_STREAM_PLAYBACK, 0), "open " + a.device)
    check(lib, lib.snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
                                      a.channels, a.rate, 1, 200000), "set params")
    print("%s open: %d Hz, %d ch, gain %.2f" % (a.device, a.rate, a.channels, gain), flush=True)

    period = a.rate // 20                       # 50 ms of frames per write
    frame_bytes = 2 * a.channels
    limit = int(a.seconds * a.rate)
    src_file = open(a.file, "rb") if a.file else None
    done, started, phase = 0, time.time(), 0.0
    try:
        while done < limit:
            n = min(period, limit - done)
            if src_file:
                raw = src_file.read(n * frame_bytes)
                if len(raw) < frame_bytes:
                    break
                buf = array.array("h", raw[: len(raw) // frame_bytes * frame_bytes])
                if gain < 1.0:
                    for i in range(len(buf)):
                        buf[i] = int(buf[i] * gain)
            else:
                buf = array.array("h")
                step = 2 * math.pi * a.tone / a.rate
                for _ in range(n):
                    s = int(32767 * gain * math.sin(phase))
                    phase += step
                    buf.extend([s] * a.channels)
            frames = len(buf) // a.channels
            addr, _ = buf.buffer_info()
            rc = lib.snd_pcm_writei(pcm, addr, frames)
            if rc < 0:
                rc = lib.snd_pcm_recover(pcm, int(rc), 1)
                if rc < 0:
                    check(lib, rc, "write")
                continue
            done += rc
    except KeyboardInterrupt:
        pass
    finally:
        lib.snd_pcm_drain(pcm)
        lib.snd_pcm_close(pcm)
    print("played %.1f s in %.1f s" % (done / a.rate, time.time() - started), flush=True)


if __name__ == "__main__":
    main()
