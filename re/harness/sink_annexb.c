/* sink_annexb: hook111's screen-B sink for the car. Stream 111 goes out as
 * Annex-B H.264 on 127.0.0.1:<port> (annexb.c), for an ffmpeg that decodes it
 * into the cluster-render `map` layer (as vizualyse-cast does for the
 * mirror). When the consumer waits for an IDR, the phone is asked for one.
 *
 *   static struct annexb ab;
 *   hook111_install(base, sink_annexb(&ab, 6111), &display);
 */
#include "annexb.h"
#include "hook111.h"

static struct annexb *ab;   /* the one screen B stream */

static void ab_avcc(const uint8_t *p, size_t n) { annexb_avcc(ab, p, n); }
static void ab_start(void) { annexb_reset(ab); }
static void ab_stop(void) { annexb_reset(ab); }   /* the connection stays: the next stream resumes at its IDR */
static void ab_frame(const uint8_t *p, size_t n, uint64_t ts) {
    (void)ts;   /* raw H.264 carries none; the consumer shows frames as they come */
    annexb_frame(ab, p, n);
    if (ab->want_keyframe && hook111_request_keyframe() == 0) ab->want_keyframe = 0;
}

static const struct hook111_sink ab_sink = { ab_avcc, ab_start, ab_stop, ab_frame };

const struct hook111_sink *sink_annexb(struct annexb *a, uint16_t port) {
    ab = a;
    annexb_init(ab, port);
    return &ab_sink;
}
