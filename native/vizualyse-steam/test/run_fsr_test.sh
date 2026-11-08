#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# src/fsr.c on the unit's own Mesa 19 (tools/gpu-bench): test/fsr_test.c
# linked for the unit in gpu-bench's image, then run
#   stub    the unit's i965: its compiler takes the shaders, the dmabuf output works
#   swrast  llvmpipe: real pixels (flat stays flat, not flipped, sharper than
#           bilinear); the pictures in build/fsr-test/ to look at
#   sh native/vizualyse-steam/test/run_fsr_test.sh [stub|swrast|all]   (all by default)
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
GB=$HERE/../../tools/gpu-bench
sh "$GB/build.sh" >&2
IMG=idrive-gpu-bench:mesa19.0.6-$(cat "$GB/image/Dockerfile" "$GB"/image/*.patch "$GB"/image/*.py | sha256sum | cut -c1-8)
mkdir -p "$HERE/build/fsr-test"
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
docker run --rm --platform linux/amd64 --network none -v "$WIN_HERE:/m" "$IMG" sh -c '
    gcc -O2 -std=gnu11 -Wall -Wextra -Werror -DEGL_NO_X11 -DMESA_EGL_NO_X11_HEADERS \
        -I/opt/mesa19/include -o /m/build/fsr-test/fsr_test /m/test/fsr_test.c /m/src/fsr.c \
        -L/opt/mesa19/lib -Wl,-rpath-link,/opt/mesa19/lib -lEGL -lGLESv2 -lgbm -lm \
        -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2'
OUT=$(cd "$HERE/build/fsr-test" && (pwd -W 2>/dev/null || pwd))
run() {
    echo "== fsr_test on $1"
    if [ "$1" = swrast ]; then
        DOCKER_ARGS="-v $OUT:/out" MOUNT="$HERE/build/fsr-test" sh "$GB/run.sh" swrast /t/fsr_test --pixels --out /out
    else
        MOUNT="$HERE/build/fsr-test" sh "$GB/run.sh" stub /t/fsr_test
    fi
}
case "${1:-all}" in
    stub|swrast) run "$1" ;;
    all) run stub && run swrast ;;
    *) echo "usage: run_fsr_test.sh [stub|swrast|all]" >&2; exit 2 ;;
esac
