# Builds code that runs against the unit's own libraries: Ubuntu 18.04 has
# glibc 2.27 and OpenSSL 1.1, as the unit (MGU I_21w12, glibc 2.27,
# libcrypto.so.1.1). Pinned to the amd64 manifest (as the old cluster-render
# toolchain image was).
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc libc6-dev libssl-dev make >/dev/null \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /h
