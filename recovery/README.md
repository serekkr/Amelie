# Offline vault recovery

`amelie-recovery.py` decrypts an Amelie vault **without the Amelie app** — a
break-glass tool for when the app won't run, or you only have a backup of the
encrypted files and want to read them on any machine.

It is **not a backdoor.** It reproduces exactly what Amelie does at unlock time,
using only your passphrase: it reads the KDF parameters and salt from the vault
header (these are not secret) and derives the key from the password *you* type.
Without the correct passphrase it derives nothing and decrypts nothing.

## Usage

```bash
pip install -r requirements.txt          # argon2-cffi + cryptography
./amelie-recovery.py /path/to/vault -o ./recovered
```

You'll be prompted for the passphrase (or pass it with `-p`, less safe — it
stays in your shell history). Use `--list` for a dry run that decrypts nothing
to disk.

The `vault` folder is the one containing `.amelie-vault.json`, `notes/` and
`attachments/`. Decrypted notes and attachments are written to the output
folder, mirroring the vault's structure; plaintext files are copied as-is.

## What it supports

| Layer        | Formats |
|--------------|---------|
| Key deriv.   | Argon2id (current), scrypt, PBKDF2-HMAC-SHA512 (older vaults) |
| Notes        | AES-256-GCM |
| Attachments  | AES-256-GCM (chunked, current) and AES-256-CTR (legacy) |

All parameters are read from the vault header, so it stays in sync with vaults
created by any version.
