# The head unit in a box, for the off-car tests: Ubuntu 18.04 (glibc 2.27,
# libcrypto.so.1.1) with Node 8.16.2, the unit's own versions, so the tool's
# TLS, crypto and moonlight-core run as they would there. No compiler. The
# unit's loader is /lib/ld-linux-x86-64.so.2 and it has no /lib64: so here.
# (The test's own uinput pad is a stock binary: it gets /lib64 back for itself.)
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libssl1.1 ca-certificates curl xz-utils >/dev/null \
 && curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v8.16.2/node-v8.16.2-linux-x64.tar.xz \
 && echo "88617a293f5828cc94ee99c94a43fbea12b989e34fe643fc14885a14748a8da6  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 node-v8.16.2-linux-x64/bin/node \
 && rm /tmp/node.tar.xz && rm -rf /var/lib/apt/lists/* \
 && ln -s /lib/x86_64-linux-gnu/ld-2.27.so /lib/ld-linux-x86-64.so.2  && node -v
WORKDIR /m
