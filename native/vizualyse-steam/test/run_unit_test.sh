#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The tool end to end in a container made from the head unit's own root
# filesystem (../idrive-rootfs/20.40.2/rootfs.tar, imported once as
# idrive-rootfs:I_21w12.2-1-4, as vizualyse-chromium's tests), with no
# network, on the GPU bench's stand-in for the unit's GPU (test/unit_test.js
# says what it covers).
#   sh native/vizualyse-steam/test/run_unit_test.sh [stub|swrast]   (both by default)
# VERBOSE=1 shows the tool's log as it goes.
# Builds what's missing: the bundles (build.sh), the test programs
# (test/build_win.sh), the GPU bench (tools/gpu-bench/build.sh).
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
GPU_BENCH=$HERE/../../tools/gpu-bench
IMG=idrive-rootfs:I_21w12.2-1-4
ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
sh "$HERE/build.sh" >&2
sh "$HERE/test/build_win.sh" >&2
sh "$GPU_BENCH/build.sh" >&2
WIN_GPU_BENCH=$(cd "$GPU_BENCH/build" && (pwd -W 2>/dev/null || pwd))
run() {
    NAME=steam-unit-test-$$
    trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
    docker run --rm --name $NAME --platform linux/amd64 --network none --shm-size=1g \
        -v "$WIN_HERE:/t:ro" -v "$WIN_GPU_BENCH:/g:ro" -e GPU="$1" ${VERBOSE:+-e VERBOSE=1} ${GREP_LOG:+-e GREP_LOG="$GREP_LOG"} $IMG \
        /bin/sh -c "mkdir -p /var/opt /tmp && chmod 1777 /tmp && ulimit -c 0 && ulimit -n 524288 2>/dev/null; /usr/bin/node /t/test/unit_test.js /t"
}
case "${1:-all}" in
    stub|swrast) run "$1" ;;
    all) run stub && run swrast ;;
    *) echo "usage: run_unit_test.sh [stub|swrast]" >&2; exit 2 ;;
esac
