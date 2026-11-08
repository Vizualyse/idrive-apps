# Builds Mosquitto for the unit: Ubuntu 18.04 has glibc 2.27, as the unit
# (MGU I_21w12). The same pinned amd64 base as hook111's image.
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc libc6-dev make binutils >/dev/null \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /b
