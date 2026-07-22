#!/usr/bin/env python3
"""
amelie-recovery.py — decrypt an Amelie vault OFFLINE, without the Amelie app.

This is a break-glass tool: it reproduces exactly what Amelie does at unlock time,
using only your passphrase. It is NOT a backdoor — without the correct passphrase
it cannot derive the key and decrypts nothing. It reads the KDF parameters and
salt straight from the vault header (they are not secret); the only secret needed
is the password you type.

    pip install argon2-cffi cryptography
    ./amelie-recovery.py /path/to/vault [-o OUTPUT_DIR] [-p PASSWORD] [--list]

Vault layout it understands:
    <vault>/.amelie-vault.json     envelope header (kdf, params, salt, wrapped DEK)
    <vault>/notes/**               encrypted notes  (*.enc / *.amd, base64 AES-GCM)
    <vault>/attachments/**         encrypted files  (magic-header binary)

Supported formats (mirrors src/main/main.js):
    KDF          argon2id | scrypt | pbkdf2(sha512)
    Notes        AES-256-GCM,  base64( iv[12] | ciphertext | tag[16] )
    Attachments  AMELIEG1 = AES-256-GCM chunked (current)
                 AMELIEC1 = AES-256-CTR         (legacy, unauthenticated)
                 AMELIEH1 = ChaCha20            (legacy, unsupported here)
"""
import argparse
import base64
import getpass
import json
import os
import shutil
import sys

try:
    from argon2.low_level import hash_secret_raw, Type
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError as e:
    sys.exit("Missing dependency: %s\nRun:  pip install argon2-cffi cryptography" % e)

import hashlib

ENC_EXTS = ('.enc', '.amd')
ATT_MAGIC = {b'AMELIEG1': 'gcm', b'AMELIEC1': 'ctr', b'AMELIEH1': 'chacha'}
ATT_MAGIC_LEN = 8
ATT_GCM_HEADER = ATT_MAGIC_LEN + 12 + 4   # magic + 12B base nonce + 4B chunkSize (BE)
HEADER_NAME = '.amelie-vault.json'
# Files that are Amelie internals, never user data — don't emit them.
SKIP_NAMES = {HEADER_NAME, '.salt', '.amelie-verify', '.verify'}


# ── key derivation (KEK) ─────────────────────────────────────────────────────
def derive_kek(password: str, kdf: str, params: dict, salt: bytes) -> bytes:
    pw = password.encode('utf-8')
    if kdf == 'argon2id':
        return hash_secret_raw(
            pw, salt,
            time_cost=int(params['iterations']),
            memory_cost=int(params['memorySize']),
            parallelism=int(params['parallelism']),
            hash_len=32, type=Type.ID,
        )
    if kdf == 'scrypt':
        N, r, p = int(params['N']), int(params['r']), int(params['p'])
        # maxmem must exceed 128*N*r (~32 MiB for the default params).
        return hashlib.scrypt(pw, salt=salt, n=N, r=r, p=p, dklen=32,
                              maxmem=256 * 1024 * 1024)
    # pbkdf2 (legacy default: 310000 iterations, SHA-512)
    iters = int(params.get('iterations', 310000))
    h = params.get('hash', 'sha512')
    return hashlib.pbkdf2_hmac(h, pw, salt, iters, dklen=32)


# ── AEAD helpers ─────────────────────────────────────────────────────────────
def gcm_decrypt(key: bytes, blob: bytes) -> bytes:
    """blob = iv[12] | ciphertext | tag[16]  (cryptography wants ciphertext|tag)."""
    iv, body = blob[:12], blob[12:]
    return AESGCM(key).decrypt(iv, body, None)


def decrypt_note(key: bytes, raw: bytes) -> bytes:
    return gcm_decrypt(key, base64.b64decode(raw))


def _att_nonce(base: bytes, i: int) -> bytes:
    n = int.from_bytes(base, 'big')
    n = (n + i) & ((1 << 96) - 1)
    return n.to_bytes(12, 'big')


def decrypt_attachment(key: bytes, raw: bytes) -> bytes:
    algo = ATT_MAGIC.get(raw[:ATT_MAGIC_LEN])
    if algo == 'gcm':
        base = raw[ATT_MAGIC_LEN:ATT_MAGIC_LEN + 12]
        chunk = int.from_bytes(raw[ATT_MAGIC_LEN + 12:ATT_GCM_HEADER], 'big')
        out, pos, i = bytearray(), ATT_GCM_HEADER, 0
        aes = AESGCM(key)
        while pos < len(raw):
            enc_len = min(chunk + 16, len(raw) - pos)
            if enc_len < 16:
                raise ValueError('corrupt attachment (short GCM chunk)')
            out += aes.decrypt(_att_nonce(base, i), raw[pos:pos + enc_len], None)
            pos += enc_len
            i += 1
        return bytes(out)
    if algo == 'ctr':
        iv = raw[ATT_MAGIC_LEN:ATT_MAGIC_LEN + 16]
        c = Cipher(algorithms.AES(key), modes.CTR(iv)).decryptor()
        return c.update(raw[ATT_MAGIC_LEN + 16:]) + c.finalize()
    if algo == 'chacha':
        raise ValueError('ChaCha20 attachment — not supported by this tool')
    raise ValueError('not an encrypted attachment')


def att_magic(path: str) -> bool:
    try:
        with open(path, 'rb') as f:
            return f.read(ATT_MAGIC_LEN) in ATT_MAGIC
    except OSError:
        return False


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description='Decrypt an Amelie vault offline.')
    ap.add_argument('vault', help='vault folder (contains .amelie-vault.json, notes/, attachments/)')
    ap.add_argument('-o', '--out', help='output folder (default: <vault>-decrypted)')
    ap.add_argument('-p', '--password', help='passphrase (omit to be prompted securely)')
    ap.add_argument('--list', action='store_true', help='dry run: list what would be written, decrypt nothing to disk')
    args = ap.parse_args()

    vault = os.path.abspath(args.vault)
    if not os.path.isdir(vault):
        sys.exit('Not a directory: %s' % vault)
    out = os.path.abspath(args.out) if args.out else vault.rstrip('/') + '-decrypted'

    header_path = os.path.join(vault, HEADER_NAME)
    header = None
    if os.path.isfile(header_path):
        with open(header_path) as f:
            header = json.load(f)

    password = args.password or getpass.getpass('Passphrase: ')

    # Derive the DATA key (DEK).
    if header:
        kdf = header.get('kdf', 'pbkdf2')
        algo = 'chacha' if header.get('algo') == 'chacha' else 'aes'
        salt = bytes.fromhex(header['salt'])
        kek = derive_kek(password, kdf, header.get('kdfParams', {}), salt)
        try:
            wrapped = base64.b64decode(header['wrappedKey'])
            if algo == 'chacha':
                sys.exit('ChaCha20 vault — not supported by this tool')
            dek_hex = gcm_decrypt(kek, wrapped).decode('ascii')
            dek = bytes.fromhex(dek_hex)
        except Exception:
            sys.exit('Wrong passphrase (could not unwrap the vault key).')
        print('Vault: %s\n  kdf=%s  algo=%s  key unwrapped OK' % (vault, kdf, algo))
    else:
        # Legacy pre-envelope vault (no header): the derived key IS the data key.
        # We can only guess the KDF — Amelie's fallback is pbkdf2/sha512/310000.
        print('No %s found → assuming LEGACY vault (pbkdf2, key = derived key).' % HEADER_NAME)
        salt_file = os.path.join(vault, '.salt')
        if not os.path.isfile(salt_file):
            # salt may live in the app-data dir, not the vault; ask the user to place it here.
            sys.exit('No header and no .salt in the vault — cannot derive the legacy key.')
        with open(salt_file, 'rb') as f:
            salt = f.read()
        dek = derive_kek(password, 'pbkdf2', {}, salt)

    # Walk the vault and emit decrypted / copied files.
    n_notes = n_att = n_copy = n_fail = 0
    for root, _dirs, files in os.walk(vault):
        for name in files:
            if name in SKIP_NAMES:
                continue
            src = os.path.join(root, name)
            rel = os.path.relpath(src, vault)
            is_enc_ext = name.endswith(ENC_EXTS)
            try:
                with open(src, 'rb') as f:
                    raw = f.read()
                is_att = raw[:ATT_MAGIC_LEN] in ATT_MAGIC
                if is_enc_ext or is_att:
                    if is_att:
                        data = decrypt_attachment(dek, raw)
                        kind = 'att'
                    else:
                        data = decrypt_note(dek, raw)
                        kind = 'note'
                    # strip the .enc/.amd marker from the output name
                    dst_rel = rel
                    for e in ENC_EXTS:
                        if dst_rel.endswith(e):
                            dst_rel = dst_rel[:-len(e)]
                            break
                else:
                    data = raw
                    dst_rel = rel
                    kind = 'copy'
            except Exception as ex:
                n_fail += 1
                print('  ! FAILED %s (%s)' % (rel, ex))
                continue

            if kind == 'note':
                n_notes += 1
            elif kind == 'att':
                n_att += 1
            else:
                n_copy += 1

            if args.list:
                print('  %-5s %s -> %s' % (kind, rel, dst_rel))
                continue
            dst = os.path.join(out, dst_rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as f:
                f.write(data)

    where = '(dry run, nothing written)' if args.list else ('→ %s' % out)
    print('\nDone: %d notes, %d attachments decrypted, %d plaintext copied, %d failed %s'
          % (n_notes, n_att, n_copy, n_fail, where))


if __name__ == '__main__':
    main()
