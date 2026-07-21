// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use thiserror::Error;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SSE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Version of the merod binary this build expects, embedded at compile time from merod-config.json.
const MEROD_CONFIG_VERSION: &str = match option_env!("MEROD_CONFIG_VERSION") {
    Some(v) => v,
    None => "unknown",
};

fn http_client() -> &'static reqwest::Client {
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
    body: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct HttpResponse {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body: String,
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

/// Check CLI args for a calimero:// deep link URL (passed by OS when app is launched via URL scheme).
fn parse_deep_link_arg() -> Option<String> {
    for arg in std::env::args() {
        if arg.starts_with("calimero://") {
            return Some(arg);
        }
    }
    None
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
                let value_preview = if value.len() > 50 {
                    let preview: String = value.chars().take(50).collect();
                    format!("{}...", preview)
                } else {
                    value.clone()
                };
                debug!(
                    "[Tauri Proxy] Adding header: '{}' = '{}'",
                    key, value_preview
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

        // Add default Content-Type if body exists but no Content-Type header
        if !has_content_type && request.body.is_some() {
            req_builder = req_builder.header("Content-Type", "application/json");
        }
    } else if request.body.is_some() {
        // No headers provided but body exists - add default Content-Type
        req_builder = req_builder.header("Content-Type", "application/json");
    }

    // Add body
    if let Some(body) = request.body {
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

    let body = response.text().await.map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::ResponseReadError,
            format!("Failed to read response from {}", request.url),
            e.to_string(),
        )
    })?;

    info!("[Tauri Proxy] Response: {} ({} bytes)", status, body.len());

    Ok(HttpResponse {
        status,
        headers: response_headers,
        body,
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
        let mut registry = cancel_registry.lock().unwrap_or_else(|p| p.into_inner());
        registry.insert(stream_id.clone(), cancel_tx);
    }

    let chunk_event = format!("sse-chunk-{}", stream_id);
    let end_event = format!("sse-end-{}", stream_id);

    if let Err(reason) = validate_allowed_url(&url, None) {
        cancel_registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
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
                .lock()
                .unwrap_or_else(|p| p.into_inner())
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
        .lock()
        .unwrap_or_else(|p| p.into_inner())
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

/// Broker an app window's `POST /auth/refresh` to the desktop window, which owns
/// the refresh token. Returns a fresh access token — never a refresh token.
#[tauri::command]
async fn broker_token_refresh(
    app_handle: tauri::AppHandle,
    registry: tauri::State<'_, TokenBrokerRegistry>,
) -> Result<String, TauriError> {
    static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request_id = format!(
        "tok-{}",
        NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let main_window = app_handle.get_webview_window("main").ok_or_else(|| {
        TauriError::new(
            TauriErrorCode::WindowOperationFailed,
            "Desktop window is unavailable; cannot refresh the access token",
        )
    })?;

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<TokenBrokerReply>();
    registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(request_id.clone(), reply_tx);

    if let Err(e) = main_window.emit(
        "calimero:token-request",
        TokenRequestPayload {
            request_id: request_id.clone(),
        },
    ) {
        registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&request_id);
        return Err(TauriError::with_details(
            TauriErrorCode::WindowOperationFailed,
            "Failed to reach the desktop window for a token refresh",
            e.to_string(),
        ));
    }

    match tokio::time::timeout(TOKEN_BROKER_TIMEOUT, reply_rx).await {
        Ok(Ok(Ok(access_token))) => Ok(access_token),
        Ok(Ok(Err(reason))) => Err(TauriError::new(TauriErrorCode::InternalError, reason)),
        // Sender dropped without replying (desktop window closed mid-request).
        Ok(Err(_)) => Err(TauriError::new(
            TauriErrorCode::InternalError,
            "Desktop window closed before the token refresh completed",
        )),
        Err(_) => {
            registry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&request_id);
            Err(TauriError::new(
                TauriErrorCode::Timeout,
                "Timed out waiting for the desktop to refresh the access token",
            ))
        }
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
        .lock()
        .unwrap_or_else(|p| p.into_inner())
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

#[tauri::command]
#[allow(unused_variables)]
fn create_desktop_shortcut(
    app_handle: tauri::AppHandle,
    app_name: String,
    frontend_url: String,
    app_id: Option<String>,
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
        let desktop = dirs::desktop_dir().ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::HomeDirNotFound,
                "Could not find Desktop folder",
            )
        })?;
        // Run the binary directly with args so the process always receives --open-app-url/--open-app-name.
        // (open -a "App" --args ... often just activates the existing process without passing args.)
        let exe_esc = exe_str.replace('\\', "\\\\").replace('"', "\\\"");
        let app_bundle = format!("{}.app", shortcut_name);
        let app_path = desktop.join(&app_bundle);
        let macos_dir = app_path.join("Contents/MacOS");
        std::fs::create_dir_all(&macos_dir).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::DirectoryError,
                "Failed to create .app bundle",
                e.to_string(),
            )
        })?;
        let launcher_path = macos_dir.join(shortcut_name);
        let id_arg = app_id
            .as_deref()
            .map(|id| {
                format!(
                    " --open-app-id \"{}\"",
                    id.replace('\\', "\\\\").replace('"', "\\\"")
                )
            })
            .unwrap_or_default();
        let script = format!(
            "#!/bin/bash\nexec \"{}\" --open-app-url \"{}\" --open-app-name \"{}\"{}\n",
            exe_esc,
            frontend_url.replace('\\', "\\\\").replace('"', "\\\""),
            app_name.replace('\\', "\\\\").replace('"', "\\\""),
            id_arg
        );
        std::fs::write(&launcher_path, script).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::FileWriteError,
                "Failed to write launcher script",
                e.to_string(),
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&launcher_path)
                .map_err(|e| {
                    TauriError::with_details(
                        TauriErrorCode::FileWriteError,
                        "Failed to stat launcher",
                        e.to_string(),
                    )
                })?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&launcher_path, perms).map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::FileWriteError,
                    "Failed to chmod launcher",
                    e.to_string(),
                )
            })?;
        }
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>{}</string>
    <key>CFBundleIdentifier</key>
    <string>network.calimero.desktop.shortcut.{}</string>
    <key>CFBundleName</key>
    <string>{}</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
"#,
            shortcut_name
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('&', "&amp;"),
            shortcut_name.replace(|c: char| !c.is_alphanumeric(), "_"),
            shortcut_name
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('&', "&amp;")
        );
        let plist_path = app_path.join("Contents/Info.plist");
        std::fs::write(&plist_path, plist).map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::FileWriteError,
                "Failed to write Info.plist",
                e.to_string(),
            )
        })?;
        return Ok(app_path.to_string_lossy().into_owned());
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
    let window = WebviewWindowBuilder::new(
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
    .initialization_script(&proxy_script) // Inject script with configured node URL
    .build()
    .map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::WindowCreationFailed,
            format!("Failed to create window '{}' for URL '{}'", title, url),
            e.to_string(),
        )
    })?;

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

/// Get the path to the bundled merod binary
fn get_merod_binary_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_candidates = if cfg!(target_os = "windows") {
        vec!["merod/merod.exe", "merod/merod"]
    } else {
        vec!["merod/merod", "merod/merod.exe"]
    };

    for candidate in &resource_candidates {
        if let Ok(resource_path) = app_handle
            .path()
            .resolve(candidate, tauri::path::BaseDirectory::Resource)
        {
            if resource_path.exists() {
                return Ok(resource_path);
            }
        }
    }

    Err(format!(
        "Merod resource not found. Checked: {:?}",
        resource_candidates
    ))
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

#[tauri::command]
async fn start_merod(
    server_port: Option<u16>,
    swarm_port: Option<u16>,
    data_dir: Option<String>,
    node_name: Option<String>,
    debug_logs: Option<bool>,
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
) -> Result<String, TauriError> {
    let server_port = server_port.unwrap_or(2528);
    let swarm_port = swarm_port.unwrap_or(2428);

    // Only stop a process that uses the same server_port (port conflict)
    let existing_on_port: Option<u32> = {
        let state = merod_state.lock().unwrap();
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
        let mut state = merod_state.lock().unwrap();
        state.retain(|p| p.pid != pid);
    }

    // Get bundled merod binary
    let merod_binary = get_merod_binary_path(&app_handle)
        .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e))?;

    // Prepare home directory (where .calimero folder is, e.g., ~/.calimero)
    let home_dir_path = if let Some(dir) = data_dir {
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

    // Validate node name before any filesystem use
    if let Some(name) = &node_name {
        validate_node_name(name).map_err(|e| TauriError::new(TauriErrorCode::InvalidInput, e))?;
    }

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
                                if addr.contains("/ip4/127.0.0.1/tcp/") {
                                    let new_addr = regex::Regex::new(r"/tcp/\d+")
                                        .unwrap()
                                        .replace(addr, &format!("/tcp/{}", server_port))
                                        .to_string();
                                    *listen_str = toml::Value::String(new_addr);
                                } else if addr.contains("/ip6/::1/tcp/") {
                                    // Replace port in IPv6 server addresses
                                    let new_addr = regex::Regex::new(r"/tcp/\d+")
                                        .unwrap()
                                        .replace(addr, &format!("/tcp/{}", server_port))
                                        .to_string();
                                    *listen_str = toml::Value::String(new_addr);
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
                                    let new_addr = regex::Regex::new(r"/tcp/\d+")
                                        .unwrap()
                                        .replace(addr, &format!("/tcp/{}", swarm_port))
                                        .to_string();
                                    *listen_str = toml::Value::String(new_addr);
                                } else if addr.contains("/udp/") {
                                    // Replace UDP port (e.g., /ip4/0.0.0.0/udp/2428/quic-v1)
                                    let new_addr = regex::Regex::new(r"/udp/\d+")
                                        .unwrap()
                                        .replace(addr, &format!("/udp/{}", swarm_port))
                                        .to_string();
                                    *listen_str = toml::Value::String(new_addr);
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

    // Create logs directory and open log file - redirect merod stdout/stderr here
    let log_dir = home_dir_path.join(&node_name_str).join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::DirectoryError,
            "Failed to create logs directory",
            e.to_string(),
        )
    })?;
    let log_path = log_dir.join("merod.log");

    // Open log file for append - use separate handles for stdout and stderr
    let log_file_stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::FileWriteError,
                "Failed to create log file",
                e.to_string(),
            )
        })?;
    let log_file_stderr = log_file_stdout
        .try_clone()
        .or_else(|_| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
        })
        .map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::FileWriteError,
                "Failed to open log file for stderr",
                e.to_string(),
            )
        })?;

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

    // Redirect stdout/stderr to log file - merod output goes directly to disk
    cmd.stdout(Stdio::from(log_file_stdout));
    cmd.stderr(Stdio::from(log_file_stderr));
    cmd.stdin(Stdio::null());

    // Log the command being run
    let cmd_str = format!("{:?}", cmd);
    info!(
        "[Merod] Running command: {}, logs at {:?}",
        cmd_str, log_path
    );

    // Start the process
    let mut child = cmd.spawn().map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::MerodStartFailed,
            "Failed to start merod",
            e.to_string(),
        )
    })?;

    let pid = child.id().unwrap();
    info!("[Merod] Started with PID: {}", pid);

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
            return Err(TauriError::new(
                TauriErrorCode::MerodProcessExited,
                error_msg,
            ));
        }
    }

    // Store process state
    {
        let mut state = merod_state.lock().unwrap();
        state.push(MerodProcess {
            pid,
            port: server_port,
        });
    }

    // Spawn a task to monitor the process
    let merod_state_clone = merod_state.inner().clone();
    let monitored_pid = pid; // Capture PID for verification
    tokio::spawn(async move {
        let status = child.wait().await;
        let mut state = merod_state_clone.lock().unwrap();
        if let Ok(exit_status) = status {
            if let Some(code) = exit_status.code() {
                warn!(
                    "[Merod] Process {} exited with code: {}",
                    monitored_pid, code
                );
            }
        }
        state.retain(|p| p.pid != monitored_pid);
    });

    Ok(format!("Merod started successfully with PID: {}", pid))
}

#[tauri::command]
async fn stop_merod(merod_state: tauri::State<'_, MerodState>) -> Result<String, TauriError> {
    let pids: Vec<u32> = {
        let state = merod_state.lock().unwrap();
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

    {
        let mut state = merod_state.lock().unwrap();
        state.clear();
    }

    Ok("Merod stopped successfully".to_string())
}

#[tauri::command]
async fn stop_merod_by_pid_command(
    pid: u32,
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
    {
        let mut state = merod_state.lock().unwrap();
        state.retain(|p| p.pid != pid);
    }

    info!("[Merod] Stopped process with PID: {}", pid);
    Ok(format!("Merod stopped successfully (PID: {})", pid))
}

fn is_process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use std::process::Command;
        let output = Command::new("kill").arg("-0").arg(pid.to_string()).output();
        output.is_ok() && output.unwrap().status.success()
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

#[tauri::command]
async fn get_merod_status(
    merod_state: tauri::State<'_, MerodState>,
) -> Result<serde_json::Value, TauriError> {
    let mut state = merod_state.lock().unwrap();
    if state.is_empty() {
        return Ok(serde_json::json!({ "running": false, "nodes": [] }));
    }
    // Filter out dead processes
    state.retain(|p| is_process_running(p.pid));
    if state.is_empty() {
        return Ok(serde_json::json!({ "running": false, "nodes": [] }));
    }
    let nodes: Vec<_> = state
        .iter()
        .map(|p| serde_json::json!({ "pid": p.pid, "port": p.port }))
        .collect();
    let first = &state[0];
    Ok(serde_json::json!({
        "running": true,
        "nodes": nodes,
        "pid": first.pid,
        "port": first.port
    }))
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::HttpClientError,
                "Failed to create HTTP client",
                e.to_string(),
            )
        })?;

    let response = client.get(&health_url).send().await;

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
    app_handle: tauri::AppHandle,
) -> Result<String, TauriError> {
    validate_node_name(&node_name).map_err(|e| TauriError::new(TauriErrorCode::InvalidInput, e))?;
    // Get bundled merod binary
    let merod_binary = get_merod_binary_path(&app_handle)
        .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e))?;

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

    // Add timeout to prevent hanging (30 seconds should be enough for init)
    let output = tokio::time::timeout(tokio::time::Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| {
            TauriError::new(
                TauriErrorCode::Timeout,
                "Merod init command timed out after 30 seconds",
            )
        })?
        .map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::MerodInitFailed,
                "Failed to execute merod init",
                e.to_string(),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TauriError::new(
            TauriErrorCode::MerodInitFailed,
            format!("Merod init failed: {}", stderr),
        ));
    }

    info!(
        "[Merod] Initialized node '{}' in {:?}",
        node_name, home_dir_path
    );
    Ok(format!("Node '{}' initialized successfully", node_name))
}

#[tauri::command]
async fn detect_running_merod_nodes() -> Result<Vec<serde_json::Value>, TauriError> {
    #[cfg(unix)]
    {
        use std::process::Command;

        // Use ps to find merod processes
        let output = Command::new("ps")
            .arg("ax")
            .arg("-o")
            .arg("pid,command")
            .output()
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
                if let Some(pid_str) = parts.get(0) {
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

                        // Try to read ports from config.toml
                        let mut server_port = 2528; // Default
                        let mut swarm_port = 2428; // Default
                        if let (Some(name), Some(home)) = (&node_name, &home_dir) {
                            let config_path = std::path::PathBuf::from(home)
                                .join(name)
                                .join("config.toml");
                            if config_path.exists() {
                                if let Ok(config_content) = std::fs::read_to_string(&config_path) {
                                    if let Ok(config) = config_content.parse::<toml::Value>() {
                                        // Try to extract server port from server.listen
                                        if let Some(server) = config.get("server") {
                                            if let Some(listen) = server.get("listen") {
                                                if let Some(listen_array) = listen.as_array() {
                                                    for listen_str in listen_array {
                                                        if let Some(addr) = listen_str.as_str() {
                                                            // Extract port from /ip4/127.0.0.1/tcp/2528
                                                            if let Some(tcp_pos) =
                                                                addr.find("/tcp/")
                                                            {
                                                                let port_str = &addr[tcp_pos + 5..];
                                                                if let Some(slash_pos) =
                                                                    port_str.find('/')
                                                                {
                                                                    if let Ok(p) = port_str
                                                                        [..slash_pos]
                                                                        .parse::<u16>()
                                                                    {
                                                                        server_port = p;
                                                                        break;
                                                                    }
                                                                } else if let Ok(p) =
                                                                    port_str.parse::<u16>()
                                                                {
                                                                    server_port = p;
                                                                    break;
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // Try to extract swarm port from swarm.listen
                                        if let Some(swarm) = config.get("swarm") {
                                            if let Some(listen) = swarm.get("listen") {
                                                if let Some(listen_array) = listen.as_array() {
                                                    for listen_str in listen_array {
                                                        if let Some(addr) = listen_str.as_str() {
                                                            // Extract port from /ip4/0.0.0.0/tcp/2428 or /ip4/0.0.0.0/udp/2428/quic-v1
                                                            if let Some(tcp_pos) =
                                                                addr.find("/tcp/")
                                                            {
                                                                let port_str = &addr[tcp_pos + 5..];
                                                                if let Some(slash_pos) =
                                                                    port_str.find('/')
                                                                {
                                                                    if let Ok(p) = port_str
                                                                        [..slash_pos]
                                                                        .parse::<u16>()
                                                                    {
                                                                        swarm_port = p;
                                                                        break;
                                                                    }
                                                                } else if let Ok(p) =
                                                                    port_str.parse::<u16>()
                                                                {
                                                                    swarm_port = p;
                                                                    break;
                                                                }
                                                            } else if let Some(udp_pos) =
                                                                addr.find("/udp/")
                                                            {
                                                                let port_str = &addr[udp_pos + 5..];
                                                                if let Some(slash_pos) =
                                                                    port_str.find('/')
                                                                {
                                                                    if let Ok(p) = port_str
                                                                        [..slash_pos]
                                                                        .parse::<u16>()
                                                                    {
                                                                        swarm_port = p;
                                                                        break;
                                                                    }
                                                                } else if let Ok(p) =
                                                                    port_str.parse::<u16>()
                                                                {
                                                                    swarm_port = p;
                                                                    break;
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

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
        use std::process::Command;

        // Use tasklist and wmic on Windows
        let output = Command::new("tasklist")
            .arg("/FO")
            .arg("CSV")
            .output()
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
                            .output();

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

/// Returns the Rust target triple for the running platform, used to pick the
/// right GitHub release asset.
pub(crate) fn merod_target_triple() -> &'static str {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

/// Scores a GitHub release asset name for the given target triple.
/// Lower score = better match. Returns `None` if the asset is not for this platform.
pub(crate) fn score_merod_asset(name: &str, target_triple: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    if !lower.starts_with("merod-") {
        return None;
    }
    if !lower.contains(&target_triple.to_lowercase()) {
        return None;
    }
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Some(0u32)
    } else if lower.ends_with(".zip") {
        Some(1)
    } else if lower.ends_with(".exe") {
        Some(2)
    } else {
        None // unknown extension — extract_merod_binary cannot handle it
    }
}

/// Recursively finds a `merod` / `merod.exe` binary inside a directory tree.
fn find_merod_binary_in_dir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(fname) = path.file_name() else {
            continue;
        };
        let name = fname.to_string_lossy().to_lowercase();
        if path.is_dir() && !path.is_symlink() {
            if let Some(found) = find_merod_binary_in_dir(&path) {
                return Some(found);
            }
        } else if (name == "merod" || name == "merod.exe") && !path.is_symlink() {
            return Some(path);
        }
    }
    None
}

/// Runs `<binary> --version` and returns the trimmed stdout, or `None` on failure or timeout.
async fn get_merod_version_at(path: &std::path::Path) -> Option<String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new(path).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;
    let raw = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    })
    .trim()
    .to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// Extracts the merod binary from an archive (`.tar.gz` / `.zip`) into `temp_dir`.
/// Returns the path to the extracted binary.
async fn extract_merod_binary(
    archive_path: &std::path::Path,
    asset_name: &str,
    temp_dir: &std::path::Path,
) -> Result<std::path::PathBuf, TauriError> {
    let lower = asset_name.to_lowercase();
    let extract_dir = temp_dir.join("extracted");
    tokio::fs::create_dir_all(&extract_dir).await.map_err(|e| {
        TauriError::new(
            TauriErrorCode::DirectoryError,
            format!("create extract dir: {}", e),
        )
    })?;

    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let status = Command::new("tar")
            .args([
                "--no-same-owner",
                "--no-same-permissions",
                "-xzf",
                &archive_path.to_string_lossy(),
                "-C",
                &extract_dir.to_string_lossy(),
            ])
            .status()
            .await
            .map_err(|e| {
                TauriError::new(TauriErrorCode::InternalError, format!("tar failed: {}", e))
            })?;
        if !status.success() {
            return Err(TauriError::new(
                TauriErrorCode::InternalError,
                "tar extraction failed".to_string(),
            ));
        }
    } else if lower.ends_with(".zip") {
        #[cfg(windows)]
        {
            // Pass paths via env vars — avoids any string interpolation / injection in the command
            let status = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command",
                       "Expand-Archive -LiteralPath $env:MEROD_ARCHIVE -DestinationPath $env:MEROD_DEST -Force"])
                .env("MEROD_ARCHIVE", archive_path.as_os_str())
                .env("MEROD_DEST", extract_dir.as_os_str())
                .status().await
                .map_err(|e| TauriError::new(TauriErrorCode::InternalError, format!("powershell failed: {}", e)))?;
            if !status.success() {
                return Err(TauriError::new(
                    TauriErrorCode::InternalError,
                    "zip extraction failed".to_string(),
                ));
            }
        }
        #[cfg(not(windows))]
        {
            let status = Command::new("unzip")
                .args([
                    "-o",
                    &archive_path.to_string_lossy(),
                    "-d",
                    &extract_dir.to_string_lossy(),
                ])
                .status()
                .await
                .map_err(|e| {
                    TauriError::new(
                        TauriErrorCode::InternalError,
                        format!("unzip failed: {}", e),
                    )
                })?;
            if !status.success() {
                return Err(TauriError::new(
                    TauriErrorCode::InternalError,
                    "unzip extraction failed".to_string(),
                ));
            }
        }
    } else if lower.ends_with(".exe") {
        // Windows bare executable — already a binary, no extraction needed
        return Ok(archive_path.to_path_buf());
    } else {
        return Err(TauriError::new(
            TauriErrorCode::InternalError,
            format!(
                "Unknown archive format '{}': expected .tar.gz, .tgz, .zip, or .exe",
                asset_name
            ),
        ));
    }

    let found = find_merod_binary_in_dir(&extract_dir).ok_or_else(|| {
        TauriError::new(
            TauriErrorCode::FileNotFound,
            "merod binary not found in extracted archive",
        )
    })?;

    // Guard against symlinks that escape the extraction directory (zip slip / symlink attack)
    let canonical_dir = extract_dir.canonicalize().map_err(|e| {
        TauriError::new(
            TauriErrorCode::DirectoryError,
            format!("canonicalize extract dir: {}", e),
        )
    })?;
    let canonical_bin = found.canonicalize().map_err(|e| {
        TauriError::new(
            TauriErrorCode::FileNotFound,
            format!("canonicalize binary path: {}", e),
        )
    })?;
    if !canonical_bin.starts_with(&canonical_dir) {
        return Err(TauriError::new(
            TauriErrorCode::PathNotAllowed,
            "Extracted binary path escapes extraction directory",
        ));
    }
    Ok(canonical_bin)
}

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

    let binary_path = get_merod_binary_path(&app_handle)
        .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e))?;

    let expected_version_output = format!("merod {}", expected);

    // Fast path: already correct
    if let Some(current) = get_merod_version_at(&binary_path).await {
        if current == expected_version_output {
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

    if new_version != expected_version_output {
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

    info!("[Updater] merod updated to {}", new_version);
    Ok(serde_json::json!({
        "replaced": true,
        "expected_version": expected,
        "current_version": new_version,
        "message": format!("merod updated to {}", new_version)
    }))
}

/// Return the version string reported by the bundled merod binary (`merod --version`).
#[tauri::command]
async fn get_merod_binary_version(app_handle: tauri::AppHandle) -> Result<String, TauriError> {
    let merod_binary = get_merod_binary_path(&app_handle)
        .map_err(|e| TauriError::new(TauriErrorCode::FileNotFound, e))?;
    Ok(get_merod_version_at(&merod_binary)
        .await
        .unwrap_or_else(|| "unknown".to_string()))
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

    let home_dir_path = if let Some(dir) = home_dir {
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

    let log_path = home_dir_path
        .join(&node_name)
        .join("logs")
        .join("merod.log");

    if !log_path.exists() {
        return Err(TauriError::new(
            TauriErrorCode::FileNotFound,
            format!("No log file found for node '{}'. Logs are only available for nodes started by the app.", node_name),
        ));
    }

    let content = tokio::fs::read_to_string(&log_path).await.map_err(|e| {
        TauriError::with_details(
            TauriErrorCode::FileReadError,
            "Failed to read log file",
            e.to_string(),
        )
    })?;

    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(lines as usize);
    let last_lines = &all_lines[start..];

    Ok(last_lines.join("\n"))
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
    merod_state: tauri::State<'_, MerodState>,
) -> Result<String, TauriError> {
    let tracked: Vec<u32> = merod_state
        .lock()
        .map(|s| s.iter().map(|p| p.pid).collect())
        .unwrap_or_default();
    let pids = collect_merod_pids(&tracked);

    kill_pids(&pids).await;

    {
        if let Ok(mut state) = merod_state.lock() {
            state.clear();
        }
    }

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

/// One WebRTC ICE server entry, serialized exactly as the browser's
/// `RTCIceServer` expects (so the frontend can feed it straight into
/// `new RTCPeerConnection({ iceServers })`).
#[derive(Serialize)]
struct IceServer {
    urls: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "credential")]
    credential: Option<String>,
}

/// Validate a credential/secret value: trims whitespace and rejects empty,
/// over-long (>256 chars), or control-character-bearing values so a malformed or
/// hostile value can't be forwarded verbatim into the frontend's
/// `RTCPeerConnection` config.
fn sanitize_secret(value: &str) -> Option<String> {
    let v = value.trim();
    (!v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control)).then(|| v.to_string())
}

/// Read and sanitize an optional TURN credential env var.
fn sanitized_turn_secret(var: &str) -> Option<String> {
    std::env::var(var).ok().as_deref().and_then(sanitize_secret)
}

/// The ICE credential endpoint URL. Runtime `CALIMERO_ICE_ENDPOINT` wins; otherwise
/// the value baked in at build time via `option_env!` (so release builds ship a
/// working default the installed app uses with zero user configuration). Returns
/// `None` unless the resolved value is an http(s) URL.
fn ice_endpoint() -> Option<String> {
    let raw = std::env::var("CALIMERO_ICE_ENDPOINT")
        .ok()
        .or_else(|| option_env!("CALIMERO_ICE_ENDPOINT").map(str::to_string))?;
    let raw = raw.trim();
    (raw.starts_with("http://") || raw.starts_with("https://")).then(|| raw.to_string())
}

/// The bearer key sent to the ICE endpoint. Runtime env wins; otherwise the
/// build-time baked value (paired with the baked `ice_endpoint`).
fn ice_endpoint_key() -> Option<String> {
    sanitized_turn_secret("CALIMERO_ICE_ENDPOINT_KEY")
        .or_else(|| option_env!("CALIMERO_ICE_ENDPOINT_KEY").and_then(sanitize_secret))
}

/// JSON returned by a self-hosted ICE credential endpoint (`CALIMERO_ICE_ENDPOINT`).
/// Matches the conventional `{ "iceServers": [...] }` shape so a coturn + minting
/// service (or any compatible TURN-as-a-service endpoint) can be swapped without a
/// code change. Each entry carries one `urls` string (the minting service emits one
/// url per entry).
#[derive(Deserialize)]
struct IceEndpointResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<IceServerWire>,
}

#[derive(Deserialize)]
struct IceServerWire {
    urls: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

/// Fetch ICE servers (with freshly-minted, short-lived TURN credentials) from a
/// self-hosted endpoint. Sends `CALIMERO_ICE_ENDPOINT_KEY` as a bearer token when
/// set so the minting service can authenticate the desktop app. Returns `None` on
/// any failure (unreachable, non-2xx, malformed, no usable entries) so the caller
/// falls back to the static path — a momentarily-down endpoint must never block a
/// user from joining a call. Bounded by a short timeout for the same reason.
async fn fetch_ice_servers_from_endpoint(endpoint: &str) -> Option<Vec<IceServer>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()?;
    let mut req = client.get(endpoint);
    if let Some(key) = ice_endpoint_key() {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        log::warn!("[webrtc] ICE endpoint returned status {}", resp.status());
        return None;
    }
    let parsed: IceEndpointResponse = resp.json().await.ok()?;
    let servers: Vec<IceServer> = parsed
        .ice_servers
        .into_iter()
        .filter_map(|s| {
            let urls = s.urls.trim().to_string();
            let is_ice = urls.starts_with("stun:")
                || urls.starts_with("stuns:")
                || urls.starts_with("turn:")
                || urls.starts_with("turns:");
            is_ice.then(|| IceServer {
                urls,
                username: s.username,
                credential: s.credential,
            })
        })
        .collect();
    if servers.is_empty() {
        None
    } else {
        Some(servers)
    }
}

/// ICE servers for WebRTC apps (Mero Meet). Resolution order:
///
/// 1. `CALIMERO_ICE_ENDPOINT` — an endpoint that mints short-lived TURN
///    credentials (authenticated with `CALIMERO_ICE_ENDPOINT_KEY` if set).
///    Resolved from the runtime env var, or from a value baked in at build time
///    (`option_env!`) so release builds use it with zero user configuration.
///    This is the preferred production path: no long-lived TURN secret ships in
///    the app binary, and the endpoint owns the full STUN+TURN list. If it's
///    configured and reachable, its response is authoritative.
/// 2. Static `CALIMERO_TURN_URL` (+ optional `CALIMERO_TURN_USER` /
///    `CALIMERO_TURN_CRED`) — appended to a default STUN server. Simple to set
///    up, but the credentials live in the environment/binary.
/// 3. Public STUN only — last resort so an un-provisioned build still gets basic
///    NAT discovery. Configuring (1) or (2) is required for calls between peers
///    behind symmetric NAT/CGNAT, where a relay is mandatory.
#[tauri::command]
async fn get_ice_servers() -> Vec<IceServer> {
    // (1) Preferred: ephemeral-credential endpoint (runtime env, else baked at build).
    if let Some(endpoint) = ice_endpoint() {
        if let Some(servers) = fetch_ice_servers_from_endpoint(&endpoint).await {
            return servers;
        }
        log::warn!(
            "[webrtc] CALIMERO_ICE_ENDPOINT unreachable/invalid; falling back to static config"
        );
    }

    // (2)/(3) Static STUN (+ optional static TURN from env).
    let mut servers = vec![IceServer {
        urls: "stun:stun.l.google.com:19302".to_string(),
        username: None,
        credential: None,
    }];
    if let Ok(turn_url) = std::env::var("CALIMERO_TURN_URL") {
        let turn_url = turn_url.trim();
        // Only accept a real TURN URI; an unset/garbled env value must not be
        // forwarded to RTCPeerConnection (it would invalidate the whole entry).
        if turn_url.starts_with("turn:") || turn_url.starts_with("turns:") {
            servers.push(IceServer {
                urls: turn_url.to_string(),
                username: sanitized_turn_secret("CALIMERO_TURN_USER"),
                credential: sanitized_turn_secret("CALIMERO_TURN_CRED"),
            });
        } else if !turn_url.is_empty() {
            log::warn!("[webrtc] ignoring CALIMERO_TURN_URL: must start with 'turn:' or 'turns:'");
        }
    }
    servers
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

/// Performs graceful shutdown:
/// 1. Drain in-flight proxy requests up to REQUEST_DRAIN_TIMEOUT_SECS
/// 2. SIGTERM all managed (and detected) merod processes
/// 3. Wait up to PROCESS_TERM_WAIT_SECS, then SIGKILL survivors
fn graceful_shutdown(merod_state: &MerodState) {
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
    info!("[Shutdown] Graceful shutdown complete");
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
                            graceful_shutdown(&merod_state);
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

            let pending = parse_open_app_args();
            app.manage(PendingOpenApp(std::sync::Mutex::new(pending.clone())));

            // Check CLI args for calimero:// deep link URL (cold-launch case,
            // e.g. macOS routes the URL via argv when the app was not running).
            let cloud_auth = parse_deep_link_arg();
            app.manage(PendingCloudAuth(std::sync::Mutex::new(cloud_auth)));

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
            // When launched from a desktop shortcut, hide the main window so only the app window is shown
            if pending.is_some() {
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
        .manage(SseCancelRegistry::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .manage(TokenBrokerRegistry::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .invoke_handler(tauri::generate_handler![
            get_pending_open_app,
            clear_pending_open_app,
            hide_main_window,
            focus_window,
            create_desktop_shortcut,
            create_app_window,
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
            init_merod_node,
            detect_running_merod_nodes,
            get_merod_logs,
            get_merod_binary_version,
            download_and_replace_merod,
            set_tray_icon_connected,
            delete_calimero_data_dir,
            kill_all_merod_processes,
            autostart_enable,
            autostart_disable,
            autostart_is_enabled,
            close_current_window,
            open_url_in_browser,
            get_ice_servers,
            secure_store_token,
            secure_get_token,
            secure_delete_token,
            get_pending_cloud_auth,
            clear_pending_cloud_auth
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{merod_target_triple, score_merod_asset, validate_allowed_url};

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

    // ── Merod binary update tests ─────────────────────────────────────────────

    #[test]
    fn test_score_merod_asset_prefers_tar_gz() {
        let triple = "aarch64-apple-darwin";
        let tar = score_merod_asset("merod-aarch64-apple-darwin.tar.gz", triple);
        let zip = score_merod_asset("merod-aarch64-apple-darwin.zip", triple);
        assert!(tar.is_some(), "tar.gz should match");
        assert!(zip.is_some(), "zip should match");
        assert!(
            tar.unwrap() < zip.unwrap(),
            "tar.gz should be preferred over zip"
        );
    }

    #[test]
    fn test_score_merod_asset_rejects_wrong_platform() {
        assert!(
            score_merod_asset("merod-x86_64-apple-darwin.tar.gz", "aarch64-apple-darwin").is_none()
        );
        assert!(score_merod_asset(
            "merod-x86_64-unknown-linux-gnu.tar.gz",
            "aarch64-apple-darwin"
        )
        .is_none());
    }

    #[test]
    fn test_score_merod_asset_rejects_non_merod() {
        assert!(score_merod_asset(
            "meroctl-aarch64-apple-darwin.tar.gz",
            "aarch64-apple-darwin"
        )
        .is_none());
        assert!(score_merod_asset("something-else.tar.gz", "x86_64-apple-darwin").is_none());
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
}
