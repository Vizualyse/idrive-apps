# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# iris-bench's build image (bench only, nothing here goes to the car):
# Mesa 19.3.5, the last iris without the context-isolation check (20.0 added
# it), built on glibc 2.27 like the unit, with iris_no_isolation.py:
#   /out/lib/libEGL.so.1, libgbm.so.1, libglapi.so.0, libGLESv2.so.2  its own
#       EGL / GBM / GLES set (drm, wayland, surfaceless platforms)
#   /out/lib/dri/iris_dri.so      iris (and swrast_dri.so: softpipe, which
#                                 the Nine state tracker insists on)
#   /out/lib/d3d/d3dadapter9.so.1 Gallium Nine's native side
#   /out/bench/kernel414.so       tools/vk-trial's stand-in for the unit's
#                                 4.14 kernel (no context isolation)
#   /out/bench/ninetest           Nine's adapter made on the render node
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
ENV LC_ALL=C.UTF-8
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      ca-certificates curl xz-utils pkg-config gcc g++ make python3 python3-mako python3-pip python3-setuptools \
      ninja-build flex bison gettext libexpat1-dev zlib1g-dev libdrm-dev \
      libwayland-dev libwayland-bin libwayland-egl-backend-dev wayland-protocols >/dev/null \
 && pip3 -q install meson==0.61.5 \
 && rm -rf /var/lib/apt/lists/*
# sha256 from Mesa's release notes (docs.mesa3d.org/relnotes/19.3.5.html)
RUN mkdir -p /src && cd /src \
 && curl -fsSLO --retry 8 --retry-delay 10 https://archive.mesa3d.org/older-versions/19.x/mesa-19.3.5.tar.xz \
 && echo "009895b055b971c82d7a0cd57227d414d323282605946e94e9b308a9cb49c6b6  mesa-19.3.5.tar.xz" | sha256sum -c - \
 && tar xJf mesa-19.3.5.tar.xz && rm mesa-19.3.5.tar.xz && mv mesa-19.3.5 mesa
COPY iris_no_isolation.py /src/
RUN python3 /src/iris_no_isolation.py /src/mesa
# iris (+ softpipe for Nine), EGL / GBM / GLES / desktop GL through EGL
# (shared glapi, no GLX: the unit has no X11), Gallium Nine. No LLVM.
RUN cd /src/mesa \
 && /usr/local/bin/meson b --buildtype=release --prefix=/opt/iris --libdir=lib \
      -Dplatforms=drm,wayland,surfaceless -Ddri-drivers= -Dgallium-drivers=iris,swrast -Dvulkan-drivers= \
      -Dglx=disabled -Degl=true -Dgbm=true -Dgles1=false -Dgles2=true -Dopengl=true -Dshared-glapi=true \
      -Dgallium-nine=true -Dgallium-xa=false -Dgallium-va=false -Dgallium-vdpau=false -Dgallium-xvmc=false \
      -Dgallium-omx=disabled -Dllvm=false -Dvalgrind=false -Dlibunwind=false -Dbuild-tests=false \
      -Ddri-drivers-path=/opt/iris/lib/dri -Dd3d-drivers-path=/opt/iris/lib/d3d >/tmp/m.log 2>&1 \
 || { tail -40 /tmp/m.log; exit 1; }; cd /src/mesa \
 && { ninja -C b src/util/xmlpool/options.h >/tmp/n.log 2>&1 || true; } \
 && { ninja -C b install >/tmp/n.log 2>&1 || { grep -B2 -A12 "FAILED\|error:" /tmp/n.log | head -60; exit 1; }; } \
 && mkdir -p /out/lib/dri /out/lib/d3d /out/bench /out/include \
 && cp -L /opt/iris/lib/libEGL.so.1 /opt/iris/lib/libgbm.so.1 /opt/iris/lib/libglapi.so.0 /opt/iris/lib/libGLESv2.so.2 /out/lib/ \
 && cp -L /opt/iris/lib/dri/iris_dri.so /opt/iris/lib/dri/swrast_dri.so /out/lib/dri/ \
 && cp -L /opt/iris/lib/d3d/d3dadapter9.so.1 /out/lib/d3d/ \
 && cp -r /opt/iris/include/d3dadapter /out/include/ \
 && strip --strip-unneeded /out/lib/*.so* /out/lib/dri/*.so /out/lib/d3d/*.so* \
 && cp docs/license.html /out/mesa-license.html \
 && rm -rf b
COPY kernel414.c ninetest.c /src/bench/
RUN gcc -O2 -Wall -Wextra -Werror -shared -fPIC -o /out/bench/kernel414.so /src/bench/kernel414.c -ldl \
 && gcc -O2 -Wall -Wextra -I/opt/iris/include -I/src/mesa/include -I/src/mesa/include/D3D9 -o /out/bench/ninetest /src/bench/ninetest.c -ldl \
      -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
