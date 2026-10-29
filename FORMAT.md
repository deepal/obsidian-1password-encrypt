# Protected note format, version 1

The entire UTF-8 Markdown file is one block, with optional outer whitespace:

```xml
<protected-note version="1" account="account-name-or-id" secret-ref="op://vault-id/item-id/password">
BASE64_JSON_PAYLOAD
</protected-note>
```

The writer emits the attributes in exactly the order shown. Attribute values use
XML entity escaping. The reader is a strict envelope parser, not a general XML
engine: no DTDs, external entities, executable XML, or surrounding note content.
Vault and item IDs are 26 lowercase alphanumeric characters. An optional section
identifier can precede the field identifier. Names are not accepted in references.

The body is canonical Base64 of UTF-8 JSON with these fields:

```json
{
  "kdf": {
    "name": "scrypt", "N": 131072, "r": 8, "p": 1, "keyLength": 32,
    "salt": "BASE64_16_RANDOM_BYTES"
  },
  "cipher": "aes-256-gcm",
  "nonce": "BASE64_12_RANDOM_BYTES",
  "tag": "BASE64_16_BYTE_AUTHENTICATION_TAG",
  "ciphertext": "BASE64_CIPHERTEXT"
}
```

Decode the exact secret field string as UTF-8 without trimming or Unicode
normalization. Derive a 32-byte key with scrypt and the stored 16-byte salt,
with a maximum-memory setting of 256 MiB. V1 accepts only the fixed parameters
above and rejects other algorithm names, costs, or byte lengths.

AES-GCM additional authenticated data is the UTF-8 encoding of the compact JSON
array below, in this exact order, using the decoded attribute values:

```text
["protected-notes",1,account,secretRef,"scrypt",131072,8,1,32,salt,"aes-256-gcm"]
```

Generate a new nonce for every encryption, including saves and recovery copies.
The salt remains stable for a note's lifetime. Return no plaintext before the
authentication tag has been verified. The path/filename is not part of key
derivation or authentication, so encrypted files can be renamed or moved.

Recovery files contain `{version: 1, path, baselineHash, envelope}`. The hash is
lowercase SHA-256 of the exact saved encrypted Markdown, including whitespace.
`envelope` is a complete encrypted Markdown block in the format above. No secret
or plaintext draft is stored there. If the original baseline changed, restore
as a new encrypted file rather than overwriting or merging ciphertext.
