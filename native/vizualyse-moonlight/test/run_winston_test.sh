#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# moonlight-core's Winston output (core/winston_video.c) against the head
# unit's own Winston (tools/winston-bench), with build/winston_video_test:
#   stub    the unit's i965: a real H.264 stream decoded (the unit's own
#           software MSDK, the GPU path's code, and libavcodec) into NV12 GPU
#           buffers, shown at 60 a second; Winston's renderer imports them as
#           NV12 dmabufs and draws them, the buffers come back (no frame
#           without a free one for long), the stop hint as an overlay
#   swrast  no dmabufs there: wv_open says so and moonlight-core would keep
#           to the frame file (the way back)
# Needs build/ (build.sh) and test/firmware/lib (test/firmware/extract.sh).
#   sh native/vizualyse-moonlight/test/run_winston_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
BENCH=$HERE/../../tools/winston-bench
[ -f "$HERE/build/winston_video_test" ] || sh "$HERE/build.sh"
[ -f "$HERE/test/firmware/lib/libmfxsw64.so" ] || sh "$HERE/test/firmware/extract.sh"
(cd "$HERE" && node tools/fetch_ffmpeg.js >/dev/null)
mkdir -p "$HERE/build/winston-test"
# the stream: 1280x720@60, x264 with access unit delimiters (as Sunshine's)
docker build -q -t ml-unit:18.04-node8 "$WIN_HERE/test/unit" >/dev/null
docker run --rm -v "$WIN_HERE:/m" -w /m ml-unit:18.04-node8 sh -c '
    build/ffmpeg -y -loglevel error -f lavfi -i "testsrc2=s=1280x720:r=60" -t 2 \
        -c:v libx264 -preset ultrafast -tune zerolatency -bf 0 -g 120 -b:v 10M -pix_fmt yuv420p \
        -x264-params aud=1:slices=4 -f h264 build/winston-test/in.h264'
OUT=$BENCH/build/out
fail=0
pass() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
for dec in msdk-sw av; do
    # the unit's own MSDK libraries are in its /usr/lib; test/firmware/lib is the same files
    DOCKER_ARGS="-v $WIN_HERE:/m:ro" WINSTON_ARGS="--param stdlog-level=3" sh "$BENCH/run.sh" stub sh -c \
        "/m/build/winston_video_test $dec /m/build/winston-test/in.h264 1280 720 /run/wayland/wayland-0 /m/build/hint.rgba 4 > /out/wv.json 2>/out/wv.err; sleep 0.3" >/dev/null 2>&1 || true
    r=$(cat "$OUT/wv.json" 2>/dev/null || echo '{}')
    log=$(tr -d '\000' < "$OUT/winston.log")
    shown=$(echo "$r" | sed -n 's/.*"shown":\([0-9]*\).*/\1/p')
    nobuf=$(echo "$r" | sed -n 's/.*"noBuffer":\([0-9]*\).*/\1/p')
    if echo "$r" | grep -q '"via":"winston"' && [ "${shown:-0}" -ge 180 ]; then pass "$dec: $shown pictures shown through Winston in 4 s ($r)"; else bad "$dec: $r $(tail -2 "$OUT/wv.err")"; fi
    if [ "${nobuf:-999}" -le 12 ]; then pass "$dec: Winston gives the buffers back ($nobuf frames without a free one)"; else bad "$dec: $nobuf frames without a free buffer"; fi
    if echo "$log" | grep -q "wrapping dmabuf: texid: [0-9]*, size: 1280x720, format: NV12" && ! echo "$log" | grep -q "could not create egl image"; then
        pass "$dec: Winston's renderer imports and draws the NV12 buffers (unit's i965)"; else bad "$dec: no NV12 import in Winston's log"; fi
    if echo "$log" | grep -q "loading shm buffer (900x100"; then pass "$dec: the stop hint over the picture (900x100)"; else bad "$dec: no stop hint"; fi
done
DOCKER_ARGS="-v $WIN_HERE:/m:ro" sh "$BENCH/run.sh" swrast sh -c \
    "/m/build/winston_video_test av /m/build/winston-test/in.h264 1280 720 /run/wayland/wayland-0 - 1 > /out/wv.json 2>/out/wv.err" >/dev/null 2>&1 || true
r=$(cat "$OUT/wv.json" 2>/dev/null || echo '{}')
if echo "$r" | grep -q '"via":"frame-file".*NV12'; then pass "no NV12 dmabufs (swrast): the frame file instead ($r)"; else bad "fallback: $r"; fi
echo "moonlight winston: $fail failed"
[ $fail -eq 0 ]
