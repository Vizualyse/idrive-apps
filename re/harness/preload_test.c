/*
 * preload_test (re/run.sh harness-preload): libhook111.so loaded as on the car.
 * Run under the unit's loader with LD_PRELOAD="<rootfs>/usr/lib/libschedconfig.so.1
 * libhook111.so". A stub library calls dlopen, as Cinemo's libNmeBaseClasses.so
 * does (dlopen@GLIBC_2.2.5), to load the plugin.
 *
 *   preload_test <stub.so> <plugin.so> on|off|wrong
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <link.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail;
#define CHECK(name, cond) do { int _c = (cond); printf("%s %s\n", _c ? "ok  " : "FAIL", name); if (!_c) fail = 1; } while (0)

static uintptr_t base_of(const char *name) {
    struct { const char *n; uintptr_t b; } q = { name, 0 };
    int cb(struct dl_phdr_info *i, size_t s, void *d) {
        (void)s; typeof(q) *x = d;
        if (i->dlpi_name && strstr(i->dlpi_name, x->n)) { x->b = i->dlpi_addr; return 1; }
        return 0;
    }
    dl_iterate_phdr(cb, &q);
    return q.b;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc < 4) { fprintf(stderr, "usage: %s <stub.so> <plugin.so> on|off|wrong\n", argv[0]); return 2; }
    const char *mode = argv[3];
    int (*st)(void) = (int (*)(void))dlsym(RTLD_DEFAULT, "hook111_preload_state");
    CHECK("libhook111.so preloaded (with the unit's libschedconfig first)", st != NULL && base_of("libschedconfig") != 0);
    if (!st) return 1;
    CHECK("before the plugin loads: nothing done", strcmp(mode, "off") ? st() == 0 : st() == -1);

    void *stub = dlopen(argv[1], RTLD_NOW);
    void *(*load)(const char *) = stub ? (void *(*)(const char *))dlsym(stub, "stub_load") : NULL;
    CHECK("stub loader", load != NULL);
    if (!load) return 1;
    void *z = load("libz.so.1");
    CHECK("another library through the stub's dlopen: loads as before", z != NULL);
    CHECK("... and changes nothing", strcmp(mode, "off") ? st() == 0 : st() == -1);

    void *p = load(argv[2]);
    CHECK("the plugin loads through the stub's dlopen", p != NULL);
    uintptr_t b = base_of("libNmeCarPlay.so");
    const unsigned char *setup = b ? (const unsigned char *)(b + 0x180670 - 0x100000) : NULL;
    if (!strcmp(mode, "on")) {
        CHECK("installed right after that dlopen", st() == 1);
        CHECK("SETUP entry now jumps to the hook (ff 25)", setup && setup[0] == 0xff && setup[1] == 0x25);
    } else if (!strcmp(mode, "off")) {
        CHECK("off: not installed", st() == -1);
        CHECK("off: SETUP entry stock (41 57)", setup && setup[0] == 0x41 && setup[1] == 0x57);
    } else {
        CHECK("another build under that name: refused", st() == -1);
    }
    printf("%s\n", fail ? "FAIL" : "PASS");
    return fail;
}
