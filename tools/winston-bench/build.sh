#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds the Winston bench into tools/winston-bench/build/ (git-ignored, never
# shipped): kms_shim.so, the GPU bench's stand-ins (stub/, swrast/: from
# tools/gpu-bench) and test/wo_bench, linked for the unit (glibc 2.27, its
# loader) with the platform's native/winston_out compiled in from its
# newest version. Kept when its inputs haven't changed.
#   sh tools/winston-bench/build.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
REPO=$(cd "$HERE/../.." && pwd)
WIN_REPO=$(cd "$REPO" && (pwd -W 2>/dev/null || pwd))
WO=${WINSTON_OUT:-platform/native/winston_out/$(ls "$REPO/platform/native/winston_out" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)}
IMG=idrive-winston-bench:18.04-$(sha256sum "$HERE/image/Dockerfile" | cut -c1-8)
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "winston-bench: building $IMG"
    docker build --platform linux/amd64 -q -t "$IMG" "$WIN_HERE/image" >/dev/null
fi
sh "$REPO/tools/gpu-bench/build.sh" >&2
key=$( (cat "$HERE"/src/*.c "$HERE"/test/*.c "$REPO/$WO"/*; ls -l "$REPO/tools/gpu-bench/build/stub" "$REPO/tools/gpu-bench/build/swrast"; \
        docker image inspect -f '{{.Id}}' "$IMG") | sha256sum | cut -c1-16)
if [ -f "$HERE/build/wo_bench" ] && [ "$(cat "$HERE/build/key" 2>/dev/null)" = "$key" ]; then
    echo "winston-bench: up to date ($key)"
    exit 0
fi
rm -rf "$HERE/build"
mkdir -p "$HERE/build"
cp -r "$REPO/tools/gpu-bench/build/stub" "$REPO/tools/gpu-bench/build/swrast" "$HERE/build/"
docker run --rm --platform linux/amd64 --network none -v "$WIN_REPO:/r" "$IMG" sh -c "
    set -e
    B=/r/tools/winston-bench; W=/r/$WO; G=/tmp/gen; mkdir -p \$G
    for x in ivi-application ivi-controller linux-dmabuf-unstable-v1; do
        wayland-scanner client-header \$W/\$x.xml \$G/\$x-client-protocol.h
        wayland-scanner private-code \$W/\$x.xml \$G/\$x-protocol.c
    done
    CF='-O2 -std=gnu11 -Wall -Wextra -Werror'
    gcc \$CF -fPIC -shared -I/usr/include/libdrm -o \$B/build/kms_shim.so \$B/src/kms_shim.c -ldl
    gcc \$CF -I\$G -I\$W -o \$B/build/wo_bench \$B/test/wo_bench.c \$W/winston_out.c \$G/*.c \
        -lwayland-client -ldl -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
"
echo "$key" > "$HERE/build/key"
echo "winston-bench: built ($key, $WO)"
