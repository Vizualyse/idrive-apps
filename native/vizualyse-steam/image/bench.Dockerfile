# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The off-car bench: the newer userland that loads the unit's own Mesa 19
# (build/unit-gl) as the tool will on the car, with the browser's base
# (Debian trixie, glibc 2.41). The unit's GL goes on LD_LIBRARY_PATH; Mesa's
# Intel no-op drm-shim (image/drm-shim.Dockerfile) stands in for the GPU.
#
# Also what Proton (build/proton, tools/fetch_proton.sh) loads outside
# Steam's runtime: Python for its launcher, Wayland and xkbcommon for its
# Wayland driver, udev / SDL2 / libusb for the controller bus, ALSA, fonts;
# the headers to build the bench's compositor (wl-sink); and weston, a
# reference compositor to tell our compositor's faults from Wine's.
FROM debian:trixie
RUN apt-get -o Acquire::Retries=5 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        libdrm2 libexpat1 zlib1g libstdc++6 \
        python3 libwayland-client0 libwayland-egl1 libwayland-server0 libxkbcommon0 libxkbregistry0 xkb-data \
        libudev1 libsdl2-2.0-0 libusb-1.0-0 libasound2t64 libfreetype6 libfontconfig1 fonts-dejavu-core libdbus-1-3 \
        weston \
        gcc libc6-dev pkg-config libwayland-dev wayland-protocols libxkbcommon-dev libdrm-dev \
        procps strace \
    && rm -rf /var/lib/apt/lists/*
