// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* Built with gcc 8 (the unit's glibc 2.27 era): intrinsics nanors uses that
 * arrived in gcc 10, written from older ones. Forced in with -include. */
#pragma once
#if defined(__x86_64__) && defined(__GNUC__) && __GNUC__ < 10
#include <immintrin.h>
#ifndef _mm256_loadu2_m128i
#define _mm256_loadu2_m128i(hi, lo) \
    _mm256_inserti128_si256(_mm256_castsi128_si256(_mm_loadu_si128((const __m128i *)(lo))), \
                            _mm_loadu_si128((const __m128i *)(hi)), 1)
#endif
#ifndef _mm256_storeu2_m128i
#define _mm256_storeu2_m128i(hi, lo, a) do { __m256i a_ = (a); \
    _mm_storeu_si128((__m128i *)(lo), _mm256_castsi256_si128(a_)); \
    _mm_storeu_si128((__m128i *)(hi), _mm256_extracti128_si256(a_, 1)); } while (0)
#endif
#endif
