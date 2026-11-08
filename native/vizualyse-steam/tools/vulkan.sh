#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# build/vulkan.tgz: Vulkan for the tool's games, unpacked by server.js into
# /var/opt/vizualyse-steam/vulkan (env.VK):
#   lib/libvulkan_intel.so  Mesa 19.0.6's ANV for the unit's HD 505, built for
#                           glibc 2.27 by tools/vk-trial (seen on the car:
#                           knowledge/browser.md, "Vulkan on this kernel")
#   lib/libvulkan.so.1      the Khronos loader 1.1.70 (the runtime has none)
#   lib/vk_crumbs.so        every DRM call of a Vulkan game logged before it
#                           enters the kernel (state/vulkan-crumbs.log)
#   dxvk/x64, dxvk/x32      DXVK 1.9.4 (the newest for ANV 19's Vulkan 1.1)
#   licenses/               Mesa (MIT), the loader (Apache-2.0), DXVK (zlib)
# No ICD file: server.js writes one into /dev/shm only while a Vulkan game
# runs. Reproducible: sorted, dated 0, root's, gzip -n.
#   sh native/vizualyse-steam/tools/vulkan.sh      (build.sh calls it)
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
VKT=$(cd "$HERE/../../tools/vk-trial" && pwd)
WIN_VKT=$(cd "$VKT" && (pwd -W 2>/dev/null || pwd))
DXVK_VER=1.9.4
DXVK_SHA=854f564c3b58a4cdf7b16eb9a4b6bc6ddc0f83d68c4f979a529fc23f7a770502
# Steam ships 19.0.6 until 19.1.8 has had its vk-trial on the car (TODO)
MESA_VER=19.0.6 sh "$VKT/build.sh" >&2
mkdir -p "$HERE/build"
# DXVK's release tarball into the build's download volume (as Proton's), checked
docker run --rm --platform linux/amd64 -v steam-build-dl:/dl -v "$WIN_VKT/build:/v:ro" -v "$WIN_HERE:/m" -v "$WIN_HERE/tools:/t:ro" \
    "$(cat "$VKT/build/image")" sh -ec "
    cd /dl
    [ -f dxvk-$DXVK_VER.tar.gz ] && echo '$DXVK_SHA  dxvk-$DXVK_VER.tar.gz' | sha256sum -c - >/dev/null 2>&1 \
        || curl -fsSL --retry 8 --retry-delay 10 -o dxvk-$DXVK_VER.tar.gz https://github.com/doitsujin/dxvk/releases/download/v$DXVK_VER/dxvk-$DXVK_VER.tar.gz
    echo '$DXVK_SHA  dxvk-$DXVK_VER.tar.gz' | sha256sum -c - >/dev/null
    R=/tmp/r/var/opt/vizualyse-steam/vulkan
    rm -rf /tmp/r && mkdir -p \$R/lib \$R/dxvk \$R/licenses
    cp /v/pkg/lib/libvulkan_intel.so /v/pkg/lib/libvulkan.so.1 /v/pkg/lib/vk_crumbs.so \$R/lib/
    tar xzf dxvk-$DXVK_VER.tar.gz -C /tmp && cp -r /tmp/dxvk-$DXVK_VER/x64 /tmp/dxvk-$DXVK_VER/x32 \$R/dxvk/
    echo $DXVK_VER > \$R/dxvk/VERSION
    cp /v/bench/mesa.html /v/bench/vulkan-loader.txt \$R/licenses/
    cp /t/dxvk-license.txt \$R/licenses/dxvk.txt
    printf 'Mesa 19.0.6 ANV (tools/vk-trial), Vulkan loader 1.1.70, DXVK $DXVK_VER\n' > \$R/VERSION
    find /tmp/r -type d -exec chmod 755 {} +; find /tmp/r -type f -exec chmod 644 {} +
    cd /tmp/r && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - var/opt/vizualyse-steam/vulkan | gzip -n -6 > /m/build/vulkan.tgz.tmp
    mv /m/build/vulkan.tgz.tmp /m/build/vulkan.tgz
    echo \"vulkan.tgz: \$(tar tzf /m/build/vulkan.tgz | grep -c -v /\$) files, \$(du -h /m/build/vulkan.tgz | cut -f1)\""
