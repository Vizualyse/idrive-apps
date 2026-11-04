/*
 * annexb_test (re/run.sh harness-annexb): the stream-111 output sink.
 *
 *   annexb_test unit                    conversion, malformed input, no consumer,
 *                                       a consumer that stops reading (never blocks,
 *                                       the stream stays whole, resumes at an IDR)
 *   annexb_test decode <in.h264> <out.h264>
 *                                       a real x264 stream, split into AVCC access units
 *                                       as the phone sends them, through the sink to a
 *                                       slow reader; out.h264 is then decoded by ffmpeg
 */
#define _GNU_SOURCE
#define ANNEXB_PROFILE
#include "annexb.c"
#include <pthread.h>
#include <stdio.h>
#include <time.h>

static int fail;
#define CHECK(name, cond) do { int _c = (cond); printf("%s %s\n", _c ? "ok  " : "FAIL", name); if (!_c) fail = 1; } while (0)
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (double)t.tv_sec + t.tv_nsec / 1e9; }

/* ---- a consumer: listens on 127.0.0.1:port, reads each connection to its end
 * (optionally stalling, or slowly); segs[] marks where each connection began ---- */
#include <poll.h>
struct consumer { int lfd, rcvbuf; volatile int stall, stop; volatile useconds_t delay; size_t chunk;
                  uint8_t *buf; size_t n, cap, segs[64]; int nseg; pthread_t t; };
static int listen_on(uint16_t port, int rcvbuf) {
    int fd = socket(AF_INET, SOCK_STREAM, 0), one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    if (rcvbuf) setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof rcvbuf);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (bind(fd, (struct sockaddr *)&a, sizeof a) || listen(fd, 4)) { perror("listen"); exit(2); }
    return fd;
}
static void *consume(void *arg) {
    struct consumer *c = arg;
    uint8_t tmp[65536];
    while (!c->stop) {
        struct pollfd pl = { c->lfd, POLLIN, 0 };
        if (poll(&pl, 1, 50) <= 0) continue;
        int fd = accept(c->lfd, NULL, NULL);
        if (fd < 0) continue;
        if (c->nseg < 64) c->segs[c->nseg++] = c->n;
        for (;;) {
            if (c->stall && !c->stop) { usleep(5000); continue; }
            struct pollfd pf = { fd, POLLIN, 0 };
            if (poll(&pf, 1, 50) <= 0) { if (c->stop) break; continue; }
            size_t want = c->chunk ? c->chunk : sizeof tmp;
            ssize_t k = recv(fd, tmp, want, 0);
            if (k <= 0) break;                              /* the sink closed it */
            if (c->n + (size_t)k > c->cap) { c->cap = (c->n + (size_t)k) * 2; c->buf = realloc(c->buf, c->cap); }
            memcpy(c->buf + c->n, tmp, (size_t)k); c->n += (size_t)k;
            if (c->delay) usleep(c->delay);
        }
        close(fd);
    }
    return NULL;
}
static void consumer_end(struct consumer *c, struct annexb *a) {
    usleep(300000);                       /* let the reader catch up */
    if (a->fd >= 0) shutdown(a->fd, SHUT_WR);
    usleep(200000);
    c->stop = 1; pthread_join(c->t, NULL); close(c->lfd);
}

/* ---- the stream as the phone sends it ---- */
static const uint8_t SPS[] = { 0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40 };
static const uint8_t PPS[] = { 0x68, 0xce, 0x3c, 0x80 };
static size_t avcc_record(uint8_t *o, int len_size) {
    size_t i = 0;
    o[i++] = 1; o[i++] = SPS[1]; o[i++] = SPS[2]; o[i++] = SPS[3]; o[i++] = (uint8_t)(0xfc | (len_size - 1));
    o[i++] = 0xe1; o[i++] = 0; o[i++] = sizeof SPS; memcpy(o + i, SPS, sizeof SPS); i += sizeof SPS;
    o[i++] = 1; o[i++] = 0; o[i++] = sizeof PPS; memcpy(o + i, PPS, sizeof PPS); i += sizeof PPS;
    return i;
}
/* frame f: an SEI-less access unit of one slice, IDR every `gop`; the slice
 * body carries its frame number so the receiver can tell which it got */
static size_t make_frame(uint8_t *o, int f, int gop, size_t body, int len_size) {
    size_t l = 1 + 4 + body, i = 0;
    for (int k = len_size - 1; k >= 0; k--) o[i++] = (uint8_t)(l >> (8 * k));
    o[i++] = f % gop == 0 ? 0x65 : 0x41;
    for (int k = 3; k >= 0; k--) o[i++] = (uint8_t)(0x10 + ((f >> (6 * k)) & 0x3f));   /* no zero bytes: no start-code lookalikes */
    for (size_t k = 0; k < body; k++) o[i++] = (uint8_t)(0x10 + (k + (size_t)f) % 0xe0);  /* never 0: no start-code lookalikes */
    return i;
}

/* the received Annex-B stream: each NAL whole, SPS PPS before every IDR, frames
 * in increasing order, and after every gap the next frame is an IDR */
static int check_stream(const uint8_t *s, size_t n, int gop, size_t body, int *frames, int *gaps, int *last_frame) {
    size_t i = 0; int last = -1, want_hdr = 0, seen_sps = 0, seen_pps = 0;
    *frames = 0; *gaps = 0;
    while (i < n) {
        if (n - i < 5 || memcmp(s + i, START, 4)) return -1;
        size_t j = i + 4; while (j + 4 <= n && memcmp(s + j, START, 4)) j++;
        if (j + 4 > n) j = n;
        const uint8_t *u = s + i + 4; size_t l = j - i - 4;
        int t = u[0] & 0x1f;
        if (t == 7) { if (l != sizeof SPS || memcmp(u, SPS, l)) return -2; seen_sps = 1; }
        else if (t == 8) { if (l != sizeof PPS || memcmp(u, PPS, l) || !seen_sps) return -3; seen_pps = 1; }
        else if (t == 5 || t == 1) {
            if (l != 5 + body) { if (j == n && l < 5 + body) break; return -4; }  /* cut short only where the connection ended */
            int f = 0; for (int k = 1; k <= 4; k++) f = (f << 6) | ((u[k] - 0x10) & 0x3f);
            if ((t == 5) != (f % gop == 0)) return -5;
            for (size_t k = 0; k < body; k++) if (u[5 + k] != (uint8_t)(0x10 + (k + (size_t)f) % 0xe0)) return -6;
            if (t == 5 && !(seen_sps && seen_pps)) return -7;               /* SPS/PPS before each IDR */
            if (f <= last) return -8;
            if (f != last + 1) { (*gaps)++; if (t != 5) return -9; }      /* resumes only at an IDR */
            last = f; (*frames)++; seen_sps = seen_pps = 0; (void)want_hdr;
            if (last_frame) *last_frame = f;
        } else return -10;
        i = j;
    }
    return 0;
}
/* every connection checked on its own; a new connection counts as a gap */
static int check_segments(struct consumer *c, int gop, size_t body, int *frames, int *gaps) {
    *frames = 0; *gaps = 0;
    for (int k = 0; k < c->nseg; k++) {
        size_t b = c->segs[k], e = k + 1 < c->nseg ? c->segs[k + 1] : c->n;
        int f, g, last = -1;
        int r = check_stream(c->buf + b, e - b, gop, body, &f, &g, &last);
        if (r) return r * 100 - k;
        *frames += f; *gaps += g + (k > 0 && f > 0);
    }
    return 0;
}

static int unit(void) {
    struct annexb a; uint8_t rec[64], fr[300000];
    /* conversion */
    annexb_init(&a, 1);
    CHECK("malformed AVCC rejected", annexb_avcc(&a, (const uint8_t *)"\x01\x42", 2) == -1);
    size_t rn = avcc_record(rec, 4);
    CHECK("AVCC accepted", annexb_avcc(&a, rec, rn) == 0 && a.nal_len_size == 4);
    CHECK("AVCC -> 00000001 SPS 00000001 PPS", a.hdr_n == 8 + sizeof SPS + sizeof PPS && !memcmp(a.hdr, START, 4)
          && !memcmp(a.hdr + 4, SPS, sizeof SPS) && !memcmp(a.hdr + 8 + sizeof SPS, PPS, sizeof PPS));
    size_t n = make_frame(fr, 0, 10, 20, 4);
    fr[3] = 200;   /* NAL length past the end */
    CHECK("NAL length past the frame: rejected, nothing read past it", annexb_frame(&a, fr, n) == -1);
    rec[4] = 0xfc | 2;   /* length size 3: invalid */
    CHECK("NAL length size 3 rejected", annexb_avcc(&a, rec, rn) == -1);
    annexb_close(&a);

    /* no consumer: nothing blocks, frames dropped */
    annexb_init(&a, 46111);
    annexb_avcc(&a, rec, avcc_record(rec, 4));
    double t0 = now_s();
    for (int f = 0; f < 50; f++) { n = make_frame(fr, f, 10, 1000, 4); annexb_frame(&a, fr, n); }
    CHECK("no consumer: 50 frames dropped, at once", a.st.dropped == 50 && a.st.frames_out == 0 && now_s() - t0 < 0.2);

    /* a consumer appears: P frames until the next IDR are dropped, then the stream starts with SPS/PPS/IDR */
    usleep(600000);   /* past the connect retry interval of the attempts above */
    struct consumer c = { .lfd = listen_on(46111, 0) };
    pthread_create(&c.t, NULL, consume, &c);
    for (int f = 50; f < 75; f++) { n = make_frame(fr, f, 10, 1000, 4); annexb_frame(&a, fr, n); usleep(2000); }
    consumer_end(&c, &a);
    int frames, gaps, r = check_segments(&c, 10, 1000, &frames, &gaps);
    printf("  late consumer: %d frames, %d gap(s), check %d\n", frames, gaps, r);
    CHECK("late consumer: starts at the next IDR (50), then 50..74 whole", r == 0 && frames == 25 && a.st.connects == 1);
    annexb_close(&a); free(c.buf);

    /* a consumer joining mid-GOP: frames dropped until the IDR, want_keyframe raised */
    annexb_init(&a, 46115);
    annexb_avcc(&a, rec, avcc_record(rec, 4));
    struct consumer c4 = { .lfd = listen_on(46115, 0) };
    pthread_create(&c4.t, NULL, consume, &c4);
    for (int f = 3; f < 10; f++) { n = make_frame(fr, f, 10, 500, 4); annexb_frame(&a, fr, n); usleep(2000); }
    CHECK("joining mid-GOP: dropped until an IDR, want_keyframe raised", a.st.frames_out == 0 && a.want_keyframe == 1);
    a.want_keyframe = 0;
    n = make_frame(fr, 10, 10, 500, 4); annexb_frame(&a, fr, n);
    CHECK("then the IDR goes out", a.st.frames_out == 1 && a.want_keyframe == 0);
    consumer_end(&c4, &a); annexb_close(&a); free(c4.buf);

    /* length size 2 */
    annexb_init(&a, 46112);
    struct consumer c2 = { .lfd = listen_on(46112, 0) };
    pthread_create(&c2.t, NULL, consume, &c2);
    annexb_avcc(&a, rec, avcc_record(rec, 2));
    for (int f = 0; f < 12; f++) { n = make_frame(fr, f, 4, 300, 2); annexb_frame(&a, fr, n); usleep(2000); }
    consumer_end(&c2, &a);
    r = check_segments(&c2, 4, 300, &frames, &gaps);
    printf("  2-byte lengths: %d frames, %d gap(s), check %d\n", frames, gaps, r);
    CHECK("2-byte NAL lengths: 12/12 frames", r == 0 && frames == 12 && gaps == 0);
    annexb_close(&a); free(c2.buf);

    /* a consumer that stops reading: the sink never blocks, the stream stays whole */
    annexb_init(&a, 46113);
    annexb_avcc(&a, rec, avcc_record(rec, 4));
    struct consumer c3 = { .lfd = listen_on(46113, 4096), .stall = 1 };
    pthread_create(&c3.t, NULL, consume, &c3);
    double worst = 0, worst_prof[4] = {0}, worst_conn = 0; int worst_f = -1;
    for (int f = 0; f < 300; f++) {
        n = make_frame(fr, f, 30, 60000, 4);
        double s = now_s(); annexb_frame(&a, fr, n); double d = now_s() - s; if (annexb_prof[0] > 0) { if (d > worst_conn) worst_conn = d; } else if (d > worst) { worst = d; worst_f = f; memcpy(worst_prof, annexb_prof, sizeof worst_prof); } memset(annexb_prof, 0, sizeof annexb_prof);
        if (f == 120) c3.stall = 0;
        if (f == 60 || f == 150 || f == 240) usleep(500000);   /* let the connect retry interval pass */           /* reads again, slowly */
        if (f > 120) c3.delay = 200, c3.chunk = 16384;
        usleep(1000);
    }
    printf("  stalled consumer: in %lu, out %lu, dropped %lu, connects %lu, slowest call %.1f ms (frame %d)\n",
           a.st.frames_in, a.st.frames_out, a.st.dropped, a.st.connects, worst * 1000, worst_f);
    printf("  slowest call: connect %.2f ms, grow %.2f ms, send %.2f ms\n", worst_prof[0] * 1e3, worst_prof[1] * 1e3, worst_prof[3] * 1e3);
    printf("  slowest call with a connect: %.2f ms\n", worst_conn * 1e3);
    CHECK("stalled consumer: no call blocks (< 20 ms; with a connect, < 100 ms)", worst < 0.02 && worst_conn < 0.1);
    CHECK("stalled consumer: frames dropped while it stalls", a.st.dropped > 0);
    c3.delay = 0;
    consumer_end(&c3, &a);
    r = check_segments(&c3, 30, 60000, &frames, &gaps);
    printf("  stalled consumer received: %d frames over %d connection(s), %d gap(s), check %d\n", frames, c3.nseg, gaps, r);
    CHECK("stalled consumer: given up after 30 busy frames, reconnected at an IDR", a.st.connects >= 2 && c3.nseg >= 2);
    CHECK("stalled consumer: every NAL whole (but a connection's cut end), resumes only at SPS/PPS/IDR", r == 0 && frames > 0 && gaps >= 1);
    annexb_close(&a); free(c3.buf);
    return fail;
}

/* ---- decode: a real stream ---- */
static int decode(const char *in, const char *out) {
    FILE *fi = fopen(in, "rb"); if (!fi) { perror(in); return 2; }
    fseek(fi, 0, SEEK_END); long sz = ftell(fi); fseek(fi, 0, SEEK_SET);
    uint8_t *s = malloc((size_t)sz); if (fread(s, 1, (size_t)sz, fi) != (size_t)sz) return 2; fclose(fi);
    /* split into NAL units at 3- or 4-byte start codes */
    size_t starts[20000], ns = 0;
    for (size_t i = 0; i + 3 < (size_t)sz && ns < 20000; i++)
        if (s[i] == 0 && s[i + 1] == 0 && s[i + 2] == 1) { starts[ns++] = i + 3; i += 2; }
    uint8_t sps[256], pps[256]; size_t sps_n = 0, pps_n = 0;
    /* access units as the phone sends them: SEI + slice, 4-byte lengths; SPS/PPS go in the AVCC */
    uint8_t *aus = malloc((size_t)sz * 2); size_t au_off[5000], au_n[5000], nau = 0, o = 0, cur = 0; int open = 0;
    for (size_t k = 0; k < ns; k++) {
        size_t b = starts[k], e = k + 1 < ns ? starts[k + 1] - 3 : (size_t)sz;
        while (e > b && s[e - 1] == 0) e--;                   /* a 4-byte start code's leading zero */
        int t = s[b] & 0x1f; size_t l = e - b;
        if (t == 7) { if (!sps_n) { memcpy(sps, s + b, l); sps_n = l; } continue; }
        if (t == 8) { if (!pps_n) { memcpy(pps, s + b, l); pps_n = l; } continue; }
        if (t == 9) continue;
        if (!open) { cur = o; open = 1; }
        aus[o++] = (uint8_t)(l >> 24); aus[o++] = (uint8_t)(l >> 16); aus[o++] = (uint8_t)(l >> 8); aus[o++] = (uint8_t)l;
        memcpy(aus + o, s + b, l); o += l;
        if (t == 1 || t == 5) { au_off[nau] = cur; au_n[nau] = o - cur; nau++; open = 0; }
    }
    uint8_t rec[600]; size_t rn = 0;
    rec[rn++] = 1; rec[rn++] = sps[1]; rec[rn++] = sps[2]; rec[rn++] = sps[3]; rec[rn++] = 0xff;
    rec[rn++] = 0xe1; rec[rn++] = (uint8_t)(sps_n >> 8); rec[rn++] = (uint8_t)sps_n; memcpy(rec + rn, sps, sps_n); rn += sps_n;
    rec[rn++] = 1; rec[rn++] = (uint8_t)(pps_n >> 8); rec[rn++] = (uint8_t)pps_n; memcpy(rec + rn, pps, pps_n); rn += pps_n;
    printf("  input: %zu access units, SPS %zu B, PPS %zu B\n", nau, sps_n, pps_n);

    struct annexb a; annexb_init(&a, 46114);
    CHECK("x264 AVCC accepted", annexb_avcc(&a, rec, rn) == 0);
    /* a reader at 60 % of the stream's byte rate (at 30 fps): it falls behind,
     * frames drop, and the stream must resume cleanly at each IDR */
    double rate = (double)o / ((double)nau / 30.0) * 0.6;
    useconds_t delay = (useconds_t)(8192.0 / rate * 1e6);
    printf("  stream %.0f KB/s, reader %.0f KB/s\n", rate / 0.6 / 1024, rate / 1024);
    struct consumer c = { .lfd = listen_on(46114, 8192), .stall = 0, .delay = delay, .chunk = 8192 };
    pthread_create(&c.t, NULL, consume, &c);
    for (size_t k = 0; k < nau; k++) { annexb_frame(&a, aus + au_off[k], au_n[k]); usleep(33333); }
    c.delay = 0;
    consumer_end(&c, &a);
    printf("  connections: %d\n", c.nseg);
    CHECK("one connection throughout (slow, never given up)", c.nseg == 1);
    printf("  sink: in %lu, out %lu, dropped %lu (slow reader)\n", a.st.frames_in, a.st.frames_out, a.st.dropped);
    CHECK("some frames dropped (the reader is slow), some through", a.st.dropped > 0 && a.st.frames_out > 0);
    FILE *fo = fopen(out, "wb"); fwrite(c.buf, 1, c.n, fo); fclose(fo);
    printf("frames_out=%lu\n", a.st.frames_out);
    annexb_close(&a);
    return fail;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc >= 2 && !strcmp(argv[1], "unit")) { int r = unit(); printf("%s\n", r ? "FAIL" : "PASS"); return r; }
    if (argc >= 4 && !strcmp(argv[1], "decode")) return decode(argv[2], argv[3]);
    fprintf(stderr, "usage: %s unit | decode <in.h264> <out.h264>\n", argv[0]);
    return 2;
}
