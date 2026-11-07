#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The Winston output end to end (winston_test.js): the tool with Chromium,
# against the head unit's own Winston in its root filesystem
# (tools/winston-bench, llvmpipe pixels). Needs build/chromium.tgz (build.sh).
#   sh native/vizualyse-chromium/test/run_winston_test.sh
# VERBOSE=1 shows the server's log.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2
[ -f "$HERE/build/chromium.tgz" ] || sh "$HERE/build.sh"
DOCKER_ARGS="--shm-size=512m -v $WIN_HERE:/t:ro ${VERBOSE:+-e VERBOSE=1}" \
    sh "$HERE/../../tools/winston-bench/run.sh" swrast \
    /bin/sh -c 'mkdir -p /var/opt && ulimit -c 0 && /usr/bin/node /t/test/winston_test.js /t'
