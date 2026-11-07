#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds our compositors for the Winston bench, from their own sources and
# pinned platform copies, in their own build images, each with every library
# it loads and its loader beside it (as the tools' bundles carry them):
#   build-sinks/chromium/chromium-wl   native/vizualyse-chromium/sink/wl.c
# Run in the rootfs container as /sinks/chromium/ld-linux-x86-64.so.2
# --library-path /sinks/chromium /sinks/chromium/chromium-wl ...
#   sh tools/winston-bench/test/build_sinks.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WIN_REPO=$(cd "$REPO" && (pwd -W 2>/dev/null || pwd))
mkdir -p "$HERE/build-sinks"
WIN_OUT=$(cd "$HERE/build-sinks" && (pwd -W 2>/dev/null || pwd))

C=$REPO/native/vizualyse-chromium
node "$WIN_REPO/platform/platform.js" sync "$WIN_REPO/native/vizualyse-chromium" >&2
IMG=$(sh "$C/build.sh" image-name)
docker image inspect "$IMG" >/dev/null 2>&1 || sh "$C/build.sh" image >&2
key=$( (cat "$C"/sink/*.[ch] "$C"/sink/protocol/*; docker image inspect -f '{{.Id}}' "$IMG") | sha256sum | cut -c1-16)
if [ "$(cat "$HERE/build-sinks/chromium.key" 2>/dev/null)" != "$key" ]; then
    rm -rf "$HERE/build-sinks/chromium"
    docker run --rm --platform linux/amd64 --network none -v "$WIN_REPO/native/vizualyse-chromium:/m:ro" -v "$WIN_OUT:/out" "$IMG" sh -euc '
        G=/tmp/g; O=/out/chromium; mkdir -p $G $O
        XDG=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
        wayland-scanner server-header $XDG $G/xdg-shell-server-protocol.h
        wayland-scanner private-code $XDG $G/xdg-shell-protocol.c
        wayland-scanner server-header /m/sink/protocol/wayland-drm.xml $G/wayland-drm-server-protocol.h
        wayland-scanner private-code /m/sink/protocol/wayland-drm.xml $G/wayland-drm-protocol.c
        for x in ivi-application ivi-controller linux-dmabuf-unstable-v1; do
            wayland-scanner client-header /m/sink/protocol/$x.xml $G/$x-client-protocol.h
            wayland-scanner private-code /m/sink/protocol/$x.xml $G/$x-protocol.c
        done
        # as tools/bundle.sh builds it
        gcc -O2 -g0 -std=gnu11 -Wall -Wextra -Werror -I/m/sink -I$G -o $O/chromium-wl \
            /m/sink/wl.c /m/sink/frame_out.c /m/sink/winston_out.c $G/*.c \
            $(pkg-config --cflags --libs wayland-server wayland-client) -lyuv -ldl
        for l in $(ldd $O/chromium-wl | awk "/=>/ { print \$3 } /ld-linux/ { print \$1 }"); do cp -L "$l" $O/; done
        # glibc stubs: the unit Mesa libraries chromium-wl dlopens ask for them (the bundle has them too)
        for l in libdl.so.2 libpthread.so.0 librt.so.1; do cp -L /lib/x86_64-linux-gnu/$l $O/ 2>/dev/null || true; done
        ls $O'
    echo "$key" > "$HERE/build-sinks/chromium.key"
    echo "winston-bench: chromium-wl built ($key)"
else
    echo "winston-bench: chromium-wl up to date ($key)"
fi
