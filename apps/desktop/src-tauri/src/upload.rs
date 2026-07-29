//! Payload custody, signing handoff and the direct-to-R2 PUT (§22.3, §22.5).
//!
//! ── Why the Parquet crosses the IPC boundary exactly once ───────────────────
//!
//! The webview builds the frame Parquet (§22.1 mandates the same
//! `hyparquet-writer` bytes the browser produces, so the server's §11.5
//! recompute stays comparable). Rust holds the signing key and does the HTTP.
//! Naively that means shipping ≤64 MiB across IPC twice — once to sign, once to
//! upload.
//!
//! `prepare_payload` therefore does BOTH: it signs the bytes and takes custody
//! of them. `put_prepared_payload` then uploads the bytes it already holds. The
//! two commands are coupled by design — calling the second without the first is
//! `no-prepared-payload`, not a silent empty upload.
//!
//! The transfer uses Tauri 2's raw IPC channel (`InvokeBody::Raw`), not the
//! JSON one: base64-in-JSON would inflate 64 MiB to 85 MiB of string.

use std::sync::Mutex;

use futures_util::StreamExt as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::signing::{PayloadSigner, MAX_SIGNATURE_CHARS};

pub const EVENT_UPLOAD_PROGRESS: &str = "upload://progress";

/// Content type the presigned PUT is signed for; a mismatch is a 403 from R2.
const PARQUET_CONTENT_TYPE: &str = "application/vnd.apache.parquet";

/// Hub origin. Baked in at build time so a shipped client cannot be pointed at
/// an attacker's host by editing a config file; overridable for local
/// development against `pnpm dev`.
///
/// NOTE: rate limits key on the client IP, and the server's `clientIp()`
/// returns "unknown" unless `RATE_LIMIT_TRUSTED_PROXY` is set. Behind Cloudflare
/// in production that is configured — on a misconfigured origin every desktop
/// user lands in one bucket and throttles each other.
pub fn api_base_url() -> String {
    option_env!("HEIMDALL_API_BASE_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http://localhost:3000")
        .trim_end_matches('/')
        .to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub sent_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPayload {
    /// Base64 raw Ed25519 signature, or absent in builds with no embedded key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub byte_length: usize,
}

/// The bytes `prepare_payload` took custody of, awaiting their PUT.
#[derive(Default)]
pub struct PayloadState {
    held: Mutex<Option<Vec<u8>>>,
}

impl PayloadState {
    fn take(&self) -> AppResult<Vec<u8>> {
        self.held
            .lock()
            .map_err(|_| AppError::Internal("payload state is poisoned".into()))?
            .take()
            .ok_or(AppError::NoPreparedPayload)
    }

    fn put(&self, bytes: Vec<u8>) -> AppResult<()> {
        let mut held = self
            .held
            .lock()
            .map_err(|_| AppError::Internal("payload state is poisoned".into()))?;
        *held = Some(bytes);
        Ok(())
    }

    /// Drop custody without uploading — a discarded capture must not leave a
    /// copy of the user's frame data resident.
    pub fn clear(&self) {
        if let Ok(mut held) = self.held.lock() {
            *held = None;
        }
    }
}

/// Sign the payload and take custody of it.
pub fn prepare(state: &PayloadState, bytes: Vec<u8>) -> AppResult<PreparedPayload> {
    // A signature the server's schema would reject is worse than none: it
    // fails the whole finalize instead of just going unverified.
    let signature = PayloadSigner::from_build()
        .map(|signer| signer.sign(&bytes))
        .filter(|signature| signature.len() <= MAX_SIGNATURE_CHARS);
    let byte_length = bytes.len();
    state.put(bytes)?;
    Ok(PreparedPayload {
        signature,
        byte_length,
    })
}

/// PUT the held bytes to the presigned URL, emitting progress as it goes.
///
/// This is why the upload does not run in the webview: Tauri's CSP allows only
/// the hub origin, so a webview PUT to an R2 presigned URL would be blocked.
/// Routing it through reqwest needs no CSP hole and keeps the signing key off
/// the JS heap.
pub async fn put_prepared(app: &AppHandle, state: &PayloadState, url: &str) -> AppResult<()> {
    let bytes = state.take()?;
    let total = bytes.len() as u64;

    // 256 KiB chunks: frequent enough for a smooth progress bar, coarse enough
    // that the event stream is not itself the bottleneck.
    const CHUNK: usize = 256 * 1024;
    let handle = app.clone();
    let mut sent: u64 = 0;
    let chunks: Vec<Result<Vec<u8>, std::io::Error>> = bytes
        .chunks(CHUNK)
        .map(|chunk| Ok(chunk.to_vec()))
        .collect();
    let progress = futures_util::stream::iter(chunks).inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            sent += chunk.len() as u64;
            let _ = handle.emit(
                EVENT_UPLOAD_PROGRESS,
                UploadProgress {
                    sent_bytes: sent,
                    total_bytes: total,
                },
            );
        }
    });

    let response = reqwest::Client::new()
        .put(url)
        .header("content-type", PARQUET_CONTENT_TYPE)
        .header("content-length", total.to_string())
        .body(reqwest::Body::wrap_stream(progress))
        .send()
        .await
        .map_err(|error| AppError::Upload(format!("storage PUT failed: {error}")))?;

    if !response.status().is_success() {
        return Err(AppError::Upload(format!(
            "storage PUT failed with status {}",
            response.status().as_u16()
        )));
    }
    Ok(())
}

/// Claim handoff (§22.5): open the run in the user's browser with the
/// single-use management token in the query string.
///
/// The desktop client cannot create a `private` run — that needs a signed-in
/// owner at create time, which this flow has no way to provide. The run is
/// created public or unlisted and the owner flips visibility from /account
/// after claiming it. The UI says so rather than offering a control that fails.
pub fn claim_url(run_id: &str, management_token: &str) -> String {
    format!(
        "{}/runs/{}?claim={}",
        api_base_url(),
        urlencode(run_id),
        urlencode(management_token)
    )
}

/// Percent-encode everything outside the unreserved set. Both inputs are
/// generated ids/tokens today, but a URL builder that assumes its inputs are
/// safe is how query-parameter injection gets in later.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custody_is_single_use_so_a_second_put_cannot_replay_the_payload() {
        let state = PayloadState::default();
        let prepared = prepare(&state, b"PAR1payloadPAR1".to_vec()).unwrap();
        assert_eq!(prepared.byte_length, 15);

        assert!(state.take().is_ok());
        // Second take: no bytes held, and the caller is told so explicitly
        // rather than silently uploading nothing.
        let error = state.take().unwrap_err();
        assert_eq!(error.code(), "no-prepared-payload");
    }

    #[test]
    fn discarding_a_capture_drops_the_held_frame_data() {
        let state = PayloadState::default();
        prepare(&state, b"frames".to_vec()).unwrap();
        state.clear();
        assert_eq!(state.take().unwrap_err().code(), "no-prepared-payload");
    }

    #[test]
    fn a_build_without_an_embedded_key_uploads_unsigned_rather_than_failing() {
        // Local and contributor builds have no HEIMDALL_SIGNING_PRIVATE_KEY,
        // and an unsigned upload is a valid outcome (§0.5 — the signature is
        // evidence, never an acceptance gate).
        let state = PayloadState::default();
        let prepared = prepare(&state, b"frames".to_vec()).unwrap();
        if PayloadSigner::from_build().is_none() {
            assert!(prepared.signature.is_none());
        } else {
            assert_eq!(prepared.signature.unwrap().len(), 88);
        }
    }

    #[test]
    fn the_claim_url_escapes_its_token_instead_of_trusting_it() {
        let url = claim_url("run_abc123", "tok en/+=");
        assert!(
            url.ends_with("/runs/run_abc123?claim=tok%20en%2F%2B%3D"),
            "{url}"
        );
    }

    #[test]
    fn the_api_base_url_has_no_trailing_slash_so_paths_concatenate_cleanly() {
        let base = api_base_url();
        assert!(!base.ends_with('/'));
        assert!(base.starts_with("http"));
    }
}
