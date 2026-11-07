#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The Winston bench's tests: the platform's native/winston_out against the
# head unit's own compositor (run.sh), as our tools use it.
#   sh tools/winston-bench/test/run_test.sh
# swrast (real pixels): shared memory and winston_out's own buffers land
# where they should, in full colour; a visible camera surface hides them; the
# HMI resetting the screen's layers takes ours off and we put it back; a
# client that goes takes its picture with it. stub (the unit's i965): a GPU
# buffer (dmabuf) is taken and imported by Winston's renderer.
set -u
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=$HERE/build/out
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))   # for a Windows Python
PY=python3
$PY -c 1 >/dev/null 2>&1 || PY=python
SIZE=800x400
PLACE=108,82,1790,638
fail=0
pass() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
run() { OUT=$OUT sh "$HERE/run.sh" "$@" >/dev/null 2>"$OUT.err" || { cat "$OUT.err" >&2; return 1; }; }
pic() { $PY "$WIN_HERE/test/check_ppm.py" "$WIN_HERE/build/out/${PPM:-grab.ppm}" "$@"; }
log() { tr -d '\000' < "$OUT/$1"; }
sh "$HERE/build.sh" >/dev/null || { echo "build failed"; exit 1; }
mkdir -p "$OUT"

for kind in shm ring; do
    rm -f "$OUT"/grab* "$OUT"/app.log
    run swrast sh -c "/bench/wo_bench app $kind $SIZE $PLACE 4 > /out/app.log 2>&1 & sleep 2; /bench/wo_bench grab; wait"
    if pic shown $SIZE $PLACE; then pass "$kind: the picture is in the app area, fitted, in colour"; else bad "$kind: the picture"; fi
    frames=$(log app.log | sed -n 's/.*"ev":"done".*"frames":\([0-9]*\).*/\1/p')
    if [ "${frames:-0}" -ge 150 ]; then pass "$kind: $frames frame callbacks in 4 s (Winston's 60 Hz)"; else bad "$kind: frames ${frames:-none}"; fi
    if log winston.log | grep -q "loading shm buffer (${SIZE%x*}x${SIZE#*x}"; then pass "$kind: Winston loads our shared memory as it is (no conversion)"; else bad "$kind: shm"; fi
done

rm -f "$OUT"/grab* "$OUT"/app.log
run swrast sh -c "/bench/wo_bench app shm $SIZE $PLACE 7 > /out/cam-app.log 2>&1 & sleep 1.5; /bench/wo_bench camera on 2 > /out/cam.log & sleep 1;
                  /bench/wo_bench grab; mv /out/grab.ppm /out/cam-on.ppm; sleep 2.5; /bench/wo_bench grab; wait"
if PPM=cam-on.ppm pic absent $SIZE $PLACE; then pass "camera: hidden while the reversing camera's surface shows"; else bad "camera: still shown"; fi
if pic shown $SIZE $PLACE; then pass "camera: back once the camera's client went (content removed)"; else bad "camera: not back"; fi
if log cam-app.log | grep -q '"ev":"yield","on":1' && log cam-app.log | grep -q '"ev":"yield","on":0'; then
    pass "camera: told when it showed and when it went"; else bad "camera: yield events"; fi

rm -f "$OUT"/grab* "$OUT"/app.log
run swrast sh -c "/bench/wo_bench app shm $SIZE $PLACE 4 > /out/app.log 2>&1 & sleep 1.5; /bench/wo_bench reset; sleep 0.5; /bench/wo_bench grab; wait"
if log app.log | grep -q "put back"; then pass "hmi reset: the layer taken off and put back"; else bad "hmi reset: not put back"; fi
if pic shown $SIZE $PLACE; then pass "hmi reset: the picture is back"; else bad "hmi reset: the picture"; fi

rm -f "$OUT"/grab* "$OUT"/app.log
run swrast sh -c "/bench/wo_bench app shm $SIZE $PLACE 1 > /out/app.log 2>&1; sleep 0.5; /bench/wo_bench grab"
if pic absent $SIZE $PLACE; then pass "exit: the picture goes with the client"; else bad "exit: still shown"; fi

rm -f "$OUT"/grab* "$OUT"/app.log
WINSTON_ARGS="--param stdlog-level=3" run stub sh -c "/bench/wo_bench app dmabuf $SIZE $PLACE 3 > /out/app.log 2>&1 & sleep 1.5; /bench/wo_bench grab; wait"
frames=$(log app.log | sed -n 's/.*"ev":"done".*"frames":\([0-9]*\).*/\1/p')
if [ "${frames:-0}" -ge 100 ]; then pass "dmabuf: $frames frames in 3 s"; else bad "dmabuf: frames ${frames:-none} ($(log app.log | tail -2))"; fi
if log winston.log | grep -q "wrapping dmabuf: texid: [0-9]*, size: ${SIZE}, format: XR24" && ! log winston.log | grep -q "could not create egl image"; then
    pass "dmabuf: Winston's renderer imports our GPU buffers (unit's i965)"; else bad "dmabuf: import"; fi

echo "winston-bench: $fail failed"
[ $fail -eq 0 ]
