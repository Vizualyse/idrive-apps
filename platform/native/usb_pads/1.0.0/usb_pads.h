// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * XInput (Xbox 360-style) USB gamepads read straight through usbfs, with no
 * kernel driver: the car's kernel has no evdev, HID or xpad and loads only
 * BMW-signed modules, but its USB port is a host and usbfs is there
 * (knowledge/input.md). A pad is an interface ff/5d/01 under
 * /sys/bus/usb/devices that no driver holds: it is claimed, its LED set to
 * its player, and its interrupt IN endpoint read with one URB at a time (the
 * fd polls POLLOUT when the URB completes). The reports go through pads.c's
 * pad_xinput_report into a struct pad.
 *
 * Taken from vizualyse-moonlight's moonlight_core.c (usb_xinput_find,
 * usb_pad_open, usb_pad_read), its pads[] table replaced by struct usb_pad.
 * Opening needs root (or the device node's owner).
 */
#pragma once
#include "pads.h"
#include <stdbool.h>

struct usb_found {
    char node[64];               /* /dev/bus/usb/BBB/DDD */
    char name[128];
    int iface;
    int ep_in, ep_out;           /* interrupt endpoints, -1 when none */
};

/* The XInput interfaces no driver holds, up to max: how many. */
int usb_xinput_find(struct usb_found *out, int max);

struct usb_pad {
    struct pad pad;              /* pad.fd: the usbfs fd, -1 when closed */
    void *urb;                   /* struct usbdevfs_urb, allocated once, kept */
    unsigned char buf[64];
    unsigned char ep_in;
};

/* A closed usb_pad (call once before use). */
void usb_pad_init(struct usb_pad *u);

/* Claim the pad, light its LED for player slot 0..3, start reading:
 * 0, or -1 (errno set). */
int usb_pad_open(struct usb_pad *u, const struct usb_found *f, int slot);

/* Completed reads mapped into u->pad (pad_xinput_report), then read again:
 * 1 when the state changed (pad_sent() is the caller's), 0 when not, -1
 * when the pad is gone or can't be read (closed then). Call on POLLOUT. */
int usb_pad_read(struct usb_pad *u);

void usb_pad_close(struct usb_pad *u);
