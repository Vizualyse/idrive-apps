// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// crumbs_watch: bench only (test/crumbs_watch_test.sh). A game's DRM calls
// without a game: N frames of a submit and a wait, then a wait that the
// stand-in kernel (slowdrm.so) keeps for 2.5 s, then the same in a forked
// child (Wine starts its processes by fork). Prints how long each took.
//   crumbs_watch FRAMES

#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <libdrm/drm.h>
#include <libdrm/i915_drm.h>

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static void slow(int fd, const char *who) {
    struct drm_i915_gem_wait w;
    memset(&w, 0, sizeof w);
    w.bo_handle = 77;   /* slowdrm.so's */
    long t = now_ms();
    ioctl(fd, DRM_IOCTL_I915_GEM_WAIT, &w);
    printf("%s: the kept call came back after %ld ms\n", who, now_ms() - t);
    fflush(stdout);
}

int main(int argc, char **argv) {
    int frames = argc > 1 ? atoi(argv[1]) : 1000;
    int fd = open("/dev/null", O_RDWR);
    struct drm_i915_gem_execbuffer2 eb;
    struct drm_i915_gem_wait w;
    memset(&eb, 0, sizeof eb);
    memset(&w, 0, sizeof w);
    w.bo_handle = 1;
    long t = now_ms();
    for (int i = 0; i < frames; i++) {
        ioctl(fd, DRM_IOCTL_I915_GEM_EXECBUFFER2, &eb);
        ioctl(fd, DRM_IOCTL_I915_GEM_WAIT, &w);
    }
    printf("%d frames (%d calls) in %ld ms\n", frames, 2 * frames, now_ms() - t);
    fflush(stdout);
    slow(fd, "parent");
    pid_t p = fork();
    if (p == 0) {
        ioctl(fd, DRM_IOCTL_I915_GEM_EXECBUFFER2, &eb);
        slow(fd, "child");
        _exit(0);
    }
    int st = 0;
    waitpid(p, &st, 0);
    return WIFEXITED(st) && WEXITSTATUS(st) == 0 ? 0 : 1;
}
