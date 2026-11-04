/* annexb: CarPlay screen frames (AVCC config + length-prefixed H.264 access
 * units, as the phone sends them) to an Annex-B byte stream on a local TCP
 * socket, for an ffmpeg reading `-f h264 -i tcp://127.0.0.1:<port>?listen`
 * (the cluster-render pipeline vizualyse-cast already runs).
 *
 * Called on the screen's frame pump, so it never blocks:
 *  - sends are non-blocking; a frame the socket only takes part of is
 *    finished before anything new goes out (the stream is never cut inside a
 *    NAL unit); a frame that finds the socket still busy is dropped;
 *  - after a drop, a (re)connect or a new config, nothing goes out until the
 *    next IDR, and SPS/PPS go before every IDR, so the consumer can always
 *    start decoding where it joins;
 *  - the send buffer is capped (256 KB) to bound the latency;
 *  - no consumer: frames are dropped; a connect is tried at most every
 *    500 ms;
 *  - a consumer waiting for an IDR sets want_keyframe: the phone only sends
 *    one at the start or when asked (forceKeyFrame). */
#ifndef ANNEXB_H
#define ANNEXB_H
#include <stddef.h>
#include <stdint.h>

struct annexb_stats { unsigned long frames_in, frames_out, dropped, connects /* that carried data */, bytes_out, bad_input; };

struct annexb {
    uint16_t port;              /* 127.0.0.1:port */
    int fd;                     /* connected, or -1 */
    int live;                   /* a byte has gone through on fd */
    int nal_len_size;           /* from the AVCC: 1, 2 or 4 */
    int need_idr;
    uint8_t *hdr; size_t hdr_n; /* SPS/PPS, Annex-B */
    uint8_t *out; size_t out_cap;
    uint8_t *pend; size_t pend_n, pend_cap;  /* the unsent tail of a frame */
    unsigned busy_frames;       /* frames dropped in a row while the tail waits */
    long long next_try;         /* CLOCK_MONOTONIC ns: no connect before */
    int want_keyframe;          /* set when a frame is dropped for want of an IDR with a consumer there; the caller clears it */
    struct annexb_stats st;
};

void annexb_init(struct annexb *a, uint16_t port);
void annexb_close(struct annexb *a);
/* the AVCCDecoderConfigurationRecord: 0, or -1 if malformed (then frames are dropped until a good one) */
int annexb_avcc(struct annexb *a, const uint8_t *p, size_t n);
/* one access unit: 1 sent (or queued), 0 dropped, -1 malformed */
int annexb_frame(struct annexb *a, const uint8_t *p, size_t n);
/* the stream stopped: the next frames start at an IDR */
void annexb_reset(struct annexb *a);

#endif
