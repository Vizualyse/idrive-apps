/* hook111: the CarPlay alternate screen (AirPlay screen stream 111) for
 * libNmeCarPlay.so in carplay 20.40.2 (build-id 8e502fa4...). See
 * re/findings-20.40.2.md for every address used. */
#ifndef HOOK111_H
#define HOOK111_H
#include <stddef.h>
#include <stdint.h>

/* Where screen B's stream goes: the AVCC header, then length-prefixed H.264
 * access units (as the phone sends them, decrypted). */
struct hook111_sink {
    void (*avcc)(const uint8_t *p, size_t n);
    void (*start)(void);
    void (*stop)(void);
    void (*frame)(const uint8_t *p, size_t n, uint64_t ts);
};

/* The second display as advertised in /info. */
struct hook111_display {
    const char *uuid;
    int width_px, height_px, width_mm, height_mm, max_fps, features;
    const char *initial_url;
    const char *suggest_urls[3];
    int port;  /* TCP port the stream-111 listener asks for (open in the unit's firewall) */
};

/* Install on an already-loaded libNmeCarPlay.so at load address `base`.
 * Returns 0, or -1 when the build is not the one the addresses are for
 * (nothing is patched then). */
int hook111_install(uintptr_t base, const struct hook111_sink *sink, const struct hook111_display *d);

/* The load address of libNmeCarPlay.so if loaded and the expected build, else 0. */
uintptr_t hook111_find(void);

/* Send a session command to the phone (POST /command on the events
 * connection), e.g. "updateViewArea". params: the library's dictionary, or
 * NULL. 0, or an error (-6709 before the events connection is up). */
int hook111_send_command(void *session, const char *type, void *params);

/* Ask the phone for a keyframe on screen B (forceKeyFrame), at most once a
 * second; for a sink whose consumer waits for an IDR. 0 or an error. */
int hook111_request_keyframe(void);

/* Log every SETUP request and response, phone command, TEARDOWN, /info
 * displays and sent command as a binary plist, <dir>/<nnn>-<what>.bplist
 * (at most 500). Off unless dir exists and is writable; NULL turns it off. */
void hook111_log_to(const char *dir);

/* The mode file (contents off | alt | full), read at every SETUP and /info.
 * Not called: full. Called with a path that does not exist: off. */
void hook111_mode_file(const char *path);
/* The second display's size file ("WxH@fps", e.g. 1056x384@30), read at
 * every /info; not called, missing or invalid: the configured display. */
void hook111_display_file(const char *path);
/* The second display's view file (contents cluster | map | card: the phone's
 * cluster view named as initialURL), read at every /info; not called,
 * missing or anything else: the configured initialURL. */
void hook111_view_file(const char *path);
/* The second display's safe area file ("x,y,w,h" in the offered display's
 * pixels), read at every SETUP and /info: with a valid one, /info gets
 * viewAreas records with it and SETUP answers viewAreas too. */
void hook111_safearea_file(const char *path);
/* The bench's trial files (features, info-a.plist, info-b.plist, unfallback)
 * live in dir; not called: none are read. See hook111.c, "trial files". */
void hook111_trial_dir(const char *dir);
/* 0 off, 1 alt, 2 full, as it applies now; whether it fell back to off. */
int hook111_mode(void);
int hook111_fell_back(void);

/* The status file (<log dir>/status) gets these lines from the sink too. */
#include <stdio.h>
extern void (*hook111_status_extra)(FILE *f);

/* Counters, for tests and logs. */
struct hook111_stats { int setups_111, accepted, pump_rc, pump_done, enabled_features, info_records, teardowns, suggest_ui, commands_sent, keyframe_requests, logged, refusals,
    b_avcc, b_avcc_bytes, b_starts, b_stops, b_frames, sent_files, last_send_rc,
    idle_held, idle_rc, b_width, b_height, info_extra_a, info_extra_b; long long b_frame_bytes; };
extern volatile struct hook111_stats hook111_stats;

#endif
