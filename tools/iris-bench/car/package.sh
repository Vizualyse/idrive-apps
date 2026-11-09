#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# car/build/iris-trial.tgz: iris for a gated try on the car, unpacked into
# /var/opt/vk-trial (next to vk-trial's own package):
#   iris/run.sh             what the gate starts (car/run.sh)
#   iris/lib/               iris's own EGL / GBM / GLES set, dri/iris_dri.so
#                           (swrast_dri.so: the same megadriver, linked), Nine
#   iris/bin/gltest         tools/gpu-bench's GL smoke test (the unit's glibc)
#   iris/bin/ninetest       Nine's adapter on the render node
#   iris/licenses/          Mesa's
# Reproducible: sorted, dated 0, root's, gzip -n.
#   sh tools/iris-bench/car/package.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
IB=$(cd "$HERE/.." && pwd)
GB=$(cd "$IB/../gpu-bench" && pwd)
VKT=$(cd "$IB/../vk-trial" && pwd)
win() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
sh "$IB/build.sh" >&2
[ -f "$GB/build/gltest" ] || { echo "iris package: no gpu-bench gltest (sh tools/gpu-bench/build.sh)" >&2; exit 2; }
[ -f "$VKT/build/image" ] || { echo "iris package: no vk-trial image (sh tools/vk-trial/build.sh)" >&2; exit 2; }
mkdir -p "$IB/car/build"
docker run --rm --platform linux/amd64 -v "$(win "$IB/build"):/i:ro" -v "$(win "$GB/build"):/g:ro" -v "$(win "$HERE"):/c:ro" -v "$(win "$IB/car/build"):/o" \
    "$(cat "$VKT/build/image")" sh -ec '
    R=/tmp/r/iris
    rm -rf /tmp/r && mkdir -p $R/lib/dri $R/lib/d3d $R/bin $R/licenses
    cp /i/lib/libEGL.so.1 /i/lib/libGLESv2.so.2 /i/lib/libgbm.so.1 /i/lib/libglapi.so.0 $R/lib/
    cp /i/lib/dri/iris_dri.so $R/lib/dri/ && ln -s iris_dri.so $R/lib/dri/swrast_dri.so
    cp /i/lib/d3d/d3dadapter9.so.1 $R/lib/d3d/
    cp /g/gltest /i/bench/ninetest $R/bin/
    cp /c/run.sh $R/run.sh
    cp /i/mesa-license.html $R/licenses/
    find /tmp/r -type d -exec chmod 755 {} +; find /tmp/r -type f -exec chmod 644 {} +
    chmod 755 $R/run.sh $R/bin/*
    cd /tmp/r && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - iris | gzip -n -6 > /o/iris-trial.tgz.tmp
    mv /o/iris-trial.tgz.tmp /o/iris-trial.tgz
    echo "iris package: car/build/iris-trial.tgz, $(tar tzf /o/iris-trial.tgz | grep -c -v /$) files, $(du -h /o/iris-trial.tgz | cut -f1)"' >&2
