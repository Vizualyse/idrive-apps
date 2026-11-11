// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// slowdrm.so: bench only (test/crumbs_watch_test.sh). Preloaded after
// vk_crumbs.so, it stands in for the kernel: every DRM ioctl returns 0 at
// once, but a GEM_WAIT on handle SLOW_HANDLE stays away for SLOW_MS, as a
// call does that a GPU hang holds.

#define _GNU_SOURCE
#include <stdarg.h>
#include <sys/ioctl.h>
#include <time.h>
#include <libdrm/drm.h>
#include <libdrm/i915_drm.h>

#define SLOW_HANDLE 77
#define SLOW_MS 2500

int ioctl(int fd, unsigned long req, ...) {
    (void)fd;
    va_list ap;
    va_start(ap, req);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    if (_IOC_TYPE(req) != DRM_IOCTL_BASE) return -1;   /* the test makes no other */
    if (_IOC_NR(req) == DRM_COMMAND_BASE + DRM_I915_GEM_WAIT && arg && ((struct drm_i915_gem_wait *)arg)->bo_handle == SLOW_HANDLE) {
        struct timespec ts = { SLOW_MS / 1000, (SLOW_MS % 1000) * 1000000L };
        nanosleep(&ts, NULL);
    }
    return 0;
}
