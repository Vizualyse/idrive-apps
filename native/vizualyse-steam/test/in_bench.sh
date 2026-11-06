#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Inside the bench container (image/bench.Dockerfile): starts a Wayland
# compositor, then runs each Windows program given through Proton with
# PROTON_USE_WINED3D=1 and its Wayland driver, as the tool will on the car.
#   in_bench.sh PROGRAM.exe [PROGRAM.exe ...]
# Environment (run_bench.sh sets these):
#   GPU=none|stub|swrast  what stands in for the GPU (none: no GL at all)
#   COMPOSITOR=weston|wl-sink
#   PROTON=/proton/GE-Proton11-11 (the volume), BENCH=/g (tools/gpu-bench/build), UNIT_GL=/b/unit-gl
# Prints each program's output, "== NAME: exit N in S s" after it, and
# Wine's errors from Proton's log; exits with the first failure's status.
set -u
PROTON=${PROTON:-/proton/GE-Proton11-11}
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"

# The unit's own GL stack ahead of the bench's libraries, as on the car.
case "${GPU:-none}" in
    none) ;;
    stub) export LD_PRELOAD=$BENCH/stub/libintel_noop_drm_shim.so INTEL_STUB_GPU_PLATFORM=bxt
          export LD_LIBRARY_PATH=$UNIT_GL/lib LIBGL_DRIVERS_PATH=$UNIT_GL/dri ;;
    swrast) export LD_PRELOAD=$BENCH/stub/libintel_noop_drm_shim.so INTEL_STUB_GPU_PLATFORM=bxt
          export LD_LIBRARY_PATH=$UNIT_GL/lib:$BENCH/swrast LIBGL_DRIVERS_PATH=$BENCH/swrast GBM_ALWAYS_SOFTWARE=1 ;;
    *) echo "in_bench: GPU=$GPU?" >&2; exit 2 ;;
esac

case "${COMPOSITOR:-weston}" in
    weston) LD_PRELOAD= LD_LIBRARY_PATH= weston --backend=headless --renderer=pixman --socket=wayland-1 \
                --idle-time=0 >/tmp/compositor.log 2>&1 & ;;
    wl-sink) mkdir -p /b/out
             /b/wl-sink --socket wayland-1 --frame /tmp/frame --create "${FRAME_SIZE:-1280x720}" \
                 --snap /b/out/snap.ppm ${WL_SINK_ARGS:-} >/tmp/compositor.log 2>&1 & ;;
esac
COMP=$!
i=0
while [ ! -S "$XDG_RUNTIME_DIR/wayland-1" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
[ -S "$XDG_RUNTIME_DIR/wayland-1" ] || { echo "in_bench: no compositor"; cat /tmp/compositor.log; exit 1; }

export WAYLAND_DISPLAY=wayland-1
# GE-Proton 10 asks xrandr for the primary display and exits without one
# (11 brings its own, which fails without X and is ignored): there is no X
# here or on the car, so a stand-in that lists nothing.
mkdir -p /tmp/bin && printf '#!/bin/sh\nexit 0\n' > /tmp/bin/xrandr && chmod +x /tmp/bin/xrandr
export PATH=/tmp/bin:$PATH
# The prefix: /pfx when run_bench.sh mounts its volume (kept between runs).
PFX=/tmp/pfx; [ -d /pfx ] && PFX=/pfx
export STEAM_COMPAT_DATA_PATH=$PFX STEAM_COMPAT_CLIENT_INSTALL_PATH=/tmp/steam
export PROTON_USE_WINED3D=1 PROTON_ENABLE_WAYLAND=1 PROTONFIXES_DISABLE=1
# Proton writes its log (steam-<id>.log) only for a game id.
export PROTON_LOG=1 PROTON_LOG_DIR=/tmp/log SteamGameId=0 SteamAppId=0
export WINEDEBUG=${WINEDEBUG:-err+all,fixme-all}
# The programs' own lines (test/win/tlog.h): Proton's steam.exe keeps their stdout.
export T_LOG='Z:\tmp\log\t.log'
mkdir -p "$PFX" /tmp/steam /tmp/log

rc=0
for exe in "$@"; do
    name=$(basename "$exe" .exe)
    : > /tmp/log/t.log
    t0=$(date +%s)
    timeout "${T_TIMEOUT:-240}" "$PROTON/proton" run "$exe" >/tmp/log/proton.out 2>&1
    st=$?
    sed 's/^/   /' /tmp/log/t.log
    [ $st -eq 124 ] && grep -vE "ProtonFixes|xrandr|machine-id" /tmp/log/proton.out | tail -5 | sed 's/^/   proton: /'
    echo "== $name: exit $st$([ $st -eq 124 ] && echo ' (timed out)') in $(( $(date +%s) - t0 )) s"
    [ $st -ne 0 ] && [ $rc -eq 0 ] && rc=$st
    # A timed-out program leaves Wine behind: end it before the next.
    [ $st -eq 124 ] && { "$PROTON/files/bin/wineserver" -k 2>/dev/null; sleep 1; }
done
echo "== Wine's errors (Proton's log):"
# Counted by message (thread ids dropped); the Wayland driver's notes about
# optional protocols a compositor lacks are left out.
grep -hE ":err:" /tmp/log/steam-*.log 2>/dev/null | sed -E 's/^([0-9.]+:)?([0-9a-f]+:)*err:/err:/' \
    | grep -vE "doesn't support (optional |xdg_toplevel_icon|xdg_activation|wp_fractional)" \
    | sort | uniq -c | sort -rn | head -n "${ERR_LINES:-25}"
[ -n "${SHOW_LOG:-}" ] && { echo "== Proton's log:"; grep -vE "^[0-9.]*:[0-9a-f]*:[0-9a-f]*:fixme" /tmp/log/steam-*.log | tail -"${SHOW_LOG}"; }
[ -n "${SHOW_COMPOSITOR:-}" ] && { echo "== compositor:"; tail -40 /tmp/compositor.log; }
kill $COMP 2>/dev/null
# Everything kept for a look afterwards: build/out/ (Proton's log, the
# programs' lines, the compositor's events, its last picture).
mkdir -p /b/out && cp /tmp/log/* /tmp/compositor.log /b/out/ 2>/dev/null
exit $rc
