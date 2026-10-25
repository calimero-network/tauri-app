//! Shared HTTP/SSE proxy for external app webviews. The injected `proxy_script.js`
//! routes an app page's `fetch`/SSE through these Tauri commands so requests reach
//! the local node (bypassing mixed-content restrictions) with byte-exact bodies.
//!
//! Both binaries serve these commands. The host wraps `proxy_http_request_inner`
//! in its own command so it can count in-flight requests for graceful merod
//! shutdown; the shell owns no merod and registers `proxy_http_request` directly.

use crate::errors::{TauriError, TauriErrorCode};
use crate::LockUnpoisoned;
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

/// Aims a request for the window's own `calimero-app` origin at the node, as
/// that app's host. Any other URL is left alone; another app's origin is refused.
pub fn retarget_own_origin(
    url: &str,
    binding: &crate::app_window::AppWindowBinding,
) -> Result<Option<crate::app_scheme::NodeTarget>, String> {
    let Some(parsed) = url::Url::parse(url).ok().filter(|u| crate::app_scheme::label_from_url(u).is_some())
    else {
        return Ok(None);
    };
    if crate::app_scheme::label_from_url(&parsed) != binding.label {
        return Err(format!("{url} is not this window's app"));
    }
    let label = binding.label.as_deref().unwrap_or_default();
    let path_and_query = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_string(),
    };
    crate::app_scheme::node_target(label, &binding.node_url, &path_and_query).map(Some)
}

/// The window's node and `request` aimed at it. A caller-supplied node URL is
/// never trusted, or any page could aim the proxy at any host; the node is the
/// one the window was opened for, and only while it shows the app's own page.
pub fn authorize_request<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    mut request: HttpRequest,
) -> Result<(HttpRequest, String), TauriError> {
    let denied = |reason| TauriError::new(TauriErrorCode::UrlNotAllowed, reason);
    let binding = crate::app_window::authorize_webview(webview).map_err(denied)?;
    if let Some(target) = retarget_own_origin(&request.url, &binding).map_err(denied)? {
        request.url = target.url;
        request
            .headers
            .get_or_insert_with(Default::default)
            .insert("Host".to_string(), target.host);
    }
    Ok((request, binding.node_url))
}

#[tauri::command]
pub async fn proxy_http_request(
    webview: tauri::Webview,
    request: HttpRequest,
) -> Result<HttpResponse, TauriError> {
    let (request, node_url) = authorize_request(&webview, request)?;
    proxy_http_request_inner(request, Some(node_url)).await
}

pub async fn proxy_http_request_inner(
    request: HttpRequest,
    configured_node_url: Option<String>,
) -> Result<HttpResponse, TauriError> {
    // Validate URL before processing (pass configured node URL if available)
    validate_allowed_url(&request.url, configured_node_url.as_deref())
        .map_err(|e| TauriError::new(TauriErrorCode::UrlNotAllowed, e))?;

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
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        "PATCH" => client.patch(&request.url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, &request.url),
        "HEAD" => client.head(&request.url),
        _ => return Err(TauriError::new(
            TauriErrorCode::UnsupportedMethod,
            format!("Unsupported HTTP method: '{}'. Supported methods are: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD", request.method),
        )),
    };

    if let Some(headers) = request.headers.as_ref() {
        let mut has_content_type = false;
        for (key, value) in headers {
            let key_lower = key.to_lowercase();
            if key_lower == "content-type" {
                has_content_type = true;
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
            req_builder = req_builder.header(key, value);
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
    webview: tauri::Webview,
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

    let allowed = crate::app_window::authorize_webview(&webview).and_then(|binding| {
        let target = retarget_own_origin(&url, &binding)?;
        let (url, host) = match target {
            Some(t) => (t.url, Some(t.host)),
            None => (url.clone(), None),
        };
        validate_allowed_url(&url, Some(&binding.node_url))?;
        Ok((url, host))
    });
    let (url, host) = match allowed {
        Ok(target) => target,
        Err(reason) => {
            cancel_registry.lock_unpoisoned().remove(&stream_id);
            let _ = window.emit(&end_event, "");
            return Err(TauriError::new(TauriErrorCode::UrlNotAllowed, reason));
        }
    };

    let mut request = sse_client()
        .get(&url)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache");
    if let Some(host) = host {
        request = request.header("Host", host);
    }
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
pub fn cancel_sse_stream(stream_id: String, cancel_registry: tauri::State<'_, SseCancelRegistry>) {
    if let Ok(mut registry) = cancel_registry.lock() {
        if let Some(sender) = registry.remove(&stream_id) {
            let _ = sender.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_textual_content_type, retarget_own_origin, validate_allowed_url};
    use crate::app_window::AppWindowBindings;

    #[test]
    fn test_is_textual_content_type() {
        // Text - carried as a UTF-8 string.
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
        // Binary - must go over IPC as base64, not lossy UTF-8.
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

    // SSE streaming tests - spin up a real TCP listener and drive reqwest's
    // bytes_stream() + tokio::select! cancellation, verifying the mechanism
    // used by proxy_sse_stream without needing a live tauri::Window.

    const LABEL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq";

    fn app_binding() -> crate::app_window::AppWindowBinding {
        let bindings = AppWindowBindings::default();
        let page: url::Url = format!("calimero-app://{LABEL}/").parse().unwrap();
        bindings.bind("app-1", &page, "http://127.0.0.1:2528");
        bindings.authorize("app-1", Some(&page)).unwrap()
    }

    #[test]
    fn own_origin_api_calls_go_to_the_node_as_the_app() {
        let binding = app_binding();
        let t = retarget_own_origin(&format!("calimero-app://{LABEL}/jsonrpc"), &binding)
            .unwrap()
            .unwrap();
        assert_eq!(t.url, "http://127.0.0.1:2528/jsonrpc");
        assert_eq!(t.host, format!("{LABEL}.localhost:2528"));
        assert!(validate_allowed_url(&t.url, Some(&binding.node_url)).is_ok());
    }

    #[test]
    fn the_http_form_is_retargeted_only_on_windows() {
        let url = format!("http://calimero-app.{LABEL}/jsonrpc");
        let retargeted = retarget_own_origin(&url, &app_binding()).unwrap().is_some();
        assert_eq!(retargeted, cfg!(windows));
    }

    #[test]
    fn own_origin_query_reaches_the_node() {
        let t = retarget_own_origin(&format!("calimero-app://{LABEL}/sse?id=7"), &app_binding())
            .unwrap()
            .unwrap();
        assert_eq!(t.url, "http://127.0.0.1:2528/sse?id=7");
    }

    #[test]
    fn other_apps_are_refused_and_plain_urls_untouched() {
        let binding = app_binding();
        let other = format!("calimero-app://{}/jsonrpc", "b".repeat(51) + "a");
        assert!(retarget_own_origin(&other, &binding).is_err());
        assert_eq!(retarget_own_origin("http://127.0.0.1:2528/jsonrpc", &binding), Ok(None));
    }

    #[tokio::test]
    async fn a_custom_host_header_reaches_the_node() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        let host = format!("{LABEL}.localhost:{port}");
        super::http_client()
            .get(format!("http://127.0.0.1:{port}/jsonrpc"))
            .header("Host", &host)
            .send()
            .await
            .unwrap();
        let seen = server.await.unwrap().to_lowercase();
        assert!(seen.contains(&format!("host: {host}")), "{seen}");
    }

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
}
