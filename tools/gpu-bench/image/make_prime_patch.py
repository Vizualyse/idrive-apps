# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Adds PRIME export / import to Mesa 22.3.7's drm-shim (src/drm-shim/device.c),
in the image (Dockerfile): python3 make_prime_patch.py <device.c>

Mesa's Wayland EGL hands each frame to the compositor as a PRIME (dmabuf) fd
(wl_drm.create_prime_buffer). The shim answered neither DRM_IOCTL_PRIME_HANDLE_TO_FD
nor DRM_IOCTL_PRIME_FD_TO_HANDLE ("DRM_SHIM: unhandled core DRM ioctl 0x2D"), so
the fd was -1, libwayland failed to marshal the request and Wine's Wayland
connection died: no GL frame ever reached the compositor on the stub
(2026-11-06).

Export: a memfd of the BO's size stands for the buffer (no pixels: the stub
draws nothing), remembered by inode with a reference on the BO. Import of an
fd this process exported gives the same BO; any other (another process's
export, as the compositor gets it) a new zeroed BO of the fd's size; but, as
the kernel, a second fd of a buffer whose import is still open on the same
DRM fd gets that same handle: the planes of an NV12 dmabuf come as separate
fds of one buffer, i965 finds its BOs by handle and refuses a multi-plane
image whose planes aren't one BO (Winston's NV12 import failed on the stub
with EGL_BAD_ALLOC until this, 2026-11-07). Sharing BOs any further (by inode
across closes) made i965's read-back of a client's buffer crash on the stub
(wl-sink, 2026-11-07), so it goes no further. Written as a Python edit rather
than a diff so the anchors are checked, not fuzzed.
"""
import sys

ANCHOR = "ioctl_fn_t core_ioctls[] = {\n"
ENTRY_ANCHOR = "   [_IOC_NR(DRM_IOCTL_GEM_CLOSE)] = drm_shim_ioctl_gem_close,\n"

CODE = r'''
/* PRIME for the stub (vizualyse gpu-bench): a memfd per exported BO. */
#include <fcntl.h>
#include <sys/stat.h>
#define SHIM_PRIME_MAX 256
/* big enough for any driver's BO struct (struct i915_bo is a few words more) */
#define SHIM_PRIME_BO_ALLOC 256
static struct { ino_t ino; struct shim_bo *bo; } shim_prime[SHIM_PRIME_MAX];
static mtx_t shim_prime_lock = _MTX_INITIALIZER_NP;

static int
drm_shim_ioctl_prime_handle_to_fd(int fd, unsigned long request, void *arg)
{
   struct shim_fd *shim_fd = drm_shim_fd_lookup(fd);
   struct drm_prime_handle *args = arg;
   struct shim_bo *bo = drm_shim_bo_lookup(shim_fd, args->handle);
   if (!bo)
      return -EINVAL;
   int mfd = memfd_create("shim prime", (args->flags & DRM_CLOEXEC) ? MFD_CLOEXEC : 0);
   struct stat st;
   if (mfd < 0 || ftruncate(mfd, bo->size) < 0 || fstat(mfd, &st) < 0) {
      if (mfd >= 0)
         close(mfd);
      drm_shim_bo_put(bo);
      return -ENOMEM;
   }
   mtx_lock(&shim_prime_lock);
   for (int i = 0; i < SHIM_PRIME_MAX; i++) {
      if (!shim_prime[i].bo) {
         shim_prime[i].ino = st.st_ino;
         shim_prime[i].bo = bo;   /* keeps the lookup's reference */
         bo = NULL;
         break;
      }
   }
   mtx_unlock(&shim_prime_lock);
   if (bo)
      drm_shim_bo_put(bo);
   args->fd = mfd;
   return 0;
}

/* Another process's buffers imported here and still open: an fd of one of
 * them on the same DRM fd gets the same handle (the kernel's rule; the planes
 * of an NV12 dmabuf come as separate fds of one buffer). */
static struct { ino_t ino; struct shim_fd *shim_fd; struct shim_bo *bo; int handle; } shim_imported[SHIM_PRIME_MAX];

static int
shim_handle_open(struct shim_fd *shim_fd, int handle, struct shim_bo *bo)
{
   mtx_lock(&shim_fd->handle_lock);
   struct hash_entry *e = _mesa_hash_table_search(shim_fd->handles, (void *)(uintptr_t)handle);
   int open = e && e->data == bo;
   mtx_unlock(&shim_fd->handle_lock);
   return open;
}

static int
drm_shim_ioctl_prime_fd_to_handle(int fd, unsigned long request, void *arg)
{
   struct shim_fd *shim_fd = drm_shim_fd_lookup(fd);
   struct drm_prime_handle *args = arg;
   struct stat st;
   if (fstat(args->fd, &st) < 0)
      return -EBADF;
   struct shim_bo *bo = NULL;
   mtx_lock(&shim_prime_lock);
   for (int i = 0; i < SHIM_PRIME_MAX; i++) {
      if (shim_prime[i].bo && shim_prime[i].ino == st.st_ino) {
         bo = shim_prime[i].bo;
         break;
      }
   }
   if (bo) {
      mtx_unlock(&shim_prime_lock);
      args->handle = drm_shim_bo_get_handle(shim_fd, bo);
      return 0;
   }
   int slot = -1;
   for (int i = 0; i < SHIM_PRIME_MAX; i++) {
      if (shim_imported[i].bo && shim_imported[i].ino == st.st_ino && shim_imported[i].shim_fd == shim_fd) {
         if (shim_handle_open(shim_fd, shim_imported[i].handle, shim_imported[i].bo)) {
            args->handle = shim_imported[i].handle;
            mtx_unlock(&shim_prime_lock);
            return 0;
         }
         slot = i;   /* closed since: a new BO in its place */
         break;
      }
      if (slot < 0 && !shim_imported[i].bo)
         slot = i;
   }
   /* a new zeroed BO of the fd's size */
   size_t size = st.st_size > 0 ? (size_t)st.st_size : 4096;
   bo = calloc(1, SHIM_PRIME_BO_ALLOC);
   if (!bo || drm_shim_bo_init(bo, size) < 0) {
      free(bo);
      mtx_unlock(&shim_prime_lock);
      return -ENOMEM;
   }
   args->handle = drm_shim_bo_get_handle(shim_fd, bo);
   if (slot < 0)
      slot = (int)(st.st_ino % SHIM_PRIME_MAX);   /* full: forget an old one */
   shim_imported[slot].ino = st.st_ino;
   shim_imported[slot].shim_fd = shim_fd;
   shim_imported[slot].bo = bo;
   shim_imported[slot].handle = args->handle;
   mtx_unlock(&shim_prime_lock);
   return 0;
}

'''

ENTRIES = (
    "   [_IOC_NR(DRM_IOCTL_PRIME_HANDLE_TO_FD)] = drm_shim_ioctl_prime_handle_to_fd,\n"
    "   [_IOC_NR(DRM_IOCTL_PRIME_FD_TO_HANDLE)] = drm_shim_ioctl_prime_fd_to_handle,\n"
)

def main(path):
    src = open(path).read()
    for a in (ANCHOR, ENTRY_ANCHOR):
        if src.count(a) != 1:
            sys.exit("make_prime_patch: anchor not found once in %s: %r" % (path, a))
    if "drm_shim_ioctl_prime_handle_to_fd" in src:
        sys.exit("make_prime_patch: already applied")
    src = src.replace(ANCHOR, CODE + ANCHOR).replace(ENTRY_ANCHOR, ENTRY_ANCHOR + ENTRIES)
    open(path, "w").write(src)
    print("make_prime_patch: PRIME export / import added to " + path)


if __name__ == "__main__":
    main(sys.argv[1])
