# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Where vizualyse-steam's bundles come from (build.sh runs tools/bundle.sh
# in it): Debian trixie, the browser's base, from snapshot.debian.org at
# SNAPSHOT so the same versions come every time.
#
# - The runtime (/var/opt/vizualyse-steam/runtime on the unit): glibc 2.41
#   and its loader (the unit has 2.27, its loader in /lib), and every library
#   Wine's Unix side, Proton's own libraries, wl-sink and .NET (for
#   DepotDownloader) load or dlopen: Wayland >= 1.20 for Wine's Wayland
#   driver, xkbcommon, ALSA, FreeType / fontconfig, GnuTLS, OpenSSL, D-Bus,
#   udev. No GPU driver: Wine draws on the unit's own Mesa 19 (i965), linked
#   from /usr/lib at run time.
# - Proton itself (GE-Proton, a tarball) and .NET / DepotDownloader are
#   downloaded by bundle.sh into the volume at /dl, checked by hash.
# - python3 (and libvulkan1, which its launcher imports) runs Proton's own
#   launcher once at build time, to make the Windows prefix and to capture how
#   it starts a game (the car runs no Python of ours).
FROM debian:trixie@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6
ARG SNAPSHOT=20261105T000000Z
RUN rm -f /etc/apt/sources.list.d/* && printf '%s\n' \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT trixie main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$SNAPSHOT trixie-updates main" \
        "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$SNAPSHOT trixie-security main" \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=5 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        libwayland-client0 libwayland-egl1 libwayland-server0 libxkbcommon0 \
        libasound2t64 libasound2-data libfreetype6 libfontconfig1 fontconfig-config \
        libgnutls30t64 libssl3t64 libdbus-1-3 libudev1 libdrm2 libexpat1 libffi8 zlib1g \
        libstdc++6 libgcc-s1 ca-certificates \
        python3 libvulkan1 \
        gcc libc6-dev pkg-config libwayland-dev wayland-protocols patchelf binutils file \
        curl unzip xz-utils 7zip \
        gcc-mingw-w64-x86-64 gcc-mingw-w64-i686 \
    && rm -rf /var/lib/apt/lists/*
