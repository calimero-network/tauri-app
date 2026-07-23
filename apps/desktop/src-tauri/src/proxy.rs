//! Shared HTTP/SSE proxy for external app webviews. The injected `proxy_script.js`
//! routes an app page's `fetch`/SSE through these Tauri commands so requests reach
//! the local node (bypassing mixed-content restrictions) with byte-exact bodies.
//!
//! This is a self-contained copy of the host's v2 proxy (binary-safe body handling
//! from #152, external-window connectivity from #156) so the separate
//! `calimero-shell` binary can serve the same commands. The host keeps its own
//! inline copy (which also tracks in-flight requests for graceful merod shutdown);
//! the shell owns no merod, so this copy omits that bookkeeping.
#![allow(dead_code)]

use crate::errors::{TauriError, TauriErrorCode};
use base64::Engine as _;
use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Emitter;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SSE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn http_client() -> &'static reqwest::Client {
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

#[derive(Debug, Serialize, Deserialize)]
pub struct HttpRequest {
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
pub struct HttpResponse {
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
pub fn is_textual_content_type(content_type: &str) -> bool {
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

/// Validates that a URL is allowed for proxying.
///
/// Only HTTP localhost URLs are proxied (HTTPS registries don't need proxying).
/// Prevents hostname spoofing like `http://localhost:2528.evil.com` or
/// `http://localhost:2528@evil.com`.
pub fn validate_allowed_url(url: &str, configured_node_url: Option<&str>) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| {
        format!(
            "Invalid URL format: {}. Please check that the URL is properly formatted.",
            e
        )
    })?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "Unsupported URL scheme: '{}'. Only 'http' and 'https' are allowed. Please use http://localhost:2528 or https://apps.calimero.network",
            scheme
        ));
    }

    if parsed.username() != "" || parsed.password().is_some() {
        return Err(
            "URLs with authentication credentials are not allowed for security reasons. Please use a URL without username/password (e.g., http://localhost:2528 instead of user@localhost:2528)".to_string()
        );
    }

    let host = parsed.host_str().ok_or_else(|| {
        "Invalid URL: missing hostname. Please provide a valid URL with a hostname (e.g., localhost or apps.calimero.network)".to_string()
    })?;
    let host_lower = host.to_lowercase();

    let port = parsed.port().unwrap_or_else(|| match scheme {
        "http" => 80,
        "https" => 443,
        _ => unreachable!(),
    });

    if let Some(node_url) = configured_node_url {
        match url::Url::parse(node_url) {
            Ok(node_parsed) => {
                let node_host = node_parsed.host_str().map(|h| h.to_lowercase());
                let node_port = node_parsed.port().or_else(|| match node_parsed.scheme() {
                    "http" => Some(80),
                    "https" => Some(443),
                    _ => None,
                });

                if node_host.as_ref().map(|h| h == &host_lower).unwrap_or(false)
                    && node_port.map(|p| p == port).unwrap_or(false)
                    && node_parsed.scheme() == scheme
                {
                    return Ok(());
                }
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
pub async fn proxy_http_request(
    request: HttpRequest,
    configured_node_url: Option<String>,
) -> Result<HttpResponse, TauriError> {
    // Validate URL before processing (pass configured node URL if available)
    validate_allowed_url(&request.url, configured_node_url.as_deref())
        .map_err(|e| TauriError::new(TauriErrorCode::UrlNotAllowed, e))?;

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
    let original_port = parsed_original
        .port()
        .or_else(|| match parsed_original.scheme() {
            "http" => Some(2528),
            "https" => Some(443),
            _ => None,
        })
        .ok_or_else(|| {
            TauriError::new(
                TauriErrorCode::InvalidUrl,
                "Could not determine port from URL",
            )
        })?;
    let host_header = format!("{}:{}", original_host, original_port);

    let normalized_url = request.url.clone();

    info!(
        "[Tauri Proxy] Proxying request: {} {}",
        request.method, request.url
    );
    if let Some(ref headers) = request.headers {
        debug!("[Tauri Proxy] Request headers count: {}", headers.len());
        let has_auth =
            headers.contains_key("Authorization") || headers.contains_key("authorization");
        debug!("[Tauri Proxy] Has Authorization header: {}", has_auth);
    }

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
            req_builder = req_builder.header(key, value);
        }
        if !has_host {
            debug!("[Tauri Proxy] Original Host would be: {}", host_header);
        }
        debug!("[Tauri Proxy] Total headers processed: {}", headers.len());
        if !has_content_type {
            if request.body_base64.is_some() {
                req_builder = req_builder.header("Content-Type", "application/octet-stream");
            } else if request.body.is_some() {
                req_builder = req_builder.header("Content-Type", "application/json");
            }
        }
    } else if request.body.is_some() || request.body_base64.is_some() {
        let default_ct = if request.body_base64.is_some() {
            "application/octet-stream"
        } else {
            "application/json"
        };
        req_builder = req_builder.header("Content-Type", default_ct);
    }

    // A base64 binary body (decoded to raw bytes) wins over the text body, so
    // image/octet-stream uploads are sent as bytes, not mangled text.
    if let Some(b64) = request.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| {
                TauriError::with_details(
                    TauriErrorCode::InvalidInput,
                    "Invalid base64 request body",
                    e.to_string(),
                )
            })?;
        req_builder = req_builder.body(bytes);
    } else if let Some(body) = request.body {
        req_builder = req_builder.body(body);
    }

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

    let status = response.status().as_u16();
    let mut response_headers = std::collections::HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(key.to_string(), value_str.to_string());
        }
    }
    let content_type = response_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let textual = content_type.is_empty() || is_textual_content_type(&content_type);
    info!(
        "[Tauri Proxy] Response: {} (content-type: {}, {})",
        status,
        if content_type.is_empty() {
            "<none>"
        } else {
            content_type.as_str()
        },
        if textual { "text" } else { "binary/base64" },
    );

    let (body, body_base64) = if textual {
        let text = response.text().await.map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::ResponseReadError,
                format!("Failed to read response from {}", request.url),
                e.to_string(),
            )
        })?;
        (text, None)
    } else {
        let bytes = response.bytes().await.map_err(|e| {
            TauriError::with_details(
                TauriErrorCode::ResponseReadError,
                format!("Failed to read response from {}", request.url),
                e.to_string(),
            )
        })?;
        (
            String::new(),
            Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        )
    };

    Ok(HttpResponse {
        status,
        headers: response_headers,
        body,
        body_base64,
    })
}

// Registry of active SSE streams, keyed by stream_id, for cancellation support.
pub type SseCancelRegistry = std::sync::Arc<
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
>;

/// Open an SSE connection to `url` on the Rust side (bypasses mixed-content
/// restrictions for HTTPS-hosted app windows) and relay each chunk back to the
/// JS layer as a `sse-chunk-{stream_id}` window event. Fires `sse-end-{stream_id}`
/// when the stream closes or errors.
#[tauri::command]
pub async fn proxy_sse_stream(
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
pub fn cancel_sse_stream(stream_id: String, cancel_registry: tauri::State<'_, SseCancelRegistry>) {
    if let Ok(mut registry) = cancel_registry.lock() {
        if let Some(sender) = registry.remove(&stream_id) {
            let _ = sender.send(());
        }
    }
}
