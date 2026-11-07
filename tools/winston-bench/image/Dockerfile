# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The Winston bench's build image: Ubuntu 18.04 (glibc 2.27, the unit's) with
# libwayland 1.16's headers and scanner (the unit has 1.15: the client calls
# it generates are all in 1.15) and libdrm's headers, for kms_shim.so and the
# test clients. Never shipped to the car.
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc libc6-dev libwayland-dev libdrm-dev pkg-config python3 >/dev/null \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /m
