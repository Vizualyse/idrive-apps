#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds vk-trial into tools/vk-trial/build/ (git-ignored):
#   bin/vk-trial       the gate, static (loads no library at all)
#   bin/vkprobe        the staged probe, for the unit's glibc 2.27 and loader
#   lib/vk_crumbs.so   breadcrumbs and the display-node guard
#   lib/libvulkan_intel.so, lib/libvulkan.so.1   Mesa 19.0.6 ANV, the loader
#   bench/kernel414.so the bench's stand-in for the unit's kernel (never packed)
#   vk-trial.tgz       bin/ and lib/, to unpack into /var/opt/vk-trial by hand
# Kept when its inputs haven't changed.
#   sh tools/vk-trial/build.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
# the GPU bench first: its image holds Mesa 19.0.6's source, its stub the tests' GPU
sh "$HERE/../gpu-bench/build.sh" >&2
BENCH=$HERE/../gpu-bench
BENCH_IMG=idrive-gpu-bench:mesa19.0.6-$(cat "$BENCH/image/Dockerfile" "$BENCH"/image/*.patch "$BENCH"/image/*.py | sha256sum | cut -c1-8)
IMG=idrive-vk-trial:$( (cat "$HERE/image/Dockerfile" "$HERE"/image/*.comp "$HERE"/image/*.vert "$HERE"/image/*.frag; echo "$BENCH_IMG") | sha256sum | cut -c1-8)
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    LOG=${TMPDIR:-/tmp}/vk-trial-image.$$.log
    echo "vk-trial: building $IMG (Mesa 19.0.6 ANV, ~5 min the first time)"
    docker build --platform linux/amd64 --progress=plain --build-context gpubench=docker-image://"$BENCH_IMG" \
        -t "$IMG" "$WIN_HERE/image" > "$LOG" 2>&1 \
        || { tail -30 "$LOG" >&2; echo "vk-trial: the image did not build (log: $LOG)" >&2; exit 1; }
    rm -f "$LOG"
fi
key=$( (cat "$HERE"/src/*.c "$HERE"/test/*.c "$HERE/build.sh"; docker image inspect -f '{{.Id}}' "$IMG") | sha256sum | cut -c1-16)
if [ -f "$HERE/build/vk-trial.tgz" ] && [ "$(cat "$HERE/build/key" 2>/dev/null)" = "$key" ]; then
    echo "vk-trial: up to date ($key)"
    exit 0
fi
rm -rf "$HERE/build"
mkdir -p "$HERE/build"
docker run --rm --platform linux/amd64 --network none -v "$WIN_HERE:/m" "$IMG" sh -ec '
    W="-O2 -std=gnu11 -Wall -Wextra -Werror"
    mkdir -p /m/build/pkg/bin /m/build/pkg/lib /m/build/bench
    gcc $W -static -o /m/build/pkg/bin/vk-trial /m/src/vk-trial.c
    gcc $W -I/out -o /m/build/pkg/bin/vkprobe /m/src/vkprobe.c -ldl -lvulkan \
        -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
    gcc $W -shared -fPIC -o /m/build/pkg/lib/vk_crumbs.so /m/src/vk_crumbs.c -ldl
    gcc $W -shared -fPIC -o /m/build/bench/kernel414.so /m/test/kernel414.c -ldl
    cp /out/lib/libvulkan_intel.so /out/lib/libvulkan.so.1 /m/build/pkg/lib/
    cp /out/shaders.spv.h /m/build/bench/   # for test/lavapipe_test.sh
    strip --strip-unneeded /m/build/pkg/bin/* /m/build/pkg/lib/vk_crumbs.so
    # the gate needs nothing; nothing else more than glibc 2.27
    ! readelf -d /m/build/pkg/bin/vk-trial | grep -q NEEDED || { echo "vk-trial is not static"; exit 1; }
    for f in /m/build/pkg/bin/vkprobe /m/build/pkg/lib/*; do
        v=$(objdump -T "$f" | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1)
        [ "$(printf "%s\nGLIBC_2.27\n" "$v" | sort -V | tail -1)" = GLIBC_2.27 ] || { echo "$f needs $v"; exit 1; }
    done
    cd /m/build/pkg && chmod 755 bin/* && chmod 644 lib/* \
        && tar --owner=0 --group=0 --mtime=@0 --sort=name -czf /m/build/vk-trial.tgz bin lib'
echo "$key" > "$HERE/build/key"
echo "$IMG" > "$HERE/build/image"
echo "vk-trial: built ($key): build/vk-trial.tgz"
