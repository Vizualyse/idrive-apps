#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The car's iris try, off the car: the unit's own root filesystem,
# vk-trial's package and iris's (car/package.sh) in /var/opt/vk-trial, the
# gate armed by hand for one `command` start over a (stand-in) SSH session,
# gpu-bench's stub GPU behind kernel414. The same steps as on the car
# (README.md, "On the car"). Nothing is drawn on the stub: pixels aren't
# checked here (run.sh checks them on the car).
#   sh tools/iris-bench/car/car_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
IB=$(cd "$HERE/.." && pwd)
VKT=$(cd "$IB/../vk-trial" && pwd)
GB=$(cd "$IB/../gpu-bench" && pwd)
win() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
sh "$HERE/package.sh" >&2
[ -f "$VKT/build/vk-trial.tgz" ] || { echo "iris car test: no vk-trial package (sh tools/vk-trial/build.sh)" >&2; exit 2; }
NAME=iris-car-$$
trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
out=$(docker run --rm --name $NAME --network none --cap-add SYS_ADMIN --tmpfs /run:mode=755 --tmpfs /tmp:exec,mode=1777 \
    -v "$(win "$VKT/build"):/b:ro" -v "$(win "$GB/build"):/g:ro" -v "$(win "$HERE/build"):/c:ro" -v "$(win "$VKT/test"):/tst:ro" -v "$(win "$HERE"):/s:ro" \
    -e VK_TRIAL_EXTRA_PRELOAD=/b/bench/kernel414.so:/g/stub/libintel_noop_drm_shim.so \
    idrive-rootfs:I_21w12.2-1-4 sh /s/car_steps.sh 2>&1 || true)
printf '%s\n' "$out"
fails=0
sect() { printf '%s\n' "$out" | awk -v s="== $1" '$0 == s {on=1; next} /^== / {on=0} on'; }
want() { if printf '%s\n' "$2" | grep -qE -- "$3"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
hasnt() { if printf '%s\n' "$2" | grep -qE -- "$3"; then echo "  FAIL $1"; fails=$((fails + 1)); else echo "  ok   $1"; fi; }
want "the gate: result=ok" "$out" "^result=ok"
want "iris: GLES 3.2 through its own EGL set" "$(sect iris)" "gl_version: OpenGL ES 3.2 Mesa 19.3.5"
want "iris: the patch engaged (no context isolation)" "$(sect iris)" "iris: no context isolation in the kernel"
want "iris: gltest ok" "$(sect iris)" "^iris rc=0"
hasnt "registers: no CS_DEBUG_MODE2" "$(sect registers)" "CS_DEBUG_MODE2"
hasnt "registers: no CS_CHICKEN1" "$(sect registers)" "CS_CHICKEN1"
want "nine: an adapter" "$(sect nine)" "PASS: Nine's adapter"
want "i965 after: the unit's Mesa still runs" "$(sect 'i965 after')" "^i965 rc=0"
hasnt "no ioctl that means something else on the unit's kernel" "$out" "kernel414: HAZARD"
want "nothing left behind" "$out" "left: run-dir:\[\] procs:\[0\]"
[ $fails -eq 0 ] || { echo "iris car test: $fails failed" >&2; exit 1; }
echo "iris car test: all passed"
