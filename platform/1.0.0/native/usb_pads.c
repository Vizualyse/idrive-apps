// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* XInput USB gamepads through usbfs (usb_pads.h): vizualyse-moonlight's,
 * from moonlight_core.c. */
#define _GNU_SOURCE
#include "usb_pads.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/usbdevice_fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define USB_SYS "/sys/bus/usb/devices"

/* A sysfs attribute, without its newline: 0, or -1. */
static int sysfs_read(const char *dir, const char *name, char *buf, size_t n) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t got = read(fd, buf, n - 1);
    close(fd);
    if (got < 0) return -1;
    buf[got] = 0;
    while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == ' ')) buf[--got] = 0;
    return 0;
}

static int sysfs_num(const char *dir, const char *name, int base) {
    char b[32];
    if (sysfs_read(dir, name, b, sizeof(b)) < 0 || !b[0]) return -1;
    return (int)strtol(b, NULL, base);
}

int usb_xinput_find(struct usb_found *out, int max) {
    DIR *d = opendir(USB_SYS);
    if (!d) return 0;
    int n = 0;
    struct dirent *e;
    while (n < max && (e = readdir(d)) != NULL) {
        const char *colon = strchr(e->d_name, ':');
        if (!colon) continue;
        char ifdir[300], devdir[300], path[320];
        snprintf(ifdir, sizeof(ifdir), USB_SYS "/%s", e->d_name);
        if (!pad_xinput_match(sysfs_num(ifdir, "bInterfaceClass", 16), sysfs_num(ifdir, "bInterfaceSubClass", 16),
                              sysfs_num(ifdir, "bInterfaceProtocol", 16))) continue;
        snprintf(path, sizeof(path), "%s/driver", ifdir);
        if (access(path, F_OK) == 0) continue;            /* a kernel driver has it (xpad) */
        snprintf(devdir, sizeof(devdir), USB_SYS "/%.*s", (int)(colon - e->d_name), e->d_name);
        int bus = sysfs_num(devdir, "busnum", 10), dev = sysfs_num(devdir, "devnum", 10);
        if (bus < 0 || dev < 0) continue;
        struct usb_found *f = &out[n];
        memset(f, 0, sizeof(*f));
        snprintf(f->node, sizeof(f->node), "/dev/bus/usb/%03d/%03d", bus, dev);
        f->iface = sysfs_num(ifdir, "bInterfaceNumber", 16);
        if (sysfs_read(devdir, "product", f->name, sizeof(f->name)) < 0 || !f->name[0]) {
            char v[8] = "?", pr[8] = "?";
            sysfs_read(devdir, "idVendor", v, sizeof(v));
            sysfs_read(devdir, "idProduct", pr, sizeof(pr));
            snprintf(f->name, sizeof(f->name), "USB gamepad %s:%s", v, pr);
        }
        f->ep_in = f->ep_out = -1;
        DIR *ed = opendir(ifdir);
        struct dirent *ee;
        while (ed && (ee = readdir(ed)) != NULL) {
            if (strncmp(ee->d_name, "ep_", 3) != 0) continue;
            char epdir[600], type[32];
            snprintf(epdir, sizeof(epdir), "%s/%s", ifdir, ee->d_name);
            if (sysfs_read(epdir, "type", type, sizeof(type)) < 0 || strcmp(type, "Interrupt") != 0) continue;
            int addr = sysfs_num(epdir, "bEndpointAddress", 16);
            if (addr < 0) continue;
            if (addr & 0x80) { if (f->ep_in < 0) f->ep_in = addr; }
            else if (f->ep_out < 0) f->ep_out = addr;
        }
        if (ed) closedir(ed);
        if (f->iface < 0 || f->ep_in < 0) continue;
        n++;
    }
    closedir(d);
    return n;
}

void usb_pad_init(struct usb_pad *u) {
    memset(u, 0, sizeof(*u));
    u->pad.fd = -1;
}

static int submit(struct usb_pad *u) {
    struct usbdevfs_urb *urb = u->urb;
    memset(urb, 0, sizeof(*urb));
    urb->type = USBDEVFS_URB_TYPE_INTERRUPT;
    urb->endpoint = u->ep_in;
    urb->buffer = u->buf;
    urb->buffer_length = sizeof(u->buf);
    return ioctl(u->pad.fd, USBDEVFS_SUBMITURB, urb);
}

int usb_pad_open(struct usb_pad *u, const struct usb_found *f, int slot) {
    if (!u->urb && !(u->urb = calloc(1, sizeof(struct usbdevfs_urb)))) return -1;
    int fd = open(f->node, O_RDWR | O_CLOEXEC);
    if (fd < 0) return -1;
    unsigned int iface = (unsigned int)f->iface;
    if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &iface) < 0) { int e = errno; close(fd); errno = e; return -1; }
    if (f->ep_out >= 0) {
        unsigned char led[3];
        pad_xinput_led(slot, led);
        struct usbdevfs_bulktransfer bt = { (unsigned int)f->ep_out, sizeof(led), 100, led };
        ioctl(fd, USBDEVFS_BULK, &bt);   /* only the LED: a pad that refuses it still works */
    }
    void *urb = u->urb;
    memset(&u->pad, 0, sizeof(u->pad));
    u->pad.fd = fd;
    u->pad.kind = PAD_XINPUT;
    snprintf(u->pad.path, sizeof(u->pad.path), "%s", f->node);
    snprintf(u->pad.name, sizeof(u->pad.name), "%s", f->name);
    u->urb = urb;
    u->ep_in = (unsigned char)f->ep_in;
    if (submit(u) < 0) { int e = errno; close(fd); u->pad.fd = -1; errno = e; return -1; }
    return 0;
}

int usb_pad_read(struct usb_pad *u) {
    struct usbdevfs_urb *done;
    int changed = 0;
    while (ioctl(u->pad.fd, USBDEVFS_REAPURBNDELAY, &done) == 0) {
        if (done->status == 0) {
            if (pad_xinput_report(&u->pad, u->buf, done->actual_length)) changed = 1;
        } else if (done->status == -ENODEV || done->status == -ESHUTDOWN) {
            usb_pad_close(u);
            return -1;
        }
        /* anything else (a CRC or babble error): read on */
        if (submit(u) < 0) { usb_pad_close(u); return -1; }
    }
    if (errno != EAGAIN) { usb_pad_close(u); return -1; }
    return changed;
}

void usb_pad_close(struct usb_pad *u) {
    if (u->pad.fd >= 0) close(u->pad.fd);   /* kills the URB, releases the interface */
    u->pad.fd = -1;
}
