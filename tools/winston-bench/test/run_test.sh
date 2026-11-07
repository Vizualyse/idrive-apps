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
pic() { $PY "$WIN_HERE/test/check_ppm.py" "$WIN_HERE/build/out/${PPM:-grab.ppm}" "$@" >"$OUT.pic" || { cat "$OUT.pic"; return 1; }; }
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

# Our compositors between a stand-in client and Winston (test/build_sinks.sh)
sh "$HERE/test/build_sinks.sh" >/dev/null || { echo "build_sinks failed"; exit 1; }
# (wl-sink lets the client choose its size: fake_client's 640x360)
for sink in chromium steam; do
    S=$SIZE
    [ $sink = steam ] && S=640x360
    rm -f "$OUT"/c-*.ppm "$OUT"/sink.log
    run swrast sh /test/sink_scenario.sh $sink shm $S
    if PPM=c-shown.ppm pic shown $S $PLACE >/dev/null; then pass "$sink shm: shown through Winston (dropped to nobody)"; else bad "$sink shm: shown"; fi
    if PPM=c-hidden.ppm pic absent $S $PLACE >/dev/null; then pass "$sink shm: hidden"; else bad "$sink shm: hidden"; fi
    if PPM=c-again.ppm pic shown $S $PLACE >/dev/null; then pass "$sink shm: shown again"; else bad "$sink shm: again"; fi
    if log fake.log | grep -q '"ev":"done"'; then pass "$sink shm: the client ran to the end ($(log fake.log | tr -d '\n'))"; else bad "$sink shm: client"; fi

    rm -f "$OUT"/sink.log
    WINSTON_ARGS="--param stdlog-level=3" run stub sh /test/sink_scenario.sh $sink drm $S
    frames=$(log fake.log | sed -n 's/.*"frames":\([0-9]*\),"releases":\([0-9]*\).*/\1 \2/p')
    set -- $frames
    if [ "${1:-0}" -ge 100 ] && [ "${2:-0}" -ge "$(( ${1:-0} - 3 ))" ]; then pass "$sink drm: every buffer back to the client ($1 frames, $2 releases)"; else bad "$sink drm: frames/releases $frames"; fi
    if [ $sink = chromium ]; then
        fwd=$(log sink.log | sed -n 's/.*"fwd":\([0-9]*\).*/\1/p' | tail -1)
        if [ "${fwd:-0}" -ge 60 ]; then pass "$sink drm: $fwd GPU buffers passed on as they are"; else bad "$sink drm: fwd ${fwd:-none}"; fi
        if log winston.log | grep -q "wrapping dmabuf: texid: [0-9]*, size: ${S}"; then pass "$sink drm: Winston's renderer imports them"; else bad "$sink drm: import"; fi
    else
        # wl-sink reads GPU buffers back (Wine's GL area is composed) and shows the picture through Winston
        sent=$(log sink.log | sed -n 's/.*"drm":\([0-9]*\),"winston":\([0-9]*\).*/\1 \2/p' | tail -1)
        set -- $sent
        if [ "${1:-0}" -ge 60 ] && [ "${2:-0}" -ge 30 ]; then pass "$sink drm: GPU buffers read back and shown through Winston ($1 read, $2 shown)"; else bad "$sink drm: $sent"; fi
    fi
done

echo "winston-bench: $fail failed"
[ $fail -eq 0 ]
