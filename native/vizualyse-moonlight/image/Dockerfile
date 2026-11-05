# Builds moonlight-core against the unit's own libraries: Ubuntu 18.04 has
# glibc 2.27 and OpenSSL 1.1 (libcrypto.so.1.1), as the unit (MGU I_21w12).
# libopus is linked in statically: the unit has none. gcc 8: nanors (the
# video FEC) needs its GFNI intrinsics, which gcc 7 lacks. The same base image,
# pinned to its amd64 manifest, as native/hook111/image.
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc-8 libc6-dev libssl-dev libopus-dev make >/dev/null \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /m
