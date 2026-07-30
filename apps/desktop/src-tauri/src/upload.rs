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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::activity::{ActivityKind, ActivityPermit, ActivityState};
use crate::error::{AppError, AppResult};
use crate::signing::{PayloadSigner, MAX_SIGNATURE_CHARS};

pub const EVENT_UPLOAD_PROGRESS: &str = "upload://progress";

/// One client for the process. `Client::new()` builds a fresh connection pool
/// and reloads the root certificate store, which is wasted on every upload
/// after the first.
static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

/// Must match `INGEST_LIMITS.maxParquetBytes` in @heimdall/shared. Rust is the
/// security boundary for raw IPC; a compromised webview must not bypass the
/// JavaScript-side guard and park an arbitrary allocation in managed state.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
const PARQUET_CONTENT_TYPE: &str = "application/vnd.apache.parquet";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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
    inner: Mutex<PayloadInner>,
}

#[derive(Default)]
struct PayloadInner {
    held: Option<Vec<u8>>,
    active_upload: Option<Arc<AtomicBool>>,
    activity: Option<ActivityPermit>,
}

impl PayloadState {
    /// Reserve the full create → PUT → finalize transaction. This begins
    /// before payload preparation and ends only after the shared ingest engine
    /// settles, so updater installation cannot restart the process mid-upload.
    pub fn begin_activity(&self, activity: &ActivityState) -> AppResult<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("payload state is poisoned".into()))?;
        if inner.activity.is_some() {
            return Err(AppError::Upload("an upload is already in progress".into()));
        }
        inner.activity = Some(activity.reserve(ActivityKind::Upload)?);
        Ok(())
    }

    pub fn end_activity(&self) -> AppResult<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("payload state is poisoned".into()))?;
        if inner.active_upload.is_some() {
            return Err(AppError::Upload(
                "cannot finish upload activity while the payload PUT is active".into(),
            ));
        }
        inner.activity = None;
        Ok(())
    }

    fn begin_upload(&self) -> AppResult<(Vec<u8>, Arc<AtomicBool>)> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("payload state is poisoned".into()))?;
        if inner.activity.is_none() {
            return Err(AppError::Upload(
                "begin_upload must reserve upload activity first".into(),
            ));
        }
        if inner.active_upload.is_some() {
            return Err(AppError::Upload("an upload is already in progress".into()));
        }
        let bytes = inner.held.take().ok_or(AppError::NoPreparedPayload)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        inner.active_upload = Some(Arc::clone(&cancelled));
        Ok((bytes, cancelled))
    }

    fn finish_upload(&self, cancelled: &Arc<AtomicBool>) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .active_upload
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, cancelled))
            {
                inner.active_upload = None;
            }
        }
    }

    fn put(&self, bytes: Vec<u8>) -> AppResult<()> {
        validate_payload_size(bytes.len())?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("upload state is poisoned".into()))?;
        if inner.activity.is_none() {
            return Err(AppError::Upload(
                "prepare_payload must reserve upload activity first".into(),
            ));
        }
        if inner.active_upload.is_some() {
            return Err(AppError::Upload("an upload is already in progress".into()));
        }
        if let Some(existing) = inner.held.as_ref() {
            // `signPayload` runs before the API create call. If create fails,
            // the shared ingest engine retries from the start with the exact
            // same Parquet. Keep custody idempotent so that retry can proceed,
            // but never let a second payload silently replace retained bytes.
            if existing.as_slice() == bytes.as_slice() {
                return Ok(());
            }
            return Err(AppError::Upload(
                "a different payload is already prepared; discard it before preparing another"
                    .into(),
            ));
        }
        inner.held = Some(bytes);
        Ok(())
    }

    /// Drop custody without uploading — a discarded capture must not leave a
    /// copy of the user's frame data resident.
    pub fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(cancelled) = inner.active_upload.as_ref() {
                cancelled.store(true, Ordering::Release);
            }
            inner.held = None;
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
pub async fn put_prepared(
    app: &AppHandle,
    state: &PayloadState,
    url: &str,
    content_type: &str,
) -> AppResult<()> {
    let destination = validate_upload_target(url, content_type)?;
    let (bytes, cancelled) = state.begin_upload()?;
    let total = bytes.len() as u64;

    // 256 KiB chunks: frequent enough for a smooth progress bar, coarse enough
    // that the event stream is not itself the bottleneck.
    //
    // Cut lazily, one chunk at a time. Collecting them up front would hold a
    // COMPLETE second copy of a payload that can reach 64 MiB before the
    // request even starts.
    const CHUNK: usize = 256 * 1024;
    let handle = app.clone();
    let stream_cancelled = Arc::clone(&cancelled);
    let progress = futures_util::stream::unfold((bytes, 0usize), move |(bytes, offset)| {
        let handle = handle.clone();
        let cancelled = Arc::clone(&stream_cancelled);
        async move {
            if cancelled.load(Ordering::Acquire) {
                let end = bytes.len();
                return Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "upload cancelled",
                    )),
                    (bytes, end),
                ));
            }
            if offset >= bytes.len() {
                return None;
            }
            let end = (offset + CHUNK).min(bytes.len());
            let chunk = bytes[offset..end].to_vec();
            let _ = handle.emit(
                EVENT_UPLOAD_PROGRESS,
                UploadProgress {
                    sent_bytes: end as u64,
                    total_bytes: total,
                },
            );
            Some((Ok::<Vec<u8>, std::io::Error>(chunk), (bytes, end)))
        }
    });

    let client = http_client()?;
    let response = client
        .put(destination)
        .header("content-type", content_type)
        .header("content-length", total.to_string())
        .body(reqwest::Body::wrap_stream(progress))
        .send()
        .await;
    state.finish_upload(&cancelled);
    let response =
        response.map_err(|error| AppError::Upload(format!("storage PUT failed: {error}")))?;

    if !response.status().is_success() {
        return Err(AppError::Upload(format!(
            "storage PUT failed with status {}",
            response.status().as_u16()
        )));
    }
    Ok(())
}

fn http_client() -> AppResult<&'static reqwest::Client> {
    if let Some(client) = HTTP.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::Upload(format!("HTTP client setup failed: {error}")))?;
    let _ = HTTP.set(client);
    HTTP.get()
        .ok_or_else(|| AppError::Internal("HTTP client initialization raced".into()))
}

fn build_r2_destination() -> Option<String> {
    let account = option_env!("HEIMDALL_R2_ACCOUNT_ID")?.trim();
    let bucket = option_env!("HEIMDALL_R2_BUCKET")?.trim();
    if account.is_empty() || bucket.is_empty() {
        return None;
    }
    // The web presigner uses the AWS SDK's default virtual-hosted addressing:
    // https://{bucket}.{account}.r2.cloudflarestorage.com/{object-key}
    Some(format!(
        "{}.{}.r2.cloudflarestorage.com",
        bucket.to_ascii_lowercase(),
        account.to_ascii_lowercase()
    ))
}

fn validate_upload_target(url: &str, content_type: &str) -> AppResult<reqwest::Url> {
    let expected_host = build_r2_destination();
    validate_upload_target_for(
        url,
        content_type,
        expected_host.as_deref(),
        cfg!(debug_assertions),
    )
}

fn validate_upload_target_for(
    url: &str,
    content_type: &str,
    expected_host: Option<&str>,
    allow_local: bool,
) -> AppResult<reqwest::Url> {
    if content_type != PARQUET_CONTENT_TYPE {
        return Err(AppError::Upload("unexpected upload content type".into()));
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::Upload("storage URL is malformed".into()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::Upload("storage URL has no host".into()))?;

    // Local development may use an in-process storage stub, but release builds
    // must carry the exact R2 account and bucket compiled from CI secrets.
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if local && allow_local {
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(AppError::Upload(
                "local storage URL must use HTTP(S)".into(),
            ));
        }
        return Ok(parsed);
    }
    if parsed.scheme() != "https" {
        return Err(AppError::Upload("storage URL must use HTTPS".into()));
    }

    let expected_host = expected_host.ok_or_else(|| {
        AppError::Upload(
            "this build has no trusted R2 destination; set HEIMDALL_R2_ACCOUNT_ID and HEIMDALL_R2_BUCKET at build time"
                .into(),
        )
    })?;
    if !host.eq_ignore_ascii_case(expected_host) {
        return Err(AppError::Upload("storage URL host is not trusted".into()));
    }

    let query: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
    let signed = query
        .get("X-Amz-Algorithm")
        .is_some_and(|value| value == "AWS4-HMAC-SHA256")
        && query
            .get("X-Amz-Credential")
            .is_some_and(|value| !value.is_empty())
        && query
            .get("X-Amz-Date")
            .is_some_and(|value| !value.is_empty())
        && query
            .get("X-Amz-Expires")
            .is_some_and(|value| !value.is_empty())
        && query
            .get("X-Amz-SignedHeaders")
            .is_some_and(|value| !value.is_empty())
        && query.get("X-Amz-Signature").is_some_and(|value| {
            value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
    if !signed {
        return Err(AppError::Upload(
            "storage URL is not a complete presigned R2 PUT".into(),
        ));
    }
    Ok(parsed)
}

fn validate_payload_size(byte_length: usize) -> AppResult<()> {
    if byte_length > MAX_PAYLOAD_BYTES {
        return Err(AppError::Upload(format!(
            "payload is {byte_length} bytes; maximum is {MAX_PAYLOAD_BYTES}",
        )));
    }
    Ok(())
}

/// Claim handoff (§22.5): open the run in the user's browser with the
/// single-use management token in the fragment. Fragments never reach the hub,
/// reverse proxy, request logs or Referer headers.
///
/// The desktop client cannot create a `private` run — that needs a signed-in
/// owner at create time, which this flow has no way to provide. The run is
/// created public or unlisted and the owner flips visibility from /account
/// after claiming it. The UI says so rather than offering a control that fails.
pub fn claim_url(run_id: &str, management_token: &str) -> String {
    format!(
        "{}/runs/{}#claim={}",
        api_base_url(),
        urlencode(run_id),
        urlencode(management_token)
    )
}

/// Percent-encode everything outside the unreserved set. The claim inputs are
/// generated ids/tokens today, but a URL builder that assumes its inputs are
/// safe is how query-parameter injection gets in later — and `crash::issue_url`
/// puts a panic message into a query string, where it is not hypothetical.
pub(crate) fn urlencode(value: &str) -> String {
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

    fn active_state() -> PayloadState {
        let state = PayloadState::default();
        state
            .begin_activity(&ActivityState::default())
            .expect("reserve upload activity");
        state
    }

    #[test]
    fn custody_is_single_use_so_a_second_put_cannot_replay_the_payload() {
        let state = active_state();
        let prepared = prepare(&state, b"PAR1payloadPAR1".to_vec()).unwrap();
        assert_eq!(prepared.byte_length, 15);

        let (bytes, cancelled) = state.begin_upload().unwrap();
        assert_eq!(bytes, b"PAR1payloadPAR1");
        state.finish_upload(&cancelled);
        // Second take: no bytes held, and the caller is told so explicitly
        // rather than silently uploading nothing.
        let error = state.begin_upload().unwrap_err();
        assert_eq!(error.code(), "no-prepared-payload");
    }

    #[test]
    fn preparing_the_same_payload_is_retry_safe_but_replacement_is_rejected() {
        let state = active_state();
        prepare(&state, b"same frames".to_vec()).unwrap();
        prepare(&state, b"same frames".to_vec()).expect("create-stage retry");

        let error = prepare(&state, b"different frames".to_vec()).unwrap_err();
        assert_eq!(error.code(), "upload-failed");
        let (bytes, _) = state.begin_upload().unwrap();
        assert_eq!(bytes, b"same frames");
    }

    #[test]
    fn active_upload_and_prepared_custody_cannot_overlap() {
        let state = active_state();
        prepare(&state, b"uploading".to_vec()).unwrap();
        let (_, active) = state.begin_upload().unwrap();

        assert_eq!(
            prepare(&state, b"second".to_vec()).unwrap_err().code(),
            "upload-failed"
        );
        state.finish_upload(&active);
        assert_eq!(
            state.begin_upload().unwrap_err().code(),
            "no-prepared-payload"
        );
    }

    #[test]
    fn upload_activity_blocks_other_exclusive_work_until_the_transaction_ends() {
        let activity = ActivityState::default();
        let state = PayloadState::default();
        state.begin_activity(&activity).unwrap();

        assert_eq!(
            activity.reserve(ActivityKind::Capture).unwrap_err().code(),
            "operation-busy"
        );
        state.end_activity().unwrap();
        activity.reserve(ActivityKind::Capture).unwrap();
    }

    #[test]
    fn discarding_a_capture_drops_the_held_frame_data() {
        let state = active_state();
        prepare(&state, b"frames".to_vec()).unwrap();
        state.clear();
        assert_eq!(
            state.begin_upload().unwrap_err().code(),
            "no-prepared-payload"
        );
    }

    #[test]
    fn a_build_without_an_embedded_key_uploads_unsigned_rather_than_failing() {
        // Local and contributor builds have no HEIMDALL_SIGNING_PRIVATE_KEY,
        // and an unsigned upload is a valid outcome (§0.5 — the signature is
        // evidence, never an acceptance gate).
        let state = active_state();
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
            url.ends_with("/runs/run_abc123#claim=tok%20en%2F%2B%3D"),
            "{url}"
        );
    }

    #[test]
    fn the_api_base_url_has_no_trailing_slash_so_paths_concatenate_cleanly() {
        let base = api_base_url();
        assert!(!base.ends_with('/'));
        assert!(base.starts_with("http"));
    }

    #[test]
    fn raw_ipc_payloads_cannot_bypass_the_shared_parquet_limit() {
        assert!(validate_payload_size(MAX_PAYLOAD_BYTES).is_ok());
        assert_eq!(
            validate_payload_size(MAX_PAYLOAD_BYTES + 1)
                .unwrap_err()
                .code(),
            "upload-failed"
        );
    }

    #[test]
    fn upload_target_is_bound_to_the_compiled_r2_account_and_bucket() {
        let expected = "benchmarks.account123.r2.cloudflarestorage.com";
        let query = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=key&X-Amz-Date=20260729T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bhost&X-Amz-Signature=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let good = format!(
            "https://benchmarks.account123.r2.cloudflarestorage.com/staging/run.parquet?{query}"
        );
        assert!(
            validate_upload_target_for(&good, PARQUET_CONTENT_TYPE, Some(expected), false).is_ok()
        );

        let attacker = good.replace(
            "benchmarks.account123.r2.cloudflarestorage.com",
            "attacker.r2.cloudflarestorage.com",
        );
        assert!(
            validate_upload_target_for(&attacker, PARQUET_CONTENT_TYPE, Some(expected), false)
                .is_err()
        );
        let wrong_bucket = good.replace("benchmarks.", "other-bucket.");
        assert!(validate_upload_target_for(
            &wrong_bucket,
            PARQUET_CONTENT_TYPE,
            Some(expected),
            false,
        )
        .is_err());
        let private_network = format!("http://127.0.0.1:9000/benchmarks/object?{query}");
        assert!(validate_upload_target_for(
            &private_network,
            PARQUET_CONTENT_TYPE,
            Some(expected),
            false,
        )
        .is_err());
    }
}
