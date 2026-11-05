// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
#define _GNU_SOURCE
#include "frame_out.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define HEADER 64

static uint32_t word(const uint8_t *m, int i) {
    return (uint32_t)m[i * 4] | (uint32_t)m[i * 4 + 1] << 8 | (uint32_t)m[i * 4 + 2] << 16 | (uint32_t)m[i * 4 + 3] << 24;
}

/* x86-64 is little-endian; the stores are ordered for the renderer's reads. */
static void set_word(uint8_t *m, int i, uint32_t v) {
    __atomic_store_n((uint32_t *)(void *)(m + i * 4), v, __ATOMIC_RELEASE);
}

int frame_out_open(struct frame_out *f, const char *path, char *err, size_t n) {
    memset(f, 0, sizeof(*f));
    int fd = open(path, O_RDWR | O_CLOEXEC);
    if (fd < 0) { snprintf(err, n, "%s: %s", path, strerror(errno)); return -1; }
    struct stat st;
    if (fstat(fd, &st) < 0 || st.st_size < HEADER) { snprintf(err, n, "%s: no header", path); close(fd); return -1; }
    uint8_t *m = mmap(NULL, (size_t)st.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (m == MAP_FAILED) { snprintf(err, n, "%s: mmap: %s", path, strerror(errno)); return -1; }
    int w = (int)word(m, 2), h = (int)word(m, 3), ns = (int)word(m, 6);
    if (word(m, 0) != FRAME_MAGIC || w < 16 || h < 16 || w > 2048 || h > 2048 || (w | h) & 1 || ns < 1 || ns > 4 ||
        (size_t)st.st_size < HEADER + (size_t)ns * w * h * 3 / 2) {
        snprintf(err, n, "%s: not a frame file (%dx%d, %d slots, %ld bytes)", path, w, h, ns, (long)st.st_size);
        munmap(m, (size_t)st.st_size);
        return -1;
    }
    f->map = m; f->size = (size_t)st.st_size; f->w = w; f->h = h; f->nslot = ns;
    f->seq = word(m, 4); f->slot = word(m, 5) % (uint32_t)ns;
    return 0;
}

void frame_out_colour(struct frame_out *f, int bt709, int full_range) {
    if (!f->map) return;
    set_word(f->map, 7, bt709 ? 1 : 0);
    set_word(f->map, 8, full_range ? 1 : 0);
}

uint8_t *frame_out_next(struct frame_out *f) {
    uint32_t next = (f->slot + 1) % (uint32_t)f->nslot;
    return f->map + HEADER + (size_t)next * f->w * f->h * 3 / 2;
}

void frame_out_publish(struct frame_out *f) {
    f->slot = (f->slot + 1) % (uint32_t)f->nslot;
    set_word(f->map, 5, f->slot);
    set_word(f->map, 4, ++f->seq);
}

void frame_out_close(struct frame_out *f) {
    if (f->map) munmap(f->map, f->size);
    memset(f, 0, sizeof(*f));
}
