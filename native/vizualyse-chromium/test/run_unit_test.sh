#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The off-car tests, in a container made from the head unit's own root
# filesystem (../idrive-rootfs/20.40.2/rootfs.tar, not in git: imported once
# as idrive-rootfs:I_21w12.2-1-4), with no network. Needs build/chromium.tgz
# (build.sh).
#   sh native/vizualyse-chromium/test/run_unit_test.sh [bundle|server]   (both by default)
# OUT_DIR=dir keeps chrome://gpu's text as dir/gpu.txt; VERBOSE=1 shows the server's log.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2   # the pinned platform version's copies (component.json "platform")
IMG=idrive-rootfs:I_21w12.2-1-4
ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
[ -f "$HERE/build/chromium.tgz" ] || sh "$HERE/build.sh"
run() {
    docker run --rm --platform linux/amd64 --network none --shm-size=512m -v "$WIN_HERE:/t:ro" \
        ${OUT_DIR:+-v "$OUT_DIR:/out" -e GPU_PAGE=1} ${VERBOSE:+-e VERBOSE=1} $IMG \
        /bin/sh -c "mkdir -p /var/opt && ulimit -c 0 && /usr/bin/node /t/test/$1 /t"
}
case "${1:-all}" in
    bundle) run unit_test.js ;;
    server) run server_test.js ;;
    all) run unit_test.js && run server_test.js ;;
    *) echo "usage: run_unit_test.sh [bundle|server]" >&2; exit 2 ;;
esac
