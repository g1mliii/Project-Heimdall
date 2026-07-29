//! Ed25519 payload signing (§22.3, §11.7).
//!
//! ── What this is, honestly ──────────────────────────────────────────────────
//!
//! One signing key is embedded in every copy of the client at build time. It
//! ships inside a binary anyone can download, and it is therefore EXTRACTABLE.
//! A determined user can pull it out and sign anything they like.
//!
//! That is a deliberate, recorded trade-off, not an oversight. `signature_valid`
//! on a run means "produced by something that looks like an unmodified client",
//! and nothing stronger. It is recorded as evidence and NEVER gates acceptance
//! (§0.5): the server's recompute from the stored Parquet is what decides
//! whether a run is honest (§11.5). See docs/integrity-and-privacy.md.
//!
//! ── What is covered ─────────────────────────────────────────────────────────
//!
//! The signature covers the complete raw Parquet frame payload and NOTHING
//! else. The declared hardware and methodology sent in POST /api/runs are not
//! signed. The UI must not imply otherwise.
//!
//! Wire format, fixed by the server's verifier (verify-run.ts): raw Ed25519
//! (not Ed25519ph) over the exact bytes, base64-encoded, ≤512 chars. The
//! matching public key is published as base64 DER SPKI in the server's
//! `HEIMDALL_SIGNING_PUBLIC_KEY`.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};

use crate::error::{AppError, AppResult};

/// Base64 PKCS#8 DER private key, injected at build time.
///
/// Absent in local and contributor builds, which is fine: the client then
/// uploads unsigned and the server records `signature_valid: null`. Only
/// release builds carry a key.
const EMBEDDED_KEY: Option<&str> = option_env!("HEIMDALL_SIGNING_PRIVATE_KEY");

pub struct PayloadSigner {
    key: SigningKey,
}

impl PayloadSigner {
    /// Load the build-time key, if this build has one.
    pub fn from_build() -> Option<Self> {
        let encoded = EMBEDDED_KEY?.trim();
        if encoded.is_empty() {
            return None;
        }
        Self::from_pkcs8_base64(encoded).ok()
    }

    pub fn from_pkcs8_base64(encoded: &str) -> AppResult<Self> {
        let der = BASE64
            .decode(encoded.trim())
            .map_err(|error| AppError::Signing(format!("private key is not base64: {error}")))?;
        let key = SigningKey::from_pkcs8_der(&der).map_err(|error| {
            AppError::Signing(format!("private key is not PKCS#8 Ed25519: {error}"))
        })?;
        Ok(Self { key })
    }

    /// Base64 raw Ed25519 signature over `payload`, exactly as the server's
    /// verifier expects it.
    pub fn sign(&self, payload: &[u8]) -> String {
        BASE64.encode(self.key.sign(payload).to_bytes())
    }

    /// Base64 DER SPKI public key — the value that goes into the server's
    /// `HEIMDALL_SIGNING_PUBLIC_KEY`. Exposed so an operator can read the
    /// public half straight off a build instead of tracking it by hand.
    pub fn public_key_spki_base64(&self) -> AppResult<String> {
        let document = self
            .key
            .verifying_key()
            .to_public_key_der()
            .map_err(|error| {
                AppError::Signing(format!("public key could not be encoded: {error}"))
            })?;
        Ok(BASE64.encode(document.as_bytes()))
    }
}

/// Signature length bound enforced by `finalizeRunRequestSchema`.
pub const MAX_SIGNATURE_CHARS: usize = 512;

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::{DecodePublicKey, EncodePrivateKey};
    use ed25519_dalek::{Verifier, VerifyingKey};

    fn fixed_key() -> SigningKey {
        // Deterministic seed: this is a test vector, never a shipped key.
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn signer() -> PayloadSigner {
        let der = fixed_key().to_pkcs8_der().unwrap();
        PayloadSigner::from_pkcs8_base64(&BASE64.encode(der.as_bytes())).unwrap()
    }

    #[test]
    fn signs_raw_bytes_and_verifies_against_the_published_spki_public_key() {
        let signer = signer();
        let payload = b"PAR1 ... frame parquet ... PAR1";

        let signature = signer.sign(payload);
        let spki = signer.public_key_spki_base64().unwrap();

        // Re-derive the verifier the way the server does: base64 → DER SPKI.
        let der = BASE64.decode(&spki).unwrap();
        let verifying = VerifyingKey::from_public_key_der(&der).unwrap();
        let raw = BASE64.decode(&signature).unwrap();
        let signature: ed25519_dalek::Signature = raw.as_slice().try_into().unwrap();

        assert!(verifying.verify(payload, &signature).is_ok());
    }

    #[test]
    fn a_signature_fits_the_servers_512_char_bound() {
        // Raw Ed25519 is 64 bytes → 88 base64 chars. Guards against anyone
        // switching to a detached-envelope format that would silently overflow.
        let signature = signer().sign(b"payload");
        assert_eq!(signature.len(), 88);
        assert!(signature.len() <= MAX_SIGNATURE_CHARS);
    }

    #[test]
    fn one_flipped_byte_fails_verification() {
        let signer = signer();
        let mut payload = b"PAR1 ... frame parquet ... PAR1".to_vec();
        let signature = signer.sign(&payload);
        payload[4] ^= 0x01;

        let der = BASE64
            .decode(signer.public_key_spki_base64().unwrap())
            .unwrap();
        let verifying = VerifyingKey::from_public_key_der(&der).unwrap();
        let raw = BASE64.decode(&signature).unwrap();
        let signature: ed25519_dalek::Signature = raw.as_slice().try_into().unwrap();

        assert!(verifying.verify(&payload, &signature).is_err());
    }

    /// Interop guard for `apps/desktop/scripts/generate-signing-key.mjs`.
    ///
    /// That script mints the production key with Node's `crypto`, which exports
    /// PKCS#8 v1 for Ed25519 while other toolchains emit v2 (public key
    /// attached). If `ed25519-dalek` ever stopped accepting what Node emits,
    /// the failure would land at release time on a key that cannot be loaded —
    /// so a real Node-generated key is pinned here as a fixture.
    ///
    /// Test key only. Generated once for this assertion, never used anywhere.
    #[test]
    fn loads_a_key_generated_by_the_node_keygen_script() {
        const NODE_PKCS8: &str = "MC4CAQAwBQYDK2VwBCIEIHUubAbVBy7/ozx4QUcTysc50d1/6aLTVW6A1Fhcqz54";
        const NODE_SPKI: &str = "MCowBQYDK2VwAyEAtoMFl7Q3GSlE4ZAthSoAIov3OkqeLiumYiwv3WF/TVE=";

        let signer = PayloadSigner::from_pkcs8_base64(NODE_PKCS8).unwrap();
        // The public half the script printed must be the one this key derives,
        // or the operator would set a server key that rejects every upload.
        assert_eq!(signer.public_key_spki_base64().unwrap(), NODE_SPKI);
        assert_eq!(signer.sign(b"payload").len(), 88);
    }

    #[test]
    fn a_malformed_embedded_key_is_an_error_not_a_panic() {
        assert!(PayloadSigner::from_pkcs8_base64("not base64!!").is_err());
        assert!(PayloadSigner::from_pkcs8_base64(&BASE64.encode([0u8; 8])).is_err());
    }
}

/// Cross-language contract vector (§22.3).
///
/// The desktop client signs in Rust and the hub verifies in Node
/// (`crypto.verify(null, …)` over a base64 DER SPKI key — verify-run.ts). Those
/// two implementations never meet at runtime, so a drift in either encoding
/// would show up only as every desktop run silently recording
/// `signature_valid: false`.
///
/// These constants pin the exact bytes. The matching assertion lives in
/// `apps/web/src/lib/jobs/verify-run.unit.test.ts`, which feeds the SAME
/// payload/signature/key to the server's verifier. Both must be updated
/// together, and neither can be updated without the other failing first.
#[cfg(test)]
pub(crate) mod vector {
    /// Deterministic seed. A test vector, never a shipped key.
    pub const SEED: [u8; 32] = [7u8; 32];
    pub const PAYLOAD: &[u8] = b"PAR1heimdall-desktop-signature-vector-v1PAR1";
    pub const SPKI_BASE64: &str = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
    pub const SIGNATURE_BASE64: &str =
        "OvYTS1iE8BLlqaiIHb4f4/I/eay8Bp1C6g5uW90Q47bJecqybaDNGSzvGXHvv173r0UW8l2H6iEoSxVtRLk0CQ==";
}

#[cfg(test)]
mod vector_tests {
    use super::vector::*;
    use super::*;
    use ed25519_dalek::pkcs8::EncodePrivateKey;
    use ed25519_dalek::SigningKey;

    fn signer_from_seed() -> PayloadSigner {
        let der = SigningKey::from_bytes(&SEED).to_pkcs8_der().unwrap();
        PayloadSigner::from_pkcs8_base64(&BASE64.encode(der.as_bytes())).unwrap()
    }

    #[test]
    fn produces_the_exact_bytes_the_servers_verifier_is_tested_against() {
        let signer = signer_from_seed();
        assert_eq!(signer.public_key_spki_base64().unwrap(), SPKI_BASE64);
        // Ed25519 is deterministic, so this is a stable golden value rather
        // than a re-derivation that could pass while disagreeing with Node.
        assert_eq!(signer.sign(PAYLOAD), SIGNATURE_BASE64);
    }
}
