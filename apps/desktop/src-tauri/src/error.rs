//! One error type for every IPC command (§22.4).
//!
//! Commands never panic across the boundary: each failure serializes to a
//! `{ code, message }` object the webview can switch on, which is the same
//! shape the ingest engine's typed failures use so the UI has one error model.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("the bundled PresentMon sidecar is missing or could not start: {0}")]
    Sidecar(String),

    #[error("no foreground game window could be resolved: {0}")]
    Foreground(String),

    #[error("a capture is already running")]
    CaptureBusy,

    #[error("no capture is running")]
    CaptureIdle,

    #[error("another exclusive operation is active: {0}")]
    OperationBusy(&'static str),

    #[error("the capture hotkey could not be registered: {0}")]
    Hotkey(String),

    #[error("this build has no embedded signing key")]
    NoSigningKey,

    #[error("signing failed: {0}")]
    Signing(String),

    #[error("no prepared payload is held — call prepare_payload first")]
    NoPreparedPayload,

    #[error("upload failed: {0}")]
    Upload(String),

    #[cfg(feature = "release-updates")]
    #[error("update failed: {0}")]
    Update(String),

    #[error("settings could not be read or written: {0}")]
    Settings(String),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable discriminant. The UI keys its named states off
    /// these, so they are part of the contract — rename with care.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Sidecar(_) => "sidecar-unavailable",
            Self::Foreground(_) => "no-foreground-game",
            Self::CaptureBusy => "capture-busy",
            Self::CaptureIdle => "capture-idle",
            Self::OperationBusy(_) => "operation-busy",
            Self::Hotkey(_) => "hotkey-unavailable",
            Self::NoSigningKey => "no-signing-key",
            Self::Signing(_) => "signing-failed",
            Self::NoPreparedPayload => "no-prepared-payload",
            Self::Upload(_) => "upload-failed",
            #[cfg(feature = "release-updates")]
            Self::Update(_) => "update-failed",
            Self::Settings(_) => "settings-unavailable",
            Self::Internal(_) => "internal",
        }
    }
}

#[derive(Serialize)]
struct WireError<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        WireError {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_code_message_envelope_the_ui_switches_on() {
        let json = serde_json::to_value(AppError::CaptureBusy).unwrap();
        assert_eq!(json["code"], "capture-busy");
        assert_eq!(json["message"], "a capture is already running");
    }

    #[test]
    fn every_variant_has_a_distinct_stable_code() {
        let codes = [
            AppError::Sidecar(String::new()).code(),
            AppError::Foreground(String::new()).code(),
            AppError::CaptureBusy.code(),
            AppError::CaptureIdle.code(),
            AppError::OperationBusy("capture").code(),
            AppError::Hotkey(String::new()).code(),
            AppError::NoSigningKey.code(),
            AppError::Signing(String::new()).code(),
            AppError::NoPreparedPayload.code(),
            AppError::Upload(String::new()).code(),
            #[cfg(feature = "release-updates")]
            AppError::Update(String::new()).code(),
            AppError::Settings(String::new()).code(),
            AppError::Internal(String::new()).code(),
        ];
        let mut unique = codes.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), codes.len());
    }
}
