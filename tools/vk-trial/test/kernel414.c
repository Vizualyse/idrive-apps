// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// kernel414.so: bench only, never on the car. Preloaded between vk_crumbs.so
// and gpu-bench's no-op shim, it answers like the unit's kernel (Intel's
// IOTG 4.14, intel/linux-intel-lts 4.14/base include/uapi/drm/i915_drm.h)
// where the shim (written for Mesa 22.3 and newer kernels) would say yes:
//
// - GETPARAM: params after I915_PARAM_HAS_EXEC_FENCE_ARRAY (49) don't exist
//   (no HAS_CONTEXT_ISOLATION, 50): EINVAL.
// - SYNCOBJ_WAIT on an unsignalled syncobj: ETIME, and MMAP_VERSION 1, as
//   the car answered (2026-11-07); syncobjs tracked below.
// - CONTEXT_GET/SETPARAM: params after PRIORITY (6; IOTG has it, mainline
//   4.14 doesn't): EINVAL here, and a HAZARD. IOTG's header stops at 6, but
//   the car's kernel answered GETPARAM 0x7 (SSEU upstream) with 0, and
//   closing that render node then waited on i915's mutex until the unit
//   restarted (ANV 22.3.7, 2026-11-09): the car has params of its own there.
// - CONTEXT_CREATE with flags (CREATE_EXT: params as extensions, 4.19+):
//   the same field is `pad` on 4.14; a HAZARD for the same reason.
// - i915 ioctl 0x39 is QUERY on newer kernels but GEM_GVTBUFFER on the
//   unit's: a program that asks it is told EINVAL here and named on stderr
//   ("kernel414: HAZARD"), because on the car the same number reaches a
//   different handler with a different struct.
// - i915 ioctls after 0x38 otherwise, and core ioctls after SYNCOBJ_SIGNAL
//   (0xc5: the timeline and later ones): ENOTTY / EINVAL as 4.14.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <libdrm/drm.h>
#include <libdrm/i915_drm.h>

#define LAST_PARAM 49
#define LAST_CTX_PARAM 6

/* Syncobjs as the car's kernel answers them (seen 2026-11-07: a wait on a
 * fresh one says ETIME, so ANV turns on syncobj fences and reports Vulkan
 * 1.1; the shim said 0 and ANV stayed on 1.0, another code path). The stub
 * GPU finishes everything at once, so a syncobj is signalled once an
 * execbuffer's fence array signals it, or by SIGNAL, or created signalled;
 * RESET clears it; a wait on one that isn't is ETIME at once. */
#define MAX_SYNC 4096
static unsigned char signalled[MAX_SYNC];
static void set_sync(uint32_t h, int v) { if (h < MAX_SYNC) signalled[h] = (unsigned char)v; }

int ioctl(int fd, unsigned long req, ...) {
    static int (*real)(int, unsigned long, ...);
    if (!real) real = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
    va_list ap;
    va_start(ap, req);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    if (_IOC_TYPE(req) != DRM_IOCTL_BASE) return real(fd, req, arg);
    unsigned nr = _IOC_NR(req);
    switch (nr) {
    case 0xbf: {   /* SYNCOBJ_CREATE */
        int r = real(fd, req, arg);
        struct drm_syncobj_create *c = arg;
        if (r == 0) set_sync(c->handle, !!(c->flags & DRM_SYNCOBJ_CREATE_SIGNALED));
        return r;
    }
    case 0xc3: {   /* SYNCOBJ_WAIT */
        struct drm_syncobj_wait *w = arg;
        const uint32_t *h = (const uint32_t *)(uintptr_t)w->handles;
        int all = !!(w->flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL), any = 0, every = 1;
        for (uint32_t i = 0; i < w->count_handles; i++) {
            int s = h[i] < MAX_SYNC && signalled[h[i]];
            if (s && !any) { any = 1; w->first_signaled = i; }
            every &= s;
        }
        if (all ? every : any) return 0;
        errno = ETIME;
        return -1;
    }
    case 0xc4:     /* SYNCOBJ_RESET */
    case 0xc5: {   /* SYNCOBJ_SIGNAL */
        struct drm_syncobj_array *a = arg;
        const uint32_t *h = (const uint32_t *)(uintptr_t)a->handles;
        for (uint32_t i = 0; i < a->count_handles; i++) set_sync(h[i], nr == 0xc5);
        return 0;
    }
    case DRM_COMMAND_BASE + DRM_I915_GEM_EXECBUFFER2: {
        int r = real(fd, req, arg);
        struct drm_i915_gem_execbuffer2 *e = arg;
        if (r == 0 && (e->flags & I915_EXEC_FENCE_ARRAY)) {
            const struct drm_i915_gem_exec_fence *f = (const void *)(uintptr_t)e->cliprects_ptr;
            for (uint32_t i = 0; i < e->num_cliprects; i++)
                if (f[i].flags & I915_EXEC_FENCE_SIGNAL) set_sync(f[i].handle, 1);
        }
        return r;
    }
    case DRM_COMMAND_BASE + DRM_I915_GETPARAM: {
        drm_i915_getparam_t *g = arg;
        if (g->param == I915_PARAM_MMAP_VERSION) { *g->value = 1; return 0; }   /* the car's answer */
        break;
    }
    }
    if (nr == DRM_COMMAND_BASE + DRM_I915_GETPARAM && ((drm_i915_getparam_t *)arg)->param > LAST_PARAM) {
        errno = EINVAL;
        return -1;
    }
    if ((nr == DRM_COMMAND_BASE + DRM_I915_GEM_CONTEXT_GETPARAM || nr == DRM_COMMAND_BASE + DRM_I915_GEM_CONTEXT_SETPARAM)
        && ((struct drm_i915_gem_context_param *)arg)->param > LAST_CTX_PARAM) {
        fprintf(stderr, "kernel414: HAZARD: context %sPARAM 0x%llx (none after 0x%x on IOTG 4.14; the car's kernel answered 0x7 and then hung)\n",
                nr == DRM_COMMAND_BASE + DRM_I915_GEM_CONTEXT_GETPARAM ? "GET" : "SET",
                (unsigned long long)((struct drm_i915_gem_context_param *)arg)->param, LAST_CTX_PARAM);
        errno = EINVAL;
        return -1;
    }
    if (nr == DRM_COMMAND_BASE + DRM_I915_GEM_CONTEXT_CREATE && _IOC_SIZE(req) >= sizeof(struct drm_i915_gem_context_create_ext)
        && ((struct drm_i915_gem_context_create_ext *)arg)->flags) {
        fprintf(stderr, "kernel414: HAZARD: CONTEXT_CREATE with flags 0x%x (pad on 4.14: context params as extensions)\n",
                ((struct drm_i915_gem_context_create_ext *)arg)->flags);
        errno = EINVAL;
        return -1;
    }
    if (nr == DRM_COMMAND_BASE + 0x39) {
        fprintf(stderr, "kernel414: HAZARD: i915 ioctl 0x39 (QUERY here, GEM_GVTBUFFER on the unit's kernel)\n");
        errno = EINVAL;
        return -1;
    }
    if (nr > DRM_COMMAND_BASE + 0x38 && nr < DRM_COMMAND_END) { errno = EINVAL; return -1; }
    if (nr > 0xc5) { errno = ENOTTY; return -1; }   /* leases and later: 4.15+ */
    return real(fd, req, arg);
}
