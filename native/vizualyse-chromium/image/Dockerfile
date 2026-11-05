# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Where vizualyse-chromium's bundle comes from: Debian trixie's Chromium
# (open source, WebGPU through Dawn, JSPI on by default since 137) and Mesa
# 25.0 (ANV: Vulkan on the unit's Gen9 GPU; iris: GL), with every library
# they load, glibc included (the unit's is 2.27). build.sh copies them out
# (tools/bundle.sh). Installed from snapshot.debian.org at SNAPSHOT, so the
# same versions come every time (the live archive drops them at the next
# security update); a newer Chromium is a newer SNAPSHOT and version.
FROM debian:trixie@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6
ARG SNAPSHOT=20261105T000000Z
ARG CHROMIUM=156.0.8078.79-1~deb13u1
ARG MESA=25.0.7-2+deb13u1
RUN rm -f /etc/apt/sources.list.d/* && printf '%s\n' \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT trixie main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT trixie-updates main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$SNAPSHOT trixie-security main" \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=5 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        chromium=$CHROMIUM chromium-common=$CHROMIUM \
        mesa-vulkan-drivers=$MESA libgl1-mesa-dri=$MESA libegl-mesa0=$MESA libgbm1=$MESA \
        libegl1 libgles2 libvulkan1 libpci3 \
        fontconfig fonts-dejavu-core fonts-liberation \
        gcc libc6-dev libturbojpeg0-dev patchelf file binutils xz-utils ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
