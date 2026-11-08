#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds tools/iris-bench/build/ (git-ignored, bench only): Mesa 19.3.5's
# iris for the unit (image/Dockerfile says what), kernel414.so (tools/vk-trial's
# 4.14 stand-in, copied in) and ninetest. Kept while its inputs stay.
#   sh tools/iris-bench/build.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
cp "$HERE/../vk-trial/test/kernel414.c" "$HERE/image/kernel414.c"
IMG=idrive-iris-bench:mesa19.3.5-$(cat "$HERE"/image/Dockerfile "$HERE"/image/*.py "$HERE"/image/*.c | sha256sum | cut -c1-8)
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    LOG=${TMPDIR:-/tmp}/iris-bench-image.$$.log
    echo "iris-bench: building $IMG (Mesa 19.3.5 iris, ~10 min the first time)"
    docker build --platform linux/amd64 --progress=plain -t "$IMG" "$WIN_HERE/image" > "$LOG" 2>&1 \
        || { tail -40 "$LOG" >&2; echo "iris-bench: the image did not build (log: $LOG)" >&2; exit 1; }
    rm -f "$LOG"
fi
if [ "$(cat "$HERE/build/image" 2>/dev/null)" != "$IMG" ]; then
    rm -rf "$HERE/build"
    mkdir -p "$HERE/build"
    docker run --rm --platform linux/amd64 --network none -v "$WIN_HERE/build:/b" "$IMG" sh -c 'cp -r /out/. /b/'
    echo "$IMG" > "$HERE/build/image"
fi
echo "iris-bench: built ($IMG)"
