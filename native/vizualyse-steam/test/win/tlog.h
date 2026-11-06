// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The test programs' output: each line goes to stdout and, when T_LOG names
 * a file (a Windows path, e.g. Z:\tmp\log\t.log), is appended there too.
 * Proton starts a game through its steam.exe wrapper, whose stdout doesn't
 * reach the bench, so the bench reads T_LOG.
 */
#pragma once
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

static void tlog(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fflush(stdout);
    const char *path = getenv("T_LOG");
    FILE *f = path ? fopen(path, "a") : NULL;
    if (f) {
        va_start(ap, fmt);
        vfprintf(f, fmt, ap);
        va_end(ap);
        fclose(f);
    }
}
