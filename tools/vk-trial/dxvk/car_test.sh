#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The car's DXVK try, off the car: the unit's own root filesystem, the Steam
# tool's real bundles unpacked where the car has them (runtime, Proton, its
# prefix, launch.json), vk-trial's two packages in /var/opt/vk-trial, its
# gate armed by hand for one `command` start over a (stand-in) SSH session,
# gpu-bench's stub GPU behind kernel414. Exactly the steps README.md lists
# for the car (dxvk/car_steps.sh): run.js setup as root, then arm, run.
#   sh tools/vk-trial/dxvk/car_test.sh [offscreen|winston]   (offscreen)
# winston: the same inside tools/winston-bench, with the unit's own Winston
# running (null outputs, the stub GPU): armed with --winston, the picture
# shown through it; checks it took our pictures (no pixels on the stub).
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
VKT=$(cd "$HERE/.." && pwd)
STEAM=$(cd "$VKT/../../native/vizualyse-steam" && pwd)
WB=$(cd "$VKT/../winston-bench" && pwd)
win() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
MODE=${1:-offscreen}
sh "$HERE/package.sh" >&2
[ -f "$STEAM/build/prefix.tgz" ] || { echo "car test: no Steam bundles (sh native/vizualyse-steam/build.sh)" >&2; exit 2; }
MOUNTS="-v $(win "$VKT/build"):/b:ro -v $(win "$VKT/../gpu-bench/build"):/g:ro -v $(win "$STEAM/build"):/sb:ro -v $(win "$VKT/test"):/tst:ro -v $(win "$HERE"):/s:ro"
OPTS="--shm-size=1g --cap-add SYS_ADMIN --tmpfs /run:mode=755 --tmpfs /tmp:exec,mode=1777"
STUB="-e VK_TRIAL_EXTRA_PRELOAD=/b/bench/kernel414.so:/g/stub/libintel_noop_drm_shim.so -e INTEL_STUB_GPU_PLATFORM=bxt"
# DXVK_PROGRAMS="t_d3d932.exe t_d3d1132.exe ...": those programs (32-bit ones need MESA_VER=19.1.8)
[ -z "${DXVK_PROGRAMS:-}" ] || STUB="$STUB -e DXVK_PROGRAMS=$(echo "$DXVK_PROGRAMS" | tr ' ' ',')"
if [ "$MODE" = winston ]; then
    # shellcheck disable=SC2086
    out=$(DOCKER_ARGS="$OPTS $MOUNTS $STUB" sh "$WB/run.sh" stub sh /s/car_steps.sh winston 2>&1 || true)
else
    NAME=vk-trial-dxvk-car-$$
    trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
    # shellcheck disable=SC2086
    out=$(docker run --rm --name $NAME --network none $OPTS $MOUNTS $STUB idrive-rootfs:I_21w12.2-1-4 sh /s/car_steps.sh offscreen 2>&1 || true)
fi
printf '%s\n' "$out" | grep -v "wine: .*err:\(waylanddrv\|keyboard\|cursor\|steamclient\)"
fails=0
check() { printf '%s\n' "$out" | grep -qF -- "$1" && echo "  ok   $1" || { echo "  FAIL $1"; fails=$((fails + 1)); }; }
for want in "setup rc=0" "prefix ready" "owner of / 0," "12990 outside vk-trial: [0] in /dev: [0]" "run rc=0" "result=ok" \
        "GPU (wl_drm)" "dxvk: ok" "run-dir:[]"; do
    check "$want"
done
for p in ${DXVK_PROGRAMS:-t_d3d1164.exe t_d3d964.exe}; do check "$p: ok"; done
[ -n "${DXVK_PROGRAMS:-}" ] || { check "t_d3d11: device, feature level 11_1"; check "t_d3d9: device"; }
if [ "$MODE" = winston ]; then
    check "group video and mgu_wayland (Winston)"
    check '"winston":true'
    check "shown through Winston at 108,82,1790,638"
    printf '%s\n' "$out" | grep -q "Winston: [1-9][0-9]* pictures" && echo "  ok   pictures reached Winston" || { echo "  FAIL no picture reached Winston"; fails=$((fails + 1)); }
fi
[ $fails -eq 0 ] || { echo "vk-trial dxvk car test ($MODE): $fails failed" >&2; exit 1; }
echo "vk-trial dxvk car test ($MODE): all passed"
