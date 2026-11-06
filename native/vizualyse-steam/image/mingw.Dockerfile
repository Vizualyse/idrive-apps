# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds the bench's Windows test programs (test/win), 64- and 32-bit.
FROM debian:trixie
RUN apt-get -o Acquire::Retries=5 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        gcc-mingw-w64-x86-64 gcc-mingw-w64-i686 mingw-w64-x86-64-dev mingw-w64-i686-dev \
    && rm -rf /var/lib/apt/lists/*
