#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds the GPU bench into tools/gpu-bench/build/ (git-ignored, never
# shipped): the stand-ins from image/Dockerfile (stub/, swrast/) and the test
# programs in test/*.c, linked for the unit (glibc 2.27, its loader at
# /lib/ld-linux-x86-64.so.2). Kept when its inputs haven't changed.
#   sh tools/gpu-bench/build.sh
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-gpu-bench:mesa19.0.6-$(cat "$HERE/image/Dockerfile" "$HERE"/image/*.patch | sha256sum | cut -c1-8)
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    LOG=${TMPDIR:-/tmp}/gpu-bench-image.$$.log
    echo "gpu-bench: building $IMG (Mesa 19.0.6 swrast + Mesa 22.3.7 shim, ~10 min the first time)"
    docker build --platform linux/amd64 --progress=plain -t "$IMG" "$WIN_HERE/image" > "$LOG" 2>&1 \
        || { tail -30 "$LOG" >&2; echo "gpu-bench: the image did not build (log: $LOG)" >&2; exit 1; }
    rm -f "$LOG"
fi
key=$( (cat "$HERE"/test/*.c; docker image inspect -f '{{.Id}}' "$IMG") | sha256sum | cut -c1-16)
if [ -f "$HERE/build/gltest" ] && [ "$(cat "$HERE/build/key" 2>/dev/null)" = "$key" ]; then
    echo "gpu-bench: up to date ($key)"
    exit 0
fi
rm -rf "$HERE/build"
mkdir -p "$HERE/build"
docker run --rm --platform linux/amd64 --network none -v "$WIN_HERE:/m" "$IMG" sh -c '
    set -e
    cp -r /out/stub /out/swrast /m/build/
    for c in /m/test/*.c; do
        gcc -O2 -std=gnu11 -Wall -Wextra -Werror -DEGL_NO_X11 -DMESA_EGL_NO_X11_HEADERS \
            -I/opt/mesa19/include -o /m/build/$(basename "$c" .c) "$c" \
            -L/opt/mesa19/lib -Wl,-rpath-link,/opt/mesa19/lib -lEGL -lGLESv2 -lgbm -lm \
            -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
    done'
echo "$key" > "$HERE/build/key"
echo "gpu-bench: built ($key)"
