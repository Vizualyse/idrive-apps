// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// vk-trial: the gate for one try of a Vulkan driver on the head unit, made so
// that a restart always ends it (README.md).
//
//   vk-trial arm STAGE [--timeout S] [--again]   STAGE: instance | enumerate |
//                                                device | compute
//   vk-trial arm command [--timeout S] [--again] -- PROGRAM [ARG...]
//   vk-trial run          the one start the arming allows
//   vk-trial disarm
//   vk-trial status
//
// The rules it keeps:
// - Only over a working SSH: `arm` and `run` (right after the disarm, before
//   anything else) want port 22 listening and their own SSH session's
//   connection established, so a blank screen still leaves a way in.
// - Arming is by hand and lives only in /run (tmpfs, checked): a restart of
//   the unit forgets it, whatever happened.
// - `run` consumes the arming before anything else: its first syscall on a
//   file is rename() of the arm file (test/gate_test.sh checks it with
//   strace). If that fails, nothing else happens. The gate is static and
//   never loads a GPU library; only the child it starts does.
// - The driver is only reachable during the run: its ICD file is written
//   into /run after the disarm and removed after, and only the child's
//   environment names it. No ICD is ever installed where the system's
//   loader looks; `arm` refuses while one is.
// - A persistent marker (state/trial, fsynced) is written before the child
//   starts and removed when it ended: one found from another boot means the
//   try never ended (the unit restarted). After that `arm` wants --again.
//   In the same boot, a marker whose gate is gone is closed as "died" once
//   its child is gone too; while the child still runs without it (stuck in
//   the kernel) nothing can be armed until a restart.
// - The child gets its own private mount namespace with /dev/null over
//   every display node (/dev/dri/card*, Winston's); the gate checks the
//   system still sees the real ones before letting it go on, and unmounts
//   any that leaked. Then it runs as uid 12990 (no uplink uid: no network),
//   group video (44) for the render node, no core dumps (RLIMIT_CORE 1: the
//   crash handler can restart the unit), with vk_crumbs.so preloaded: every
//   DRM ioctl is written durably before it enters the kernel.
// - A child that stops making progress gets the kernel's blocked tasks
//   dumped (sysrq w) into the log; one that outlives the timeout is killed.
// Never run it from a systemd unit: recmgr restarts the head unit when a
// unit not on its whitelist exits (knowledge/head-unit.md).

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RUN_DIR    "/run/vk-trial"
#define ARM        RUN_DIR "/armed"
#define CONSUMED   RUN_DIR "/consumed"
#define ARM_TMP    RUN_DIR "/armed.tmp"
#define ICD        RUN_DIR "/icd.json"
#define HOME       "/var/opt/vk-trial"
#define LIB        HOME "/lib"
#define STATE      HOME "/state"
#define MARKER     STATE "/trial"
#define LAST       STATE "/last"
#define LOGS       STATE "/log"
#define DRIVER     LIB "/libvulkan_intel.so"
#define CRUMBS_SO  LIB "/vk_crumbs.so"
#define PROBE      HOME "/bin/vkprobe"
#define TMPFS_MAGIC_ 0x01021994
#define CHILD_UID  12990
#define VIDEO_GID  44
#define STALL_S    8
#define MAX_ARGS   32

static const char *STAGES[] = { "instance", "enumerate", "device", "compute", "command", NULL };

/* where the system's Vulkan loader looks for ICDs and implicit layers */
static const char *LOADER_DIRS[] = {
    "/etc/vulkan/icd.d", "/usr/share/vulkan/icd.d", "/usr/local/share/vulkan/icd.d",
    "/usr/local/etc/vulkan/icd.d", "/etc/vulkan/implicit_layer.d",
    "/usr/share/vulkan/implicit_layer.d", "/usr/local/share/vulkan/implicit_layer.d",
    "/root/.local/share/vulkan/icd.d", NULL };

static int gate_log = -1;   /* the run's gate.log, durable */
static int ssh_check(char *info, size_t cap);

static void say(const char *fmt, ...) {
    char b[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(b, sizeof b - 1, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n > (int)sizeof b - 2) n = sizeof b - 2;
    b[n++] = '\n';
    if (write(1, b, n) < 0) { /* the SSH session may be gone */ }
    if (gate_log >= 0) {
        char t[40];
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        int m = snprintf(t, sizeof t, "%ld.%03ld ", (long)ts.tv_sec, ts.tv_nsec / 1000000);
        if (write(gate_log, t, m) < 0 || write(gate_log, b, n) < 0) { /* best effort */ }
    }
}

static void die(int code, const char *fmt, ...) {
    char b[900];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    say("vk-trial: %s", b);
    exit(code);
}

static int fsync_path(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    int r = fsync(fd);
    close(fd);
    return r;
}

/* write a whole file durably: tmp, fsync, rename, fsync the directory */
static int write_durable(const char *path, const char *text, mode_t mode) {
    char tmp[512], dir[512];
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
    if (fd < 0) return -1;
    size_t len = strlen(text);
    if (write(fd, text, len) != (ssize_t)len || fsync(fd) < 0) { close(fd); unlink(tmp); return -1; }
    close(fd);
    if (rename(tmp, path) < 0) { unlink(tmp); return -1; }
    snprintf(dir, sizeof dir, "%s", path);
    char *s = strrchr(dir, '/');
    if (s) { *s = 0; fsync_path(dir); }
    return 0;
}

static int read_file(const char *path, char *buf, size_t cap) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, cap - 1);
    close(fd);
    if (n < 0) return -1;
    buf[n] = 0;
    return (int)n;
}

static void boot_id(char out[40]) {
    if (read_file("/proc/sys/kernel/random/boot_id", out, 40) < 0) strcpy(out, "unknown");
    out[strcspn(out, "\n")] = 0;
}

/* "key=value" on its own line */
static int field(const char *text, const char *key, char *out, size_t cap) {
    size_t kl = strlen(key);
    for (const char *p = text; p && *p; p = strchr(p, '\n') ? strchr(p, '\n') + 1 : NULL) {
        if (!strncmp(p, key, kl) && p[kl] == '=') {
            const char *v = p + kl + 1;
            size_t n = strcspn(v, "\n");
            if (n >= cap) n = cap - 1;
            memcpy(out, v, n);
            out[n] = 0;
            return 0;
        }
    }
    return -1;
}

static int stage_index(const char *s) {
    for (int i = 0; STAGES[i]; i++) if (!strcmp(s, STAGES[i])) return i;
    return -1;
}

static void mkdirs(void) {
    mkdir(HOME, 0755);
    mkdir(STATE, 0700);
    mkdir(LOGS, 0700);
}

/* pid is a running gate (its name) / a running child of ours (uid 12990):
 * a pid reused by something else doesn't count */
static int gate_alive(int pid) {
    char p[64], c[32];
    snprintf(p, sizeof p, "/proc/%d/comm", pid);
    if (pid <= 0 || read_file(p, c, sizeof c) < 0) return 0;
    c[strcspn(c, "\n")] = 0;
    return !strcmp(c, "vk-trial");
}
static int child_alive(int pid) {
    char p[64], s[2048], uid[64] = "";
    snprintf(p, sizeof p, "/proc/%d/status", pid);
    if (pid <= 0 || read_file(p, s, sizeof s) < 0) return 0;
    char *u = strstr(s, "\nUid:");
    if (!u) return 0;
    sscanf(u + 5, "%63s", uid);
    return atoi(uid) == CHILD_UID;
}

static void close_try(const char *dir, const char *res) {
    char p[400];
    if (dir[0]) {
        snprintf(p, sizeof p, "%s/result", dir);
        write_durable(p, res, 0600);
        write_durable(LAST, dir, 0600);
    }
    unlink(MARKER);
    fsync_path(STATE);
}

/* The marker of a try that isn't running any more becomes its result:
 * - from another boot: it never ended, the unit restarted ("hung");
 * - from this boot, its gate and child both gone: the gate was killed or
 *   died, or the unit's software restarted without a reboot ("died").
 * Returns 1 while it must stay: its gate still runs (a try going on), or
 * its child still does without it (stuck in the kernel: only a restart
 * ends that). */
static int settle_marker(void) {
    char m[1024], b[40], mb[40] = "", dir[256] = "", pid[16] = "0", cpid[16] = "0";
    if (read_file(MARKER, m, sizeof m) < 0) return 0;
    boot_id(b);
    field(m, "boot", mb, sizeof mb);
    field(m, "log", dir, sizeof dir);
    field(m, "pid", pid, sizeof pid);
    field(m, "child", cpid, sizeof cpid);
    char res[1400];
    if (strcmp(mb, b)) {
        snprintf(res, sizeof res, "result=hung\nwhy=the try never ended: the unit restarted during it (boot %s)\n%s", mb, m);
        close_try(dir, res);
        say("vk-trial: the last try (%s) never ended: the unit restarted during it. Its log: %s", mb, dir[0] ? dir : "?");
        return 0;
    }
    if (gate_alive(atoi(pid))) return 1;
    if (child_alive(atoi(cpid))) {
        say("vk-trial: the last try's child (pid %s) still runs without its gate: probably stuck in the kernel. Restart the unit", cpid);
        return 1;
    }
    snprintf(res, sizeof res, "result=died\nwhy=its gate (pid %s) and child (pid %s) are gone without an end: killed, or the software restarted without a reboot\n%s",
             pid, cpid, m);
    unlink(ICD);   /* a killed gate couldn't (seen on the car, 2026-11-07) */
    close_try(dir, res);
    say("vk-trial: the last try's gate ended without finishing it (killed?); closed as died. Its log: %s", dir[0] ? dir : "?");
    return 0;
}

static int last_result(char *res, size_t cap, char *dir, size_t dcap) {
    if (read_file(LAST, dir, dcap) < 0) return -1;
    dir[strcspn(dir, "\n")] = 0;
    char p[400];
    snprintf(p, sizeof p, "%s/result", dir);
    return read_file(p, res, cap);
}

/* ICDs or implicit layers where every Vulkan program on the unit would find
 * them: none may exist while we arm */
static int system_icds(int print) {
    int found = 0;
    for (int i = 0; LOADER_DIRS[i]; i++) {
        DIR *d = opendir(LOADER_DIRS[i]);
        if (!d) continue;
        struct dirent *e;
        while ((e = readdir(d))) {
            if (e->d_name[0] == '.') continue;
            if (print) say("  %s/%s", LOADER_DIRS[i], e->d_name);
            found++;
        }
        closedir(d);
    }
    return found;
}

/* ---- arm ------------------------------------------------------------------ */

static int cmd_arm(int argc, char **argv) {
    if (argc < 3) die(2, "arm what? one of instance, enumerate, device, compute, command");
    int st = stage_index(argv[2]);
    if (st < 0) die(2, "unknown stage '%s'", argv[2]);
    int timeout = 30, again = 0, i = 3;
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "--timeout") && i + 1 < argc) timeout = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--again")) again = 1;
        else if (!strcmp(argv[i], "--")) { i++; break; }
        else die(2, "unknown option '%s'", argv[i]);
    }
    if (timeout < 5 || timeout > 600) die(2, "--timeout between 5 and 600 seconds");
    int is_cmd = !strcmp(STAGES[st], "command");
    if (is_cmd && i >= argc) die(2, "arm command -- PROGRAM [ARG...]");
    if (!is_cmd && i < argc) die(2, "a program only with the stage 'command'");
    if (is_cmd && argc - i > MAX_ARGS) die(2, "at most %d arguments", MAX_ARGS);
    if (geteuid() != 0) die(2, "arm as root");

    mkdirs();
    if (settle_marker()) die(4, "a try is still going on in this boot (%s): not armed", MARKER);
    char res[2048], dir[256];
    if (last_result(res, sizeof res, dir, sizeof dir) >= 0 && !again
        && (!strncmp(res, "result=hung\n", 12) || !strncmp(res, "result=stuck\n", 13) || !strncmp(res, "result=gpu-hang\n", 16)))
        die(4, "the last try hung the unit or the GPU (%s). Read it first; arm with --again to try once more", dir);
    if (system_icds(0)) {
        say("vk-trial: Vulkan ICDs or layers where every program would find them:");
        system_icds(1);
        die(4, "not armed: remove or rename them first");
    }
    char sinfo[300];
    if (ssh_check(sinfo, sizeof sinfo) < 0) die(4, "%s. Not armed", sinfo);
    say("vk-trial: ssh: %s", sinfo);
    struct stat sd;
    if (stat(DRIVER, &sd) < 0) die(4, "no driver at %s", DRIVER);
    if (stat(CRUMBS_SO, &sd) < 0) die(4, "no %s", CRUMBS_SO);
    if (!is_cmd && stat(PROBE, &sd) < 0) die(4, "no %s", PROBE);

    mkdir(RUN_DIR, 0755);
    struct statfs fs;
    if (statfs(RUN_DIR, &fs) < 0 || (unsigned long)fs.f_type != TMPFS_MAGIC_)
        die(4, "%s is not on tmpfs: a restart would not forget the arming. Not armed", RUN_DIR);

    char b[40], text[4096];
    boot_id(b);
    int n = snprintf(text, sizeof text, "stage=%s\ntimeout=%d\nboot=%s\nat=%ld\n", STAGES[st], timeout, b, (long)time(NULL));
    for (int k = 0; is_cmd && i + k < argc; k++) {
        if (strchr(argv[i + k], '\n')) die(2, "no newlines in arguments");
        n += snprintf(text + n, sizeof text - n, "arg%d=%s\n", k, argv[i + k]);
        if (n >= (int)sizeof text) die(2, "the command is too long");
    }
    int fd = open(ARM_TMP, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0 || write(fd, text, n) != n) die(1, "%s: %s", ARM_TMP, strerror(errno));
    close(fd);
    if (rename(ARM_TMP, ARM) < 0) die(1, "%s: %s", ARM, strerror(errno));
    say("vk-trial: armed for one start: stage %s, %d s. `vk-trial run` uses it up; a restart forgets it.", STAGES[st], timeout);
    return 0;
}

/* ---- SSH: a way in that doesn't need the screen ------------------------------ */

/* On the unit systemd itself listens on 22 (sshd.socket, Accept=yes) and
 * starts `sshd -i` per connection: neither touches the GPU, nor does the
 * login (/etc/profile.d only sets variables). Before any try:
 * - something listens on TCP port 22 (/proc/net/tcp, tcp6);
 * - this gate was started from an SSH session (SSH_CONNECTION) whose
 *   connection is ESTABLISHED right now: sshd, the link and the firewall
 *   work at this moment.
 * Fills `info` (what was found, or what is missing); 0 = both hold. */

/* each socket in /proc/net/tcp{,6}: local port, remote port, state, inode */
static int scan_tcp(int (*fn)(unsigned lport, unsigned rport, unsigned st, unsigned long ino, void *), void *ctx) {
    const char *files[] = { "/proc/net/tcp", "/proc/net/tcp6", NULL };
    for (int f = 0; files[f]; f++) {
        FILE *t = fopen(files[f], "re");
        if (!t) continue;
        char line[512];
        if (!fgets(line, sizeof line, t)) { fclose(t); continue; }   /* header */
        while (fgets(line, sizeof line, t)) {
            char la[64], ra[64];
            unsigned st;
            unsigned long ino;
            if (sscanf(line, "%*d: %63s %63s %x %*s %*s %*s %*s %*s %lu", la, ra, &st, &ino) != 4) continue;
            char *lp = strrchr(la, ':'), *rp = strrchr(ra, ':');
            if (!lp || !rp) continue;
            if (fn((unsigned)strtoul(lp + 1, NULL, 16), (unsigned)strtoul(rp + 1, NULL, 16), st, ino, ctx)) { fclose(t); return 1; }
        }
        fclose(t);
    }
    return 0;
}

struct want { unsigned lport, rport; unsigned long ino; };
static int is_listen22(unsigned lport, unsigned rport, unsigned st, unsigned long ino, void *c) {
    (void)rport;
    if (lport == 22 && st == 0x0A) { ((struct want *)c)->ino = ino; return 1; }
    return 0;
}
static int is_session(unsigned lport, unsigned rport, unsigned st, unsigned long ino, void *c) {
    struct want *w = c;
    (void)ino;
    return st == 0x01 && lport == w->lport && rport == w->rport;
}

/* the process holding socket inode `ino`, for the log */
static void socket_owner(unsigned long ino, char *out, size_t cap) {
    snprintf(out, cap, "?");
    char want[64];
    snprintf(want, sizeof want, "socket:[%lu]", ino);
    DIR *pd = opendir("/proc");
    if (!pd) return;
    struct dirent *p;
    while ((p = readdir(pd))) {
        if (p->d_name[0] < '0' || p->d_name[0] > '9') continue;
        char fdp[300];
        snprintf(fdp, sizeof fdp, "/proc/%s/fd", p->d_name);
        DIR *fd = opendir(fdp);
        if (!fd) continue;
        struct dirent *e;
        while ((e = readdir(fd))) {
            char lp[600], l[64];
            snprintf(lp, sizeof lp, "%s/%s", fdp, e->d_name);
            ssize_t n = readlink(lp, l, sizeof l - 1);
            if (n <= 0) continue;
            l[n] = 0;
            if (strcmp(l, want)) continue;
            char cp[300], comm[32] = "?";
            snprintf(cp, sizeof cp, "/proc/%s/comm", p->d_name);
            if (read_file(cp, comm, sizeof comm) >= 0) comm[strcspn(comm, "\n")] = 0;
            snprintf(out, cap, "%.20s (pid %.12s)", comm, p->d_name);
            closedir(fd);
            closedir(pd);
            return;
        }
        closedir(fd);
    }
    closedir(pd);
}

static int ssh_check(char *info, size_t cap) {
    struct want l = { 0, 0, 0 };
    if (!scan_tcp(is_listen22, &l)) { snprintf(info, cap, "nothing listens on TCP port 22: no SSH to get back in"); return -1; }
    char owner[80];
    socket_owner(l.ino, owner, sizeof owner);
    const char *sc = getenv("SSH_CONNECTION");
    char cip[64], sip[64];
    unsigned cport, sport;
    if (!sc || sscanf(sc, "%63s %u %63s %u", cip, &cport, sip, &sport) != 4) {
        snprintf(info, cap, "port 22 is open (%s), but this was not started from an SSH session (no SSH_CONNECTION): run it over SSH", owner);
        return -1;
    }
    struct want s = { sport, cport, 0 };
    if (!scan_tcp(is_session, &s)) {
        snprintf(info, cap, "port 22 is open (%s), but the SSH connection from %s:%u to port %u is not established", owner, cip, cport, sport);
        return -1;
    }
    snprintf(info, cap, "port 22 open (%s); this session from %s:%u established", owner, cip, cport);
    return 0;
}

/* ---- the display nodes ------------------------------------------------------ */

#define MAX_CARDS 8
struct card { char path[64]; dev_t rdev; };

/* /dev/dri/card*: Winston's display nodes */
static int cards(struct card *out) {
    int n = 0;
    DIR *d = opendir("/dev/dri");
    if (!d) return 0;
    struct dirent *e;
    while ((e = readdir(d)) && n < MAX_CARDS) {
        if (strncmp(e->d_name, "card", 4)) continue;
        struct stat s;
        snprintf(out[n].path, sizeof out[n].path, "/dev/dri/%.50s", e->d_name);
        if (stat(out[n].path, &s) == 0) { out[n].rdev = s.st_rdev; n++; }
    }
    closedir(d);
    return n;
}

static void child_fail(int code, const char *what) {
    char b[200];
    int n = snprintf(b, sizeof b, "vk-trial child: %s: %s: not started\n", what, strerror(errno));
    if (write(2, b, n) < 0) { /* nothing else to do */ }
    _exit(code);
}

/* In the child, before it drops root: its own mount namespace, private (so
 * nothing propagates back to the system's), and /dev/null bound over every
 * display node. Whatever the child runs, however it opens them (relative
 * paths, raw syscalls, static programs), it gets /dev/null. The render node
 * stays. Any failure: the child never starts. */
static void hide_cards(void) {
    struct card c[MAX_CARDS];
    if (unshare(CLONE_NEWNS) < 0) child_fail(110, "unshare");
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0) child_fail(111, "making / private");
    int n = cards(c);
    struct stat null;
    if (stat("/dev/null", &null) < 0) child_fail(112, "/dev/null");
    for (int i = 0; i < n; i++) {
        if (mount("/dev/null", c[i].path, NULL, MS_BIND, NULL) < 0) child_fail(112, c[i].path);
        struct stat s;
        if (stat(c[i].path, &s) < 0 || s.st_rdev != null.st_rdev) child_fail(113, c[i].path);
    }
}

/* ---- run -------------------------------------------------------------------- */

static pid_t child = 0;

static void sysrq_w(void) {
    int fd = open("/proc/sysrq-trigger", O_WRONLY | O_CLOEXEC);
    if (fd < 0 || write(fd, "w", 1) != 1) say("vk-trial: sysrq w: %s", strerror(errno));
    else say("vk-trial: blocked tasks dumped into the kernel log (sysrq w)");
    if (fd >= 0) close(fd);
}

/* copy what the kernel logs into kmsg.log; returns lines read */
static int pump_kmsg(int kfd, int out, int *flags) {
    char rec[8192];
    int lines = 0;
    for (;;) {
        ssize_t n = read(kfd, rec, sizeof rec - 1);
        if (n < 0) { if (errno == EPIPE) continue; break; }  /* EPIPE: overwritten, go on */
        if (n == 0) break;
        rec[n] = 0;
        if (write(out, rec, n) < 0) { /* best effort */ }
        if (strstr(rec, "GPU HANG") || strstr(rec, "hangcheck") || strstr(rec, "Resetting")) *flags |= 1;
        if (strstr(rec, "blocked for more than")) *flags |= 2;
        lines++;
    }
    return lines;
}

static long file_size(int fd) { struct stat s; return fstat(fd, &s) < 0 ? -1 : (long)s.st_size; }

static int cmd_run(void) {
    /* 1. Use the arming up: nothing comes before this. */
    if (rename(ARM, CONSUMED) < 0) {
        if (errno == ENOENT) die(3, "not armed: nothing done");
        die(3, "could not take the arming (%s): nothing done", strerror(errno));
    }
    char arm[4096];
    int an = read_file(CONSUMED, arm, sizeof arm);
    unlink(CONSUMED);
    if (an < 0) die(3, "the arming could not be read: disarmed, nothing done");

    /* 2. Only an arming from this boot, on tmpfs. */
    char b[40], ab[40] = "", stage[32] = "", tos[16] = "30";
    boot_id(b);
    field(arm, "boot", ab, sizeof ab);
    field(arm, "stage", stage, sizeof stage);
    field(arm, "timeout", tos, sizeof tos);
    if (strcmp(ab, b)) die(3, "the arming is from another boot (%s): disarmed, nothing done", ab);
    int st = stage_index(stage);
    int timeout = atoi(tos);
    if (st < 0 || timeout < 5 || timeout > 600) die(3, "the arming is malformed: disarmed, nothing done");
    if (geteuid() != 0) die(3, "run as root: disarmed, nothing done");

    /* A way back in that doesn't need the screen, before anything loads. */
    char sinfo[300];
    if (ssh_check(sinfo, sizeof sinfo) < 0) die(3, "%s: disarmed, nothing done", sinfo);

    mkdirs();
    if (settle_marker()) die(4, "a try is still going on in this boot: disarmed, nothing done");

    /* 3. The witness, durable before any GPU code runs. */
    char dir[256], marker[1024];
    {
        time_t now = time(NULL);
        struct tm tm;
        gmtime_r(&now, &tm);
        char stamp[32];
        strftime(stamp, sizeof stamp, "%Y%m%d-%H%M%S", &tm);
        snprintf(dir, sizeof dir, "%s/%s-%.8s-%s", LOGS, stamp, b, stage);
    }
    if (mkdir(dir, 0700) < 0) die(1, "%s: %s", dir, strerror(errno));
    fsync_path(LOGS);
    snprintf(marker, sizeof marker, "boot=%s\npid=%d\nstage=%s\ntimeout=%d\nstarted=%ld\nlog=%s\n",
             b, (int)getpid(), stage, timeout, (long)time(NULL), dir);
    if (write_durable(MARKER, marker, 0600) < 0) die(1, "%s: %s: nothing started", MARKER, strerror(errno));
    sync();

    char p[400];
    snprintf(p, sizeof p, "%s/gate.log", dir);
    gate_log = open(p, O_WRONLY | O_CREAT | O_APPEND | O_DSYNC | O_CLOEXEC, 0600);
    say("vk-trial: disarmed; trying stage %s for at most %d s; log %s", stage, timeout, dir);
    say("vk-trial: ssh: %s", sinfo);

    /* 4. Keep going without the SSH session. */
    signal(SIGHUP, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);
    setsid();

    snprintf(p, sizeof p, "%s/kmsg.log", dir);
    int kout = open(p, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    int kfd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (kfd >= 0) lseek(kfd, 0, SEEK_END); else say("vk-trial: /dev/kmsg: %s (no kernel log)", strerror(errno));

    /* 5. The driver becomes reachable: only now, only in /run. */
    char icd[256];
    snprintf(icd, sizeof icd, "{\"file_format_version\":\"1.0.0\",\"ICD\":{\"library_path\":\"%s\",\"api_version\":\"1.1.102\"}}\n", DRIVER);
    if (write_durable(ICD, icd, 0644) < 0) { unlink(MARKER); die(1, "%s: %s", ICD, strerror(errno)); }

    snprintf(p, sizeof p, "%s/crumbs.log", dir);
    int crumbs = open(p, O_WRONLY | O_CREAT | O_APPEND | O_DSYNC | O_CLOEXEC, 0600);
    snprintf(p, sizeof p, "%s/out.log", dir);
    int outfd = open(p, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (crumbs < 0 || outfd < 0) { unlink(ICD); unlink(MARKER); die(1, "the log files: %s", strerror(errno)); }

    /* 6. The child: its own environment, unprivileged, the crumbs on fd 3. */
    char *args[MAX_ARGS + 3];
    char argbuf[MAX_ARGS][1024];
    int na = 0;
    if (!strcmp(stage, "command")) {
        for (int k = 0; k < MAX_ARGS; k++) {
            char key[16];
            snprintf(key, sizeof key, "arg%d", k);
            if (field(arm, key, argbuf[k], sizeof argbuf[k]) < 0) break;
            args[na++] = argbuf[k];
        }
    } else {
        args[na++] = (char *)PROBE;
        args[na++] = stage;
    }
    args[na] = NULL;

    char e_icd[300], e_ld[300], e_pre[700], e_stage[64];
    snprintf(e_icd, sizeof e_icd, "VK_ICD_FILENAMES=%s", ICD);
    snprintf(e_ld, sizeof e_ld, "LD_LIBRARY_PATH=%s", LIB);
    const char *extra = getenv("VK_TRIAL_EXTRA_PRELOAD");   /* the bench's GPU stand-in */
    snprintf(e_pre, sizeof e_pre, "LD_PRELOAD=%s%s%s", CRUMBS_SO, extra && *extra ? ":" : "", extra && *extra ? extra : "");
    snprintf(e_stage, sizeof e_stage, "VK_TRIAL_STAGE=%s", stage);
    char *env[24];
    int ne = 0;
    env[ne++] = (char *)"PATH=/usr/bin:/bin";
    env[ne++] = (char *)"HOME=/tmp";
    env[ne++] = e_icd; env[ne++] = e_ld; env[ne++] = e_pre; env[ne++] = e_stage;
    env[ne++] = (char *)"VK_TRIAL_CRUMB_FD=3";
    static char passed[8][300];
    const char *pass[] = { "INTEL_DEBUG", "VK_LOADER_DEBUG", "INTEL_STUB_GPU_PLATFORM", "VK_TRIAL_EMULATE", "MESA_DEBUG", "ANV_ENABLE_PIPELINE_CACHE", NULL };
    for (int k = 0, m = 0; pass[k] && m < 8; k++) {
        const char *v = getenv(pass[k]);
        if (v) { snprintf(passed[m], sizeof passed[m], "%s=%s", pass[k], v); env[ne++] = passed[m++]; }
    }
    env[ne] = NULL;

    /* The display nodes as the system sees them, to check after the child
     * hid them in its own namespace that the system still does. */
    struct card host[MAX_CARDS];
    int nhost = cards(host);
    int ready[2], go[2];
    if (pipe2(ready, O_CLOEXEC) < 0 || pipe2(go, O_CLOEXEC) < 0) { unlink(ICD); unlink(MARKER); die(1, "pipe: %s", strerror(errno)); }

    child = fork();
    if (child < 0) { unlink(ICD); unlink(MARKER); die(1, "fork: %s", strerror(errno)); }
    if (child == 0) {
        setpgid(0, 0);
        if (dup2(crumbs, 3) < 0 || dup2(outfd, 1) < 0 || dup2(outfd, 2) < 0) _exit(120);
        int nul = open("/dev/null", O_RDONLY);
        if (nul >= 0) dup2(nul, 0);
        hide_cards();                     /* exits 110-113 if it can't */
        /* no core dump: the unit's crash handler can restart the head unit
         * for an unlisted program's core (knowledge/head-unit.md); a limit
         * of 1 also stops a piped core_pattern, which 0 doesn't */
        struct rlimit core = { 1, 1 };
        if (setrlimit(RLIMIT_CORE, &core) < 0) child_fail(115, "RLIMIT_CORE");
        char c = 'r';
        if (write(ready[1], &c, 1) != 1 || read(go[0], &c, 1) != 1 || c != 'g') _exit(114);
        gid_t g = VIDEO_GID;
        if (setgroups(1, &g) < 0 || setgid(VIDEO_GID) < 0 || setuid(CHILD_UID) < 0) _exit(121);
        if (setuid(0) == 0) _exit(122);   /* must not get root back */
        execve(args[0], args, env);
        _exit(127);
    }
    setpgid(child, child);
    close(ready[1]);
    close(go[0]);
    /* the child's pid in the marker before it loads anything: a later start
     * of the gate can then tell a child stuck without its gate */
    {
        char m2[1100];
        snprintf(m2, sizeof m2, "%schild=%d\n", marker, (int)child);
        if (write_durable(MARKER, m2, 0600) < 0) say("vk-trial: %s: %s", MARKER, strerror(errno));
    }
    char rc;
    if (read(ready[0], &rc, 1) == 1) {
        int leaked = 0;
        for (int i = 0; i < nhost; i++) {
            struct stat s;
            if (stat(host[i].path, &s) == 0 && s.st_rdev == host[i].rdev) continue;
            /* the bind reached the system's namespace: undo it, stop the child */
            leaked = 1;
            for (int k = 0; k < 4 && umount2(host[i].path, MNT_DETACH) == 0; k++) { }
            say("vk-trial: %s changed for the system too: unmounted, the child stopped", host[i].path);
        }
        if (leaked) kill(child, SIGKILL);
        else if (write(go[1], "g", 1) != 1) say("vk-trial: could not start the child: %s", strerror(errno));
        if (!leaked) say("vk-trial: started %s (pid %d, uid %d, group video, display nodes hidden: %d)",
                         args[0], (int)child, CHILD_UID, nhost);
    } else say("vk-trial: the child failed before starting (out.log says why)");
    close(ready[0]);
    close(go[1]);

    /* 7. Watch: the child, its crumbs, the kernel log. */
    struct timespec t0, now;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    time_t started = time(NULL);
    double last_progress = 0;
    long last_size = file_size(crumbs);
    int status = 0, done = 0, kflags = 0, dumped = 0, killed = 0;
    double killed_at = 0, last_sync = 0;
    while (!done) {
        if (kfd >= 0) { struct pollfd pf = { kfd, POLLIN, 0 }; poll(&pf, 1, 250); pump_kmsg(kfd, kout, &kflags); }
        else usleep(250000);
        pid_t r = waitpid(child, &status, WNOHANG);
        if (r == child) { done = 1; break; }
        clock_gettime(CLOCK_MONOTONIC, &now);
        double t = (now.tv_sec - t0.tv_sec) + (now.tv_nsec - t0.tv_nsec) / 1e9;
        long sz = file_size(crumbs);
        if (sz != last_size) { last_size = sz; last_progress = t; }
        if (t - last_sync >= 1) { fsync(kout); last_sync = t; }
        if (!dumped && t - last_progress >= STALL_S) {
            say("vk-trial: no progress for %d s", STALL_S);
            sysrq_w();
            dumped = 1;
        }
        if (!killed && t >= timeout) {
            say("vk-trial: %d s are up: killing pid %d", timeout, (int)child);
            if (!dumped) { sysrq_w(); dumped = 1; }
            kill(-child, SIGKILL);
            kill(child, SIGKILL);
            killed = 1;
            killed_at = t;
        }
        if (killed && t - killed_at >= 10) {
            /* unkillable: in the kernel. Leave the marker: if the unit
             * restarts, the next start says this try hung. */
            if (kfd >= 0) pump_kmsg(kfd, kout, &kflags);
            fsync(kout);
            unlink(ICD);
            snprintf(p, sizeof p, "%s/result", dir);
            write_durable(p, "result=stuck\nwhy=the child could not be killed: stuck in the kernel\n", 0600);
            write_durable(LAST, dir, 0600);
            die(5, "pid %d does not die: stuck in the kernel. The marker stays; a restart will end it", (int)child);
        }
    }

    /* 8. It ended: no hang held it. */
    usleep(300000);
    if (kfd >= 0) pump_kmsg(kfd, kout, &kflags);
    fsync(kout);
    unlink(ICD);
    char res[1024], how[64];
    if (WIFEXITED(status)) snprintf(how, sizeof how, "exit %d", WEXITSTATUS(status));
    else snprintf(how, sizeof how, "signal %d", WTERMSIG(status));
    const char *verdict = killed ? "timeout" : (WIFEXITED(status) && WEXITSTATUS(status) == 0 ? "ok" : "failed");
    if (kflags & 1) verdict = "gpu-hang";
    snprintf(res, sizeof res, "result=%s\nhow=%s\nstage=%s\nkernel_gpu_hang=%s\nkernel_blocked_tasks=%s\nseconds=%ld\n",
             verdict, how, stage, kflags & 1 ? "yes" : "no", kflags & 2 ? "yes" : "no", (long)(time(NULL) - started));
    snprintf(p, sizeof p, "%s/result", dir);
    write_durable(p, res, 0600);
    write_durable(LAST, dir, 0600);
    unlink(MARKER);
    fsync_path(STATE);
    say("vk-trial: %s (%s)%s%s", verdict, how, kflags & 1 ? ", the kernel reported a GPU hang" : "",
        kflags & 2 ? ", the kernel reported blocked tasks" : "");
    return strcmp(verdict, "ok") ? 6 : 0;
}

/* ---- disarm, status ------------------------------------------------------- */

static int cmd_disarm(void) {
    if (unlink(ARM) == 0) say("vk-trial: disarmed");
    else if (errno == ENOENT) say("vk-trial: was not armed");
    else die(1, "%s: %s", ARM, strerror(errno));
    return 0;
}

static int cmd_status(void) {
    char a[4096], res[2048], dir[256], m[1024];
    if (read_file(ARM, a, sizeof a) >= 0) {
        char s[32] = "?";
        field(a, "stage", s, sizeof s);
        say("armed: stage %s (one start)", s);
    } else say("armed: no");
    if (read_file(MARKER, m, sizeof m) >= 0) {
        char b[40], mb[40] = "";
        boot_id(b);
        field(m, "boot", mb, sizeof mb);
        say("trial: %s", strcmp(mb, b) ? "one never ended (another boot): the unit restarted during it" : "one is going on in this boot");
    } else say("trial: none going on");
    if (last_result(res, sizeof res, dir, sizeof dir) >= 0) {
        res[strcspn(res, "\n")] = 0;
        say("last: %s (%s)", res + (strncmp(res, "result=", 7) ? 0 : 7), dir);
    } else say("last: none");
    if (system_icds(0)) { say("system ICDs or layers (a risk, arming refused):"); system_icds(1); }
    char sinfo[300];
    say("ssh: %s%s", ssh_check(sinfo, sizeof sinfo) < 0 ? "NOT READY (arming refused): " : "", sinfo);
    return 0;
}

int main(int argc, char **argv) {
    /* `run` first, before anything that touches a file */
    if (argc == 2 && !strcmp(argv[1], "run")) return cmd_run();
    if (argc >= 2 && !strcmp(argv[1], "arm")) return cmd_arm(argc, argv);
    if (argc == 2 && !strcmp(argv[1], "disarm")) return cmd_disarm();
    if (argc == 2 && !strcmp(argv[1], "status")) { mkdirs(); settle_marker(); return cmd_status(); }
    fprintf(stderr, "usage: vk-trial arm STAGE [--timeout S] [--again] | arm command [...] -- PROGRAM [ARG...]\n"
                    "       vk-trial run | disarm | status\n"
                    "STAGE: instance enumerate device compute\n");
    return 2;
}
