#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# build/iris.tgz: iris for a game's OpenGL (a per-game choice), unpacked by
# server.js into /var/opt/vizualyse-steam/iris (env.IRIS):
#   lib/libEGL.so.1, libgbm.so.1, libglapi.so.0, libGLESv2.so.2
#                     Mesa 19.3.5's own EGL / GBM / GLES set (the unit's
#                     libEGL 19.0.6 can't load iris 19.3.5)
#   lib/dri/iris_dri.so  iris, patched for the unit's 4.14 kernel
#                     (tools/iris-bench: iris_no_isolation.py); swrast_dri.so
#                     the same megadriver, linked
#   VERSION, licenses/mesa.html
# Built by tools/iris-bench (glibc 2.27); its gated try passed on the car
# (2026-11-09). Reproducible: sorted, dated 0, root's, gzip -n.
#   sh native/vizualyse-steam/tools/iris.sh      (build.sh calls it)
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IB=$(cd "$HERE/../../tools/iris-bench" && pwd)
WIN_IB=$(cd "$IB" && (pwd -W 2>/dev/null || pwd))
mkdir -p "$HERE/build"
# Kept while its inputs stay (and from BUILD_CACHE on a fresh machine, CI):
# iris-bench's image tag (a hash of its Dockerfile and patches), this script
. "$HERE/../../tools/build_cache.sh"
ikey=$( (sh "$IB/build.sh" image-name; cat "$HERE/tools/iris.sh") | sha256sum | cut -c1-16)
if [ -f "$HERE/build/iris.tgz" ] && [ "$(cat "$HERE/build/iris.key" 2>/dev/null)" = "$ikey" ]; then
    echo "iris.tgz: up to date ($ikey)"
    exit 0
fi
rm -f "$HERE/build/iris.key"
if build_cache_get iris "$ikey" "$HERE/build"; then
    echo "$ikey" > "$HERE/build/iris.key"
    exit 0
fi
sh "$IB/build.sh" >&2
sh "$HERE/build.sh" image >&2   # packed in the Steam build image
docker run --rm --platform linux/amd64 -v "$WIN_IB/build:/i:ro" -v "$WIN_HERE:/m" "$(sh "$HERE/build.sh" image-name)" sh -ec '
    R=/tmp/r/var/opt/vizualyse-steam/iris
    rm -rf /tmp/r && mkdir -p $R/lib/dri $R/licenses
    cp /i/lib/libEGL.so.1 /i/lib/libgbm.so.1 /i/lib/libglapi.so.0 /i/lib/libGLESv2.so.2 $R/lib/
    cp /i/lib/dri/iris_dri.so $R/lib/dri/ && ln -s iris_dri.so $R/lib/dri/swrast_dri.so
    cp /i/mesa-license.html $R/licenses/mesa.html
    printf "Mesa 19.3.5 iris (tools/iris-bench)\n" > $R/VERSION
    find /tmp/r -type d -exec chmod 755 {} +; find /tmp/r -type f -exec chmod 644 {} +
    cd /tmp/r && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - var/opt/vizualyse-steam/iris | gzip -n -6 > /m/build/iris.tgz.tmp
    mv /m/build/iris.tgz.tmp /m/build/iris.tgz
    echo "iris.tgz: $(tar tzf /m/build/iris.tgz | grep -c -v /$) files, $(du -h /m/build/iris.tgz | cut -f1)"'
echo "$ikey" > "$HERE/build/iris.key"
build_cache_put iris "$ikey" "$HERE/build" iris.tgz
