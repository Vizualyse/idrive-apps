# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# test/lavapipe_test.sh's image: Debian bookworm's lavapipe (Mesa's Vulkan
# on the CPU) and a compiler, to run vkprobe's stages with real results off
# the car: the compute numbers and every pixel of the draw. Not the unit's
# driver or kernel (gpu-bench's stub is for those): this checks the probe.
FROM debian:bookworm-20241016-slim@sha256:36e591f228bb9b99348f584e83f16e012c33ba5cad44ef5981a1d7c0a93eca22
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc libc6-dev libvulkan-dev mesa-vulkan-drivers >/dev/null && rm -rf /var/lib/apt/lists/*
