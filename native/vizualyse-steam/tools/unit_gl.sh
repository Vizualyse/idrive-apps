#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Copies the head unit's own GL stack out of a copy of its root filesystem
# (../idrive-rootfs/20.40.2/rootfs.tar, not in git) into build/unit-gl/ (lib/
# and dri/), for the off-car tests: Mesa 19.0.6's libEGL, libgbm, libglapi,
# libGLESv2 and i965_dri.so, nothing else. The unit's Wayland 1.15 stays
# out: Wine's Wayland driver needs libwayland-client >= 1.20
# (wl_proxy_marshal_flags), and Mesa 19 runs on the newer one. The BMW-built
# files stay out of git (build/ is ignored).
#   sh tools/unit_gl.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
ROOTFS_DIR=$(cd "$(dirname "$ROOTFS")" && (pwd -W 2>/dev/null || pwd))
rm -rf "$HERE/build/unit-gl"
mkdir -p "$HERE/build/unit-gl/lib" "$HERE/build/unit-gl/dri"
OUT=$(cd "$HERE/build/unit-gl" && (pwd -W 2>/dev/null || pwd))
docker run --rm -v "$ROOTFS_DIR:/r:ro" -v "$OUT:/o" debian:trixie sh -euc '
    mkdir -p /tmp/x && cd /tmp/x
    tar xf /r/'"$(basename "$ROOTFS")"' --wildcards --warning=no-unknown-keyword \
        "usr/lib/libEGL.so*" "usr/lib/libgbm.so*" "usr/lib/libglapi.so*" "usr/lib/libGLESv2.so*" \
        "usr/lib/dri/*" "etc/alternatives/*" 2>/dev/null || true
    for f in libEGL.so.1 libgbm.so.1 libglapi.so.0 libGLESv2.so.2; do cp -L usr/lib/$f /o/lib/; done
    cp -L usr/lib/dri/mesa/i965_dri.so /o/dri/i965_dri.so
    ls -l /o/lib /o/dri'
