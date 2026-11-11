# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# test/crumbs_watch_test.sh: a C compiler and libdrm's headers on the
# unit's glibc (2.27, Ubuntu 18.04, as ../../image/Dockerfile), and no
# more: the test needs no Mesa, so it doesn't wait for vk-trial's image.
FROM ubuntu:18.04
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libdrm-dev \
    && rm -rf /var/lib/apt/lists/*
