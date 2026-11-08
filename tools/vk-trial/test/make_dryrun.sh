#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# build/vk-trial-dryrun.tgz: the gate's safeties on the car with no driver.
# The real bin/vk-trial and lib/vk_crumbs.so; bin/vkprobe is
# test/fake_probe.sh (says what the child sees), bin/show_nodes.sh shows the
# DRM nodes from inside; lib/libvulkan_intel.so is an empty placeholder
# (arm wants the file; nothing ever loads it: the children are shell
# scripts). No Vulkan loader, no ANV.
#   sh tools/vk-trial/test/make_dryrun.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
sh "$HERE/build.sh" >&2
docker run --rm --network none -v "$WIN_HERE:/m" "$(cat "$HERE/build/image")" sh -ec '
    rm -rf /tmp/d && mkdir -p /tmp/d/bin /tmp/d/lib
    cp /m/build/pkg/bin/vk-trial /tmp/d/bin/
    cp /m/test/fake_probe.sh /tmp/d/bin/vkprobe
    cp /m/test/show_nodes.sh /tmp/d/bin/
    cp /m/build/pkg/lib/vk_crumbs.so /tmp/d/lib/
    : > /tmp/d/lib/libvulkan_intel.so
    chmod 755 /tmp/d/bin/*; chmod 644 /tmp/d/lib/*
    cd /tmp/d && tar --owner=0 --group=0 --mtime=@0 --sort=name -czf /m/build/vk-trial-dryrun.tgz bin lib
    tar tvzf /m/build/vk-trial-dryrun.tgz'
echo "built build/vk-trial-dryrun.tgz"
