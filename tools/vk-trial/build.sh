#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds vk-trial into tools/vk-trial/build/ (git-ignored):
#   bin/vk-trial       the gate, static (loads no library at all)
#   bin/vkprobe        the staged probe, for the unit's glibc 2.27 and loader
#   bin/wl-sink        the Steam tool's compositor (main's source, compiled
#                      here for the unit): the present stage's target
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
# (the tests need tools/gpu-bench's stub GPU too: they build it themselves;
# this build needs nothing local, so the Steam tool's release builds it in CI)
IMG=idrive-vk-trial:$( (cat "$HERE/image/Dockerfile" "$HERE"/image/*.comp "$HERE"/image/*.vert "$HERE"/image/*.frag) | sha256sum | cut -c1-8)
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    LOG=${TMPDIR:-/tmp}/vk-trial-image.$$.log
    echo "vk-trial: building $IMG (Mesa 19.0.6 ANV, ~5 min the first time)"
    docker build --platform linux/amd64 --progress=plain -t "$IMG" "$WIN_HERE/image" > "$LOG" 2>&1 \
        || { tail -30 "$LOG" >&2; echo "vk-trial: the image did not build (log: $LOG)" >&2; exit 1; }
    rm -f "$LOG"
fi
# wl-sink, the compositor the present stage draws into: the Steam tool's, as
# it is on main (compiled here for the unit's glibc, not changed)
SINK=$HERE/../../native/vizualyse-steam/src
WIN_SINK=$(cd "$SINK" && (pwd -W 2>/dev/null || pwd))
# its platform modules (frame_out, winston_out, protocols) are synced copies,
# not committed: as the Steam tool's own build does first
node "$(cd "$HERE/../../platform" && (pwd -W 2>/dev/null || pwd))/platform.js" sync \
    "$(cd "$HERE/../../native/vizualyse-steam" && (pwd -W 2>/dev/null || pwd))" >&2
key=$( (cat "$HERE"/src/*.c "$HERE"/test/*.c "$HERE/build.sh" "$SINK"/wl_sink.c "$SINK"/rgb.c "$SINK"/frame_out.c "$SINK"/winston_out.c "$SINK"/*.h "$SINK"/protocol/*.xml;
        docker image inspect -f '{{.Id}}' "$IMG") | sha256sum | cut -c1-16)
if [ -f "$HERE/build/vk-trial.tgz" ] && [ "$(cat "$HERE/build/key" 2>/dev/null)" = "$key" ]; then
    echo "vk-trial: up to date ($key)"
    exit 0
fi
rm -rf "$HERE/build"
mkdir -p "$HERE/build/unitlib"
# the unit's own Wayland libraries, to check every symbol we use is in them
# (ours are built on 18.04's 1.16 headers; the unit has an older build)
# (only where the unit's root filesystem image is: not in CI, which checks
# the same build's outputs without it)
UNITLIB=$(cd "$HERE/build/unitlib" && (pwd -W 2>/dev/null || pwd))
if docker image inspect idrive-rootfs:I_21w12.2-1-4 >/dev/null 2>&1; then
    cid=$(docker create idrive-rootfs:I_21w12.2-1-4 true)
    docker cp "$cid:/usr/lib/libwayland-client.so.0.3.0" "$UNITLIB/" >/dev/null
    docker cp "$cid:/usr/lib/libwayland-server.so.0.1.0" "$UNITLIB/" >/dev/null
    docker cp "$cid:/usr/lib/libffi.so.6.0.4" "$UNITLIB/libffi.so.6" >/dev/null   # for dxvk/'s bench (trixie lacks it)
    docker rm "$cid" >/dev/null
else
    echo "vk-trial: no unit root filesystem image: the check against its libwayland is skipped" >&2
fi
docker run --rm --platform linux/amd64 --network none -e HOST_IDS="$(id -u):$(id -g)" -v "$WIN_HERE:/m" -v "$WIN_SINK:/sink:ro" "$IMG" sh -ec '
    W="-O2 -std=gnu11 -Wall -Wextra -Werror"
    mkdir -p /m/build/pkg/bin /m/build/pkg/lib /m/build/bench /tmp/gen
    # vkprobe: a client on the unit'"'"'s libwayland-client (18.04'"'"'s 1.16 headers, xdg-shell 1.13)
    mkdir -p /tmp/gen/client /tmp/gen/sink
    XDG=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
    wayland-scanner client-header $XDG /tmp/gen/client/xdg-shell-client-protocol.h
    wayland-scanner private-code $XDG /tmp/gen/client/xdg-shell-protocol.c
    gcc $W -static -o /m/build/pkg/bin/vk-trial /m/src/vk-trial.c
    gcc $W -I/out -I/tmp/gen/client -o /m/build/pkg/bin/vkprobe /m/src/vkprobe.c /tmp/gen/client/xdg-shell-protocol.c \
        -ldl -lvulkan -lwayland-client -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
    # wl-sink: on libwayland 1.22 (/opt/wl), server and client (it is also
    # a client of Winston: winston_out), shipped in lib/wl/ and found through
    # its RPATH only, so nothing else of ours loads them. RPATH, not RUNPATH:
    # it wins over LD_LIBRARY_PATH, which callers set for the EGL of the unit
    # (/usr/lib, with the old libwayland-client of the unit: "undefined symbol
    # wl_proxy_marshal_flags" in dxvk/car_test.sh with a RUNPATH)
    S=/opt/wl/bin/wayland-scanner G=/tmp/gen/sink
    XDG=/opt/wlp/stable/xdg-shell/xdg-shell.xml VP=/opt/wlp/stable/viewporter/viewporter.xml
    $S server-header $XDG $G/xdg-shell-server-protocol.h; $S private-code $XDG $G/xdg-shell-protocol.c
    $S server-header /sink/protocol/wayland-drm.xml $G/wayland-drm-server-protocol.h
    $S private-code /sink/protocol/wayland-drm.xml $G/wayland-drm-protocol.c
    $S server-header $VP $G/viewporter-server-protocol.h; $S private-code $VP $G/viewporter-protocol.c
    for x in ivi-application ivi-controller linux-dmabuf-unstable-v1; do
        $S client-header /sink/protocol/$x.xml $G/$x-client-protocol.h; $S private-code /sink/protocol/$x.xml $G/$x-protocol.c
    done
    gcc $W -I/sink -I$G -I/opt/wl/include -o /m/build/pkg/bin/wl-sink /sink/wl_sink.c /sink/rgb.c /sink/frame_out.c /sink/winston_out.c \
        $G/xdg-shell-protocol.c $G/wayland-drm-protocol.c $G/viewporter-protocol.c \
        $G/ivi-application-protocol.c $G/ivi-controller-protocol.c $G/linux-dmabuf-unstable-v1-protocol.c \
        -L/opt/wl/lib -lwayland-server -lwayland-client -ldl -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 \
        -Wl,--disable-new-dtags,-rpath,\$ORIGIN/../lib/wl
    mkdir -p /m/build/pkg/lib/wl && cp /out/lib/wl/* /m/build/pkg/lib/wl/
    cp /tmp/gen/client/xdg-shell-client-protocol.h /tmp/gen/client/xdg-shell-protocol.c /m/build/bench/   # for test/lavapipe_test.sh
    gcc $W -shared -fPIC -o /m/build/pkg/lib/vk_crumbs.so /m/src/vk_crumbs.c -ldl
    gcc $W -shared -fPIC -o /m/build/bench/kernel414.so /m/test/kernel414.c -ldl
    cp /out/lib/libvulkan_intel.so /out/lib/libvulkan.so.1 /m/build/pkg/lib/
    cp /out/shaders.spv.h /m/build/bench/   # for test/lavapipe_test.sh
    strip --strip-unneeded /m/build/pkg/bin/* /m/build/pkg/lib/vk_crumbs.so
    # the gate needs nothing; nothing else more than glibc 2.27
    ! readelf -d /m/build/pkg/bin/vk-trial | grep -q NEEDED || { echo "vk-trial is not static"; exit 1; }
    for f in /m/build/pkg/bin/vkprobe /m/build/pkg/bin/wl-sink /m/build/pkg/lib/*.so* /m/build/pkg/lib/wl/*; do
        v=$(objdump -T "$f" | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1)
        [ "$(printf "%s\nGLIBC_2.27\n" "$v" | sort -V | tail -1)" = GLIBC_2.27 ] || { echo "$f needs $v"; exit 1; }
    done
    # every wl_ symbol vkprobe and ANV import is in the unit'"'"'s own
    # libwayland-client; wl-sink'"'"'s in the libwayland 1.22 we ship for it
    have() { nm -D --defined-only "$@" | grep -o " wl_[a-z0-9_]*" | tr -d " " | sort -u; }
    need() { nm -D --undefined-only "$1" | grep -o " wl_[a-z0-9_]*" | tr -d " " | sort -u; }
    have /m/build/pkg/lib/wl/libwayland-server.so.0 /m/build/pkg/lib/wl/libwayland-client.so.0 > /tmp/ours
    ! ls /m/build/pkg/lib/libwayland* 2>/dev/null || { echo "no libwayland in lib/ (ANV and vkprobe use the unit'"'"'s)"; exit 1; }
    readelf -d /m/build/pkg/bin/wl-sink | grep -q "(RPATH).*\$ORIGIN/../lib/wl" || { echo "wl-sink has no RPATH to lib/wl"; exit 1; }
    if [ -f /m/build/unitlib/libwayland-client.so.0.3.0 ]; then
        have /m/build/unitlib/libwayland-client.so.0.3.0 > /tmp/unit
        for f in /m/build/pkg/bin/vkprobe /m/build/pkg/lib/libvulkan_intel.so; do
            miss=$(need "$f" | comm -23 - /tmp/unit)
            [ -z "$miss" ] || { echo "$f needs what the unit'"'"'s libwayland-client lacks: $miss"; exit 1; }
        done
    fi
    cp /out/licenses/* /m/build/bench/ 2>/dev/null || true   # Mesa'"'"'s and the loader'"'"'s licences (the Steam tool ships them)
    miss=$(need /m/build/pkg/bin/wl-sink | comm -23 - /tmp/ours)
    [ -z "$miss" ] || { echo "wl-sink needs what our libwayland 1.22 lacks: $miss"; exit 1; }
    cd /m/build/pkg && chmod 755 bin/* lib/wl && find lib -type f -exec chmod 644 {} + \
        && tar --owner=0 --group=0 --mtime=@0 --sort=name -czf /m/build/vk-trial.tgz bin lib
    # back to the caller, so the release tooling (and a plain rm) can remove them
    chown -R "$HOST_IDS" /m/build/pkg /m/build/bench /m/build/vk-trial.tgz'
echo "$key" > "$HERE/build/key"
echo "$IMG" > "$HERE/build/image"
echo "vk-trial: built ($key): build/vk-trial.tgz"
