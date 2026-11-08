# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Mosquitto 2.0.21's src/conf.c checks every listener's TLS files in
# config__check() without WITH_TLS around it, so a build without TLS fails
# (the listener struct has no cafile then). This puts the check inside
# #ifdef WITH_TLS: from its comment up to the function's return.
/Check for missing TLS cafile\/capath\/certfile\/keyfile/ { print "#ifdef WITH_TLS"; inside = 1; done = 1 }
inside && /^\treturn MOSQ_ERR_SUCCESS;/ { print "#endif"; inside = 0; closed = 1 }
{ print }
END { if (!done || !closed) { print "no-tls-check.awk: config__check's TLS check not found" > "/dev/stderr"; exit 1 } }
