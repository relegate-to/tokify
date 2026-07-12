// Package sharing is the pure-crypto core of Tokify's end-to-end-encrypted
// sharing feature (e2ee-sharing-plan-v2.md §2, §2a, §2b). Everything here is
// deterministic and side-effect-free: key generation, sealing to public keys,
// canonical encodings, signatures, and epoch-chain verification. No HTTP, no
// database, no services — those are built against the fixed contracts this
// package exposes.
//
// Threat model (plan §2a/§2b): the server is honest-but-curious at minimum and
// potentially malicious. Confidentiality is not enough; every wrap binds its
// database context into AEAD AAD so a server that splices ciphertext A under
// row B's metadata gets a decryption failure, and everything an author or admin
// asserts is Ed25519-signed so tampering is detectable rather than silent.
//
// # Fixed contracts
//
// A schema and an operations layer are being built in parallel against these,
// so they are frozen:
//
//   - Binary values destined for DB text columns are standard-encoding base64,
//     matching the existing neonsync crypto. Chain-link hashes are lowercase
//     hex. Epochs are integers starting at 1.
//   - Canonical bytes for signing/AAD are json.Marshal of fixed-field structs
//     (deterministic key order; same trick as neonsync's canonicalEntry).
//   - Ed25519 signatures are computed over []byte(domain) || '\n' || canonical.
//     Domain strings are the frozen constants in this package.
//
// # Deviation from plan §3: per-entry DEKs are derived, not stored
//
// The plan's schema shows a wrapped_dek_author column (§3). This package
// deliberately does NOT store a per-entry DEK. Entry ids in this system are
// keyed content hashes (neonsync.EntryID), so the plaintext for a given id is
// immutable — an edit mints a new id rather than mutating an entry. That makes
// a stored, randomly-minted DEK pure overhead: the author can re-derive it
// deterministically from the account DEK and the entry id via
// DeriveEntryDEK. There is therefore no wrapped_dek_author to persist or to
// keep in sync, and one fewer secret at rest. Grants still wrap the (derived)
// DEK to audience epoch keys exactly as the plan requires — only the author's
// self-wrap is replaced by derivation.
package sharing
