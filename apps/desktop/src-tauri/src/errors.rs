//! Typed error types shared by Tauri commands across both binaries.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Error codes for programmatic error handling on the frontend.
/// Serializes as SCREAMING_SNAKE_CASE, e.g. `"INVALID_URL"`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TauriErrorCode {
    // URL / proxy errors
    InvalidUrl,
    UrlNotAllowed,
    UnsupportedMethod,
    // HTTP errors
    HttpClientError,
    HttpRequestFailed,
    HttpTimeout,
    ConnectionFailed,
    ResponseReadError,
    // Merod process errors
    MerodNotRunning,
    MerodStartFailed,
    MerodStopFailed,
    MerodInitFailed,
    MerodProcessExited,
    MerodVersionMismatch,
    // Window errors
    WindowCreationFailed,
    WindowOperationFailed,
    // Filesystem errors
    FileNotFound,
    FileReadError,
    FileWriteError,
    DirectoryError,
    PathNotAllowed,
    // Config errors
    ConfigParseError,
    ConfigWriteError,
    // Platform / feature errors
    PlatformNotSupported,
    ShortcutCreationFailed,
    HomeDirNotFound,
    AutostartNotAvailable,
    // General
    InvalidInput,
    Timeout,
    InternalError,
}

/// Structured error returned by all `#[tauri::command]` functions.
///
/// Serialises to:
/// ```json
/// { "code": "INVALID_URL", "message": "...", "details": "..." }
/// ```
#[derive(Debug, Clone, Error, Serialize)]
#[error("{message}")]
pub struct TauriError {
    pub code: TauriErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl TauriError {
    pub fn new(code: TauriErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: None }
    }

    pub fn with_details(code: TauriErrorCode, message: impl Into<String>, details: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: Some(details.into()) }
    }
}

/// Fallback conversion so internal helpers returning `Result<_, String>` can propagate
/// through commands with `?`. Uses `InternalError` — callers that need a specific code
/// should call `.map_err(|e| TauriError::new(TauriErrorCode::XYZ, e))?` explicitly.
impl From<String> for TauriError {
    fn from(e: String) -> Self {
        TauriError::new(TauriErrorCode::InternalError, e)
    }
}
