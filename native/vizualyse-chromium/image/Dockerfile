# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Where vizualyse-chromium's bundle comes from: Debian trixie's Chromium
# (open source, WebGPU through Dawn, JSPI on by default since 137) with every
# library it loads, glibc included (the unit's is 2.27), and a Vulkan driver.
# build.sh copies them out (tools/bundle.sh). Mesa's EGL and GBM are not
# bundled: ANGLE and Dawn both run on Vulkan.
#
# The Vulkan driver is **Mesa 22.3's ANV from Debian bookworm**, not trixie's
# 25.0: newer ANV and iris (25.0 at least) refuse a kernel without i915 context
# isolation (4.16+), and the unit runs 4.14.147 ("Vulkan requires context
# isolation for Intel(R) HD Graphics 505 (APL 3)", seen on the car
# 2026-11-05). 22.3 works around its absence. Only libvulkan_intel.so is
# taken from it; its libraries resolve to the newer trixie ones.
#
# Installed from snapshot.debian.org at SNAPSHOT, so the same versions come
# every time (the live archive drops them at the next security update).
FROM debian:bookworm@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8 AS anv22
ARG SNAPSHOT=20261105T000000Z
ARG ANV=22.3.6-1+deb12u2
RUN rm -f /etc/apt/sources.list.d/* && printf '%s\n' \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT bookworm main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT bookworm-updates main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$SNAPSHOT bookworm-security main" \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=5 update \
    && cd /tmp && apt-get -o Acquire::Retries=5 download mesa-vulkan-drivers=$ANV \
    && dpkg-deb -x mesa-vulkan-drivers_*.deb /anv22 \
    && echo "$ANV" > /anv22/VERSION \
    && rm -rf /var/lib/apt/lists/*

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
        libegl-mesa0=$MESA libgbm1=$MESA \
        libegl1 libgles2 libvulkan1 libpci3 \
        fontconfig fonts-dejavu-core fonts-liberation \
        gcc libc6-dev libturbojpeg0-dev patchelf file binutils xz-utils ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=anv22 /anv22 /opt/anv22
