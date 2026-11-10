# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# A build's finished outputs kept across fresh machines (sourced, not run).
# CI's runners start empty, so a build that skips its work only when its
# last outputs are still in build/ redid it every time (Steam's: two Mesa
# builds, Wine's ntdll and the Proton bundle, ~12 min a release). With
# BUILD_CACHE set to a folder (the workflows restore and save it with
# actions/cache), each part keeps its outputs there as NAME-KEY.tar, KEY
# made from the part's inputs only, and is restored instead of built. Unset
# (a build by hand), nothing changes.
#
#   . tools/build_cache.sh
#   build_cache_get NAME KEY DIR            0 when DIR got NAME's outputs for KEY
#   build_cache_put NAME KEY DIR FILE...    keeps FILE... (relative to DIR)
#
# One key per name: a put drops the name's older keys. A put leaves
# $BUILD_CACHE/.changed, so a workflow saves the folder only when something
# was built.

build_cache_get() {
    [ -n "${BUILD_CACHE:-}" ] && [ -f "$BUILD_CACHE/$1-$2.tar" ] || return 1
    mkdir -p "$3"
    tar -xf "$BUILD_CACHE/$1-$2.tar" -C "$3" || return 1
    echo "build cache: $1 restored ($2)" >&2
}

build_cache_put() {
    [ -n "${BUILD_CACHE:-}" ] || return 0
    _n=$1 _k=$2 _d=$3
    shift 3
    mkdir -p "$BUILD_CACHE"
    tar -cf "$BUILD_CACHE/$_n-$_k.tar.tmp" -C "$_d" "$@" || { rm -f "$BUILD_CACHE/$_n-$_k.tar.tmp"; return 1; }
    for _f in "$BUILD_CACHE/$_n"-*.tar; do
        [ "$_f" = "$BUILD_CACHE/$_n-$_k.tar" ] || rm -f "$_f"
    done
    mv "$BUILD_CACHE/$_n-$_k.tar.tmp" "$BUILD_CACHE/$_n-$_k.tar"
    touch "$BUILD_CACHE/.changed"
    echo "build cache: $_n kept ($_k, $(du -h "$BUILD_CACHE/$_n-$_k.tar" | cut -f1))" >&2
}
