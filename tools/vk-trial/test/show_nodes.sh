#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
# gate_test.sh: what the child sees of the DRM nodes (major,minor in hex),
# by absolute path, by relative path, through a symlink; then waits so the
# test can look from outside.
echo "child card0 abs: $(stat -c %t,%T /dev/dri/card0)"
cd /dev/dri && echo "child card0 rel: $(stat -c %t,%T card0)"
echo "child card0 link: $(stat -L -c %t,%T /dev/dri/by-path/pci-0000:00:02.0-card)"
echo "child render: $(stat -c %t,%T /dev/dri/renderD128)"
sleep 3
