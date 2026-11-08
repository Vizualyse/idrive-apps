#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The Winston output end to end: unit_test.js (a real Wine test program as
# the game) with WINSTON_CHECK=1, in the container where tools/winston-bench
# runs the head unit's own Winston:
#   swrast  Mesa's llvmpipe, shared memory: the game's picture through
#           wl-sink straight onto Winston's centre screen, pixels read back
#   stub    the unit's own i965 (no pixels): Wine's GPU buffers passed on to
#           Winston as they are, no read-back; read back again while hidden
# Needs the bundles (build.sh) and test programs.
#   sh native/vizualyse-steam/test/run_winston_test.sh [swrast|stub|all]   (all by default)
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
GPU_BENCH=$HERE/../../tools/gpu-bench
sh "$HERE/build.sh" >&2
sh "$HERE/test/build_win.sh" >&2
sh "$GPU_BENCH/build.sh" >&2
WIN_GPU_BENCH=$(cd "$GPU_BENCH/build" && (pwd -W 2>/dev/null || pwd))
run() {
    DOCKER_ARGS="--shm-size=1g --cap-add SYS_ADMIN -v $WIN_HERE:/t:ro -v $WIN_GPU_BENCH:/g:ro -e GPU=$1 -e USB_FS=tmpfs -e WINSTON_CHECK=1 ${VERBOSE:+-e VERBOSE=1} ${GREP_LOG:+-e GREP_LOG} ${SKIP_FSR_CHECK:+-e SKIP_FSR_CHECK}" \
        sh "$HERE/../../tools/winston-bench/run.sh" "$1" /bin/sh -c \
        'mkdir -p /var/opt /tmp /media/TESTSTICK && chmod 1777 /tmp && mount -t tmpfs -o ro,nosuid,nodev,noexec,mode=0777,size=256m teststick /media/TESTSTICK && ulimit -c 0 && ulimit -n 524288 2>/dev/null; unset LD_PRELOAD LD_LIBRARY_PATH LIBGL_DRIVERS_PATH GBM_ALWAYS_SOFTWARE; /usr/bin/node /t/test/unit_test.js /t'
}
case "${1:-all}" in
    swrast|stub) run "$1" ;;
    all) run swrast && run stub ;;
    *) echo "usage: run_winston_test.sh [swrast|stub|all]" >&2; exit 2 ;;
esac
