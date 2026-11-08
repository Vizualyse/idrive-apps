#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# vkprobe's stages on lavapipe (Mesa's Vulkan on the CPU, Debian bookworm):
# real results, so the probe's own checks are checked: the compute numbers,
# every pixel of the draw (the triangle, its edge rule, the colour rounding)
# and of the picture wl-sink composes from 60 presented frames (by shared
# memory here: no EGL in this image, so wl-sink offers no wl_drm). The same
# sources as the car's probe and wl-sink, built here against the same
# shaders (build/bench/shaders.spv.h) and Debian's libwayland.
#   sh tools/vk-trial/test/lavapipe_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
WIN_SINK=$(cd "$HERE/../../native/vizualyse-steam/src" && (pwd -W 2>/dev/null || pwd))
sh "$HERE/build.sh" >&2
IMG=idrive-vk-trial-lavapipe:$(sha256sum < "$HERE/test/lavapipe/Dockerfile" | cut -c1-8)
docker image inspect "$IMG" >/dev/null 2>&1 || docker build -q -t "$IMG" "$WIN_HERE/test/lavapipe" >/dev/null
out=$(docker run --rm --network none -v "$WIN_HERE:/m:ro" -v "$WIN_SINK:/sink:ro" "$IMG" sh -ec '
    W="-O2 -std=gnu11 -Wall -Wextra -Werror"
    G=/tmp/gen; mkdir -p $G
    P=/usr/share/wayland-protocols
    wayland-scanner client-header $P/stable/xdg-shell/xdg-shell.xml $G/xdg-shell-client-protocol.h
    wayland-scanner server-header $P/stable/xdg-shell/xdg-shell.xml $G/xdg-shell-server-protocol.h
    wayland-scanner private-code $P/stable/xdg-shell/xdg-shell.xml $G/xdg-shell-protocol.c
    wayland-scanner server-header /sink/protocol/wayland-drm.xml $G/wayland-drm-server-protocol.h
    wayland-scanner private-code /sink/protocol/wayland-drm.xml $G/wayland-drm-protocol.c
    wayland-scanner server-header $P/stable/viewporter/viewporter.xml $G/viewporter-server-protocol.h
    wayland-scanner private-code $P/stable/viewporter/viewporter.xml $G/viewporter-protocol.c
    gcc $W -I/m/build/bench -I$G -o /tmp/vkprobe /m/src/vkprobe.c $G/xdg-shell-protocol.c -ldl -lvulkan -lwayland-client
    gcc $W -I/sink -I$G -o /tmp/wl-sink /sink/wl_sink.c /sink/rgb.c /sink/frame_out.c \
        $G/xdg-shell-protocol.c $G/wayland-drm-protocol.c $G/viewporter-protocol.c -lwayland-server -ldl
    VK_ICD_FILENAMES=$(ls /usr/share/vulkan/icd.d/lvp_icd.*.json | head -1) /tmp/vkprobe present; echo "rc=$?"' 2>&1 || true)
printf '%s\n' "$out" | sed 's/^/  | /'
fails=0
for want in "llvmpipe" "compute: 1024 of 1024 right" "draw: 65536 of 65536 pixels right" "0 wrong, 0 untouched" "stage draw: ok" \
        "present: 60 frames presented" "wl-sink's picture: 65536 of 65536 pixels right, 0 wrong" "stage present: ok" "rc=0"; do
    if printf '%s\n' "$out" | grep -qF -- "$want"; then echo "  ok   $want"; else echo "  FAIL $want"; fails=$((fails + 1)); fi
done
[ $fails -eq 0 ] || { echo "vk-trial lavapipe: $fails failed" >&2; exit 1; }
echo "vk-trial lavapipe: all passed"
