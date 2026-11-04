/* annexb: see annexb.h */
#include "annexb.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#ifdef ANNEXB_PROFILE   /* test builds only: where a call's time goes */
#include <time.h>
double annexb_prof[4];  /* connect, grow, copy, send (seconds, last call) */
static double prof_now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (double)t.tv_sec + t.tv_nsec / 1e9; }
#define PROF(i, stmt) do { double _t = prof_now(); stmt; annexb_prof[i] = prof_now() - _t; } while (0)
#else
#define PROF(i, stmt) do { stmt; } while (0)
#endif

#define BUSY_LIMIT 30   /* frames dropped behind one unsent tail before the consumer is given up */
/* A non-blocking connect on loopback runs the handshake in the caller's kernel
 * context: under 1 ms normally, but 29 ms was seen once (WSL2) on a reconnect
 * while the old connection drained. So at most one attempt per interval. */
#define RETRY_NS 500000000LL
/* The send buffer bounds the latency: loopback auto-tunes it to megabytes,
 * i.e. seconds of stale map queued for the cluster. A few frames' worth, then
 * frames drop instead (the kernel doubles this value). */
#define SNDBUF (256 * 1024)

static long long mono_ns(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (long long)t.tv_sec * 1000000000LL + t.tv_nsec; }

static const uint8_t START[4] = { 0, 0, 0, 1 };

void annexb_init(struct annexb *a, uint16_t port) {
    memset(a, 0, sizeof *a);
    a->port = port; a->fd = -1; a->need_idr = 1;
}

static void drop_conn(struct annexb *a) {
    if (a->fd >= 0) close(a->fd);
    a->fd = -1; a->pend_n = 0; a->busy_frames = 0; a->need_idr = 1; a->confirmed = 0;
}

void annexb_close(struct annexb *a) {
    drop_conn(a);
    free(a->hdr); free(a->out); free(a->pend);
    a->hdr = a->out = a->pend = NULL; a->hdr_n = a->out_cap = a->pend_cap = 0;
}

void annexb_reset(struct annexb *a) { a->need_idr = 1; }

static int grow(uint8_t **b, size_t *cap, size_t need) {
    if (need <= *cap) return 0;
    size_t c = *cap ? *cap : 4096;
    while (c < need) c *= 2;
    uint8_t *n = realloc(*b, c);
    if (!n) return -1;
    *b = n; *cap = c;
    return 0;
}

/* ---- the picture size from the AVCC's first SPS (H.264 7.3.2.1.1) ---- */
struct bits { const uint8_t *p; size_t n, i; int bad; };   /* RBSP: emulation bytes removed */
static unsigned bit1(struct bits *b) {
    if (b->i >= b->n * 8) { b->bad = 1; return 0; }
    unsigned v = (b->p[b->i >> 3] >> (7 - (b->i & 7))) & 1; b->i++; return v;
}
static unsigned bitsn(struct bits *b, int k) { unsigned v = 0; while (k--) v = (v << 1) | bit1(b); return v; }
static unsigned ue(struct bits *b) {
    int z = 0;
    while (!bit1(b)) { if (b->bad || ++z > 31) { b->bad = 1; return 0; } }
    return z ? ((1u << z) - 1) + bitsn(b, z) : 0;
}
static int se(struct bits *b) { unsigned k = ue(b); return k & 1 ? (int)((k + 1) / 2) : -(int)(k / 2); }
static void skip_scaling_list(struct bits *b, int size) {
    int last = 8, next = 8;
    for (int j = 0; j < size && !b->bad; j++) {
        if (next) next = (last + se(b) + 256) % 256;
        last = next ? next : last;
    }
}
int annexb_avcc_size(const uint8_t *p, size_t n, int *w, int *h) {
    if (n < 9 || p[0] != 1 || !(p[5] & 0x1f)) return -1;
    size_t l = ((size_t)p[6] << 8) | p[7];
    if (l < 4 || 8 + l > n || (p[8] & 0x1f) != 7) return -1;
    uint8_t r[256]; size_t rn = 0; int zeros = 0;   /* the SPS's RBSP, after its NAL header byte */
    for (size_t k = 9; k < 8 + l && rn < sizeof r; k++) {
        if (zeros >= 2 && p[k] == 3) { zeros = 0; continue; }
        zeros = p[k] == 0 ? zeros + 1 : 0;
        r[rn++] = p[k];
    }
    struct bits b = { r, rn, 0, 0 };
    unsigned profile = bitsn(&b, 8); bitsn(&b, 16); ue(&b);
    unsigned chroma = 1, separate = 0;
    if (profile == 100 || profile == 110 || profile == 122 || profile == 244 || profile == 44 || profile == 83 ||
        profile == 86 || profile == 118 || profile == 128 || profile == 138 || profile == 139 || profile == 134 || profile == 135) {
        chroma = ue(&b);
        if (chroma == 3) separate = bit1(&b);
        ue(&b); ue(&b); bit1(&b);
        if (bit1(&b))
            for (int k = 0; k < (chroma != 3 ? 8 : 12) && !b.bad; k++)
                if (bit1(&b)) skip_scaling_list(&b, k < 6 ? 16 : 64);
    }
    ue(&b);
    unsigned poc = ue(&b);
    if (poc == 0) ue(&b);
    else if (poc == 1) {
        bit1(&b); se(&b); se(&b);
        unsigned cycle = ue(&b);
        for (unsigned k = 0; k < cycle && !b.bad; k++) se(&b);
    }
    ue(&b); bit1(&b);
    unsigned wmb = ue(&b) + 1, hmu = ue(&b) + 1, frame_mbs_only = bit1(&b);
    if (!frame_mbs_only) bit1(&b);
    bit1(&b);
    unsigned cl = 0, cr = 0, ct = 0, cb = 0;
    if (bit1(&b)) { cl = ue(&b); cr = ue(&b); ct = ue(&b); cb = ue(&b); }
    if (b.bad) return -1;
    unsigned array = separate ? 0 : chroma;
    unsigned cx = array == 0 ? 1 : (array == 3 ? 1 : 2), cy = (array == 1 ? 2 : 1) * (2 - frame_mbs_only);
    long W = (long)wmb * 16 - (long)cx * (cl + cr), H = (long)(2 - frame_mbs_only) * hmu * 16 - (long)cy * (ct + cb);
    if (W <= 0 || H <= 0 || W > 8192 || H > 8192) return -1;
    *w = (int)W; *h = (int)H;
    return 0;
}

int annexb_avcc(struct annexb *a, const uint8_t *p, size_t n) {
    free(a->hdr); a->hdr = NULL; a->hdr_n = 0; a->nal_len_size = 0; a->need_idr = 1;
    if (n < 7 || p[0] != 1) goto bad;
    int len_size = (p[4] & 3) + 1;
    if (len_size == 3) goto bad;
    size_t cap = 0, i = 5;
    uint8_t *h = NULL; size_t hn = 0;
    for (int set = 0; set < 2; set++) {           /* SPS, then PPS */
        if (i >= n) { free(h); goto bad; }
        unsigned count = set == 0 ? (p[i] & 0x1f) : p[i];
        i++;
        for (unsigned k = 0; k < count; k++) {
            if (i + 2 > n) { free(h); goto bad; }
            size_t l = ((size_t)p[i] << 8) | p[i + 1];
            i += 2;
            if (l == 0 || i + l > n || grow(&h, &cap, hn + 4 + l)) { free(h); goto bad; }
            memcpy(h + hn, START, 4); memcpy(h + hn + 4, p + i, l);
            hn += 4 + l; i += l;
        }
    }
    if (hn == 0) { free(h); goto bad; }
    a->hdr = h; a->hdr_n = hn; a->nal_len_size = len_size;
    return 0;
bad:
    a->st.bad_input++;
    return -1;
}

static int try_connect(struct annexb *a) {
    long long now = mono_ns();
    if (a->next_try && now < a->next_try) return -1;
    a->next_try = now + RETRY_NS;
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons(a->port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    /* loopback: a non-blocking connect either succeeds at once, is refused at
     * once, or is in progress for the time the kernel takes; never wait */
    int c = connect(fd, (struct sockaddr *)&sa, sizeof sa);
    if (c != 0 && errno != EINPROGRESS) { close(fd); return -1; }
    int one = 1, sb = SNDBUF;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sb, sizeof sb);
    a->fd = fd; a->live = 0;   /* counted in connects once a byte goes through */
    a->confirmed = c == 0; a->conn_started = now;
    return 0;
}

/* An in-progress connect: done, refused, or still waiting? Without this, a
 * connect refused while nobody listened stayed as a dead socket for good,
 * since nothing is sent while waiting for an IDR (seen on the unit,
 * 2026-11-04: 1880 frames dropped, never reconnected). */
#define CONNECT_WAIT_NS 1000000000LL
static void check_conn(struct annexb *a) {
    if (a->fd < 0 || a->confirmed) return;
    struct pollfd pf = { a->fd, POLLOUT, 0 };
    if (poll(&pf, 1, 0) > 0) {
        int err = 0; socklen_t el = sizeof err;
        if (getsockopt(a->fd, SOL_SOCKET, SO_ERROR, &err, &el) != 0 || err != 0 || (pf.revents & (POLLERR | POLLHUP))) drop_conn(a);
        else a->confirmed = 1;
    } else if (mono_ns() - a->conn_started > CONNECT_WAIT_NS) drop_conn(a);
}

/* send what it takes now; the rest becomes the pending tail */
static int send_some(struct annexb *a, const uint8_t *p, size_t n) {
    size_t off = 0;
    while (off < n) {
        ssize_t k = send(a->fd, p + off, n - off, MSG_DONTWAIT | MSG_NOSIGNAL);
        if (k > 0) { off += (size_t)k; a->st.bytes_out += (unsigned long)k; if (!a->live) { a->live = 1; a->st.connects++; } continue; }
        if (k < 0 && errno == EINTR) continue;
        if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOTCONN)) break;  /* ENOTCONN: connect in progress */
        drop_conn(a);                              /* EPIPE, ECONNRESET, refused, ... */
        return -1;
    }
    if (off < n) {
        if (grow(&a->pend, &a->pend_cap, n - off)) { drop_conn(a); return -1; }
        memmove(a->pend, p + off, n - off);       /* p may be a->pend itself */
        a->pend_n = n - off;
    } else a->pend_n = 0;
    return 0;
}

int annexb_frame(struct annexb *a, const uint8_t *p, size_t n) {
    a->st.frames_in++;
    if (!a->nal_len_size) { a->st.dropped++; return 0; }       /* no config yet */
    /* walk the NAL units: bounds, and whether this is an IDR */
    int idr = 0; size_t i = 0, nals = 0, payload = 0;
    while (i < n) {
        if (i + (size_t)a->nal_len_size > n) goto bad;
        size_t l = 0;
        for (int k = 0; k < a->nal_len_size; k++) l = (l << 8) | p[i + k];
        i += (size_t)a->nal_len_size;
        if (l == 0 || l > n - i) goto bad;
        if ((p[i] & 0x1f) == 5) idr = 1;
        nals++; payload += l; i += l;
    }
    if (nals == 0) goto bad;

    /* a tail from the last frame first: the stream must stay whole */
    if (a->fd >= 0 && a->pend_n) {
        if (send_some(a, a->pend, a->pend_n) == 0 && a->pend_n) {
            a->need_idr = 1; a->st.dropped++;
            if (++a->busy_frames >= BUSY_LIMIT) drop_conn(a);   /* the consumer has stopped reading */
            return 0;
        }
        a->busy_frames = 0;
    }
    int conn_rc = 0;
    check_conn(a);
    if (a->fd < 0) { PROF(0, conn_rc = try_connect(a)); if (conn_rc == 0) check_conn(a); }
    if (a->fd < 0 || conn_rc != 0) { a->st.dropped++; return 0; }
    if (a->need_idr && !idr) {
        a->st.dropped++;
        if (a->confirmed) a->want_keyframe = 1;   /* a consumer is there: ask the phone */
        return 0;
    }

    size_t total = (idr ? a->hdr_n : 0) + payload + 4 * nals, o = 0;
    int grow_rc;
    PROF(1, grow_rc = grow(&a->out, &a->out_cap, total));
    if (grow_rc) { a->st.dropped++; return 0; }
    if (idr) { memcpy(a->out, a->hdr, a->hdr_n); o = a->hdr_n; }
    for (i = 0; i < n; ) {
        size_t l = 0;
        for (int k = 0; k < a->nal_len_size; k++) l = (l << 8) | p[i + k];
        i += (size_t)a->nal_len_size;
        memcpy(a->out + o, START, 4); memcpy(a->out + o + 4, p + i, l);
        o += 4 + l; i += l;
    }
    int send_rc;
    PROF(3, send_rc = send_some(a, a->out, o));
    if (send_rc != 0) { a->st.dropped++; return 0; }
    a->need_idr = 0;
    a->st.frames_out++;
    return 1;
bad:
    a->st.bad_input++;
    return -1;
}
