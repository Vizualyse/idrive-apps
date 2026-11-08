/*
 * kspreload: a software stand-in for the unit's Intel IAS keystore (/dev/keystore),
 * for the emulator only. In /etc/ld.so.preload: oapcontroller starts MainApp and
 * its keychain script through uidrun, which clears the environment.
 *
 * libmgucrypto calls the keystore client functions below through its PLT, so
 * defining them here replaces the kernel device. The signatures are read from
 * libmgucrypto's own client (each packs its arguments into one ioctl on
 * /dev/keystore, type '7'). Semantics, self-consistent and nothing more:
 *
 *   a client ticket       8 random bytes
 *   a wrapped key         nonce(12) | AES-256-GCM(master, key) | tag(16), so
 *                         wrapped size = key size + 28
 *   load_key              unwraps into a slot (per process)
 *   encrypt / decrypt     AES-GCM with the slot's key and the caller's IV,
 *                         the 16-byte tag appended to the ciphertext
 *
 * The master key is a fixed constant: keys wrapped here are bound to the
 * emulator, not to any car (the car's wrapped keys can't be opened, as on
 * another unit). Every call is logged to stderr ("kspreload: ...").
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <errno.h>
#include <gcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#define NONCE 12
#define TAG 16
#define SLOTS 64

static const unsigned char master[32] = "mgu-emu keystore master key 001";
static struct { int used; size_t len; unsigned char key[64]; } slot[SLOTS];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

#define LOG(...) do { fprintf(stderr, "kspreload: " __VA_ARGS__); fputc('\n', stderr); } while (0)

/* key spec -> key bytes; unknown specs are logged and taken as 256-bit */
static size_t spec_len(uint32_t spec)
{
    switch (spec) {
    case 1: return 16;
    case 2: return 32;
    default: LOG("unknown key spec %u, taking 32 bytes", spec); return 32;
    }
}

static void init(void)
{
    if (!gcry_control(GCRYCTL_INITIALIZATION_FINISHED_P)) {
        gcry_check_version(NULL);
        gcry_control(GCRYCTL_INITIALIZATION_FINISHED, 0);
    }
}

/* AES-GCM with a key of 16/24/32 bytes; enc: out = ct | tag, dec: in = ct | tag */
static int gcm(int enc, const unsigned char *key, size_t klen, const unsigned char *iv, size_t ivlen,
               const unsigned char *in, size_t inlen, unsigned char *out)
{
    gcry_cipher_hd_t h;
    int algo = klen == 16 ? GCRY_CIPHER_AES128 : klen == 24 ? GCRY_CIPHER_AES192 : GCRY_CIPHER_AES256;
    int rc = -EINVAL;
    init();
    if (gcry_cipher_open(&h, algo, GCRY_CIPHER_MODE_GCM, 0)) return -EINVAL;
    if (gcry_cipher_setkey(h, key, klen) || gcry_cipher_setiv(h, iv, ivlen)) goto done;
    if (enc) {
        if (gcry_cipher_encrypt(h, out, inlen, in, inlen) || gcry_cipher_gettag(h, out + inlen, TAG)) goto done;
    } else {
        if (inlen < TAG) goto done;
        size_t n = inlen - TAG;
        if (gcry_cipher_decrypt(h, out, n, in, n) || gcry_cipher_checktag(h, in + n, TAG)) { rc = -EBADMSG; goto done; }
    }
    rc = 0;
done:
    gcry_cipher_close(h);
    return rc;
}

static int wrap(const unsigned char *key, size_t len, unsigned char *wrapped)
{
    init();
    gcry_randomize(wrapped, NONCE, GCRY_STRONG_RANDOM);
    return gcm(1, master, 32, wrapped, NONCE, key, len, wrapped + NONCE);
}

int ias_keystore_register_client(uint32_t spec, uint8_t ticket[8])
{
    if (!ticket) return -EFAULT;
    init();
    gcry_randomize(ticket, 8, GCRY_STRONG_RANDOM);
    LOG("register_client(spec %u)", spec);
    return 0;
}

int ias_keystore_unregister_client(const uint8_t ticket[8])
{
    (void)ticket;
    LOG("unregister_client");
    return 0;
}

int ias_keystore_wrapped_key_size(uint32_t spec, size_t *wrapped, size_t *unwrapped)
{
    size_t n = spec_len(spec);
    if (wrapped) *wrapped = n + NONCE + TAG;
    if (unwrapped) *unwrapped = n;
    LOG("wrapped_key_size(spec %u) = %zu / %zu", spec, n + NONCE + TAG, n);
    return 0;
}

int ias_keystore_generate_key(const uint8_t ticket[8], uint32_t spec, uint8_t *wrapped)
{
    unsigned char key[64];
    size_t n = spec_len(spec);
    if (!ticket || !wrapped) return -EFAULT;
    init();
    gcry_randomize(key, n, GCRY_VERY_STRONG_RANDOM);
    int rc = wrap(key, n, wrapped);
    LOG("generate_key(spec %u) = %d", spec, rc);
    return rc;
}

int ias_keystore_wrap_key(const uint8_t ticket[8], const uint8_t *key, uint32_t len, uint32_t spec, uint8_t *wrapped)
{
    if (!ticket || !key || !wrapped) return -EFAULT;
    if (len != spec_len(spec) || len > 64) { LOG("wrap_key: %u bytes for spec %u", len, spec); return -EINVAL; }
    int rc = wrap(key, len, wrapped);
    LOG("wrap_key(spec %u, %u bytes) = %d", spec, len, rc);
    return rc;
}

int ias_keystore_load_key(const uint8_t ticket[8], const uint8_t *wrapped, uint32_t wlen, uint32_t *slot_id)
{
    unsigned char key[64];
    if (!ticket || !wrapped || !slot_id) return -EFAULT;
    if (wlen <= NONCE + TAG || wlen - NONCE - TAG > sizeof key) { LOG("load_key: bad size %u", wlen); return -EINVAL; }
    size_t n = wlen - NONCE - TAG;
    int rc = gcm(0, master, 32, wrapped, NONCE, wrapped + NONCE, wlen - NONCE, key);
    if (rc) { LOG("load_key: key not wrapped by this keystore (%d)", rc); return rc; }
    pthread_mutex_lock(&lock);
    int i;
    for (i = 0; i < SLOTS && slot[i].used; i++) ;
    if (i < SLOTS) { slot[i].used = 1; slot[i].len = n; memcpy(slot[i].key, key, n); }
    pthread_mutex_unlock(&lock);
    if (i == SLOTS) { LOG("load_key: no free slot"); return -ENOMEM; }
    *slot_id = i;
    LOG("load_key(%u bytes) = slot %d", wlen, i);
    return 0;
}

int ias_keystore_unload_key(const uint8_t ticket[8], uint32_t id)
{
    if (!ticket) return -EFAULT;
    if (id >= SLOTS) return -EINVAL;
    pthread_mutex_lock(&lock);
    memset(&slot[id], 0, sizeof slot[id]);
    pthread_mutex_unlock(&lock);
    LOG("unload_key(slot %u)", id);
    return 0;
}

int ias_keystore_encrypt_size(uint32_t algo, uint32_t in, size_t *out)
{
    if (!out) return -EFAULT;
    *out = (size_t)in + TAG;
    (void)algo;
    return 0;
}

int ias_keystore_decrypt_size(uint32_t algo, uint32_t in, size_t *out)
{
    if (!out) return -EFAULT;
    if (in < TAG) return -EINVAL;
    *out = in - TAG;
    (void)algo;
    return 0;
}

static int ks_crypt(int enc, const uint8_t ticket[8], uint32_t id, uint32_t algo, const uint8_t *iv, uint32_t ivlen,
                 const uint8_t *in, uint32_t inlen, uint8_t *out)
{
    if (!ticket || !in || !out) return -EFAULT;
    if (id >= SLOTS || !slot[id].used) { LOG("%scrypt: slot %u not loaded", enc ? "en" : "de", id); return -EINVAL; }
    int rc = gcm(enc, slot[id].key, slot[id].len, iv, ivlen, in, inlen, out);
    if (rc) LOG("%scrypt(slot %u, algo %u, %u bytes) = %d", enc ? "en" : "de", id, algo, inlen, rc);
    return rc;
}

int ias_keystore_encrypt(const uint8_t ticket[8], uint32_t id, uint32_t algo, const uint8_t *iv, uint32_t ivlen,
                         const uint8_t *in, uint32_t inlen, uint8_t *out)
{
    return ks_crypt(1, ticket, id, algo, iv, ivlen, in, inlen, out);
}

int ias_keystore_decrypt(const uint8_t ticket[8], uint32_t id, uint32_t algo, const uint8_t *iv, uint32_t ivlen,
                         const uint8_t *in, uint32_t inlen, uint8_t *out)
{
    return ks_crypt(0, ticket, id, algo, iv, ivlen, in, inlen, out);
}

/* the keystore module's own key (0x88 bytes out); nothing to give: zeros */
int ias_keystore_get_ksm_key(uint8_t *out)
{
    if (!out) return -EFAULT;
    memset(out, 0, 0x88);
    LOG("get_ksm_key");
    return 0;
}
