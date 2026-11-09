# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Mesa 19.3.5's iris on a kernel without context isolation (the unit's
IOTG 4.14): keep 3DSTATE_CONSTANT_* buffer 0 relative, as the unit's own
i965 19.0.6 does there, instead of setting CS_DEBUG_MODE2's CONSTANT_BUFFER
Address Offset Disable.

Without isolation (I915_PARAM_HAS_CONTEXT_ISOLATION, Linux 4.16) that
register isn't the context's own: iris setting it would flip it under the
HMI's i965 contexts, whose buffer 0 is relative on this kernel (i965's
brw_state_upload.c: "only safe on kernels with context isolation
support"). Mesa 20.0 made iris refuse such kernels instead.

With compiler->constant_buffer_0_is_relative the compiler pushes at most 3
UBO ranges (brw_nir_analyze_ubo_ranges), which iris puts in buffers 3..1
(iris_state.c fills from 3 down): buffer 0 is never used, so the bit is
never needed. Only when the GETPARAM fails or says 0; a kernel with
isolation gets stock iris.

    python3 iris_no_isolation.py <mesa source tree>
"""
import sys

root = sys.argv[1]


def patch(rel, old, new):
    p = root + '/' + rel
    s = open(p).read()
    if s.count(old) != 1:
        sys.exit('iris_no_isolation: %s: the text to replace is there %d times' % (rel, s.count(old)))
    open(p, 'w').write(s.replace(old, new))


patch('src/gallium/drivers/iris/iris_screen.c',
      '   screen->compiler->supports_shader_constants = true;\n',
      '   screen->compiler->supports_shader_constants = true;\n'
      '   /* no I915_PARAM_HAS_CONTEXT_ISOLATION (kernels before 4.16): buffer 0\n'
      '    * relative, CS_DEBUG_MODE2 left alone (tools/iris-bench) */\n'
      '   screen->compiler->constant_buffer_0_is_relative =\n'
      '      iris_getparam_integer(screen, I915_PARAM_HAS_CONTEXT_ISOLATION) <= 0;\n'
      '   if (screen->compiler->constant_buffer_0_is_relative)\n'
      '      fprintf(stderr, "iris: no context isolation in the kernel: "\n'
      '              "constant buffer 0 relative, CS_DEBUG_MODE2 not written\\n");\n')

patch('src/gallium/drivers/iris/iris_state.c',
      '#if GEN_GEN >= 9\n'
      '   iris_pack_state(GENX(CS_DEBUG_MODE2), &reg_val, reg) {\n'
      '      reg.CONSTANT_BUFFERAddressOffsetDisable = true;\n'
      '      reg.CONSTANT_BUFFERAddressOffsetDisableMask = true;\n'
      '   }\n'
      '   iris_emit_lri(batch, CS_DEBUG_MODE2, reg_val);\n',
      '#if GEN_GEN >= 9\n'
      '   if (!batch->screen->compiler->constant_buffer_0_is_relative) {\n'
      '      iris_pack_state(GENX(CS_DEBUG_MODE2), &reg_val, reg) {\n'
      '         reg.CONSTANT_BUFFERAddressOffsetDisable = true;\n'
      '         reg.CONSTANT_BUFFERAddressOffsetDisableMask = true;\n'
      '      }\n'
      '      iris_emit_lri(batch, CS_DEBUG_MODE2, reg_val);\n'
      '   }\n')
# CS_CHICKEN1 (object-level preemption): neither the unit's i965 nor ANV
# 19.0.6 ever write it; whether it is the context's own on the unit's
# kernel isn't known, so without isolation iris leaves it as they do.
patch('src/gallium/drivers/iris/iris_state.c',
      'iris_enable_obj_preemption(struct iris_batch *batch, bool enable)\n'
      '{\n'
      '   uint32_t reg_val;\n',
      'iris_enable_obj_preemption(struct iris_batch *batch, bool enable)\n'
      '{\n'
      '   uint32_t reg_val;\n'
      '\n'
      '   /* no context isolation: CS_CHICKEN1 left as i965 leaves it (tools/iris-bench) */\n'
      '   if (batch->screen->compiler->constant_buffer_0_is_relative)\n'
      '      return;\n')

# The topology query (DRM_IOCTL_I915_QUERY, i915 ioctl 0x39, Linux 4.17) is
# GEM_GVTBUFFER on the unit's IOTG 4.14: the same number reaches another
# handler with another struct (tools/vk-trial's kernel414 calls it a
# HAZARD). A kernel without context isolation (before 4.16) has no QUERY:
# then only the 4.13+ getparams, which Gen9 falls back to anyway.
patch('src/intel/dev/gen_device_info.c',
      '   if (!query_topology(devinfo, fd)) {\n',
      '   int isolation = 0;   /* a kernel before 4.16: no I915_QUERY (tools/iris-bench) */\n'
      '   if (!getparam(fd, I915_PARAM_HAS_CONTEXT_ISOLATION, &isolation) || !query_topology(devinfo, fd)) {\n')
# ...and the perf queries' (gen_perf: i915-perf config through QUERY)
patch('src/intel/perf/gen_perf.c',
      '   struct drm_i915_query q = {\n'
      '      .num_items = n_items,\n'
      '      .items_ptr = to_user_pointer(items),\n'
      '   };\n'
      '   return gen_ioctl(fd, DRM_IOCTL_I915_QUERY, &q);\n',
      '   struct drm_i915_query q = {\n'
      '      .num_items = n_items,\n'
      '      .items_ptr = to_user_pointer(items),\n'
      '   };\n'
      '   /* a kernel before 4.16: no I915_QUERY, 0x39 is another ioctl there (tools/iris-bench) */\n'
      '   int isolation = 0;\n'
      '   struct drm_i915_getparam gp = { .param = I915_PARAM_HAS_CONTEXT_ISOLATION, .value = &isolation };\n'
      '   if (gen_ioctl(fd, DRM_IOCTL_I915_GETPARAM, &gp)) {\n'
      '      errno = EINVAL;\n'
      '      return -1;\n'
      '   }\n'
      '   return gen_ioctl(fd, DRM_IOCTL_I915_QUERY, &q);\n')
# Context params after PRIORITY (6): the unit's kernel has its own there.
# On the car (2026-11-09) ANV 22.3.7's GETPARAM 0x7 (SSEU upstream) was
# answered 0, and closing the render node then waited on i915's mutex until
# the unit restarted (tools/vk-trial's mesa-ctx-params-max-6.patch).
# iris sets RECOVERABLE (0x8) on every context it makes, through libdrm's
# drmIoctl: not sent at all. A 4.14 kernel without it recovers the context
# itself after a hang, as it does for the unit's i965.
patch('src/gallium/drivers/iris/iris_bufmgr.c',
      '   drmIoctl(bufmgr->fd, DRM_IOCTL_I915_GEM_CONTEXT_SETPARAM, &p);\n'
      '\n'
      '   return create.ctx_id;\n',
      '   /* not on the unit\'s 4.14: context params after 6 are its own (tools/iris-bench) */\n'
      '   if (p.param <= I915_CONTEXT_PARAM_PRIORITY)\n'
      '      drmIoctl(bufmgr->fd, DRM_IOCTL_I915_GEM_CONTEXT_SETPARAM, &p);\n'
      '\n'
      '   return create.ctx_id;\n')
# ...and any other context param or CONTEXT_CREATE extension through
# gen_ioctl, as tools/vk-trial does for ANV's intel_ioctl
patch('src/intel/common/gen_gem.h',
      '#include <sys/ioctl.h>\n',
      '#include <sys/ioctl.h>\n'
      '#include "drm-uapi/i915_drm.h"\n')
patch('src/intel/common/gen_gem.h',
      '    int ret;\n'
      '\n'
      '    do {\n'
      '        ret = ioctl(fd, request, arg);\n',
      '    int ret;\n'
      '\n'
      '    /* the unit\'s 4.14: no context params after PRIORITY (6) (tools/iris-bench) */\n'
      '    if ((request == DRM_IOCTL_I915_GEM_CONTEXT_GETPARAM ||\n'
      '         request == DRM_IOCTL_I915_GEM_CONTEXT_SETPARAM) &&\n'
      '        ((struct drm_i915_gem_context_param *)arg)->param > I915_CONTEXT_PARAM_PRIORITY) {\n'
      '        errno = EINVAL;\n'
      '        return -1;\n'
      '    }\n'
      '\n'
      '    do {\n'
      '        ret = ioctl(fd, request, arg);\n')
print('iris_no_isolation: patched')
