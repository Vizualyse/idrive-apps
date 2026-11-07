#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# vkprobe's stages on lavapipe (Mesa's Vulkan on the CPU, Debian bookworm):
# real results, so the probe's own checks are checked: the compute numbers
# and every pixel of the draw (the triangle, its edge rule, the colour
# rounding). The same source as the car's probe, built here against the
# same shaders (build/bench/shaders.spv.h).
#   sh tools/vk-trial/test/lavapipe_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
sh "$HERE/build.sh" >&2
IMG=idrive-vk-trial-lavapipe:$(sha256sum < "$HERE/test/lavapipe/Dockerfile" | cut -c1-8)
docker image inspect "$IMG" >/dev/null 2>&1 || docker build -q -t "$IMG" "$WIN_HERE/test/lavapipe" >/dev/null
out=$(docker run --rm --network none -v "$WIN_HERE:/m:ro" "$IMG" sh -ec '
    gcc -O2 -std=gnu11 -Wall -Wextra -Werror -I/m/build/bench -o /tmp/vkprobe /m/src/vkprobe.c -ldl -lvulkan
    VK_ICD_FILENAMES=$(ls /usr/share/vulkan/icd.d/lvp_icd.*.json | head -1) /tmp/vkprobe draw; echo "rc=$?"' 2>&1 || true)
printf '%s\n' "$out" | sed 's/^/  | /'
fails=0
for want in "llvmpipe" "compute: 1024 of 1024 right" "draw: 65536 of 65536 pixels right" "0 wrong, 0 untouched" "stage draw: ok" "rc=0"; do
    if printf '%s\n' "$out" | grep -qF -- "$want"; then echo "  ok   $want"; else echo "  FAIL $want"; fails=$((fails + 1)); fi
done
[ $fails -eq 0 ] || { echo "vk-trial lavapipe: $fails failed" >&2; exit 1; }
echo "vk-trial lavapipe: all passed"
