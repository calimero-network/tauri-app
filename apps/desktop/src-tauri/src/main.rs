// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use thiserror::Error;

/// Chain-style poison recovery: every mutex here guards a plain collection with
/// no cross-field invariant, so the pre-poison data is always safe to reuse.
pub(crate) trait LockUnpoisoned<T> {
    fn lock_unpoisoned(&self) -> std::sync::MutexGuard<'_, T>;
}
impl<T> LockUnpoisoned<T> for std::sync::Mutex<T> {
    fn lock_unpoisoned(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock_unpoisoned()
    }
}
// Brings `.encode()` / `.decode()` onto the base64 engine used by the HTTP proxy.
use base64::Engine as _;

mod log_rotation;
mod merod_versions;
mod webview_isolation;

use webview_isolation::{webview_isolation_supported, IsolatedWindows};
use merod_versions::{
    extract_merod_binary, get_bundled_merod_path, get_merod_version_at, merod_target_triple,
    score_merod_asset,
};

// Imported unqualified so generate_handler! registers them under their bare
// command names, which is what the ACL in permissions/app-commands.toml grants.
use merod_versions::{
    list_installed_merod_versions, list_merod_releases, remove_merod_version, repoint_local_build,
};

// Per-app launcher foundation (macOS only): pure, zero-Tauri-API modules shared
// with the `calimero-shell` binary via the crate's lib target.
#[cfg(target_os = "macos")]
use calimero_tauri_app::{app_registry, host_socket_path, launcher, token_broker_ipc};

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SSE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Version of the merod binary this build expects, embedded at compile time from merod-config.json.
const MEROD_CONFIG_VERSION: &str = match option_env!("MEROD_CONFIG_VERSION") {
    Some(v) => v,
    None => "unknown",
};

pub(crate) fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(false)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to build HTTP client")
    })
}

// SSE streams are long-lived; no request timeout is set so the connection
// is only closed when the server ends the stream or the stream is cancelled.
fn sse_client() -> &'static reqwest::Client {
    SSE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(false)
            .build()
            .expect("Failed to build SSE HTTP client")
    })
}

// ============================================================================
// Typed error types for Tauri commands
// ============================================================================

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
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: TauriErrorCode,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details: Some(details.into()),
        }
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

#[derive(Debug, Serialize, Deserialize)]
struct HttpRequest {
    url: String,
    method: String,
    headers: Option<std::collections::HashMap<String, String>>,
    /// Text bodies (JSON, form-encoded, …) — sent as a UTF-8 string.
    body: Option<String>,
    /// Binary bodies (image uploads, octet-stream, …) — base64 of the raw bytes.
    /// Set by the proxy script instead of `body` so bytes survive the IPC hop
    /// intact; `String(arrayBuffer)`/`.text()` would otherwise mangle them.
    #[serde(default)]
    body_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct HttpResponse {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    /// Text responses — a UTF-8 string (unchanged wire shape for JSON/text).
    body: String,
    /// Binary responses (images, octet-stream, …) — base64 of the raw bytes.
    /// When present the proxy script decodes this instead of reading `body`,
    /// so downloaded blobs are byte-exact rather than UTF-8-lossy corrupted.
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

/// Whether a response/request body of this content-type is safe to carry as a
/// UTF-8 string. Anything else (images, octet-stream, video, …) must go over the
/// IPC boundary as base64 to avoid lossy UTF-8 corruption.
///
/// Precise on purpose: a broad `contains("xml")`/`contains("json")` would
/// misclassify ZIP-based Office Open XML types (`application/vnd.openxmlformats-*`
/// = docx/xlsx/pptx) as text and corrupt them. Note the asymmetry — treating a
/// genuinely textual type as binary is harmless (base64 round-trips exactly),
/// while treating binary as text corrupts, so we bias toward binary.
fn is_textual_content_type(content_type: &str) -> bool {
    // Media type only, ignoring any `; charset=…` parameters.
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    // Vendor types are overwhelmingly binary containers (OOXML, .xls, …); never
    // treat them as text even though some contain "xml"/"json" in the name.
    if ct.starts_with("application/vnd.") {
        return false;
    }
    ct.starts_with("text/")
        || ct == "application/json"
        || ct.ends_with("+json")
        || ct == "application/xml"
        || ct == "text/xml"
        || ct.ends_with("+xml")
        || ct.contains("javascript")
        || ct.contains("ecmascript")
        || ct == "application/x-www-form-urlencoded"
        || ct == "text/csv"
        || ct.starts_with("multipart/") // boundaries + text fields; keep as-is
}

/// Parses --open-app-url, --open-app-name, --open-app-id from CLI args (used when launched from a desktop shortcut).
fn parse_open_app_args() -> Option<(String, String, Option<String>)> {
    let args: Vec<String> = std::env::args().collect();
    let mut url = None;
    let mut name = None;
    let mut app_id = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--open-app-url" && i + 1 < args.len() {
            url = Some(args[i + 1].clone());
            i += 2;
            continue;
        }
        if args[i] == "--open-app-name" && i + 1 < args.len() {
            name = Some(args[i + 1].clone());
            i += 2;
            continue;
        }
        if args[i] == "--open-app-id" && i + 1 < args.len() {
            let id = args[i + 1].clone();
            // Validate before use: non-empty, ≤128 chars, alphanumeric + hyphen only.
            if !id.is_empty()
                && id.len() <= 128
                && id.chars().all(|c| c.is_alphanumeric() || c == '-')
            {
                app_id = Some(id);
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    url.map(|u| (u, name.unwrap_or_else(|| "Application".to_string()), app_id))
}

/// Check CLI args for a deep-link URL passed by the OS at cold launch. Matches
/// both the custom scheme (`calimero://…`, OAuth callback + app deep-links) and
/// the Universal Link host (`https://links.calimero.network/…`, app deep-links
/// on signed release builds). The caller routes it: OAuth callback vs app
/// deep-link (see `parse_app_deep_link`).
fn parse_deep_link_arg() -> Option<String> {
    for arg in std::env::args() {
        if arg.starts_with("calimero://")
            || arg.starts_with("https://links.calimero.network/")
        {
            return Some(arg);
        }
    }
    None
}

/// An app deep-link parsed from a shared link, shaped
/// `<scheme-or-host>/<slug>/<action>?<params>`. Emitted to the frontend as the
/// `app-deep-link` event; the frontend resolves `slug` → an installed app and
/// opens it with `params` appended to the app's frontend URL.
#[derive(Clone, serde::Serialize)]
pub struct AppDeepLink {
    pub slug: String,
    pub action: String,
    /// The raw query string (without the leading `?`), e.g. `invitation=X`.
    pub params: String,
}

/// State for a pending app deep-link (cold-launch case: the OS launched the app
/// with the deep-link URL before any listener was set up). Read by the frontend
/// via `get_pending_app_deep_link`. Mirrors `PendingCloudAuth`.
pub struct PendingAppDeepLink(pub std::sync::Mutex<Option<AppDeepLink>>);

/// Parse an app deep-link from either the custom scheme or the Universal Link
/// host. Returns `None` for anything that is not an app deep-link — crucially
/// the OAuth callback (`calimero://cloud-callback?…`), which the caller keeps
/// routing through the existing cloud-auth path.
///
/// Accepted shapes:
///   - `calimero://<slug>/<action>?<params>`          (host=slug, path=/action)
///   - `https://links.calimero.network/<slug>/<action>?<params>`
fn parse_app_deep_link(raw: &str) -> Option<AppDeepLink> {
    let parsed = url::Url::parse(raw).ok()?;

    let (slug, action) = match parsed.scheme() {
        "calimero" => {
            // `calimero://<slug>/<action>` → host is the slug, first path
            // segment is the action.
            let host = parsed.host_str()?;
            // Reserve the OAuth callback host: it is NOT an app deep-link.
            if host == "cloud-callback" {
                return None;
            }
            let action = parsed
                .path_segments()
                .and_then(|mut segs| segs.next())
                .filter(|s| !s.is_empty())?;
            (host.to_string(), action.to_string())
        }
        "https" if parsed.host_str() == Some("links.calimero.network") => {
            // `https://links.calimero.network/<slug>/<action>`
            let mut segs = parsed.path_segments()?.filter(|s| !s.is_empty());
            let slug = segs.next()?;
            let action = segs.next()?;
            (slug.to_string(), action.to_string())
        }
        _ => return None,
    };

    // Light shape validation. The slug is the app PACKAGE — reverse-DNS with
    // dots (e.g. `com.calimero.curb`) — so `.` must be allowed alongside `-`/`_`.
    // Keep permissive (the frontend does the real resolve against installed apps
    // and simply warns on no match), but reject obviously bogus segments.
    let is_token = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    if !is_token(&slug) || !is_token(&action) {
        return None;
    }

    Some(AppDeepLink {
        slug,
        action,
        params: parsed.query().unwrap_or("").to_string(),
    })
}

/// True when a per-app shell auto-booted this host headless (`--headless-host`)
/// solely to serve the token broker; the tray host runs window-less in that case.
fn is_headless_host() -> bool {
    std::env::args().any(|a| a == "--headless-host")
}

/// State for app to open when launched from a desktop shortcut (read by frontend on load).
pub struct PendingOpenApp(pub std::sync::Mutex<Option<(String, String, Option<String>)>>);

/// State for pending Calimero Cloud auth callback (set by deep link handler, read by frontend).
pub struct PendingCloudAuth(pub std::sync::Mutex<Option<String>>);

const MAX_NODE_NAME_LENGTH: usize = 64;

/// Validates a node name to prevent path traversal and command injection.
/// Valid names: non-empty, max 64 chars, alphanumeric/hyphen/underscore only, no leading hyphen.
fn validate_node_name(node_name: &str) -> Result<(), String> {
    if node_name.is_empty() {
        return Err("Node name cannot be empty".to_string());
    }
    if node_name.len() > MAX_NODE_NAME_LENGTH {
        return Err(format!(
            "Node name is too long ({} characters). Maximum allowed is {} characters.",
            node_name.len(),
            MAX_NODE_NAME_LENGTH
        ));
    }
    if node_name.starts_with('-') {
        return Err(
            "Node name cannot start with a hyphen (-) as it may be interpreted as a command flag"
                .to_string(),
        );
    }
    for (i, c) in node_name.chars().enumerate() {
        if !c.is_ascii_alphanumeric() && c != '-' && c != '_' {
            if c == '/' || c == '\\' {
                return Err(format!(
                    "Node name contains invalid path separator '{}' at position {}. \
                     Path separators are not allowed to prevent path traversal attacks.",
                    c, i
                ));
            } else if c == ';' || c == '|' || c == '&' || c == '$' || c == '`' {
                return Err(format!(
                    "Node name contains invalid shell metacharacter '{}' at position {}. \
                     Shell metacharacters are not allowed to prevent command injection.",
                    c, i
                ));
            } else if c == '.' && node_name.contains("..") {
                return Err(
                    "Node name contains '..' which could be used for path traversal attacks"
                        .to_string(),
                );
            } else {
                return Err(format!(
                    "Node name contains invalid character '{}' at position {}. \
                     Only alphanumeric characters, hyphens (-), and underscores (_) are allowed.",
                    c, i
                ));
            }
        }
    }
    Ok(())
}

/// Validates that a URL is allowed for proxying
///
/// Allowed URLs:
/// - Configured node URL (from settings, typically http://localhost:2528 or custom HTTP localhost)
///
/// Only HTTP localhost URLs are proxied. HTTPS registries don't need proxying (no mixed content issues).
///
/// This function prevents hostname spoofing attacks like:
/// - http://localhost:2528.evil.com (invalid hostname)
/// - http://localhost:2528@evil.com (invalid URL structure)
pub(crate) fn validate_allowed_url(
    url: &str,
    configured_node_url: Option<&str>,
) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| {
        format!(
            "Invalid URL format: {}. Please check that the URL is properly formatted.",
            e
        )
    })?;

    // Validate scheme
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "Unsupported URL scheme: '{}'. Only 'http' and 'https' are allowed. Please use http://localhost:2528 or https://apps.calimero.network",
            scheme
        ));
    }

    // Reject URLs with userinfo (e.g., user@host) as a security measure
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(format!(
            "URLs with authentication credentials are not allowed for security reasons. Please use a URL without username/password (e.g., http://localhost:2528 instead of user@localhost:2528)"
        ));
    }

    // Validate hostname (must be exact match, no subdomains or spoofing)
    let host = parsed.host_str()
        .ok_or_else(|| "Invalid URL: missing hostname. Please provide a valid URL with a hostname (e.g., localhost or apps.calimero.network)".to_string())?;

    // Normalize hostname to lowercase for comparison
    let host_lower = host.to_lowercase();

    // Get port (explicit or default based on scheme)
    let port = parsed.port().unwrap_or_else(|| {
        match scheme {
            "http" => 80,
            "https" => 443,
            _ => unreachable!(), // Already validated scheme above
        }
    });

    // Check if URL matches configured node URL
    if let Some(node_url) = configured_node_url {
        match url::Url::parse(node_url) {
            Ok(node_parsed) => {
                let node_host = node_parsed.host_str().map(|h| h.to_lowercase());
                let node_port = node_parsed.port().or_else(|| match node_parsed.scheme() {
                    "http" => Some(80),
                    "https" => Some(443),
                    _ => None,
                });

                if node_host
                    .as_ref()
                    .map(|h| h == &host_lower)
                    .unwrap_or(false)
                    && node_port.map(|p| p == port).unwrap_or(false)
                    && node_parsed.scheme() == scheme
                {
                    return Ok(());
                }
                // Configured URL present but request URL doesn't match — reject.
                return Err(format!(
                    "URL not allowed: {}. Only requests to the configured node URL are proxied.",
                    url
                ));
            }
            Err(_) => {
                return Err(format!(
                    "URL not allowed: {}. The configured node URL is invalid and cannot be used for proxying.",
                    url
                ));
            }
        }
    }

    // No configured URL — allow any HTTP localhost request (any port).
    match (scheme, host_lower.as_str()) {
        ("http", "localhost") | ("http", "127.0.0.1") => Ok(()),
        _ => {
            let suggestion = if scheme == "https" {
                "HTTPS URLs don't need proxying. Only HTTP localhost node URLs are proxied."
                    .to_string()
            } else {
                "Only HTTP localhost URLs are allowed for proxying (e.g., http://localhost:2528)."
                    .to_string()
            };

            Err(format!(
                "URL not allowed: {}://{}:{}. {}",
                scheme, host, port, suggestion
            ))
        }
    }
}

#[tauri::command]
async fn proxy_http_request(
    request: HttpRequest,
    configured_node_url: Option<String>,
) -> Result<HttpResponse, TauriError> {
    let _guard = InFlightGuard::new();
    proxy_http_request_inner(request, configured_node_url).await
}

async fn proxy_http_request_inner(
    request: HttpRequest,
    configured_node_url: Option<String>,
) -> Result<HttpResponse, TauriError> {
    use reqwest;

    // Validate URL before processing (pass configured node URL if available)
    validate_allowed_url(&request.url, configured_node_url.as_deref())
        .map_err(|e| TauriError::new(TauriErrorCode::UrlNotAllowed, e))?;

    // Parse URL to determine what Host header to use
    let parsed_original = url::Url::parse(&request.url).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::InvalidUrl,
            format!("Failed to parse URL '{}'", request.url),
            e.to_string(),
        )
    })?;
    let original_host = parsed_original.host_str().ok_or_else(|| {
        TauriError::new(
            TauriErrorCode::InvalidUrl,
            format!("Invalid URL '{}': missing hostname", request.url),
        )
    })?;
    // Get port (explicit or default)
    let original_port = parsed_original
        .port()
        .or_else(|| {
            match parsed_original.scheme() {
                "http" => Some(2528), // Default for localhost
                "https" => Some(443), // Default for HTTPS
                _ => None,
            }
        })
        .ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::InvalidUrl,
                "Could not determine port from URL",
            )
        })?;
    let host_header = format!("{}:{}", original_host, original_port);

    // DON'T normalize - use original URL exactly as Chrome does
    // The issue might be that normalizing breaks something
    let normalized_url = request.url.clone();

    info!(
        "[Tauri Proxy] Proxying request: {} {}",
        request.method, request.url
    );
    if let Some(ref headers) = request.headers {
        debug!("[Tauri Proxy] Request headers count: {}", headers.len());
        // Log only whether auth header is present — never log its value
        let has_auth =
            headers.contains_key("Authorization") || headers.contains_key("authorization");
        debug!("[Tauri Proxy] Has Authorization header: {}", has_auth);
    }

    // Build request (use normalized URL)
    let client = http_client();
    let mut req_builder = match request.method.as_str() {
        "GET" => client.get(&normalized_url),
        "POST" => client.post(&normalized_url),
        "PUT" => client.put(&normalized_url),
        "DELETE" => client.delete(&normalized_url),
        "PATCH" => client.patch(&normalized_url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, &normalized_url),
        "HEAD" => client.head(&normalized_url),
        _ => return Err(TauriError::new(
            TauriErrorCode::UnsupportedMethod,
            format!("Unsupported HTTP method: '{}'. Supported methods are: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD", request.method),
        )),
    };

    // Add headers (default to JSON if body is present and no content-type)
    if let Some(headers) = request.headers.as_ref() {
        let mut has_content_type = false;
        let mut has_host = false;
        for (key, value) in headers {
            let key_lower = key.to_lowercase();
            if key_lower == "content-type" {
                has_content_type = true;
            }
            if key_lower == "host" {
                has_host = true;
            }
            // Redact sensitive headers entirely in logs
            let is_sensitive = key_lower == "authorization"
                || key_lower == "cookie"
                || key_lower == "x-api-key"
                || key_lower == "x-auth-token"
                || key_lower.contains("secret")
                || key_lower.contains("password")
                || key_lower.contains("token");
            if is_sensitive {
                debug!("[Tauri Proxy] Adding header: '{}' = '[REDACTED]'", key);
            } else {
                // Built inside the macro so the truncation/clone only runs when
                // debug logging is actually enabled.
                debug!(
                    "[Tauri Proxy] Adding header: '{}' = '{}'",
                    key,
                    if value.len() > 50 {
                        format!("{}...", value.chars().take(50).collect::<String>())
                    } else {
                        value.clone()
                    }
                );
            }
            // Add header directly - reqwest will handle validation
            req_builder = req_builder.header(key, value);
        }
        // Explicitly set Host header to match original request (localhost vs 127.0.0.1)
        // reqwest will override this, so we need to use a custom client or handle differently
        // For now, let's not normalize the URL at all - use it exactly as Chrome does
        if !has_host {
            debug!("[Tauri Proxy] Original Host would be: {}", host_header);
            // Note: reqwest sets Host automatically from URL, so we can't override it easily
            // The solution is to NOT normalize the URL
        }
        debug!("[Tauri Proxy] Total headers processed: {}", headers.len());
        // Add default Content-Type if a body exists but no Content-Type header.
        // Binary bodies default to octet-stream, text bodies to JSON.
        if !has_content_type {
            if request.body_base64.is_some() {
                req_builder = req_builder.header("Content-Type", "application/octet-stream");
            } else if request.body.is_some() {
                req_builder = req_builder.header("Content-Type", "application/json");
            }
        }
    } else if request.body.is_some() || request.body_base64.is_some() {
        // No headers provided but body exists - add default Content-Type
        let default_ct = if request.body_base64.is_some() {
            "application/octet-stream"
        } else {
            "application/json"
        };
        req_builder = req_builder.header("Content-Type", default_ct);
    }

    // Add body: a base64 binary body (decoded to raw bytes) wins over the text
    // body, so image/octet-stream uploads are sent as bytes, not mangled text.
    if let Some(b64) = request.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| TauriError::with_details(TauriErrorCode::InvalidInput, "Invalid base64 request body", e.to_string()))?;
        req_builder = req_builder.body(bytes);
    } else if let Some(body) = request.body {
        req_builder = req_builder.body(body);
    }

    // Send request
    let response = req_builder.send().await.map_err(|e| {
        let error_msg = e.to_string();
        if error_msg.contains("timeout") {
            TauriError::with_details(
                TauriErrorCode::HttpTimeout,
                format!("Request to {} timed out after 30 seconds", request.url),
                error_msg,
            )
        } else if error_msg.contains("connection") || error_msg.contains("resolve") {
            TauriError::with_details(
                TauriErrorCode::ConnectionFailed,
                format!("Failed to connect to {}", request.url),
                error_msg,
            )
        } else {
            TauriError::with_details(
                TauriErrorCode::HttpRequestFailed,
                format!("Request to {} failed", request.url),
                error_msg,
            )
        }
    })?;

    // Extract response
    let status = response.status().as_u16();
    let mut response_headers = std::collections::HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(key.to_string(), value_str.to_string());
        }
    }
    // Decide text vs binary from the response Content-Type BEFORE consuming the
    // body: textual replies keep the plain-string wire shape (unchanged for
    // JSON/text); binary (images, octet-stream) is base64 so the raw bytes reach
    // the webview byte-exact. A missing content-type is treated as text to
    // preserve prior behavior for plain APIs.
    let content_type = response_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let textual = content_type.is_empty() || is_textual_content_type(&content_type);
    info!(
        "[Tauri Proxy] Response: {} (content-type: {}, {})",
        status,
        if content_type.is_empty() { "<none>" } else { content_type.as_str() },
        if textual { "text" } else { "binary/base64" },
    );

    let (body, body_base64) = if textual {
        // reqwest's text() honors the Content-Type charset (defaulting to UTF-8),
        // so a non-UTF-8 text response isn't garbled the way from_utf8_lossy would.
        let text = response.text().await.map_err(|e| {
            TauriError::with_details(TauriErrorCode::ResponseReadError, format!("Failed to read response from {}", request.url), e.to_string())
        })?;
        (text, None)
    } else {
        let bytes = response.bytes().await.map_err(|e| {
            TauriError::with_details(TauriErrorCode::ResponseReadError, format!("Failed to read response from {}", request.url), e.to_string())
        })?;
        (String::new(), Some(base64::engine::general_purpose::STANDARD.encode(&bytes)))
    };

    Ok(HttpResponse {
        status,
        headers: response_headers,
        body,
        body_base64,
    })
}

// Registry of active SSE streams, keyed by stream_id, for cancellation support.
type SseCancelRegistry = std::sync::Arc<
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
>;

/// Open an SSE connection to `url` on the Rust side (bypasses mixed-content
/// restrictions for HTTPS-hosted app windows) and relay each chunk back to the
/// JS layer as a `sse-chunk-{stream_id}` window event.  Fires `sse-end-{stream_id}`
/// when the stream closes or errors.  Designed to be fire-and-forget from JS
/// (do not await the return value for data — use the window events).
#[tauri::command]
async fn proxy_sse_stream(
    window: tauri::Window,
    url: String,
    auth_header: String,
    stream_id: String,
    cancel_registry: tauri::State<'_, SseCancelRegistry>,
) -> Result<(), TauriError> {
    use futures_util::StreamExt;

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut registry = cancel_registry.lock_unpoisoned();
        registry.insert(stream_id.clone(), cancel_tx);
    }

    let chunk_event = format!("sse-chunk-{}", stream_id);
    let end_event = format!("sse-end-{}", stream_id);

    if let Err(reason) = validate_allowed_url(&url, None) {
        cancel_registry
            .lock_unpoisoned()
            .remove(&stream_id);
        let _ = window.emit(&end_event, "");
        return Err(TauriError::new(TauriErrorCode::UrlNotAllowed, reason));
    }

    let mut request = sse_client()
        .get(&url)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache");
    if !auth_header.is_empty() {
        request = request.header("Authorization", &auth_header);
    }
    let result = request.send().await;

    let response = match result {
        Ok(r) => r,
        Err(e) => {
            cancel_registry
                .lock_unpoisoned()
                .remove(&stream_id);
            let _ = window.emit(&end_event, "");
            return Err(TauriError::with_details(
                TauriErrorCode::HttpRequestFailed,
                format!("SSE connection to {} failed", url),
                e.to_string(),
            ));
        }
    };

    let mut stream = response.bytes_stream();
    loop {
        tokio::select! {
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        if window.emit(&chunk_event, text).is_err() {
                            break; // window closed
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            _ = &mut cancel_rx => break,
        }
    }

    cancel_registry
        .lock_unpoisoned()
        .remove(&stream_id);
    let _ = window.emit(&end_event, "");
    Ok(())
}

/// Cancel a running SSE stream started by `proxy_sse_stream`.
#[tauri::command]
fn cancel_sse_stream(stream_id: String, cancel_registry: tauri::State<'_, SseCancelRegistry>) {
    if let Ok(mut registry) = cancel_registry.lock() {
        if let Some(sender) = registry.remove(&stream_id) {
            let _ = sender.send(());
        }
    }
}

// ─── Desktop token broker ───────────────────────────────────────────────────
//
// Refresh tokens are single-use (calimero-network/core#3083): every
// POST /auth/refresh consumes the presented token, and re-presenting a consumed
// one is treated as theft — the node revokes the whole token family and logs
// out every holder. Each app webview is a separate origin with its own
// localStorage and its own MeroJs, so they must not share a refresh token: the
// first to rotate consumes it and the next one trips reuse detection.
//
// So app windows never get the real refresh token. The desktop window holds it
// and is the sole rotator. The proxy script intercepts an app's
// POST /auth/refresh and calls `broker_token_refresh`, which relays the request
// to the desktop window and returns the access token it hands back.

/// What the desktop window answers with: a fresh access token, or why not.
type TokenBrokerReply = Result<String, String>;

/// In-flight broker requests, keyed by request id, awaiting the desktop's reply.
type TokenBrokerRegistry = std::sync::Arc<
    std::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<TokenBrokerReply>>,
    >,
>;

/// How long the desktop window gets to answer before the app's fetch fails.
const TOKEN_BROKER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Clone, Serialize)]
struct TokenRequestPayload {
    #[serde(rename = "requestId")]
    request_id: String,
}

/// Ask the desktop rotator window for a fresh access token. Shared by the
/// in-process `broker_token_refresh` command and the Unix-socket broker service
/// (macOS) that serves the separate per-app shell processes.
async fn rotate_access_token(
    app_handle: &tauri::AppHandle,
    registry: &TokenBrokerRegistry,
) -> Result<String, String> {
    static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request_id = format!(
        "tok-{}",
        NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let main_window = app_handle.get_webview_window("main").ok_or_else(|| {
        "Desktop window is unavailable; cannot refresh the access token".to_string()
    })?;

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<TokenBrokerReply>();
    registry
        .lock_unpoisoned()
        .insert(request_id.clone(), reply_tx);

    if let Err(e) = main_window.emit(
        "calimero:token-request",
        TokenRequestPayload {
            request_id: request_id.clone(),
        },
    ) {
        registry
            .lock_unpoisoned()
            .remove(&request_id);
        return Err(format!("Failed to reach the desktop window: {e}"));
    }

    match tokio::time::timeout(TOKEN_BROKER_TIMEOUT, reply_rx).await {
        Ok(Ok(Ok(access_token))) => Ok(access_token),
        Ok(Ok(Err(reason))) => Err(reason),
        // Sender dropped without replying (desktop window closed mid-request).
        Ok(Err(_)) => Err("Desktop window closed before the token refresh completed".into()),
        Err(_) => {
            registry
                .lock_unpoisoned()
                .remove(&request_id);
            Err("Timed out waiting for the desktop to refresh the access token".into())
        }
    }
}

/// Broker an app window's `POST /auth/refresh` to the desktop window, which owns
/// the refresh token. Returns a fresh access token — never a refresh token.
#[tauri::command]
async fn broker_token_refresh(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: tauri::State<'_, TokenBrokerRegistry>,
    isolated: tauri::State<'_, IsolatedWindows>,
) -> Result<String, TauriError> {
    // Our session belongs to the active node, so a window holding another node's
    // session must never receive it. The label is Tauri's, not the caller's.
    if webview_isolation::is_isolated(&isolated, window.label()) {
        return Err(TauriError::new(
            TauriErrorCode::PathNotAllowed,
            "Token brokering is not available to a window targeting another node",
        ));
    }
    rotate_access_token(&app_handle, &registry)
        .await
        .map_err(|reason| TauriError::new(TauriErrorCode::InternalError, reason))
}

/// Maps an issued capability token -> its app id. Populated when a per-app
/// launcher is generated and loaded from `caps.json` at startup. The Unix-socket
/// broker only rotates for a `(cap, app_id)` pair present here.
#[cfg(target_os = "macos")]
type CapRegistry = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>;

#[cfg(target_os = "macos")]
fn cap_is_valid(registry: &CapRegistry, cap: &str, app_id: &str) -> bool {
    registry
        .lock_unpoisoned()
        .get(cap)
        .map(|id| id == app_id)
        .unwrap_or(false)
}

/// Bind the token-broker Unix socket and serve requests: reject other-user peers
/// (handled in `token_broker_ipc::serve`), validate the peer's cap against the
/// `CapRegistry`, then relay to the desktop rotator window. Returns a fresh
/// access token only — never a refresh token.
#[cfg(target_os = "macos")]
async fn run_broker_service(app_handle: tauri::AppHandle) {
    let path = host_socket_path();
    let _ = std::fs::remove_file(&path); // clear a stale socket
    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            log::error!("[broker] failed to bind {}: {e}", path.display());
            return;
        }
    };
    let handler = move |req: token_broker_ipc::BrokerRequest| {
        let app_handle = app_handle.clone();
        async move {
            let caps = app_handle.state::<CapRegistry>();
            if !cap_is_valid(&caps, &req.cap, &req.app_id) {
                return token_broker_ipc::BrokerResponse {
                    access_token: None,
                    error: Some("unknown capability".into()),
                };
            }
            let registry = app_handle.state::<TokenBrokerRegistry>();
            match rotate_access_token(&app_handle, &registry).await {
                Ok(t) => token_broker_ipc::BrokerResponse {
                    access_token: Some(t),
                    error: None,
                },
                Err(e) => token_broker_ipc::BrokerResponse {
                    access_token: None,
                    error: Some(e),
                },
            }
        }
    };
    if let Err(e) = token_broker_ipc::serve(listener, handler).await {
        log::error!("[broker] serve ended: {e}");
    }
}

/// Called by the desktop window to answer a `broker_token_refresh` request.
#[tauri::command]
fn resolve_token_request(
    request_id: String,
    access_token: Option<String>,
    error: Option<String>,
    registry: tauri::State<'_, TokenBrokerRegistry>,
) {
    if let Some(sender) = registry
        .lock_unpoisoned()
        .remove(&request_id)
    {
        let reply = match access_token {
            Some(token) => Ok(token),
            None => Err(error.unwrap_or_else(|| "Token refresh failed".to_string())),
        };
        // Receiver gone means the request already timed out — nothing to do.
        let _ = sender.send(reply);
    }
}

#[tauri::command]
fn get_pending_open_app(
    state: tauri::State<'_, PendingOpenApp>,
) -> Option<(String, String, Option<String>)> {
    state.0.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
fn clear_pending_open_app(state: tauri::State<'_, PendingOpenApp>) {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
}

#[tauri::command]
fn get_pending_cloud_auth(state: tauri::State<'_, PendingCloudAuth>) -> Option<String> {
    state.0.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
fn clear_pending_cloud_auth(state: tauri::State<'_, PendingCloudAuth>) {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
}

#[tauri::command]
fn get_pending_app_deep_link(state: tauri::State<'_, PendingAppDeepLink>) -> Option<AppDeepLink> {
    state.0.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
fn clear_pending_app_deep_link(state: tauri::State<'_, PendingAppDeepLink>) {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
}

/// Read the deep-link the app was launched with directly from the plugin's
/// `get_current()`. On macOS the plugin populates this from the launch Open
/// event independently of our `on_open_url` listener, so it's a reliable
/// fallback when the `PendingAppDeepLink` (set via the event listener) races
/// and comes up empty on a cold launch. Returns None for the OAuth callback.
#[tauri::command]
fn get_current_app_deep_link(app: tauri::AppHandle) -> Option<AppDeepLink> {
    use tauri_plugin_deep_link::DeepLinkExt;
    let raw = app
        .deep_link()
        .get_current()
        .ok()
        .flatten()?
        .into_iter()
        .map(|u| u.to_string())
        .find(|s| {
            s.starts_with("calimero://") || s.starts_with("https://links.calimero.network/")
        })?;
    parse_app_deep_link(&raw)
}

#[tauri::command]
fn hide_main_window(app_handle: tauri::AppHandle) -> Result<(), TauriError> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window
            .hide()
            .map_err(|e| TauriError::new(TauriErrorCode::WindowOperationFailed, e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
fn focus_window(app_handle: tauri::AppHandle, window_label: String) -> Result<(), TauriError> {
    if let Some(window) = app_handle.get_webview_window(&window_label) {
        window
            .set_focus()
            .map_err(|e| TauriError::new(TauriErrorCode::WindowOperationFailed, e.to_string()))?;
    }
    Ok(())
}

// ─── Per-app launcher (macOS) ────────────────────────────────────────────────
// A per-app `.app` is an UNSIGNED bash trampoline that execs a shared, loose,
// ad-hoc-signed `calimero-shell` binary with `--app-config <bundle>/…/app.json`.
// The shell owns the app's dock identity + badge/notify, and brokers refresh to
// this host over the Unix socket.

/// Where the host persists per-app capabilities (loaded into CapRegistry at startup).
#[cfg(target_os = "macos")]
fn caps_store_path() -> std::path::PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("network.calimero.desktop");
    let _ = std::fs::create_dir_all(&base);
    base.join("caps.json")
}

/// A per-app capability token. Unguessable-enough for defense-in-depth atop the
/// same-user socket.
#[cfg(target_os = "macos")]
fn new_cap(app_id: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("cap-{app_id}-{nanos:x}-{}", std::process::id())
}

/// The `calimero-shell` binary bundled inside this app's Resources.
#[cfg(target_os = "macos")]
fn bundled_shell_path(app_handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app_handle
        .path()
        .resolve("shell/calimero-shell", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Stable per-app cache location for the generated launcher `.icns`, keyed by id.
#[cfg(target_os = "macos")]
fn app_icon_cache_path(app_id: &str) -> std::path::PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("network.calimero.desktop")
        .join("app-icons");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{app_id}.icns"))
}

/// Resolve a manifest icon `src` (which may be absolute, root-relative, or
/// path-relative) against the app's `frontend_url` origin.
#[cfg(target_os = "macos")]
fn resolve_icon_url(base: &str, src: &str) -> Option<String> {
    url::Url::parse(base)
        .ok()?
        .join(src)
        .ok()
        .map(|u| u.to_string())
}

/// Parse a web-app manifest body and pick the largest PNG icon `src`, resolved to
/// an absolute URL against `base`.
#[cfg(target_os = "macos")]
fn pick_manifest_png(body: &str, base: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let icons = v.get("icons")?.as_array()?;
    let mut best: Option<(u64, String)> = None;
    for icon in icons {
        let Some(src) = icon.get("src").and_then(|s| s.as_str()) else {
            continue;
        };
        let is_png = icon
            .get("type")
            .and_then(|t| t.as_str())
            .map(|t| t.eq_ignore_ascii_case("image/png"))
            .unwrap_or(false)
            || src.to_ascii_lowercase().ends_with(".png");
        if !is_png {
            continue;
        }
        // "sizes" like "512x512" (may be a space-separated list, or "any").
        let size = icon
            .get("sizes")
            .and_then(|s| s.as_str())
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.split(['x', 'X']).next())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let Some(resolved) = resolve_icon_url(base, src) else {
            continue;
        };
        if best.as_ref().map(|(bs, _)| size > *bs).unwrap_or(true) {
            best = Some((size, resolved));
        }
    }
    best.map(|(_, u)| u)
}

/// Fetch `url` and return its bytes iff the response is a real PNG (magic bytes).
#[cfg(target_os = "macos")]
async fn fetch_png_bytes(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    Some(bytes.to_vec())
}

/// Best-effort: obtain a PNG app icon from the web app served at `base`. Tries the
/// web manifest first (largest PNG), then falls back to common PWA icon paths.
#[cfg(target_os = "macos")]
async fn fetch_icon_png(client: &reqwest::Client, base: &str) -> Option<Vec<u8>> {
    // 1. Manifest → largest PNG.
    for manifest in [
        "/manifest.webmanifest",
        "/site.webmanifest",
        "/manifest.json",
    ] {
        let murl = format!("{base}{manifest}");
        if let Ok(resp) = client.get(&murl).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Some(icon_url) = pick_manifest_png(&text, base) {
                        if let Some(bytes) = fetch_png_bytes(client, &icon_url).await {
                            return Some(bytes);
                        }
                    }
                }
            }
        }
    }
    // 2. Fall back to well-known PWA icon paths.
    for path in [
        "/icons/icon-512x512.png",
        "/icons/icon-192x192.png",
        "/pwa-512x512.png",
        "/apple-touch-icon.png",
        "/favicon.png",
    ] {
        let url = format!("{base}{path}");
        if let Some(bytes) = fetch_png_bytes(client, &url).await {
            return Some(bytes);
        }
    }
    None
}

/// Convert a PNG file to `.icns`. Prefers the macOS built-in `sips` single-size
/// conversion; if that fails, materializes a minimal `.iconset` (via `sips`
/// resizes) and runs `iconutil -c icns`.
#[cfg(target_os = "macos")]
fn png_to_icns(png: &std::path::Path, icns: &std::path::Path) -> std::io::Result<()> {
    // Assembled at a temp path and renamed in. The icon cache trusts any file it
    // finds, so a crash mid-conversion must not leave a partial one behind.
    let tmp = icns.with_extension("icns.part");
    let _ = std::fs::remove_file(&tmp);

    let out = std::process::Command::new("sips")
        .args(["-s", "format", "icns"])
        .arg(png)
        .arg("--out")
        .arg(&tmp)
        .output()?;
    if out.status.success() && tmp.exists() {
        return std::fs::rename(&tmp, icns);
    }
    // Fallback: build a minimal .iconset and let iconutil assemble the .icns.
    let iconset = icns.with_extension("iconset");
    let _ = std::fs::remove_dir_all(&iconset);
    std::fs::create_dir_all(&iconset)?;
    for base_px in [16u32, 32, 128, 256, 512] {
        for (name, px) in [
            (format!("icon_{base_px}x{base_px}.png"), base_px),
            (format!("icon_{base_px}x{base_px}@2x.png"), base_px * 2),
        ] {
            let dst = iconset.join(&name);
            let _ = std::process::Command::new("sips")
                .args(["-z", &px.to_string(), &px.to_string()])
                .arg(png)
                .arg("--out")
                .arg(&dst)
                .output();
        }
    }
    let out = std::process::Command::new("iconutil")
        .args(["-c", "icns"])
        .arg(&iconset)
        .arg("-o")
        .arg(&tmp)
        .output()?;
    let _ = std::fs::remove_dir_all(&iconset);
    if out.status.success() && tmp.exists() {
        std::fs::rename(&tmp, icns)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "iconutil failed to produce .icns",
        ))
    }
}

/// Best-effort produce a `.icns` for the per-app launcher, sourced from the web
/// app served at `frontend_url`. Returns the cached `.icns` path on success, or
/// `None` on ANY failure so launcher creation never breaks.
/// Decode a `data:image/...;base64,<b64>` URI to raw PNG bytes, verifying the PNG
/// magic. Returns None for anything that isn't a base64 PNG data URI.
#[cfg(target_os = "macos")]
fn decode_data_uri_png(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let (_, b64) = s.strip_prefix("data:")?.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        Some(bytes)
    } else {
        None
    }
}

/// Fetch the app's web-manifest / favicon PNG. Runs on a DEDICATED thread with its
/// OWN runtime: this is reached from a Tauri command that may execute inside the
/// ambient Tokio runtime, where `tauri::async_runtime::block_on` does not drive
/// the request (the fetch came back empty and every launcher fell back to the
/// generic exec icon). A fresh std::thread has no ambient runtime, so a
/// current-thread runtime can block on it; a one-off client keeps its pool here.
#[cfg(target_os = "macos")]
fn fetch_frontend_icon_png(frontend_url: &str) -> Option<Vec<u8>> {
    let base = frontend_url.trim_end_matches('/').to_string();
    std::thread::spawn(move || -> Option<Vec<u8>> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        rt.block_on(async {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .ok()?;
            fetch_icon_png(&client, &base).await
        })
    })
    .join()
    .ok()
    .flatten()
}

/// The launcher icon for an app. Prefers a PNG **bundled in the app manifest**
/// (`metadata.icon`, a `data:` URI) — deterministic, offline, travels with the
/// app — and falls back to fetching the app's web favicon/PWA-manifest icon.
#[cfg(target_os = "macos")]
fn ensure_app_launcher_icon(
    bundled_icon: Option<&str>,
    frontend_url: &str,
    app_id: &str,
) -> Option<std::path::PathBuf> {
    // A generated .icns is reused as-is: regenerating it costs a network fetch and
    // ~11 `sips` forks. Manifest icons are content-keyed so a changed icon
    // regenerates itself; fetched favicons (content unknown until fetched) key by
    // app id and refresh via Remove Launchers, which clears this cache.
    let cache_key = match bundled_icon {
        Some(data) => {
            use sha2::{Digest, Sha256};
            format!("{app_id}-{}", &format!("{:x}", Sha256::digest(data.as_bytes()))[..12])
        }
        None => app_id.to_string(),
    };
    let cached = app_icon_cache_path(&cache_key);
    if cached.exists() {
        return Some(cached);
    }
    let png = bundled_icon
        .and_then(decode_data_uri_png)
        .or_else(|| fetch_frontend_icon_png(frontend_url))?;
    let tmp_png = std::env::temp_dir().join(format!("calimero-appicon-{app_id}.png"));
    std::fs::write(&tmp_png, &png).ok()?;
    let result = png_to_icns(&tmp_png, &cached);
    let _ = std::fs::remove_file(&tmp_png);
    match result {
        Ok(()) => Some(cached),
        Err(_) => None,
    }
}

/// Where per-app launchers live: the user's `~/Applications` folder. Unlike the
/// Desktop it is NOT TCC-protected (no permission prompt), and it is visible in
/// Finder / Spotlight / Launchpad. (This is where Chrome-style app launchers go.)
#[cfg(target_os = "macos")]
fn launcher_dir() -> Result<std::path::PathBuf, TauriError> {
    let dir = dirs::home_dir()
        .ok_or_else(|| {
            TauriError::new(TauriErrorCode::HomeDirNotFound, "Could not find home folder")
        })?
        .join("Applications");
    std::fs::create_dir_all(&dir).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Could not create ~/Applications",
            e.to_string(),
        )
    })?;
    Ok(dir)
}

/// Create-or-refresh the single launcher `.app` for an app under `dest_dir`:
/// extract the shell, (re)generate the unsigned trampoline, persist + register
/// the cap. Deduplicates by app id — reuses the app's existing cap and removes a
/// stale bundle if the launcher moved (rename, or Desktop <-> managed).
#[cfg(target_os = "macos")]
fn ensure_app_launcher(
    app_handle: &tauri::AppHandle,
    app_name: &str,
    frontend_url: &str,
    app_id: &str,
    bundled_icon: Option<&str>,
    node_url: &str,
    dest_dir: &std::path::Path,
) -> Result<std::path::PathBuf, TauriError> {
    launcher::validate_app_id(app_id)
        .map_err(|e| TauriError::new(TauriErrorCode::ShortcutCreationFailed, e.to_string()))?;

    // Both callers now run this on a blocking thread, so two builds can overlap and
    // interleave the caps.json read-modify-write below. Global, not per app id: the
    // cap must also match the bundle it was baked into when one app is opened twice.
    static BUILD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _serialised = BUILD.lock_unpoisoned();

    // sanitize the name for the .app filename
    let safe: String = app_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim().trim_matches('_');
    let safe = if safe.is_empty() { "Calimero App" } else { safe };

    // ensure the shared shell is extracted to its loose path (idempotent).
    let shell_dest = launcher::shell_install_path();
    let src = bundled_shell_path(app_handle).ok_or_else(|| {
        TauriError::new(TauriErrorCode::ShortcutCreationFailed, "bundled shell missing")
    })?;
    launcher::extract_shell(&src, &shell_dest)
        .map_err(|e| TauriError::new(TauriErrorCode::ShortcutCreationFailed, e.to_string()))?;

    // Dedup by app id: keep a stable cap; drop any previous bundle elsewhere.
    let store = caps_store_path();
    let prev = app_registry::installed_apps(&store)
        .into_iter()
        .find(|a| a.id == app_id);
    let cap = prev
        .as_ref()
        .map(|a| a.cap.clone())
        .unwrap_or_else(|| new_cap(app_id));
    let target = dest_dir.join(format!("{}.app", safe));
    if let Some(p) = prev.as_ref() {
        if !p.bundle_path.is_empty() && std::path::Path::new(&p.bundle_path) != target {
            let _ = std::fs::remove_dir_all(&p.bundle_path);
        }
    }

    // Best-effort real launcher icon: the bundled `metadata.icon` if the app
    // ships one, else the app's web favicon; None (generic exec icon) if neither
    // yields a usable PNG.
    let icon = ensure_app_launcher_icon(bundled_icon, frontend_url, app_id);
    let spec = launcher::AppSpec {
        id: app_id.to_string(),
        name: safe.to_string(),
        url: frontend_url.to_string(),
        node_url: node_url.to_string(),
        cap: cap.clone(),
        icon,
    };
    let bundle = launcher::generate_launcher(dest_dir, &shell_dest, &spec)
        .map_err(|e| TauriError::new(TauriErrorCode::ShortcutCreationFailed, e.to_string()))?;

    app_registry::persist_app(
        &store,
        &app_registry::InstalledApp {
            id: app_id.to_string(),
            name: safe.to_string(),
            url: frontend_url.to_string(),
            node_url: node_url.to_string(),
            cap: cap.clone(),
            bundle_path: bundle.to_string_lossy().into_owned(),
            host_version: env!("CARGO_PKG_VERSION").to_string(),
        },
    )
    .map_err(|e| TauriError::new(TauriErrorCode::ShortcutCreationFailed, e.to_string()))?;
    app_handle
        .state::<CapRegistry>()
        .lock_unpoisoned()
        .insert(cap, app_id.to_string());

    Ok(bundle)
}

/// "Open" on macOS: launch the app through its per-app shell/launcher (first-class
/// dock identity), creating a managed launcher if one doesn't exist yet. Reuses
/// the app's existing launcher location (e.g. a Desktop one) when present.
///
/// The body takes seconds (shell extract, icon fetch, `sips`, waiting on `open`),
/// so it runs on a blocking thread rather than a runtime worker.
#[tauri::command]
async fn open_app_launcher(
    app_handle: tauri::AppHandle,
    app_name: String,
    frontend_url: String,
    app_id: String,
    icon: Option<String>,
    node_url: String,
) -> Result<String, TauriError> {
    tokio::task::spawn_blocking(move || {
        open_app_launcher_blocking(app_handle, app_name, frontend_url, app_id, icon, node_url)
    })
    .await
    .map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::ShortcutCreationFailed,
            "Launcher task failed",
            e.to_string(),
        )
    })?
}

#[allow(unused_variables)]
fn open_app_launcher_blocking(
    app_handle: tauri::AppHandle,
    app_name: String,
    frontend_url: String,
    app_id: String,
    icon: Option<String>,
    node_url: String,
) -> Result<String, TauriError> {
    #[cfg(target_os = "macos")]
    {
        let existing_dir = app_registry::installed_apps(&caps_store_path())
            .into_iter()
            .find(|a| a.id == app_id)
            .and_then(|a| {
                std::path::Path::new(&a.bundle_path)
                    .parent()
                    .map(|p| p.to_path_buf())
            })
            .filter(|p| p.exists());
        let dest_dir = match existing_dir {
            Some(d) => d,
            None => launcher_dir()?,
        };
        let bundle = ensure_app_launcher(
            &app_handle,
            &app_name,
            &frontend_url,
            &app_id,
            icon.as_deref(),
            &node_url,
            &dest_dir,
        )?;
        // Wait for `open` rather than spawning it: spawn only reports that the
        // helper started, so a LaunchServices failure left the caller with no
        // window and no error instead of falling back to an in-process one.
        let out = std::process::Command::new("open")
            .arg(&bundle)
            .output()
            .map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::ShortcutCreationFailed,
                    "Failed to open launcher",
                    e.to_string(),
                )
            })?;
        if !out.status.success() {
            let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(TauriError::with_details(
                TauriErrorCode::ShortcutCreationFailed,
                format!("macOS could not open {}", bundle.display()),
                if detail.is_empty() {
                    format!("open exited with {}", out.status)
                } else {
                    detail
                },
            ));
        }
        Ok(bundle.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(TauriError::new(
            TauriErrorCode::PlatformNotSupported,
            "per-app launchers are only supported on macOS",
        ))
    }
}

/// Shares `ensure_app_launcher` with `open_app_launcher`, so it blocks for just as
/// long and takes the same blocking thread.
#[tauri::command]
async fn create_desktop_shortcut(
    app_handle: tauri::AppHandle,
    app_name: String,
    frontend_url: String,
    app_id: Option<String>,
    icon: Option<String>,
    node_url: String,
) -> Result<String, TauriError> {
    tokio::task::spawn_blocking(move || {
        create_desktop_shortcut_blocking(app_handle, app_name, frontend_url, app_id, icon, node_url)
    })
    .await
    .map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::ShortcutCreationFailed,
            "Shortcut task failed",
            e.to_string(),
        )
    })?
}

#[allow(unused_variables)]
fn create_desktop_shortcut_blocking(
    app_handle: tauri::AppHandle,
    app_name: String,
    frontend_url: String,
    app_id: Option<String>,
    icon: Option<String>,
    node_url: String,
) -> Result<String, TauriError> {
    let exe = std::env::current_exe().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::ShortcutCreationFailed,
            "Could not get executable path",
            e.to_string(),
        )
    })?;
    let exe_str = exe.to_str().ok_or_else(|| {
        TauriError::new(
            TauriErrorCode::ShortcutCreationFailed,
            "Executable path is not valid UTF-8",
        )
    })?;

    let safe_name: String = app_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let shortcut_name = safe_name.trim().trim_matches('_');
    let shortcut_name = if shortcut_name.is_empty() {
        "Calimero App"
    } else {
        shortcut_name
    };

    #[cfg(windows)]
    {
        let desktop = dirs::desktop_dir().ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::HomeDirNotFound,
                "Could not find Desktop folder",
            )
        })?;
        let lnk_path = desktop.join(format!("{}.lnk", shortcut_name));
        let url_esc = frontend_url.replace('"', "\\\"");
        let name_esc = app_name.replace('"', "\\\"");
        let id_arg = app_id
            .as_deref()
            .map(|id| format!(" --open-app-id \"{}\"", id.replace('"', "\\\"")))
            .unwrap_or_default();
        let args = format!(
            "--open-app-url \"{}\" --open-app-name \"{}\"{}",
            url_esc, name_esc, id_arg
        );
        let ps = format!(
            "$WshShell = New-Object -ComObject WScript.Shell; $s = $WshShell.CreateShortcut('{}'); $s.TargetPath = '{}'; $s.Arguments = '{}'; $s.Save()",
            lnk_path.display(),
            exe_str.replace('\'', "''"),
            args.replace('\'', "''")
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output()
            .map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::ShortcutCreationFailed,
                    "Failed to run PowerShell",
                    e.to_string(),
                )
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TauriError::new(
                TauriErrorCode::ShortcutCreationFailed,
                format!("Failed to create shortcut: {}", stderr),
            ));
        }
        return Ok(lnk_path.to_string_lossy().into_owned());
    }

    #[cfg(target_os = "macos")]
    {
        // Per-app launcher: an unsigned bash-trampoline `.app` in ~/Applications
        // that execs the shared `calimero-shell`. First-class dock identity +
        // badge/notify, no per-app signing. Replaces the earlier self-exec shim.
        let dir = launcher_dir()?;
        let app_id = app_id
            .clone()
            .unwrap_or_else(|| shortcut_name.replace(' ', "-").to_lowercase());
        let bundle = ensure_app_launcher(
            &app_handle,
            &app_name,
            &frontend_url,
            &app_id,
            icon.as_deref(),
            &node_url,
            &dir,
        )?;
        return Ok(bundle.to_string_lossy().into_owned());
    }

    #[cfg(target_os = "linux")]
    {
        let desktop = std::env::var("XDG_DESKTOP_DIR")
            .map(std::path::PathBuf::from)
            .or_else(|_| {
                dirs::desktop_dir().ok_or_else(|| {
                    TauriError::new(
                        TauriErrorCode::HomeDirNotFound,
                        "Could not find Desktop folder",
                    )
                })
            })?;
        let path = desktop.join(format!("{}.desktop", shortcut_name));
        let exe_esc = exe_str.replace('\\', "\\\\").replace('"', "\\\"");
        let url_esc = frontend_url.replace('\\', "\\\\").replace('"', "\\\"");
        let name_esc = app_name.replace('\\', "\\\\").replace('"', "\\\"");
        let id_arg = app_id
            .as_deref()
            .map(|id| {
                format!(
                    " --open-app-id \"{}\"",
                    id.replace('\\', "\\\\").replace('"', "\\\"")
                )
            })
            .unwrap_or_default();
        let content = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={}\n\
             Exec=\"{}\" --open-app-url \"{}\" --open-app-name \"{}\"{}\n\
             Terminal=false\n",
            name_esc, exe_esc, url_esc, name_esc, id_arg
        );
        std::fs::write(&path, content).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::FileWriteError,
                "Failed to write shortcut file",
                e.to_string(),
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path)
                .map_err(|e| {
                    TauriError::with_details(
                        TauriErrorCode::FileWriteError,
                        "Failed to stat shortcut file",
                        e.to_string(),
                    )
                })?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::FileWriteError,
                    "Failed to chmod shortcut file",
                    e.to_string(),
                )
            })?;
        }
        return Ok(path.to_string_lossy().into_owned());
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (app_handle, app_name, frontend_url);
        Err(TauriError::new(
            TauriErrorCode::PlatformNotSupported,
            "Desktop shortcuts are not supported on this platform",
        ))
    }
}


#[tauri::command]
async fn create_app_window(
    app_handle: tauri::AppHandle,
    window_label: String,
    url: String,
    title: String,
    open_devtools: Option<bool>,
    node_url: Option<String>,
    isolation_key: Option<String>,
) -> Result<(), TauriError> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // Parse URL up front to fail fast on invalid input.
    let _parsed_url = url.parse::<url::Url>().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::InvalidUrl,
            format!("Invalid URL '{}'", url),
            e.to_string(),
        )
    })?;

    // Inject fetch interceptor to proxy node requests through Tauri
    // Since calimero-client-js now uses fetch instead of Axios, we only need fetch interception
    // CRITICAL: Intercept IMMEDIATELY before React makes any fetch calls
    // Load proxy script from external file and inject configured node URL
    let mut proxy_script = include_str!("proxy_script.js").to_string();

    // Inject configured node URL into the proxy script
    // Default to http://localhost:2528 for backwards compatibility
    let node_url_to_use = node_url.as_deref().unwrap_or("http://localhost:2528");
    // Replace placeholder in script with actual node URL
    proxy_script = proxy_script.replace("__CONFIGURED_NODE_URL__", node_url_to_use);

    // Create window with proxy script injected BEFORE page loads
    let mut builder = WebviewWindowBuilder::new(
        &app_handle,
        &window_label,
        WebviewUrl::External(url.parse::<url::Url>().map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::InvalidUrl,
                format!("Invalid URL '{}'", url),
                e.to_string(),
            )
        })?),
    )
    .title(&title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .center()
    .initialization_script(&proxy_script); // Inject script with configured node URL

    // A stable per-(app, node) bucket so the window keeps its own session across
    // opens. macOS has no per-webview data directory, hence the identifier.
    if let Some(key) = &isolation_key {
        // Refuse rather than open a window that quietly shares one store with
        // another node's session. wry falls back to the default store silently
        // below macOS 14, so this cannot be a per-platform cfg, and it must not
        // depend on the caller having checked webview_isolation_supported.
        if !webview_isolation_supported() {
            return Err(TauriError::new(
                TauriErrorCode::PlatformNotSupported,
                "Isolated app windows need macOS 14 or newer, or Linux",
            ));
        }
        let digest = webview_isolation::store_id(&app_handle, key)?;
        #[cfg(target_os = "macos")]
        {
            builder = builder.data_store_identifier(digest);
        }
        #[cfg(target_os = "linux")]
        {
            let dir = app_handle
                .path()
                .app_data_dir()
                .map_err(|e| {
                    TauriError::with_details(
                        TauriErrorCode::DirectoryError,
                        "Failed to resolve app data dir for webview isolation",
                        e.to_string(),
                    )
                })?
                .join("webviews")
                .join(webview_isolation::dir_name(&digest));
            builder = builder.data_directory(dir);
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            // Unreachable: webview_isolation_supported() is false here.
            let _ = digest;
        }

        // Register last: setup above can fail, and no page exists until build()
        // below, so nothing can reach the broker before this lands.
        webview_isolation::remember(&app_handle, &window_label);
    }

    let window = builder.build().map_err(|e| {
        // The registration has to precede build() so a page cannot reach the
        // broker before it lands; drop it again if no window ever existed.
        if isolation_key.is_some() {
            webview_isolation::forget(&app_handle, &window_label);
        }
        TauriError::with_details(
            TauriErrorCode::WindowCreationFailed,
            format!("Failed to create window '{}' for URL '{}'", title, url),
            e.to_string(),
        )
    })?;

    // Stop tracking a label once its window is gone, so the set does not grow
    // for the life of the process.
    if isolation_key.is_some() {
        let handle = app_handle.clone();
        let label = window_label.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                webview_isolation::forget(&handle, &label);
            }
        });
    }

    // Remote-URL IPC access is granted statically in Tauri v2 via the
    // capabilities system (see src-tauri/capabilities/remote.json), which
    // targets the `app-*` window labels and the allowed remote origins
    // (localhost, 127.0.0.1, *.calimero.network). The v1 runtime
    // `RemoteDomainAccessScope`/`ipc_scope().configure_remote_access()` API
    // no longer exists. Note: IP-hosted pages (127.0.0.1) still fall back to
    // native fetch via the injected proxy script.

    // Camera/microphone for WebRTC video calls (e.g. Mero Meet) needs no extra
    // work here: wry's own WKUIDelegate already grants
    // `requestMediaCapturePermissionForOrigin` on macOS, and WebView2 / WebKitGTK
    // grant it on Windows/Linux. The OS-level permission prompt (gated by the
    // Info.plist usage strings + entitlements) still applies on first use.
    // Installing a custom delegate here would replace wry's, breaking its
    // `<input type=file>` open-panel handler.

    // Show the window AFTER IPC scope is configured
    window.show().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::WindowOperationFailed,
            format!("Failed to display window '{}'", title),
            e.to_string(),
        )
    })?;
    // Bring app window to front so user sees it instead of the main dashboard
    let _ = window.set_focus();

    // Open devtools if flag is set (defaults to debug mode only, or TAURI_OPEN_DEVTOOLS env var)
    // IMPORTANT: Release builds NEVER enable devtools, even if env var is set
    let should_open_devtools = {
        #[cfg(not(debug_assertions))]
        {
            // Release builds: NEVER enable devtools (security)
            false
        }
        #[cfg(debug_assertions)]
        {
            // Debug builds: Check explicit parameter first, then env var, then default to true
            open_devtools.unwrap_or_else(|| {
                // Check environment variable (allows override via script)
                if let Ok(env_value) = std::env::var("TAURI_OPEN_DEVTOOLS") {
                    env_value == "true" || env_value == "1"
                } else {
                    // Default to true in debug builds
                    true
                }
            })
        }
    };

    #[cfg(feature = "devtools")]
    if should_open_devtools {
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        window.open_devtools();
    }

    Ok(())
}

#[tauri::command]
async fn open_devtools(_window_label: String, _app_handle: tauri::AppHandle) {
    #[cfg(feature = "devtools")]
    {
        // Try multiple times with delays in case window isn't ready yet
        for _i in 0..5 {
            if let Some(window) = _app_handle.get_webview_window(&_window_label) {
                window.open_devtools();
                return;
            }
            // Wait a bit before retrying (use async sleep to avoid blocking runtime)
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }
    }
}

// Merod process management using bundled resource
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Tracks the number of in-flight HTTP proxy requests.
/// Used during graceful shutdown to wait for pending requests to complete.
static IN_FLIGHT_REQUESTS: AtomicUsize = AtomicUsize::new(0);

struct InFlightGuard;
impl InFlightGuard {
    fn new() -> Self {
        IN_FLIGHT_REQUESTS.fetch_add(1, Ordering::SeqCst);
        InFlightGuard
    }
}
impl Drop for InFlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT_REQUESTS.fetch_sub(1, Ordering::SeqCst);
    }
}

const REQUEST_DRAIN_TIMEOUT_SECS: u64 = 10;
const PROCESS_TERM_WAIT_SECS: u64 = 3;
use tokio::process::Command;

/// Returns PIDs of running merod processes, merging tracked state with OS-level discovery.
fn collect_merod_pids(tracked: &[u32]) -> Vec<u32> {
    let mut pids: Vec<u32> = tracked.to_vec();
    #[cfg(unix)]
    {
        if let Ok(output) = std::process::Command::new("ps")
            .args(["ax", "-o", "pid,command"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let mut parts = line.split_whitespace();
                let pid_str = match parts.next() {
                    Some(p) => p,
                    None => continue,
                };
                let exe = match parts.next() {
                    Some(e) => e,
                    None => continue,
                };
                let args: Vec<&str> = parts.collect();
                let basename = exe.split('/').last().unwrap_or(exe);
                if basename == "merod" && args.iter().any(|a| *a == "run") {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(output) = std::process::Command::new("tasklist")
            .args(["/FO", "CSV"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines().skip(1) {
                if line.to_lowercase().starts_with("\"merod.exe\"") {
                    let parts: Vec<&str> = line.split(',').collect();
                    if parts.len() >= 2 {
                        if let Ok(pid) = parts[1].trim_matches('"').parse::<u32>() {
                            if !pids.contains(&pid) {
                                pids.push(pid);
                            }
                        }
                    }
                }
            }
        }
    }
    pids
}

/// PIDs of running per-app shell processes. Each launcher `.app` trampoline execs
/// the shared loose shell binary, so the process shows up under the shell's own
/// name — never as the host. Used by the total nuke: a live shell keeps an
/// authenticated app webview (and would re-flush its localStorage after a wipe).
#[cfg(target_os = "macos")]
fn collect_shell_pids() -> Vec<u32> {
    // Installed name (extract_shell's dest) plus the cargo binary name used in dev.
    const SHELL_BINARY_NAMES: [&str; 2] = ["CalimeroShell", "calimero-shell"];
    let mut pids: Vec<u32> = Vec::new();
    if let Ok(output) = std::process::Command::new("ps")
        .args(["ax", "-o", "pid,command"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let mut parts = line.split_whitespace();
            let (Some(pid_str), Some(exe)) = (parts.next(), parts.next()) else {
                continue;
            };
            let basename = exe.split('/').last().unwrap_or(exe);
            if SHELL_BINARY_NAMES.contains(&basename) {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids
}

/// Sends SIGTERM to all pids, waits, then force-kills any survivors.
async fn kill_pids(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let pids_owned = pids.to_vec();
    tokio::task::spawn_blocking(move || {
        for pid in &pids_owned {
            #[cfg(unix)]
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
            #[cfg(windows)]
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string()])
                .output();
        }
        std::thread::sleep(std::time::Duration::from_secs(PROCESS_TERM_WAIT_SECS));
        for pid in &pids_owned {
            #[cfg(unix)]
            {
                let still_alive = std::process::Command::new("ps")
                    .arg("-p")
                    .arg(pid.to_string())
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if still_alive {
                    let _ = std::process::Command::new("kill")
                        .args(["-9", &pid.to_string()])
                        .output();
                }
            }
            #[cfg(windows)]
            {
                let still_alive = std::process::Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
                    .unwrap_or(false);
                if still_alive {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F"])
                        .output();
                }
            }
        }
    })
    .await
    .unwrap_or(());
}

#[derive(Debug, Clone)]
struct MerodProcess {
    pid: u32,
    port: u16,
}

type MerodState = Arc<Mutex<Vec<MerodProcess>>>;

/// Announce that the set of tracked merod processes changed, so the frontend can
/// refetch on the edge instead of polling for it. Emitted on every mutation of
/// `MerodState`; carries no payload.
fn emit_merod_status_changed(app_handle: &tauri::AppHandle) {
    let _ = app_handle.emit("merod-status-changed", ());
}

/// A registered log writer plus a reference count of live processes using it.
/// Ref-counting means a restart or a concurrent second start (which reuse the
/// same writer) don't drop the shared registration until the *last* user exits.
struct LogWriterEntry {
    writer: Arc<Mutex<log_rotation::RollingLogWriter>>,
    refs: usize,
}

/// Live rotating log writers, keyed by log directory. Lets `clear_merod_logs`
/// clear through the same writer the drain tasks use (serialized by the inner
/// Mutex) rather than racing it via free functions on raw paths.
type MerodLogWriters = Arc<Mutex<std::collections::HashMap<String, LogWriterEntry>>>;

/// Resolve an optional caller-supplied home dir: expand a leading `~`, or fall
/// back to `~/.calimero`. Single source of truth for the node commands.
pub(crate) fn resolve_home_dir(home_dir: Option<String>) -> Result<std::path::PathBuf, TauriError> {
    if let Some(dir) = home_dir {
        let expanded = if dir.starts_with("~") {
            match dirs::home_dir() {
                Some(home) => dir.replacen("~", &home.to_string_lossy(), 1),
                None => return Err(TauriError::new(TauriErrorCode::HomeDirNotFound, "Failed to get home directory")),
            }
        } else {
            dir
        };
        Ok(std::path::PathBuf::from(expanded))
    } else {
        Ok(dirs::home_dir()
            .ok_or_else(|| TauriError::new(TauriErrorCode::HomeDirNotFound, "Failed to get home directory"))?
            .join(".calimero"))
    }
}

/// Serialises node creation per name without holding a lock across the download
/// a pinned release may need. Cleared on drop so every exit path releases it.
struct NodeInitReservation(String);

static NODE_INIT_IN_FLIGHT: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::LazyLock::new(Default::default);

impl NodeInitReservation {
    fn claim(home: &std::path::Path, node_name: &str) -> Result<Self, TauriError> {
        let key = format!("{}::{}", home.display(), node_name);
        let mut in_flight = NODE_INIT_IN_FLIGHT
            .lock_unpoisoned();

        // merod init over an existing node reports success without minting the
        // admin account, leaving a node nobody can sign in to. Refuse instead.
        if home.join(node_name).exists() {
            return Err(TauriError::new(
                TauriErrorCode::InvalidInput,
                format!(
                    "Node '{}' already exists. Pick a different name, or delete it first - re-initialising cannot change its merod version or its admin account.",
                    node_name
                ),
            ));
        }
        if !in_flight.insert(key.clone()) {
            return Err(TauriError::new(
                TauriErrorCode::InvalidInput,
                format!("Node '{}' is already being created", node_name),
            ));
        }
        Ok(Self(key))
    }
}

impl Drop for NodeInitReservation {
    fn drop(&mut self) {
        NODE_INIT_IN_FLIGHT
            .lock_unpoisoned()
            .remove(&self.0);
    }
}

/// Get the app data directory for storing merod data
fn get_app_data_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    Ok(app_data_dir)
}

/// Drain a child stdout/stderr stream into the rotating log writer.
/// The lock is held only for each short synchronous write (never across an await),
/// so the two drain tasks (stdout + stderr) interleave without corrupting output.
fn spawn_log_drain<R>(
    reader: R,
    writer: std::sync::Arc<std::sync::Mutex<log_rotation::RollingLogWriter>>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::AsyncReadExt;
    tokio::spawn(async move {
        // Read into a fixed-size buffer rather than read_until(b'\n'): raw bytes
        // never fail on non-UTF-8 (merod panic backtraces / stray binary) the way
        // lines() would, and a fixed buffer can't grow unbounded on a runaway
        // newline-less stream (an OOM vector). Bytes are written verbatim (ANSI
        // colours included); the writer's rotation and the viewer's lossy decode
        // handle anything unusual downstream.
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        // Log a persistent write failure (disk full, dir deleted, …) or a
        // poisoned writer lock once so it's discoverable, without spamming a
        // warning for every dropped chunk.
        let mut write_error_logged = false;
        let mut poison_logged = false;
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break, // EOF: process exited / stream closed
                Ok(n) => {
                    // Recover the guard even if the mutex was poisoned (some other
                    // holder panicked): a std Mutex stays poisoned forever, so
                    // ignoring the Err would silently stop all logging. into_inner()
                    // keeps draining; we warn once so it's diagnosable.
                    let mut w = match writer.lock() {
                        Ok(g) => g,
                        Err(poisoned) => {
                            if !poison_logged {
                                warn!("[Merod] log writer mutex poisoned; recovering and continuing: {}", poisoned);
                                poison_logged = true;
                            }
                            poisoned.into_inner()
                        }
                    };
                    // Keep draining even if a write fails, so a write error can
                    // never wedge merod by leaving its pipe unread — but surface
                    // the first failure so silent log loss is diagnosable.
                    if let Err(e) = w.write_line(&buf[..n]) {
                        if !write_error_logged {
                            warn!("[Merod] log write failed (further errors suppressed): {}", e);
                            write_error_logged = true;
                        }
                    } else {
                        write_error_logged = false;
                    }
                }
                Err(e) => {
                    // A genuine I/O error — log it so a stream that stops mid-run
                    // is diagnosable, then exit.
                    warn!("[Merod] log drain stopped on read error: {}", e);
                    break;
                }
            }
        }
    });
}

/// Repoint the port of the first `/<proto>/<digits>` component of a multiaddr,
/// leaving any trailing components (e.g. `/quic-v1`) intact.
fn replace_multiaddr_port(addr: &str, proto: &str, port: u16) -> String {
    let needle = format!("/{}/", proto);
    let Some(start) = addr.find(&needle) else {
        return addr.to_string();
    };
    let rest = &addr[start + needle.len()..];
    let tail = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    if tail.len() == rest.len() {
        return addr.to_string();
    }
    format!("{}{}{}{}", &addr[..start], needle, port, tail)
}

#[tauri::command]
async fn start_merod(
    server_port: Option<u16>,
    swarm_port: Option<u16>,
    data_dir: Option<String>,
    node_name: Option<String>,
    debug_logs: Option<bool>,
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
    log_writers: tauri::State<'_, MerodLogWriters>,
) -> Result<String, TauriError> {
    let server_port = server_port.unwrap_or(2528);
    let swarm_port = swarm_port.unwrap_or(2428);

    // Only stop a process that uses the same server_port (port conflict)
    let existing_on_port: Option<u32> = {
        let state = merod_state.lock_unpoisoned();
        state.iter().find(|p| p.port == server_port).map(|p| p.pid)
    };

    if let Some(pid) = existing_on_port {
        info!(
            "[Merod] Stopping existing process on port {} (PID: {}) before starting new one",
            server_port, pid
        );
        #[cfg(unix)]
        {
            use std::process::Command;
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .output();
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
        }
        #[cfg(windows)]
        {
            use std::process::Command;
            let _ = Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/F")
                .output();
        }
        merod_state
            .lock_unpoisoned()
            .retain(|p| p.pid != pid);
        emit_merod_status_changed(&app_handle);
    }

    // Prepare home directory (where .calimero folder is, e.g., ~/.calimero)
    // Same resolver as get_merod_logs/clear_merod_logs, so a node writes logs at
    // exactly the path the viewer/Clear later resolve (no ~-expansion drift).
    let home_dir_path = resolve_home_dir(data_dir)?;

    std::fs::create_dir_all(&home_dir_path).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to create home directory",
            e.to_string(),
        )
    })?;

    // Validate node name before any filesystem use
    if let Some(name) = &node_name {
        validate_node_name(name).map_err(|e| TauriError::new(TauriErrorCode::InvalidInput, e))?;
    }

    // The node's pin is the only source of truth: an override here could start a
    // node on a binary that every "used by" listing still attributes elsewhere.
    let version_id = match &node_name {
        Some(name) => merod_versions::read_pin(&home_dir_path, name)?,
        None => merod_versions::VersionId::Bundled,
    };
    let merod_binary = merod_versions::resolve_binary(&app_handle, &version_id).await?;

    // Update config.toml with the specified ports if node_name is provided
    if let Some(name) = &node_name {
        let node_dir = home_dir_path.join(name);
        let config_path = node_dir.join("config.toml");

        // Verify the node is initialized (config.toml exists)
        if !config_path.exists() {
            return Err(TauriError::new(
                TauriErrorCode::FileNotFound,
                format!(
                    "Node '{}' is not initialized. config.toml not found. Please run init first.",
                    name
                ),
            ));
        }

        // Config exists, proceed with port updates
        {
            // Read existing config
            let config_content = std::fs::read_to_string(&config_path).map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::FileReadError,
                    "Failed to read config.toml",
                    e.to_string(),
                )
            })?;

            let mut config: toml::Value = config_content.parse::<toml::Value>().map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::ConfigParseError,
                    "Failed to parse config.toml",
                    e.to_string(),
                )
            })?;

            // Update server.listen ports (auth_mode comes from merod init --auth-mode embedded)
            if let Some(server) = config.get_mut("server") {
                if let Some(listen) = server.get_mut("listen") {
                    if let Some(listen_array) = listen.as_array_mut() {
                        for listen_str in listen_array.iter_mut() {
                            if let Some(addr) = listen_str.as_str() {
                                // Replace port in IPv4 server addresses (e.g., /ip4/127.0.0.1/tcp/2528)
                                if addr.contains("/ip4/127.0.0.1/tcp/")
                                    || addr.contains("/ip6/::1/tcp/")
                                {
                                    *listen_str = toml::Value::String(replace_multiaddr_port(
                                        addr,
                                        "tcp",
                                        server_port,
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            // Update swarm.listen ports - use regex-like replacement for any port number
            if let Some(swarm) = config.get_mut("swarm") {
                if let Some(listen) = swarm.get_mut("listen") {
                    if let Some(listen_array) = listen.as_array_mut() {
                        for listen_str in listen_array.iter_mut() {
                            if let Some(addr) = listen_str.as_str() {
                                // Replace port in swarm addresses - handle both TCP and UDP
                                if addr.contains("/tcp/") && !addr.contains("/udp/") {
                                    // Replace TCP port (e.g., /ip4/0.0.0.0/tcp/2428)
                                    *listen_str = toml::Value::String(replace_multiaddr_port(
                                        addr, "tcp", swarm_port,
                                    ));
                                } else if addr.contains("/udp/") {
                                    // Replace UDP port (e.g., /ip4/0.0.0.0/udp/2428/quic-v1)
                                    *listen_str = toml::Value::String(replace_multiaddr_port(
                                        addr, "udp", swarm_port,
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            // Write updated config back
            let updated_config = toml::to_string_pretty(&config).map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::ConfigWriteError,
                    "Failed to serialize config.toml",
                    e.to_string(),
                )
            })?;
            std::fs::write(&config_path, updated_config).map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::ConfigWriteError,
                    "Failed to write config.toml",
                    e.to_string(),
                )
            })?;

            info!(
                "[Merod] Updated config.toml with server_port={} and swarm_port={}",
                server_port, swarm_port
            );
        }
    }

    // Node name required
    let node_name_str = node_name
        .as_ref()
        .ok_or_else(|| TauriError::new(TauriErrorCode::InvalidInput, "Node name is required"))?
        .clone();

    // Create logs directory. merod's stdout/stderr are piped to the app and drained
    // into a size-capped rotating writer (see below) so logs never grow unbounded.
    let log_dir = home_dir_path.join(&node_name_str).join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to create logs directory",
            e.to_string(),
        )
    })?;
    let log_path = log_dir.join("merod.log");

    // Trim old/oversized rotated segments before we start writing (also brings a
    // legacy pre-rotation merod.log back under the cap on next start).
    if let Err(e) = log_rotation::cleanup_logs(&log_dir) {
        warn!("[Merod] Log cleanup failed (non-fatal): {}", e);
    }

    // Rotating writer shared by the stdout and stderr drain tasks. Registered in
    // MerodLogWriters so clear_merod_logs can clear through this same instance
    // (serialized by the inner Mutex) instead of racing it on raw paths. We
    // get-or-create per log dir: if a writer already exists for this dir (e.g. a
    // second start for the same node on a different port), reuse it so both sets
    // of drains write through ONE writer rather than two racing on the same files.
    let log_key = log_dir.to_string_lossy().to_string();
    let log_writer = {
        let mut map = log_writers
            .lock()
            .map_err(|_| TauriError::new(TauriErrorCode::InternalError, "log writers lock poisoned"))?;
        match map.get_mut(&log_key) {
            Some(entry) => {
                entry.refs += 1;
                entry.writer.clone()
            }
            None => {
                let w = std::sync::Arc::new(std::sync::Mutex::new(
                    log_rotation::RollingLogWriter::open(&log_dir)
                        .map_err(|e| TauriError::with_details(TauriErrorCode::FileWriteError, "Failed to open log writer", e.to_string()))?,
                ));
                map.insert(log_key.clone(), LogWriterEntry { writer: w.clone(), refs: 1 });
                w
            }
        }
    };

    // Drop the ref we just took, for the early-return paths before the exit
    // monitor (which is what normally decrements) is spawned — otherwise a failed
    // spawn / immediate exit would leak the registration (and its file handle).
    let unregister_writer = || {
        if let Ok(mut map) = log_writers.lock() {
            if let Some(entry) = map.get_mut(&log_key) {
                entry.refs = entry.refs.saturating_sub(1);
                if entry.refs == 0 {
                    map.remove(&log_key);
                }
            }
        }
    };

    // Build command - global options come BEFORE subcommand
    // Merod expects: merod --home ~/.calimero --node node1 run
    let mut cmd = Command::new(&merod_binary);
    // Force ANSI colors in output so the log viewer can display them
    cmd.env("CLICOLOR_FORCE", "1");
    cmd.env("FORCE_COLOR", "1");
    // Set log level based on debug_logs setting
    if debug_logs.unwrap_or(false) {
        cmd.env("RUST_LOG", "debug");
        info!("[Merod] Debug logging enabled");
    } else {
        cmd.env("RUST_LOG", "info");
    }

    // Set home directory (global option, before subcommand)
    cmd.arg("--home").arg(&home_dir_path);

    // Set node name (global option, before subcommand)
    cmd.arg("--node").arg(&node_name_str);

    // Add 'run' subcommand last
    cmd.arg("run");

    // Pipe stdout/stderr so the app can drain them into the rotating writer.
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    // Log the command being run
    let cmd_str = format!("{:?}", cmd);
    info!(
        "[Merod] Running command: {}, logs at {:?}",
        cmd_str, log_path
    );

    // Start the process
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            unregister_writer();
            return Err(TauriError::with_details(TauriErrorCode::MerodStartFailed, "Failed to start merod", e.to_string()));
        }
    };

    let pid = child.id().unwrap();
    info!("[Merod] Started with PID: {}", pid);

    // Drain stdout+stderr into the rotating writer. Taken before the child is moved
    // into the monitor task below.
    if let Some(out) = child.stdout.take() {
        spawn_log_drain(out, log_writer.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_log_drain(err, log_writer.clone());
    }

    // Wait a brief moment to check if process is still alive
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Check if process already exited
    if let Ok(Some(status)) = child.try_wait() {
        if let Some(code) = status.code() {
            let error_msg = format!(
                "Merod process exited immediately with code: {}. Check merod logs for details.",
                code
            );
            warn!("[Merod] {}", error_msg);
            unregister_writer();
            return Err(TauriError::new(TauriErrorCode::MerodProcessExited, error_msg));
        }
    }

    // Store process state
    {
        let mut state = merod_state.lock_unpoisoned();
        state.push(MerodProcess {
            pid,
            port: server_port,
        });
    }
    emit_merod_status_changed(&app_handle);

    // Spawn a task to monitor the process
    let merod_state_clone = merod_state.inner().clone();
    let log_writers_clone = log_writers.inner().clone();
    let exit_log_key = log_key.clone();
    let monitored_pid = pid; // Capture PID for verification
    let exit_app_handle = app_handle.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        {
            let mut state = merod_state_clone.lock_unpoisoned();
            if let Ok(exit_status) = status {
                if let Some(code) = exit_status.code() {
                    warn!("[Merod] Process {} exited with code: {}", monitored_pid, code);
                }
            }
            state.retain(|p| p.pid != monitored_pid);
        }
        emit_merod_status_changed(&exit_app_handle);
        // Drop one reference to this node's writer; remove the registration only
        // when the last user exits. Ref-counting means a restart or a concurrent
        // second start (which reuse the same writer) don't unregister it out from
        // under a still-running drain — which would send clear() down the
        // unsynchronized on-disk path while writes are live.
        if let Ok(mut map) = log_writers_clone.lock() {
            if let Some(entry) = map.get_mut(&exit_log_key) {
                entry.refs = entry.refs.saturating_sub(1);
                if entry.refs == 0 {
                    map.remove(&exit_log_key);
                }
            }
        }
    });

    Ok(format!("Merod started successfully with PID: {}", pid))
}

#[tauri::command]
async fn stop_merod(
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
) -> Result<String, TauriError> {
    let pids: Vec<u32> = {
        let state = merod_state.lock_unpoisoned();
        state.iter().map(|p| p.pid).collect()
    };

    if pids.is_empty() {
        return Err(TauriError::new(
            TauriErrorCode::MerodNotRunning,
            "Merod is not running",
        ));
    }

    for pid in &pids {
        #[cfg(unix)]
        {
            use std::process::Command;

            let check_output = Command::new("ps").arg("-p").arg(pid.to_string()).output();

            let process_exists = if let Ok(output) = &check_output {
                output.status.success()
            } else {
                false
            };

            if !process_exists {
                info!("[Merod] Process with PID {} already stopped", pid);
            } else {
                let _ = Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .output();

                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                let check_output = Command::new("ps").arg("-p").arg(pid.to_string()).output();

                let still_running = if let Ok(output) = &check_output {
                    output.status.success()
                } else {
                    false
                };

                if still_running {
                    let output = Command::new("kill").arg("-9").arg(pid.to_string()).output();

                    if let Ok(output) = output {
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if !stderr.contains("No such process") {
                                return Err(TauriError::new(
                                    TauriErrorCode::MerodStopFailed,
                                    format!("Failed to stop merod process: {}", stderr),
                                ));
                            }
                        }
                    }
                }
            }
        }

        #[cfg(windows)]
        {
            use std::process::Command;
            let output = Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/F")
                .output();

            if let Ok(output) = output {
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if !stderr.contains("not found") && !stderr.contains("does not exist") {
                        return Err(TauriError::new(
                            TauriErrorCode::MerodStopFailed,
                            format!("Failed to stop merod process: {}", stderr),
                        ));
                    }
                }
            }
        }

        info!("[Merod] Stopped process with PID: {}", pid);
    }

    merod_state
        .lock_unpoisoned()
        .clear();
    emit_merod_status_changed(&app_handle);

    Ok("Merod stopped successfully".to_string())
}

#[tauri::command]
async fn stop_merod_by_pid_command(
    pid: u32,
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
) -> Result<String, TauriError> {
    #[cfg(unix)]
    {
        use std::process::Command;

        // Check if process exists first
        let check_output = Command::new("ps").arg("-p").arg(pid.to_string()).output();

        let process_exists = if let Ok(output) = &check_output {
            output.status.success()
        } else {
            false
        };

        if !process_exists {
            // Process doesn't exist, already stopped
            info!("[Merod] Process with PID {} already stopped", pid);
        } else {
            // Try graceful shutdown first (SIGTERM)
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .output();

            // Wait a bit
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            // Check if still running before force kill
            let check_output = Command::new("ps").arg("-p").arg(pid.to_string()).output();

            let still_running = if let Ok(output) = &check_output {
                output.status.success()
            } else {
                false
            };

            if still_running {
                // Force kill if still running (SIGKILL)
                let output = Command::new("kill").arg("-9").arg(pid.to_string()).output();

                if let Ok(output) = output {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // If process doesn't exist, that's fine - it's already stopped
                        if !stderr.contains("No such process") {
                            return Err(TauriError::new(
                                TauriErrorCode::MerodStopFailed,
                                format!("Failed to stop merod process: {}", stderr),
                            ));
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::process::Command;
        let output = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/F")
            .output();

        if let Ok(output) = output {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                // If process doesn't exist, that's fine - it's already stopped
                if !stderr.contains("not found") && !stderr.contains("does not exist") {
                    return Err(TauriError::new(
                        TauriErrorCode::MerodStopFailed,
                        format!("Failed to stop merod process: {}", stderr),
                    ));
                }
            }
        }
    }

    // Remove this process from state
    merod_state
        .lock_unpoisoned()
        .retain(|p| p.pid != pid);
    emit_merod_status_changed(&app_handle);

    info!("[Merod] Stopped process with PID: {}", pid);
    Ok(format!("Merod stopped successfully (PID: {})", pid))
}

fn is_process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // kill(2) reads pid <= 0 as a process-group target, so anything that is
        // not a positive pid_t must never reach it.
        let pid = match libc::pid_t::try_from(pid) {
            Ok(pid) if pid > 0 => pid,
            _ => return false,
        };
        // SAFETY: plain FFI call, no pointers; the guard above keeps pid a single
        // positive process and signal 0 delivers nothing.
        unsafe { libc::kill(pid, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use std::process::Command;
        let output = Command::new("tasklist")
            .arg("/FI")
            .arg(format!("PID eq {}", pid))
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            !stdout.contains("No tasks are running") && stdout.contains(&pid.to_string())
        } else {
            false
        }
    }
}

/// The reap probes every tracked node for liveness while holding the state lock,
/// and this command is polled - too much to leave on a runtime worker.
#[tauri::command]
async fn get_merod_status(
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
) -> Result<serde_json::Value, TauriError> {
    let merod_state = merod_state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut state = merod_state.lock_unpoisoned();
        if state.is_empty() {
            return serde_json::json!({ "running": false, "nodes": [] });
        }
        // Filter out dead processes. Only announce when this reap actually dropped
        // one, or a polling caller would emit on every tick.
        let before = state.len();
        state.retain(|p| is_process_running(p.pid));
        if state.len() != before {
            emit_merod_status_changed(&app_handle);
        }
        if state.is_empty() {
            return serde_json::json!({ "running": false, "nodes": [] });
        }
        let nodes: Vec<_> = state
            .iter()
            .map(|p| serde_json::json!({ "pid": p.pid, "port": p.port }))
            .collect();
        let first = &state[0];
        serde_json::json!({
            "running": true,
            "nodes": nodes,
            "pid": first.pid,
            "port": first.port
        })
    })
    .await
    .map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::InternalError,
            "Status task failed",
            e.to_string(),
        )
    })
}

#[tauri::command]
async fn list_merod_nodes(home_dir: Option<String>) -> Result<Vec<String>, TauriError> {
    // Merod stores nodes in ~/.calimero/ as directories (node1, node2, etc.)
    let calimero_home = if let Some(dir) = home_dir {
        // Expand ~ if present
        let expanded = if dir.starts_with("~") {
            if let Some(home) = dirs::home_dir() {
                dir.replacen("~", &home.to_string_lossy(), 1)
            } else {
                dir
            }
        } else {
            dir
        };
        std::path::PathBuf::from(expanded)
    } else {
        dirs::home_dir()
            .ok_or_else(|| {
                TauriError::new(
                    TauriErrorCode::HomeDirNotFound,
                    "Failed to get home directory",
                )
            })?
            .join(".calimero")
    };

    if !calimero_home.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&calimero_home).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to read calimero directory",
            e.to_string(),
        )
    })?;

    let mut nodes = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::DirectoryError,
                "Failed to read directory entry",
                e.to_string(),
            )
        })?;
        let file_type = entry.file_type().map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::DirectoryError,
                "Failed to get file type",
                e.to_string(),
            )
        })?;
        if file_type.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                // Skip hidden directories
                if !name.starts_with('.') {
                    let node_path = entry.path();
                    let config_path = node_path.join("config.toml");

                    // Check if config.toml exists and is valid TOML
                    // Include nodes with valid config.toml even if they don't have bootstrap nodes yet
                    // Bootstrap nodes are only required when starting the node, not for listing
                    if config_path.exists() {
                        if let Ok(config_content) = std::fs::read_to_string(&config_path) {
                            if config_content.parse::<toml::Value>().is_ok() {
                                // Valid config.toml found, include the node
                                nodes.push(name.to_string());
                            } else {
                                debug!(
                                    "[Merod] Skipping node '{}': invalid TOML in config.toml",
                                    name
                                );
                            }
                        } else {
                            debug!(
                                "[Merod] Skipping node '{}': failed to read config.toml",
                                name
                            );
                        }
                    } else {
                        debug!("[Merod] Skipping node '{}': config.toml not found", name);
                    }
                }
            }
        }
    }

    // Sort nodes alphabetically
    nodes.sort();

    Ok(nodes)
}

#[tauri::command]
async fn check_merod_health(node_url: String) -> Result<serde_json::Value, TauriError> {
    let health_url = format!("{}/health", node_url.trim_end_matches('/'));

    info!("[Merod] Checking health at: {}", health_url);

    // Onboarding polls this twice a second, so it shares the pooled client rather
    // than building one (and reloading the trust store) per call.
    let response = http_client()
        .get(&health_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;

    match response {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            let healthy = status >= 200 && status < 300;

            Ok(serde_json::json!({
                "status": status,
                "healthy": healthy,
                "body": body
            }))
        }
        Err(e) => Ok(serde_json::json!({
            "status": 0,
            "healthy": false,
            "body": format!("Request failed: {}", e)
        })),
    }
}

#[tauri::command]
async fn init_merod_node(
    node_name: String,
    home_dir: Option<String>,
    admin_user: Option<String>,
    admin_password: Option<String>,
    merod_version_id: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, TauriError> {
    validate_node_name(&node_name).map_err(|e| TauriError::new(TauriErrorCode::InvalidInput, e))?;

    // Prepare home directory (where .calimero folder will be)
    let home_dir_path = if let Some(dir) = home_dir {
        // Expand ~ if present
        let expanded = if dir.starts_with("~") {
            if let Some(home) = dirs::home_dir() {
                dir.replacen("~", &home.to_string_lossy(), 1)
            } else {
                dir
            }
        } else {
            dir
        };
        std::path::PathBuf::from(expanded)
    } else {
        dirs::home_dir()
            .ok_or_else(|| {
                TauriError::new(
                    TauriErrorCode::HomeDirNotFound,
                    "Failed to get home directory",
                )
            })?
            .join(".calimero")
    };

    std::fs::create_dir_all(&home_dir_path).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to create home directory",
            e.to_string(),
        )
    })?;

    // Reserve the name, then release the lock: holding it across resolve_binary
    // would block every other creation for the length of a release download.
    // The guard clears the reservation on every exit, including the early ones.
    let reservation = NodeInitReservation::claim(&home_dir_path, &node_name)?;

    let version_id = match &merod_version_id {
        Some(raw) => merod_versions::parse_version_id(raw)?,
        None => merod_versions::VersionId::Bundled,
    };
    let merod_binary = merod_versions::resolve_binary(&app_handle, &version_id).await?;

    // Run merod init command - global options come BEFORE subcommand
    // Use --auth-mode embedded so merod creates the full embedded_auth config
    let mut cmd = Command::new(&merod_binary);
    cmd.arg("--home").arg(&home_dir_path);
    cmd.arg("--node").arg(&node_name);
    cmd.arg("init").arg("--auth-mode").arg("embedded");

    // Since core rc.17 the login path never mints accounts: merod mints the
    // admin root key AT INIT from these credentials (passed via env, never
    // argv — argv is visible in process listings). The password is consumed
    // by merod to derive the key; nothing secret lands in config.toml.
    // Without credentials, --no-admin defers provisioning explicitly and the
    // node stays login-disabled until an account is created out of band.
    match (admin_user, admin_password) {
        (Some(user), Some(password)) if !user.is_empty() && !password.is_empty() => {
            let _ = cmd.env("MERO_AUTH_ADMIN_USER", user);
            let _ = cmd.env("MERO_AUTH_ADMIN_PASSWORD", password);
        }
        (None, None) => {
            let _ = cmd.arg("--no-admin");
        }
        _ => {
            return Err(TauriError::new(
                TauriErrorCode::InvalidInput,
                "Both an admin username and password are required to create the node's account",
            ));
        }
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    // The guard above proved this directory did not exist, so anything merod
    // leaves behind on a failed init is ours to remove - otherwise the guard
    // would reject every retry of the same name.
    let node_dir = home_dir_path.join(&node_name);
    let discard_partial_node = || {
        if node_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&node_dir) {
                warn!("[Merod] could not clean up after a failed init: {}", e);
            }
        }
    };

    // Add timeout to prevent hanging (30 seconds should be enough for init)
    let output = match tokio::time::timeout(tokio::time::Duration::from_secs(30), cmd.output()).await
    {
        Err(_) => {
            discard_partial_node();
            return Err(TauriError::new(
                TauriErrorCode::Timeout,
                "Merod init command timed out after 30 seconds",
            ));
        }
        Ok(Err(e)) => {
            discard_partial_node();
            return Err(TauriError::with_details(
                TauriErrorCode::MerodInitFailed,
                "Failed to execute merod init",
                e.to_string(),
            ));
        }
        Ok(Ok(output)) => output,
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_partial_node();
        return Err(TauriError::new(
            TauriErrorCode::MerodInitFailed,
            format!("Merod init failed: {}", stderr),
        ));
    }

    // Only after a successful init: a node that failed to initialise must not be
    // left pinned to a version.
    // A node without its pin would silently start on a different binary, so treat
    // a failed write as a failed creation rather than leaving that behind.
    if let Err(e) = merod_versions::write_pin(
        &home_dir_path,
        &node_name,
        &merod_versions::NodePin {
            id: merod_versions::version_id_to_string(&version_id),
            version_at_init: get_merod_version_at(&merod_binary).await,
        },
    ) {
        discard_partial_node();
        return Err(e);
    }

    drop(reservation);
    info!(
        "[Merod] Initialized node '{}' in {:?}",
        node_name, home_dir_path
    );
    Ok(format!("Node '{}' initialized successfully", node_name))
}

/// `(server, swarm)` ports a node uses when its config says nothing usable.
const DEFAULT_NODE_PORTS: (u16, u16) = (2528, 2428);

/// The port out of a multiaddr like `/ip4/127.0.0.1/tcp/2528` or
/// `/ip4/0.0.0.0/udp/2428/quic-v1`.
fn multiaddr_port(addr: &str, proto: &str) -> Option<u16> {
    addr[addr.find(proto)? + proto.len()..]
        .split('/')
        .next()?
        .parse()
        .ok()
}

/// `(server, swarm)` ports declared by a node's `config.toml` body.
fn parse_node_ports(body: &str) -> (u16, u16) {
    let Ok(config) = body.parse::<toml::Value>() else {
        return DEFAULT_NODE_PORTS;
    };
    let port_of = |section: &str, protos: &[&str]| -> Option<u16> {
        config
            .get(section)?
            .get("listen")?
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str())
            .find_map(|addr| protos.iter().find_map(|p| multiaddr_port(addr, p)))
    };
    (
        port_of("server", &["/tcp/"]).unwrap_or(DEFAULT_NODE_PORTS.0),
        port_of("swarm", &["/tcp/", "/udp/"]).unwrap_or(DEFAULT_NODE_PORTS.1),
    )
}

fn node_ports(config_path: &std::path::Path) -> (u16, u16) {
    std::fs::read_to_string(config_path)
        .map(|body| parse_node_ports(&body))
        .unwrap_or(DEFAULT_NODE_PORTS)
}

#[tauri::command]
async fn detect_running_merod_nodes() -> Result<Vec<serde_json::Value>, TauriError> {
    #[cfg(unix)]
    {
        // Use ps to find merod processes
        let output = tokio::process::Command::new("ps")
            .arg("ax")
            .arg("-o")
            .arg("pid,command")
            .output()
            .await
            .map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::InternalError,
                    "Failed to run ps",
                    e.to_string(),
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut running_nodes = Vec::new();

        for line in stdout.lines() {
            if line.contains("merod") && line.contains("run") {
                // Parse PID and extract node name and home directory from command
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(pid_str) = parts.first() {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        // Try to extract node name and home directory from arguments
                        let mut node_name = None;
                        let mut home_dir = None;

                        for (i, part) in parts.iter().enumerate() {
                            if (part == &"--node" || part == &"-n") && i + 1 < parts.len() {
                                node_name = Some(parts[i + 1].to_string());
                            }
                            if part == &"--home" && i + 1 < parts.len() {
                                home_dir = Some(parts[i + 1].to_string());
                            }
                        }

                        let (server_port, swarm_port) = match (&node_name, &home_dir) {
                            (Some(name), Some(home)) => node_ports(
                                &std::path::PathBuf::from(home)
                                    .join(name)
                                    .join("config.toml"),
                            ),
                            _ => DEFAULT_NODE_PORTS,
                        };

                        running_nodes.push(serde_json::json!({
                            "pid": pid,
                            "node_name": node_name.unwrap_or_else(|| format!("node_{}", pid)),
                            "port": server_port,
                            "swarm_port": swarm_port,
                            "home_dir": home_dir.unwrap_or_else(|| "unknown".to_string())
                        }));
                    }
                }
            }
        }

        Ok(running_nodes)
    }

    #[cfg(windows)]
    {
        use tokio::process::Command;

        // Use tasklist and wmic on Windows
        let output = Command::new("tasklist")
            .arg("/FO")
            .arg("CSV")
            .output()
            .await
            .map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::InternalError,
                    "Failed to run tasklist",
                    e.to_string(),
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut running_nodes = Vec::new();

        // Parse CSV output and find merod processes
        for line in stdout.lines().skip(1) {
            if line.contains("merod") {
                // Extract PID and command line
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    if let Ok(pid) = parts[1].trim_matches('"').parse::<u32>() {
                        // Try to get command line using wmic
                        let cmd_output = Command::new("wmic")
                            .arg("process")
                            .arg("where")
                            .arg(format!("ProcessId={}", pid))
                            .arg("get")
                            .arg("CommandLine")
                            .output()
                            .await;

                        if let Ok(cmd_out) = cmd_output {
                            let cmd_line = String::from_utf8_lossy(&cmd_out.stdout);
                            // Parse node name and port from command line
                            let mut node_name = None;
                            let mut port = None;

                            let cmd_parts: Vec<&str> = cmd_line.split_whitespace().collect();
                            for (i, part) in cmd_parts.iter().enumerate() {
                                if (part == &"--node" || part == &"-n") && i + 1 < cmd_parts.len() {
                                    node_name = Some(cmd_parts[i + 1].to_string());
                                }
                                if part == &"--port" && i + 1 < cmd_parts.len() {
                                    if let Ok(p) = cmd_parts[i + 1].parse::<u16>() {
                                        port = Some(p);
                                    }
                                }
                            }

                            let port = port.unwrap_or(2528);

                            running_nodes.push(serde_json::json!({
                                "pid": pid,
                                "node_name": node_name.unwrap_or_else(|| format!("node_{}", pid)),
                                "port": port
                            }));
                        }
                    }
                }
            }
        }

        Ok(running_nodes)
    }
}

// ── Merod binary self-update helpers ─────────────────────────────────────────

/// Downloads the merod binary matching `MEROD_CONFIG_VERSION` from GitHub,
/// replaces the bundled binary, and verifies the version.
///
/// Returns `{ replaced, expected_version, current_version, message }`.
/// If the binary is already at the correct version, `replaced` is `false`.
#[tauri::command]
async fn download_and_replace_merod(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, TauriError> {
    let expected = MEROD_CONFIG_VERSION;
    if expected == "unknown" {
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            "MEROD_CONFIG_VERSION was not embedded at build time — cannot determine target version",
        ));
    }

    // Validate version string only contains semver-safe chars before using in URL
    if !expected
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!(
                "MEROD_CONFIG_VERSION '{}' contains unexpected characters",
                expected
            ),
        ));
    }

    let binary_path = get_bundled_merod_path(&app_handle)
        .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e))?;

    let expected_version_output = format!("merod {}", expected);

    // Fast path: already correct
    if let Some(current) = get_merod_version_at(&binary_path).await {
        if merod_versions::version_matches_tag(&current, expected) {
            return Ok(serde_json::json!({
                "replaced": false,
                "expected_version": expected,
                "current_version": current,
                "message": "Binary is already at the expected version"
            }));
        }
    }

    // Fetch GitHub release metadata
    let target = merod_target_triple();
    let release_url = format!(
        "https://api.github.com/repos/calimero-network/core/releases/tags/{}",
        expected
    );
    // HTTPS to api.github.com ensures transport security; no auth token needed
    // for public releases (60 req/hr unauthenticated is ample for a rare update path).
    let client = http_client();
    let api_resp = client
        .get(&release_url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "calimero-desktop")
        .send()
        .await
        .map_err(|e| {
            TauriError::new(TauriErrorCode::InternalError, format!("GitHub API: {}", e))
        })?;
    let api_status = api_resp.status();
    let release: serde_json::Value = api_resp.json().await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::InternalError,
            format!("Parse release JSON: {}", e),
        )
    })?;
    if !api_status.is_success() {
        let msg = release["message"].as_str().unwrap_or("unknown error");
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!("GitHub API returned {}: {}", api_status, msg),
        ));
    }

    let assets = release["assets"].as_array().ok_or_else(|| {
        TauriError::new(TauriErrorCode::InternalError, "No assets in GitHub release")
    })?;

    let (asset_name, asset_url) = assets
        .iter()
        .filter_map(|a| {
            let name = a["name"].as_str()?;
            let url = a["browser_download_url"].as_str()?;
            let score = score_merod_asset(name, target)?;
            Some((score, name.to_string(), url.to_string()))
        })
        .min_by_key(|(s, _, _)| *s)
        .map(|(_, n, u)| (n, u))
        .ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::InternalError,
                format!(
                    "No merod asset for target '{}' in release '{}'",
                    target, expected
                ),
            )
        })?;

    // Validate the asset URL is an HTTPS GitHub URL before downloading
    {
        let parsed = url::Url::parse(&asset_url).map_err(|e| {
            TauriError::new(
                TauriErrorCode::InternalError,
                format!("parse asset URL: {}", e),
            )
        })?;
        if parsed.scheme() != "https" {
            return Err(TauriError::new(
                TauriErrorCode::InternalError,
                format!("Asset URL must use https, got: {}", asset_url),
            ));
        }
        let host = parsed.host_str().unwrap_or("");
        if host != "github.com"
            && !host.ends_with(".github.com")
            && !host.ends_with(".githubusercontent.com")
        {
            return Err(TauriError::new(
                TauriErrorCode::InternalError,
                format!(
                    "Asset URL hostname '{}' is not from github.com or githubusercontent.com",
                    host
                ),
            ));
        }
    }

    info!("[Updater] Downloading {} for {}", asset_name, target);

    // Sanitize asset name: strip any path components to prevent path traversal
    let safe_asset_name: String = std::path::Path::new(&asset_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("merod-asset")
        .to_string();

    // Use nanoseconds for uniqueness in case two updates run back-to-back
    let temp_dir = std::env::temp_dir().join(format!(
        "merod-update-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::DirectoryError,
            format!("create temp dir: {}", e),
        )
    })?;
    // Restrict temp dir to owner only so other processes can't tamper with the download
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_dir, std::fs::Permissions::from_mode(0o700)).map_err(
            |e| {
                TauriError::new(
                    TauriErrorCode::DirectoryError,
                    format!("set temp dir permissions: {}", e),
                )
            },
        )?;
    }

    let archive_path = temp_dir.join(&safe_asset_name);
    // Binary downloads can be tens of MB; use a longer timeout than the shared 30s client.
    // merod binaries are a few MB; loading into memory before writing is acceptable for a desktop app.
    let download_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| {
            TauriError::new(
                TauriErrorCode::InternalError,
                format!("build download client: {}", e),
            )
        })?;
    let dl_resp = download_client
        .get(&asset_url)
        .header("User-Agent", "calimero-desktop")
        .send()
        .await
        .map_err(|e| TauriError::new(TauriErrorCode::InternalError, format!("download: {}", e)))?;
    if !dl_resp.status().is_success() {
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!("Asset download returned HTTP {}", dl_resp.status()),
        ));
    }
    let bytes = dl_resp.bytes().await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::InternalError,
            format!("read download: {}", e),
        )
    })?;
    tokio::fs::write(&archive_path, &bytes).await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::FileReadError,
            format!("write archive: {}", e),
        )
    })?;

    // Extract
    let extracted = extract_merod_binary(&archive_path, &safe_asset_name, &temp_dir).await?;

    // Atomic replace: copy to .tmp, set +x, rename over the old binary
    let tmp_path = binary_path.with_extension("tmp");
    tokio::fs::copy(&extracted, &tmp_path).await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::InternalError,
            format!("copy new binary: {}", e),
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755)).map_err(
            |e| TauriError::new(TauriErrorCode::InternalError, format!("set +x: {}", e)),
        )?;
    }

    // Rename old binary to .bak first; restore it on rename failure OR version mismatch.
    // On Windows rename-over-existing is not allowed, so we must .bak first regardless.
    // On Unix rename is atomic over the destination, but we still keep a .bak until
    // version verification succeeds so we can roll back if the new binary is wrong.
    let bak_path = binary_path.with_extension("bak");
    {
        let _ = tokio::fs::remove_file(&bak_path).await; // remove stale .bak if present
        if binary_path.exists() {
            tokio::fs::rename(&binary_path, &bak_path)
                .await
                .map_err(|e| {
                    TauriError::new(
                        TauriErrorCode::InternalError,
                        format!("backup old binary: {}", e),
                    )
                })?;
        }
        if let Err(e) = tokio::fs::rename(&tmp_path, &binary_path).await {
            let _ = tokio::fs::rename(&bak_path, &binary_path).await;
            return Err(TauriError::new(
                TauriErrorCode::InternalError,
                format!("replace binary: {}", e),
            ));
        }
        // .bak intentionally kept until version verification succeeds below
    }

    // Cleanup temp dir (archive and extracted files no longer needed regardless of verification outcome)
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    // Verify — .bak still present so we can restore on mismatch
    let new_version = get_merod_version_at(&binary_path)
        .await
        .unwrap_or_else(|| "unknown".to_string());

    if !merod_versions::version_matches_tag(&new_version, expected) {
        // Restore backup so the app is not left with a wrong binary
        let _ = tokio::fs::rename(&bak_path, &binary_path).await;
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!(
                "Version mismatch after replace: expected '{}', binary reports '{}'",
                expected_version_output, new_version
            ),
        ));
    }

    // Verification passed — safe to discard backup
    let _ = tokio::fs::remove_file(&bak_path).await;

    *BUNDLED_MEROD_VERSION.lock_unpoisoned() = Some(new_version.clone());
    info!("[Updater] merod updated to {}", new_version);
    Ok(serde_json::json!({
        "replaced": true,
        "expected_version": expected,
        "current_version": new_version,
        "message": format!("merod updated to {}", new_version)
    }))
}

/// `merod --version` for the bundled binary. Cached: three UI surfaces re-invoke
/// this on mount, and only `download_and_replace_merod` can change the answer.
static BUNDLED_MEROD_VERSION: Mutex<Option<String>> = Mutex::new(None);


/// Return the version string reported by the bundled merod binary (`merod --version`).
#[tauri::command]
async fn get_merod_binary_version(app_handle: tauri::AppHandle) -> Result<String, TauriError> {
    if let Some(version) = BUNDLED_MEROD_VERSION.lock_unpoisoned().clone() {
        return Ok(version);
    }
    let merod_binary = get_bundled_merod_path(&app_handle)
        .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e))?;
    // A failed probe is not cached: the binary may simply be mid-replacement.
    let Some(version) = get_merod_version_at(&merod_binary).await else {
        return Ok("unknown".to_string());
    };
    *BUNDLED_MEROD_VERSION.lock_unpoisoned() = Some(version.clone());
    Ok(version)
}

/// Read merod logs for a node. Logs are only available for nodes started by the app.
#[tauri::command]
async fn get_merod_logs(
    node_name: String,
    home_dir: Option<String>,
    lines: Option<u32>,
) -> Result<String, TauriError> {
    validate_node_name(&node_name).map_err(|e| TauriError::new(TauriErrorCode::InvalidInput, e))?;
    let lines = lines.unwrap_or(500).min(10_000);

    let home_dir_path = resolve_home_dir(home_dir)?;
    let log_dir = home_dir_path.join(&node_name).join("logs");
    // Path safety is from validate_node_name; the data dir is user-configurable
    // (may be outside $HOME), so we don't constrain it here — this is a read-only
    // tail of `<data_dir>/<node>/logs` and can't traverse out.

    // Only hard-error when the node has no logs dir at all (never started by the
    // app). If the dir exists, read_tail returns whatever is present — including
    // rotated segments alone when the active merod.log has been cleared/rotated
    // away — or "" when empty.
    if !log_dir.exists() {
        return Err(TauriError::new(
            TauriErrorCode::FileNotFound,
            format!("No log file found for node '{}'. Logs are only available for nodes started by the app.", node_name),
        ));
    }

    // Bounded reverse tail across the active file + rotated segments — never loads
    // the whole (up to ~100 MB) history into memory just to return the last N lines.
    let max_lines = lines as usize;
    let result = tokio::task::spawn_blocking(move || log_rotation::read_tail(&log_dir, max_lines))
        .await
        .map_err(|e| TauriError::with_details(TauriErrorCode::InternalError, "Log read task failed", e.to_string()))?
        .map_err(|e| TauriError::with_details(TauriErrorCode::FileReadError, "Failed to read log file", e.to_string()))?;

    Ok(result)
}

/// Truncate the active log file and delete rotated segments for a node.
#[tauri::command]
async fn clear_merod_logs(
    node_name: String,
    home_dir: Option<String>,
    log_writers: tauri::State<'_, MerodLogWriters>,
) -> Result<String, TauriError> {
    validate_node_name(&node_name).map_err(|e| TauriError::new(TauriErrorCode::InvalidInput, e))?;

    let home_dir_path = resolve_home_dir(home_dir)?;
    let log_dir = home_dir_path.join(&node_name).join("logs");
    // Path safety comes from validate_node_name (no separators / `..`), so the
    // target is always `<data_dir>/<node>/logs` and can't traverse out. We do NOT
    // constrain to $HOME here: the data dir is user-configurable (pick_directory
    // can point at an external volume), and start_merod already writes logs there.
    // Only files literally named merod.log[.N] under a validated node's logs dir
    // are ever touched.

    // If a node is running, clear through its live writer (serialized with the
    // drain tasks by the inner Mutex) so we don't race a concurrent rotation or
    // leave the writer's cached length desynced. Otherwise clear on disk.
    let key = log_dir.to_string_lossy().to_string();
    let live = log_writers.lock().ok().and_then(|m| m.get(&key).map(|e| e.writer.clone()));

    let removed = tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
        if let Some(writer) = live {
            let mut w = writer
                .lock()
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "log writer lock poisoned"))?;
            w.clear()
        } else {
            log_rotation::clear_logs(&log_dir)
        }
    })
    .await
    .map_err(|e| TauriError::with_details(TauriErrorCode::InternalError, "Log clear task failed", e.to_string()))?
    .map_err(|e| TauriError::with_details(TauriErrorCode::FileWriteError, "Failed to clear log files", e.to_string()))?;

    Ok(format!("Cleared logs ({} rotated segment(s) removed)", removed))
}

#[tauri::command]
async fn set_tray_icon_connected(
    connected: bool,
    app_handle: tauri::AppHandle,
) -> Result<(), TauriError> {
    let icon_bytes: &[u8] = if connected {
        include_bytes!("../icons/tray-icon-connected.png")
    } else {
        include_bytes!("../icons/tray-icon.png")
    };
    let image = tauri::image::Image::from_bytes(icon_bytes)
        .map_err(|e| TauriError::new(TauriErrorCode::WindowOperationFailed, e.to_string()))?;
    let tray = app_handle
        .tray_by_id("main-tray")
        .ok_or_else(|| TauriError::new(TauriErrorCode::WindowOperationFailed, "tray not found"))?;
    tray.set_icon(Some(image))
        .map_err(|e| TauriError::new(TauriErrorCode::WindowOperationFailed, e.to_string()))
}

#[tauri::command]
async fn pick_directory(
    app_handle: tauri::AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, TauriError> {
    use tauri_plugin_dialog::DialogExt;

    let mut dialog = app_handle.dialog().file();

    // Set default directory if provided
    if let Some(path_str) = default_path {
        // Expand ~ to home directory
        let expanded_path = if path_str.starts_with("~") {
            if let Some(home) = dirs::home_dir() {
                path_str.replacen("~", &home.to_string_lossy(), 1)
            } else {
                path_str
            }
        } else {
            path_str
        };

        let path_buf = std::path::PathBuf::from(&expanded_path);
        if path_buf.exists() && path_buf.is_dir() {
            dialog = dialog.set_directory(path_buf);
        } else if let Some(parent) = path_buf.parent() {
            if parent.exists() && parent.is_dir() {
                dialog = dialog.set_directory(parent.to_path_buf());
            }
        }
    }

    let result = dialog.blocking_pick_folder();

    match result {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// Pick a locally compiled merod binary.
#[tauri::command]
async fn pick_merod_binary(app_handle: tauri::AppHandle) -> Result<Option<String>, TauriError> {
    use tauri_plugin_dialog::DialogExt;

    let result = app_handle.dialog().file().set_title("Select a merod binary").blocking_pick_file();

    match result {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

#[cfg(feature = "autostart")]
#[tauri::command]
async fn autostart_enable(app: tauri::AppHandle) -> Result<(), TauriError> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .enable()
        .map_err(|e| TauriError::new(TauriErrorCode::AutostartNotAvailable, e.to_string()))
}

#[cfg(feature = "autostart")]
#[tauri::command]
async fn autostart_disable(app: tauri::AppHandle) -> Result<(), TauriError> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .disable()
        .map_err(|e| TauriError::new(TauriErrorCode::AutostartNotAvailable, e.to_string()))
}

#[cfg(feature = "autostart")]
#[tauri::command]
async fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, TauriError> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| TauriError::new(TauriErrorCode::AutostartNotAvailable, e.to_string()))
}

#[cfg(not(feature = "autostart"))]
#[tauri::command]
async fn autostart_enable(_app: tauri::AppHandle) -> Result<(), TauriError> {
    Err(TauriError::new(
        TauriErrorCode::AutostartNotAvailable,
        "Autostart is not available",
    ))
}

#[cfg(not(feature = "autostart"))]
#[tauri::command]
async fn autostart_disable(_app: tauri::AppHandle) -> Result<(), TauriError> {
    Err(TauriError::new(
        TauriErrorCode::AutostartNotAvailable,
        "Autostart is not available",
    ))
}

#[cfg(not(feature = "autostart"))]
#[tauri::command]
async fn autostart_is_enabled(_app: tauri::AppHandle) -> Result<bool, TauriError> {
    Ok(false)
}

/// Kill all merod processes on the system. Used before total nuke to ensure no process
/// has the data directory open. Clears MerodState and waits for processes to fully exit.
#[tauri::command]
async fn kill_all_merod_processes(
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
) -> Result<String, TauriError> {
    let tracked: Vec<u32> = merod_state
        .lock()
        .map(|s| s.iter().map(|p| p.pid).collect())
        .unwrap_or_default();
    let pids = collect_merod_pids(&tracked);

    kill_pids(&pids).await;

    merod_state
        .lock_unpoisoned()
        .clear();
    emit_merod_status_changed(&app_handle);

    info!("[Calimero] Killed {} merod process(es)", pids.len());
    Ok(format!("Stopped {} merod process(es)", pids.len()))
}

/// Delete the Calimero data directory and all its contents. Used for "total nuke" reset.
/// Path must be under the user's home directory for safety.
/// Call kill_all_merod_processes first to ensure no process has the directory open.
#[tauri::command]
async fn close_current_window(window: tauri::Window) -> Result<(), TauriError> {
    window
        .close()
        .map_err(|e| TauriError::new(TauriErrorCode::WindowOperationFailed, e.to_string()))
}

#[tauri::command]
async fn open_url_in_browser(url: String, app_handle: tauri::AppHandle) -> Result<(), TauriError> {
    use tauri_plugin_shell::ShellExt;
    app_handle
        .shell()
        .open(url, None)
        .map_err(|e| TauriError::new(TauriErrorCode::InternalError, e.to_string()))
}

#[tauri::command]
async fn delete_calimero_data_dir(data_dir: String) -> Result<String, TauriError> {
    let expanded = if data_dir.starts_with("~") {
        if let Some(home) = dirs::home_dir() {
            data_dir.replacen("~", &home.to_string_lossy(), 1)
        } else {
            return Err(TauriError::new(
                TauriErrorCode::HomeDirNotFound,
                "Could not resolve home directory",
            ));
        }
    } else {
        data_dir
    };

    let path = std::path::PathBuf::from(&expanded);

    // If path doesn't exist, nothing to delete
    if !path.exists() {
        return Ok("Directory did not exist (nothing to delete)".to_string());
    }

    let path_canonical = path.canonicalize().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Invalid path",
            e.to_string(),
        )
    })?;

    // Safety: only allow deleting paths under the user's home directory
    if let Some(home) = dirs::home_dir() {
        if let Ok(home_canonical) = home.canonicalize() {
            if !path_canonical.starts_with(&home_canonical) {
                return Err(TauriError::new(
                    TauriErrorCode::PathNotAllowed,
                    "Path must be under your home directory",
                ));
            }
        }
    }

    if !path_canonical.is_dir() {
        return Err(TauriError::new(
            TauriErrorCode::InvalidInput,
            "Path is not a directory",
        ));
    }

    std::fs::remove_dir_all(&path_canonical).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to delete directory",
            e.to_string(),
        )
    })?;

    info!("[Calimero] Deleted data directory: {:?}", path_canonical);
    Ok(format!("Deleted {}", path_canonical.display()))
}

/// True if `bundle` is a launcher `.app` we generated and may remove: it must be
/// a `.app` directory under the user's home. `bundle_path` comes from our own
/// `caps.json`, but that file is plain JSON on disk — a corrupted or tampered
/// entry must not turn the nuke into an arbitrary recursive delete.
fn launcher_bundle_is_removable(bundle: &std::path::Path, home: &std::path::Path) -> bool {
    bundle.extension().and_then(|e| e.to_str()) == Some("app")
        && bundle.starts_with(home)
        && !bundle
            .components()
            .any(|c| c.as_os_str() == std::ffi::OsStr::new(".."))
}

/// Tear down every app session this desktop has handed out. Clearing the
/// desktop's own `localStorage` was never enough:
///
/// - Each app frontend is its own web origin, so the SSO'd access token its
///   MeroJs persists lands in the webview's shared website-data store
///   (`~/Library/WebKit/<bundle id>`), which no `localStorage.removeItem` from
///   the desktop's origin can reach. Reopening an app after a "reset" resumed
///   the old authenticated session.
/// - Open app windows and running launcher shells hold live sessions of their
///   own, and a live webview re-flushes its `localStorage` to disk on close —
///   so they must go first, or the wipe is undone behind us.
///
/// Every step is best-effort except the final website-data wipe, whose failure
/// is reported so the caller can tell the user their sessions may persist.
#[tauri::command]
async fn clear_app_sessions(app_handle: tauri::AppHandle) -> Result<String, TauriError> {
    let mut done: Vec<String> = Vec::new();

    // 1. Close the in-process app windows.
    let mut closed = 0;
    for (label, window) in app_handle.webview_windows() {
        if label.starts_with("app-") {
            let _ = window.close();
            closed += 1;
        }
    }
    if closed > 0 {
        done.push(format!("{closed} app window(s)"));
    }

    // 2. Kill the per-app launcher shells, for the same reason.
    #[cfg(target_os = "macos")]
    {
        let pids = collect_shell_pids();
        if !pids.is_empty() {
            kill_pids(&pids).await;
            done.push(format!("{} launcher process(es)", pids.len()));
        }
    }

    // 3. The shells are separate processes with their own website-data store,
    //    which step 4 cannot reach. They are dead by now, so delete it directly.
    //    Every name is ours: the shell's bundle identifier plus the loose binary
    //    names WebKit falls back to when the executable has no bundle.
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        for name in ["network.calimero.shell", "CalimeroShell", "calimero-shell"] {
            let _ = std::fs::remove_dir_all(home.join("Library/WebKit").join(name));
            let _ = std::fs::remove_dir_all(home.join("Library/HTTPStorages").join(name));
            let _ = std::fs::remove_file(
                home.join("Library/HTTPStorages")
                    .join(format!("{name}.binarycookies")),
            );
        }
        done.push("launcher website data".to_string());
    }

    // 4. Wipe this process's website data: localStorage, cookies, IndexedDB and
    //    caches for EVERY origin the host has loaded — which is where the app
    //    windows' access tokens live. All windows of the process share the one
    //    default data store, so clearing it through the main window is enough.
    let main = app_handle.get_webview_window("main").ok_or_else(|| {
        TauriError::new(
            TauriErrorCode::WindowOperationFailed,
            "Main window is gone; webview session data was not cleared",
        )
    })?;
    main.clear_all_browsing_data().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::InternalError,
            "Failed to clear webview session data — app sessions may persist",
            e.to_string(),
        )
    })?;
    done.push("webview session data".to_string());

    let summary = format!("Cleared app sessions: {}", done.join(", "));
    info!("[Reset] {summary}");
    Ok(summary)
}

/// Remove the per-app launchers: the generated `.app` bundles, the capability
/// store that keeps authorizing them (`caps.json` — a launcher built before a
/// total nuke would otherwise still get tokens brokered over the host socket),
/// and the extracted shell binary they exec. Total-nuke only: a launcher is a
/// dock icon the user placed, so the softer "reset settings" leaves them alone.
///
/// Best-effort per launcher; a bundle we can't remove is logged, not fatal.
/// Call `clear_app_sessions` first so no shell is still running out of a bundle.
#[tauri::command]
async fn remove_app_launchers(app_handle: tauri::AppHandle) -> Result<String, TauriError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        return Ok("No launchers on this platform".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let store = caps_store_path();
        let home = dirs::home_dir();
        let mut removed = 0;
        for app in app_registry::installed_apps(&store) {
            let bundle = std::path::PathBuf::from(&app.bundle_path);
            let removable = home
                .as_deref()
                .map_or(false, |h| launcher_bundle_is_removable(&bundle, h));
            if !removable {
                if !app.bundle_path.is_empty() {
                    warn!(
                        "[Reset] Skipping unexpected launcher path for {}: {}",
                        app.id, app.bundle_path
                    );
                }
                continue;
            }
            match std::fs::remove_dir_all(&bundle) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => warn!("[Reset] Failed to remove {}: {}", bundle.display(), e),
            }
        }

        let _ = std::fs::remove_file(&store);
        app_handle
            .state::<CapRegistry>()
            .lock_unpoisoned()
            .clear();
        if let Some(shell_dir) = launcher::shell_install_path().parent() {
            let _ = std::fs::remove_dir_all(shell_dir);
        }
        // Cached icons too, or a regenerated launcher keeps a stale icon forever.
        if let Some(parent) = app_icon_cache_path("x").parent() {
            let _ = std::fs::remove_dir_all(parent);
        }

        let summary = format!("Removed {removed} app launcher(s) and their capabilities");
        info!("[Reset] {summary}");
        Ok(summary)
    }
}

/// Performs graceful shutdown:
/// 1. Drain in-flight proxy requests up to REQUEST_DRAIN_TIMEOUT_SECS
/// 2. SIGTERM all managed (and detected) merod processes
/// 3. Wait up to PROCESS_TERM_WAIT_SECS, then SIGKILL survivors
fn graceful_shutdown(app_handle: &tauri::AppHandle, merod_state: &MerodState) {
    info!("[Shutdown] Starting graceful shutdown...");

    // Drain in-flight proxy requests before killing merod so they can complete
    let in_flight = IN_FLIGHT_REQUESTS.load(Ordering::SeqCst);
    if in_flight > 0 {
        info!(
            "[Shutdown] Waiting for {} in-flight proxy request(s) to drain (timeout: {}s)...",
            in_flight, REQUEST_DRAIN_TIMEOUT_SECS
        );
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(REQUEST_DRAIN_TIMEOUT_SECS);
        while IN_FLIGHT_REQUESTS.load(Ordering::SeqCst) > 0 {
            if start.elapsed() >= timeout {
                warn!(
                    "[Shutdown] Timeout — {} request(s) will be dropped",
                    IN_FLIGHT_REQUESTS.load(Ordering::SeqCst)
                );
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if IN_FLIGHT_REQUESTS.load(Ordering::SeqCst) == 0 {
            info!("[Shutdown] All in-flight requests drained");
        }
    } else {
        info!("[Shutdown] No in-flight proxy requests to drain");
    }

    let tracked: Vec<u32> = merod_state
        .lock()
        .map(|s| s.iter().map(|p| p.pid).collect())
        .unwrap_or_default();
    let pids = collect_merod_pids(&tracked);

    if !pids.is_empty() {
        info!(
            "[Shutdown] Terminating {} merod process(es): {:?}",
            pids.len(),
            pids
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(kill_pids(&pids));
        info!("[Shutdown] All merod processes terminated");
    } else {
        info!("[Shutdown] No merod processes to terminate");
    }

    if let Ok(mut state) = merod_state.lock() {
        state.clear();
    }
    emit_merod_status_changed(app_handle);
    info!("[Shutdown] Graceful shutdown complete");
}

/// Where the MCP subprocess looks for its credential. Must be a plain `~/.config`
/// path, not `dirs::config_dir()`: the MCP package resolves it via `os.homedir()`.
fn mcp_agent_file(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".config")
        .join("calimero")
        .join("mcp")
        .join("agent.json")
}

/// `.mode()` only takes effect when the file is newly created, so a leftover
/// temp file from a prior failed write needs the mode reapplied explicitly.
fn write_owner_only(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);

    let write = || -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&tmp, contents)?;
        }

        std::fs::rename(&tmp, path)
    };

    let result = write();
    if result.is_err() {
        // The temp file holds the whole access+refresh pair; a failed write must
        // not leave it sitting next to the target.
        std::fs::remove_file(&tmp).ok();
    }
    result
}

/// DirBuilder only sets the mode on directories it creates, so a leaf left
/// over at a looser mode from an older version needs it reapplied explicitly.
fn create_owner_only_dir(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    {
        // No ACL hardening: this inherits the profile directory's default
        // user-and-administrators ACLs, not world-readable but not explicitly restricted either.
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

/// Hand the MCP server its own node credential. Returns the path written so the
/// UI can name it; the token values never travel back out.
#[tauri::command]
fn write_mcp_agent_credentials(
    node_url: String,
    access_token: String,
    refresh_token: String,
) -> Result<String, TauriError> {
    let home = dirs::home_dir().ok_or_else(|| {
        TauriError::new(TauriErrorCode::HomeDirNotFound, "Could not find home folder")
    })?;
    let path = mcp_agent_file(&home);
    let dir = path.parent().expect("agent file always has a parent");

    create_owner_only_dir(dir).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Could not create the MCP credential folder",
            e.to_string(),
        )
    })?;

    let body = serde_json::json!({
        "nodeUrl": node_url,
        "accessToken": access_token,
        "refreshToken": refresh_token,
    })
    .to_string();

    write_owner_only(&path, &body).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::FileWriteError,
            "Could not write the MCP credential file",
            e.to_string(),
        )
    })?;

    info!("[MCP] Wrote agent credential to {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

// ─── Secure Token Storage ──────────────────────────────────────────────────────
// Stores JWT tokens in the OS keychain (Keychain on macOS, Credential Manager
// on Windows, libsecret on Linux) instead of plaintext localStorage.

const KEYRING_SERVICE: &str = "calimero-desktop";

#[tauri::command]
fn secure_store_token(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Failed to store token: {}", e))?;
    debug!("[SecureStorage] Stored token for key: {}", key);
    Ok(())
}

#[tauri::command]
fn secure_get_token(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    match entry.get_password() {
        Ok(password) => {
            debug!("[SecureStorage] Retrieved token for key: {}", key);
            Ok(Some(password))
        }
        Err(keyring::Error::NoEntry) => {
            debug!("[SecureStorage] No token found for key: {}", key);
            Ok(None)
        }
        Err(e) => Err(format!("Failed to retrieve token: {}", e)),
    }
}

#[tauri::command]
fn secure_delete_token(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    match entry.delete_password() {
        Ok(()) => {
            debug!("[SecureStorage] Deleted token for key: {}", key);
            Ok(())
        }
        Err(keyring::Error::NoEntry) => {
            // Token doesn't exist — deletion is idempotent
            debug!(
                "[SecureStorage] Token for key {} didn't exist, nothing to delete",
                key
            );
            Ok(())
        }
        Err(e) => Err(format!("Failed to delete token: {}", e)),
    }
}

fn main() {
    // Initialize logger - reads from RUST_LOG environment variable
    // Default: info level in release, debug level in debug builds
    env_logger::Builder::from_default_env()
        .filter_level({
            #[cfg(debug_assertions)]
            {
                log::LevelFilter::Debug
            }
            #[cfg(not(debug_assertions))]
            {
                log::LevelFilter::Info
            }
        })
        .init();

    tauri::Builder::default()
        // Single-instance must be registered first so a second launch is routed
        // to the running host (which focuses the dashboard) instead of spawning a
        // rival process that would fight over the merod node + broker socket.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    window.hide().unwrap();
                    api.prevent_close();
                }
                // When launched from shortcut, main window is shown first; hide it immediately so only app window is visible
                tauri::WindowEvent::Focused(focused) if *focused => {
                    if let Some(state) = window.app_handle().try_state::<PendingOpenApp>() {
                        if state.0.lock().map_or(false, |g| g.is_some()) {
                            let _ = window.hide();
                        }
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // Migrate per-app launchers made by an OLDER desktop version: re-extract
            // the shared shell (dequarantine + preserve signature) and rewrite each
            // launcher's trampoline to the current format. An old x86_64/Rosetta
            // trampoline SIGKILLs on Apple Silicon, and a desktop update alone does
            // NOT refresh a launcher until its app is re-opened - so do it here.
            // Off the main thread: setup() blocks the run loop that serves the
            // webview's assets, and this touches disk on every launch.
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let shell_dest = launcher::shell_install_path();
                    if let Some(src) = bundled_shell_path(&handle) {
                        let _ = launcher::extract_shell(&src, &shell_dest);
                        for a in app_registry::installed_apps(&caps_store_path()) {
                            let bundle = std::path::PathBuf::from(&a.bundle_path);
                            if bundle.exists() {
                                if let Err(e) = launcher::refresh_trampoline(&bundle, &shell_dest) {
                                    warn!(
                                        "[Launcher] refresh trampoline failed for {}: {}",
                                        a.id, e
                                    );
                                }
                            }
                        }
                    }
                });
            }

            // System tray with context menu
            let show_i = MenuItem::with_id(app, "show", "Show Calimero", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(merod_state) = app.try_state::<MerodState>() {
                            graceful_shutdown(app, &merod_state);
                        }
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // The per-app capability registry (cap -> app id) backing the socket
            // broker's peer check. Managed before `run_broker_service` reads it.
            #[cfg(target_os = "macos")]
            app.manage::<CapRegistry>(std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )));

            let pending = parse_open_app_args();
            app.manage(PendingOpenApp(std::sync::Mutex::new(pending.clone())));

            // Check CLI args for a deep-link URL (cold-launch case, e.g. macOS
            // routes the URL via argv when the app was not running). Route it:
            // an app deep-link (`<slug>/<action>`) goes to PendingAppDeepLink;
            // anything else (the OAuth `calimero://cloud-callback` callback)
            // stays on the existing PendingCloudAuth path.
            let (cloud_auth, app_deep_link) = match parse_deep_link_arg() {
                Some(raw) => match parse_app_deep_link(&raw) {
                    Some(dl) => (None, Some(dl)),
                    None => (Some(raw), None),
                },
                None => (None, None),
            };
            app.manage(PendingCloudAuth(std::sync::Mutex::new(cloud_auth)));
            app.manage(PendingAppDeepLink(std::sync::Mutex::new(app_deep_link)));

            // Hot-launch case: the app is already running when the browser
            // redirects to calimero://…. The plugin hooks NSAppleEventManager
            // (macOS) / the registered scheme handler (Windows/Linux) and
            // delivers the URL to the running process. We stash it in
            // PendingCloudAuth and emit an event so the frontend can react
            // without polling.
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Ensure the calimero:// scheme is registered at runtime on
                // Linux/Windows (needed for dev builds; the bundler handles it
                // for installed builds via the configured schemes).
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                {
                    let _ = app.deep_link().register("calimero");
                }

                let deep_link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let request = url.to_string();

                        // App deep-link (`<slug>/<action>?<params>`)? Emit the
                        // `app-deep-link` event for the frontend to resolve +
                        // open. `parse_app_deep_link` returns None for the OAuth
                        // callback, so that path falls through unchanged below.
                        if let Some(dl) = parse_app_deep_link(&request) {
                            if let Some(state) =
                                deep_link_handle.try_state::<PendingAppDeepLink>()
                            {
                                if let Ok(mut g) = state.0.lock() {
                                    *g = Some(dl.clone());
                                }
                            }
                            let _ = deep_link_handle.emit("app-deep-link", &dl);
                            if let Some(window) = deep_link_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            continue;
                        }

                        // OAuth callback path (calimero://cloud-callback…) —
                        // unchanged.
                        if let Some(state) = deep_link_handle.try_state::<PendingCloudAuth>() {
                            if let Ok(mut g) = state.0.lock() {
                                *g = Some(request.clone());
                            }
                        }
                        let _ = deep_link_handle.emit("cloud-auth-callback", &request);
                        if let Some(window) = deep_link_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }
            // Serve the Unix-socket token broker (per-app shells connect here to
            // broker their POST /auth/refresh) and restore capabilities issued to
            // launchers generated in previous sessions.
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(run_broker_service(handle));

                let caps = app.state::<CapRegistry>();
                let loaded = app_registry::caps_map(&caps_store_path());
                *caps.lock_unpoisoned() = loaded;
            }

            // When launched from a desktop shortcut, or auto-booted headless by a
            // per-app shell, hide the main window (tray-only host).
            if pending.is_some() || is_headless_host() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            #[cfg(feature = "autostart")]
            {
                let _ = app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ));
            }

            // Enable devtools for main window based on TAURI_OPEN_DEVTOOLS env var
            // IMPORTANT: Release builds NEVER enable devtools, even if env var is set
            // Debug builds also default to false - only open if explicitly requested
            let should_open_main_devtools = {
                #[cfg(not(debug_assertions))]
                {
                    // Release builds: NEVER enable devtools (security)
                    false
                }
                #[cfg(debug_assertions)]
                {
                    // Debug builds: Only open if explicitly requested via env var
                    if let Ok(env_value) = std::env::var("TAURI_OPEN_DEVTOOLS") {
                        env_value == "true" || env_value == "1"
                    } else {
                        // Default to false - don't open devtools automatically
                        false
                    }
                }
            };

            #[cfg(feature = "devtools")]
            if should_open_main_devtools {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .manage(MerodState::default())
        .manage(MerodLogWriters::default())
        .manage(SseCancelRegistry::new(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(TokenBrokerRegistry::new(std::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(IsolatedWindows::new(std::sync::Mutex::new(std::collections::HashSet::new())))
        .invoke_handler(tauri::generate_handler![
            get_pending_open_app,
            clear_pending_open_app,
            hide_main_window,
            focus_window,
            create_desktop_shortcut,
            open_app_launcher,
            create_app_window,
            webview_isolation_supported,
            open_devtools,
            proxy_http_request,
            proxy_sse_stream,
            cancel_sse_stream,
            broker_token_refresh,
            resolve_token_request,
            start_merod,
            stop_merod,
            stop_merod_by_pid_command,
            get_merod_status,
            list_merod_nodes,
            check_merod_health,
            pick_directory,
            pick_merod_binary,
            init_merod_node,
            detect_running_merod_nodes,
            get_merod_logs,
            clear_merod_logs,
            get_merod_binary_version,
            download_and_replace_merod,
            list_merod_releases,
            list_installed_merod_versions,
            remove_merod_version,
            repoint_local_build,
            set_tray_icon_connected,
            delete_calimero_data_dir,
            clear_app_sessions,
            remove_app_launchers,
            kill_all_merod_processes,
            autostart_enable,
            autostart_disable,
            autostart_is_enabled,
            close_current_window,
            open_url_in_browser,
            secure_store_token,
            secure_get_token,
            secure_delete_token,
            write_mcp_agent_credentials,
            get_pending_cloud_auth,
            clear_pending_cloud_auth,
            get_pending_app_deep_link,
            clear_pending_app_deep_link,
            get_current_app_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        is_textual_content_type, launcher_bundle_is_removable, merod_target_triple,
        parse_app_deep_link, parse_node_ports, replace_multiaddr_port, score_merod_asset,
        validate_allowed_url, DEFAULT_NODE_PORTS,
    };
    use base64::Engine as _;
    use std::path::Path;

    #[test]
    fn multiaddr_port_is_replaced_in_place() {
        assert_eq!(
            replace_multiaddr_port("/ip4/127.0.0.1/tcp/2528", "tcp", 3001),
            "/ip4/127.0.0.1/tcp/3001"
        );
        assert_eq!(
            replace_multiaddr_port("/ip6/::1/tcp/2528", "tcp", 3001),
            "/ip6/::1/tcp/3001"
        );
        // Trailing components survive.
        assert_eq!(
            replace_multiaddr_port("/ip4/0.0.0.0/udp/2428/quic-v1", "udp", 4001),
            "/ip4/0.0.0.0/udp/4001/quic-v1"
        );
        // No matching component, or no port digits: left untouched.
        assert_eq!(
            replace_multiaddr_port("/ip4/0.0.0.0/udp/2428", "tcp", 4001),
            "/ip4/0.0.0.0/udp/2428"
        );
        assert_eq!(
            replace_multiaddr_port("/ip4/0.0.0.0/tcp/", "tcp", 4001),
            "/ip4/0.0.0.0/tcp/"
        );
    }

    #[test]
    fn node_ports_are_read_from_listen_multiaddrs() {
        let config = r#"
[server]
listen = ["/ip4/127.0.0.1/tcp/3001"]
[swarm]
listen = ["/ip4/0.0.0.0/udp/4001/quic-v1", "/ip4/0.0.0.0/tcp/4002"]
"#;
        assert_eq!(parse_node_ports(config), (3001, 4001));

        // Anything unusable falls back rather than reporting a wrong port.
        assert_eq!(parse_node_ports("[server]\n"), DEFAULT_NODE_PORTS);
        assert_eq!(parse_node_ports("not toml ["), DEFAULT_NODE_PORTS);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decode_data_uri_png_accepts_and_rejects() {
        use base64::Engine;
        // Minimal valid PNG: 8-byte magic is all `decode_data_uri_png` checks.
        let png = b"\x89PNG\r\n\x1a\n\x00\x01\x02\x03";
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let uri = format!("data:image/png;base64,{b64}");
        assert_eq!(super::decode_data_uri_png(&uri).as_deref(), Some(&png[..]));

        // Not a data URI.
        assert!(super::decode_data_uri_png("https://example.com/icon.png").is_none());
        // Data URI but not base64-PNG magic (a JPEG payload).
        let jpeg_b64 = base64::engine::general_purpose::STANDARD.encode(b"\xff\xd8\xff\xe0junk");
        assert!(super::decode_data_uri_png(&format!("data:image/jpeg;base64,{jpeg_b64}")).is_none());
        // Garbage base64.
        assert!(super::decode_data_uri_png("data:image/png;base64,!!!!").is_none());
    }

    #[test]
    fn launcher_bundle_removal_is_confined_to_app_bundles_under_home() {
        let home = Path::new("/Users/x");
        assert!(launcher_bundle_is_removable(
            Path::new("/Users/x/Applications/MeroDrive.app"),
            home
        ));

        // Not a .app: a tampered caps.json must not delete a data directory.
        assert!(!launcher_bundle_is_removable(
            Path::new("/Users/x/Documents"),
            home
        ));
        // Outside home.
        assert!(!launcher_bundle_is_removable(
            Path::new("/Applications/Safari.app"),
            home
        ));
        // Traversal back out of home.
        assert!(!launcher_bundle_is_removable(
            Path::new("/Users/x/../../System/Library/CoreServices/Finder.app"),
            home
        ));
        // Empty / relative paths.
        assert!(!launcher_bundle_is_removable(Path::new(""), home));
        assert!(!launcher_bundle_is_removable(Path::new("MeroDrive.app"), home));
    }

    #[test]
    fn app_deep_link_custom_scheme() {
        let dl = parse_app_deep_link("calimero://mero-chat/join?invitation=TESTTOKEN")
            .expect("should parse app deep-link");
        assert_eq!(dl.slug, "mero-chat");
        assert_eq!(dl.action, "join");
        assert_eq!(dl.params, "invitation=TESTTOKEN");
    }

    #[test]
    fn app_deep_link_universal_link() {
        let dl = parse_app_deep_link(
            "https://links.calimero.network/mero-chat/join?invitation=TESTTOKEN",
        )
        .expect("should parse universal link");
        assert_eq!(dl.slug, "mero-chat");
        assert_eq!(dl.action, "join");
        assert_eq!(dl.params, "invitation=TESTTOKEN");
    }

    #[test]
    fn oauth_callback_is_not_an_app_deep_link() {
        // The OAuth callback MUST fall through to the cloud-auth path.
        assert!(parse_app_deep_link(
            "calimero://cloud-callback?state=ABC#id_token=eyJ"
        )
        .is_none());
    }

    #[test]
    fn app_deep_link_rejects_unrelated_urls() {
        // Missing action segment.
        assert!(parse_app_deep_link("calimero://mero-chat").is_none());
        // Wrong https host.
        assert!(parse_app_deep_link("https://example.com/mero-chat/join").is_none());
        // Non-deep-link scheme.
        assert!(parse_app_deep_link("http://localhost:2528/api").is_none());
    }

    #[test]
    fn test_allowed_localhost_urls() {
        // Valid localhost URLs (backwards compatibility - no configured URL)
        assert!(validate_allowed_url("http://localhost:2528/", None).is_ok());
        assert!(validate_allowed_url("http://localhost:2528/api/test", None).is_ok());
        assert!(validate_allowed_url("http://localhost:2528", None).is_ok());
        assert!(validate_allowed_url("http://127.0.0.1:2528/", None).is_ok());
        assert!(validate_allowed_url("http://127.0.0.1:2528/api/test", None).is_ok());
        assert!(validate_allowed_url("http://127.0.0.1:2528", None).is_ok());
    }

    #[test]
    fn test_reject_https_urls() {
        // HTTPS URLs should not be proxied (no mixed content issues)
        assert!(validate_allowed_url("https://apps.calimero.network/", None).is_err());
        assert!(validate_allowed_url("https://apps.calimero.network/api/test", None).is_err());
        assert!(validate_allowed_url("https://localhost:2528/", None).is_err());
    }

    #[test]
    fn test_configured_node_url() {
        // Test with configured node URL
        assert!(
            validate_allowed_url("http://localhost:8080/", Some("http://localhost:8080")).is_ok()
        );
        assert!(validate_allowed_url(
            "http://192.168.1.100:2528/",
            Some("http://192.168.1.100:2528")
        )
        .is_ok());
        assert!(validate_allowed_url(
            "http://node.example.com:2528/",
            Some("http://node.example.com:2528")
        )
        .is_ok());
        // Should still reject wrong URLs even with configured node URL
        assert!(
            validate_allowed_url("http://localhost:2528/", Some("http://localhost:8080")).is_err()
        );
    }

    #[test]
    fn test_allow_any_localhost_port() {
        // Any localhost port should be allowed (needed for multi-node setups)
        assert!(validate_allowed_url("http://localhost:80/", None).is_ok());
        assert!(validate_allowed_url("http://localhost:8080/", None).is_ok());
        assert!(validate_allowed_url("http://localhost:2529/", None).is_ok());
        assert!(validate_allowed_url("http://127.0.0.1:80/", None).is_ok());
        assert!(validate_allowed_url("http://127.0.0.1:8080/", None).is_ok());
        assert!(validate_allowed_url("http://127.0.0.1:2529/", None).is_ok());
    }

    #[test]
    fn test_reject_wrong_hostnames() {
        // Hostname spoofing attempts
        assert!(validate_allowed_url("http://localhost:2528.evil.com/", None).is_err());
        assert!(validate_allowed_url("http://127.0.0.1:2528.evil.com/", None).is_err());
        assert!(validate_allowed_url("http://evil.com:2528/", None).is_err());
        assert!(validate_allowed_url("http://localhost.evil.com:2528/", None).is_err());
    }

    #[test]
    fn test_reject_wrong_schemes() {
        // Wrong schemes
        assert!(validate_allowed_url("ftp://localhost:2528/", None).is_err());
        assert!(validate_allowed_url("file://localhost:2528/", None).is_err());
        assert!(validate_allowed_url("ws://localhost:2528/", None).is_err());
    }

    #[test]
    fn test_reject_malformed_urls() {
        // Malformed URLs
        assert!(validate_allowed_url("not-a-url", None).is_err());
        assert!(validate_allowed_url("http://", None).is_err());
        assert!(validate_allowed_url("http://localhost", None).is_ok()); // localhost port 80 is valid
        assert!(validate_allowed_url("http://:2528/", None).is_err()); // Missing hostname
    }

    #[test]
    fn test_reject_case_variations() {
        // Case variations should be handled (hostname is lowercased)
        assert!(validate_allowed_url("http://LOCALHOST:2528/", None).is_ok());
        assert!(validate_allowed_url("http://LocalHost:2528/", None).is_ok());
    }

    #[test]
    fn test_reject_subdomain_attacks() {
        // Subdomain attacks
        assert!(validate_allowed_url("http://subdomain.localhost:2528/", None).is_err());
        assert!(validate_allowed_url("http://subdomain.127.0.0.1:2528/", None).is_err());
    }

    #[test]
    fn test_reject_url_encoding_attacks() {
        // URL encoding attacks
        assert!(validate_allowed_url("http://localhost%3A2528/", None).is_err());
        assert!(validate_allowed_url("http://localhost:2528%2Fevil.com/", None).is_err());
    }

    #[test]
    fn test_reject_userinfo_attacks() {
        // Userinfo attacks
        assert!(validate_allowed_url("http://user@localhost:2528/", None).is_err());
        assert!(validate_allowed_url("http://localhost:2528@evil.com/", None).is_err());
    }

    // SSE streaming tests — spin up a real TCP listener and drive reqwest's
    // bytes_stream() + tokio::select! cancellation, verifying the mechanism
    // used by proxy_sse_stream without needing a live tauri::Window.

    #[tokio::test]
    async fn test_sse_stream_delivers_chunks() {
        use futures_util::StreamExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // drain request headers
            let mut buf = vec![0u8; 4096];
            let mut total = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                total.extend_from_slice(&buf[..n]);
                if total.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            // send SSE headers + two chunked events + terminal chunk
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            ).await.unwrap();
            for event in &["data: hello\n\n", "data: world\n\n"] {
                let frame = format!("{:x}\r\n{}\r\n", event.len(), event);
                sock.write_all(frame.as_bytes()).await.unwrap();
            }
            sock.write_all(b"0\r\n\r\n").await.unwrap();
        });

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{port}/sse"))
            .header("Accept", "text/event-stream")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);

        let mut body = String::new();
        let mut stream = resp.bytes_stream();
        while let Some(Ok(chunk)) = stream.next().await {
            body.push_str(&String::from_utf8_lossy(&chunk));
        }

        assert!(body.contains("data: hello"), "unexpected body: {body:?}");
        assert!(body.contains("data: world"), "unexpected body: {body:?}");
    }

    #[tokio::test]
    async fn test_sse_stream_stops_on_cancel() {
        use futures_util::StreamExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        use tokio::sync::oneshot;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // Server sends one chunk then stalls (infinite stream)
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let mut total = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                total.extend_from_slice(&buf[..n]);
                if total.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            ).await.unwrap();
            let event = "data: first\n\n";
            let frame = format!("{:x}\r\n{}\r\n", event.len(), event);
            sock.write_all(frame.as_bytes()).await.unwrap();
            sock.flush().await.unwrap();
            // stall until the test drops the connection
            tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        });

        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
        let mut cancel_tx_opt = Some(cancel_tx);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let resp = client
            .get(format!("http://127.0.0.1:{port}/sse"))
            .header("Accept", "text/event-stream")
            .send()
            .await
            .unwrap();

        let mut received: Vec<String> = Vec::new();
        let mut stream = resp.bytes_stream();
        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            received.push(String::from_utf8_lossy(&bytes).into_owned());
                            if let Some(tx) = cancel_tx_opt.take() {
                                let _ = tx.send(());
                            }
                        }
                        Some(Err(_)) | None => break,
                    }
                }
                _ = &mut cancel_rx => break,
            }
        }

        assert!(
            !received.is_empty(),
            "expected at least one chunk before cancel"
        );
        let body = received.concat();
        assert!(body.contains("data: first"), "unexpected: {body:?}");
    }


    #[test]
    fn test_score_merod_asset_windows() {
        let triple = "x86_64-pc-windows-msvc";
        assert!(score_merod_asset("merod-x86_64-pc-windows-msvc.zip", triple).is_some());
        assert!(score_merod_asset("merod-x86_64-pc-windows-msvc.exe", triple).is_some());
        assert!(score_merod_asset("merod-aarch64-apple-darwin.tar.gz", triple).is_none());
    }

    #[test]
    fn test_merod_target_triple_is_known() {
        let triple = merod_target_triple();
        assert_ne!(
            triple, "unknown",
            "target triple should be known on supported platforms"
        );
        // Must contain OS and arch info
        assert!(triple.contains('-'), "triple should be dash-separated");
    }

    #[test]
    fn test_is_textual_content_type() {
        // Text — carried as a UTF-8 string.
        for ct in [
            "application/json",
            "application/json; charset=utf-8",
            "text/plain",
            "text/html; charset=utf-8",
            "application/xml",
            "application/javascript",
            "application/x-www-form-urlencoded",
            "text/csv",
            "multipart/form-data; boundary=xyz",
            "image/svg+xml",              // +xml suffix
            "application/problem+json",   // +json suffix
            "text/xml",
        ] {
            assert!(is_textual_content_type(ct), "should be textual: {ct}");
        }
        // Binary — must go over IPC as base64, not lossy UTF-8.
        for ct in [
            "application/octet-stream",
            "image/png",
            "image/jpeg",
            "image/webp",
            "video/mp4",
            "application/pdf",
            // Office Open XML / vendor types are ZIP binaries despite "xml" in the name.
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
        ] {
            assert!(!is_textual_content_type(ct), "should be binary: {ct}");
        }
    }

    #[test]
    fn test_base64_roundtrip_preserves_binary() {
        // Bytes that are NOT valid UTF-8 (a PNG-ish header) — the exact case
        // response.text() used to corrupt.
        let raw: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).unwrap();
        assert_eq!(raw, decoded, "base64 round-trip must be byte-exact");
    }

    #[test]
    fn mcp_agent_file_is_under_dot_config() {
        assert_eq!(
            super::mcp_agent_file(Path::new("/Users/x")),
            Path::new("/Users/x/.config/calimero/mcp/agent.json")
        );
    }

    #[cfg(unix)]
    #[test]
    fn create_owner_only_dir_is_0o700_for_dirs_it_creates() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("calimero-mcp-dir-{}", std::process::id()));
        let leaf = base.join("parent").join("mcp");

        super::create_owner_only_dir(&leaf).unwrap();

        for dir in [&leaf, leaf.parent().unwrap()] {
            let mode = std::fs::metadata(dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "{dir:?} must be owner-only");
        }

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn create_owner_only_dir_retightens_a_leaf_left_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("calimero-mcp-dir-existing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        super::create_owner_only_dir(&dir).unwrap();

        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "a pre-existing looser leaf must be retightened");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_owner_only_is_not_readable_by_others() {
        let dir = std::env::temp_dir().join(format!("calimero-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.json");

        // Pre-existing world-readable file: the write must tighten it, not inherit it.
        std::fs::write(&path, "stale").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        super::write_owner_only(&path, r#"{"nodeUrl":"http://localhost:2528"}"#).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"nodeUrl":"http://localhost:2528"}"#
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "credential file must be owner-only");
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_owner_only_leaves_no_temp_file_behind() {
        let dir = std::env::temp_dir().join(format!("calimero-mcp-tmp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.json");

        super::write_owner_only(&path, r#"{"nodeUrl":"http://localhost:2528"}"#).unwrap();

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.as_str() != "agent.json")
            .collect();
        assert!(leftovers.is_empty(), "write left {leftovers:?} behind");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_owner_only_removes_the_temp_file_when_the_write_fails() {
        let dir = std::env::temp_dir().join(format!("calimero-mcp-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // A directory at the target makes the rename fail once the temp file - which
        // holds the full token pair - has already been written.
        let path = dir.join("agent.json");
        std::fs::create_dir_all(&path).unwrap();

        assert!(super::write_owner_only(&path, r#"{"refreshToken":"secret"}"#).is_err());
        assert!(
            !dir.join("agent.json.tmp").exists(),
            "failed write left the temp file holding the token pair behind"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Reads both sources directly so generate_handler! and the ACL file can't drift apart.
    #[test]
    fn generate_handler_commands_match_acl_permissions() {
        const MAIN_RS: &str = include_str!("main.rs");
        const ACL_TOML: &str = include_str!("../permissions/app-commands.toml");

        let handler_commands: std::collections::BTreeSet<&str> = MAIN_RS
            .split_once("tauri::generate_handler![")
            .expect("generate_handler! macro not found in main.rs")
            .1
            .split_once(']')
            .expect("unterminated generate_handler! command list")
            .0
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();

        let declared_permissions: std::collections::BTreeSet<&str> = ACL_TOML
            .lines()
            .filter(|line| line.trim_start().starts_with("commands.allow"))
            .flat_map(|line| line.split('"').skip(1).step_by(2))
            .collect();

        let missing_permission: Vec<_> =
            handler_commands.difference(&declared_permissions).collect();
        let missing_handler: Vec<_> =
            declared_permissions.difference(&handler_commands).collect();

        assert!(
            missing_permission.is_empty() && missing_handler.is_empty(),
            "generate_handler! and permissions/app-commands.toml are out of sync.\n\
             In generate_handler! but missing a permission in app-commands.toml: {missing_permission:?}\n\
             In app-commands.toml but missing from generate_handler!: {missing_handler:?}"
        );
    }

    // A permission left out of the aggregate [[set]] is never granted, so its
    // command fails at runtime exactly as if it had no permission at all.
    #[test]
    fn acl_permissions_are_all_granted_to_the_main_window() {
        const ACL_TOML: &str = include_str!("../permissions/app-commands.toml");

        let (permission_blocks, set_block) = ACL_TOML
            .split_once("[[set]]")
            .expect("aggregate [[set]] not found in app-commands.toml");

        let declared: std::collections::BTreeSet<&str> = permission_blocks
            .lines()
            .filter_map(|line| line.trim().strip_prefix("identifier = "))
            .map(|value| value.trim_matches('"'))
            .collect();

        let granted: std::collections::BTreeSet<&str> = set_block
            .split_once("permissions = [")
            .expect("the [[set]] has no permissions list")
            .1
            .split_once(']')
            .expect("unterminated permissions list in the [[set]]")
            .0
            .split('"')
            .skip(1)
            .step_by(2)
            .collect();

        let ungranted: Vec<_> = declared.difference(&granted).collect();
        let unknown: Vec<_> = granted.difference(&declared).collect();

        assert!(
            ungranted.is_empty() && unknown.is_empty(),
            "the allow-app-commands set does not match the declared permissions.\n\
             Declared as [[permission]] but not in the set: {ungranted:?}\n\
             In the set but not declared as a [[permission]]: {unknown:?}"
        );
    }
}
