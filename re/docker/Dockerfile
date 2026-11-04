# Off-car reverse-engineering environment: ELF tools, pyelftools, a C
# toolchain (for test fixtures) and Ghidra headless. Nothing here reaches a car.
FROM ubuntu:24.04

ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openjdk-21-jdk-headless binutils file gcc g++ libc6-dev make \
        python3 python3-pyelftools curl ca-certificates unzip tar \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/ghidra.zip "$GHIDRA_URL" \
    && echo "$GHIDRA_SHA256  /tmp/ghidra.zip" | sha256sum -c - \
    && unzip -q /tmp/ghidra.zip -d /opt \
    && mv /opt/ghidra_* /opt/ghidra \
    && rm /tmp/ghidra.zip

ENV GHIDRA_HOME=/opt/ghidra
WORKDIR /re
