# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Where tools/build_ntdll.sh rebuilds Proton's ntdll.so from GE-Proton's own
# Wine tree with our patch (patches/wine-no-ia32.patch): the bundles' base
# (image/Dockerfile: Debian trixie from snapshot.debian.org at SNAPSHOT),
# whose GCC 14.2.0-19 is the one the shipped ntdll.so was built with, and
# what Wine's configure, its tools and GE's patch script need. The sources
# live in the Docker volume steam-wine-src, never on the Windows drive.
FROM debian:trixie@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6
ARG SNAPSHOT=20261105T000000Z
RUN rm -f /etc/apt/sources.list.d/* && printf '%s\n' \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT trixie main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT trixie-updates main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$SNAPSHOT trixie-security main" \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=5 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        gcc libc6-dev make flex bison autoconf automake perl python3 git patch ca-certificates \
        pkg-config binutils file \
    && rm -rf /var/lib/apt/lists/*
