// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use serde::{Deserialize, Serialize};
use log::{debug, info, warn};

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
pub(crate) fn validate_allowed_url(url: &str, configured_node_url: Option<&str>) -> Result<(), String> {
    let parsed = url::Url::parse(url)
        .map_err(|e| format!("Invalid URL format: {}. Please check that the URL is properly formatted.", e))?;
    
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
        if let Ok(node_parsed) = url::Url::parse(node_url) {
            let node_host = node_parsed.host_str().map(|h| h.to_lowercase());
            let node_port = node_parsed.port().or_else(|| {
                match node_parsed.scheme() {
                    "http" => Some(80),
                    "https" => Some(443),
                    _ => None,
                }
            });
            
            // Check if the request URL matches the configured node URL
            if node_host.as_ref().map(|h| h == &host_lower).unwrap_or(false) 
                && node_port.map(|p| p == port).unwrap_or(false)
                && node_parsed.scheme() == scheme {
                return Ok(());
            }
        }
    }
    
    // If a node URL is configured, only allow that URL (no fallback to defaults)
    if configured_node_url.is_some() {
        return Err(format!(
            "URL not allowed: {}://{}:{}. Only the configured node URL is allowed for proxying.",
            scheme, host, port
        ));
    }
    
    // Validate allowed combinations with strict hostname matching (fallback defaults)
    match (scheme, host_lower.as_str(), port) {
        // HTTP localhost on port 2528 (default fallback for backwards compatibility)
        ("http", "localhost", 2528) => Ok(()),
        ("http", "127.0.0.1", 2528) => Ok(()),
        // Reject everything else (including HTTPS - no proxying needed)
        _ => {
            // Provide helpful error message based on what's wrong
            let mut suggestions = Vec::new();
            
            if scheme == "http" {
                if host_lower == "localhost" || host_lower == "127.0.0.1" {
                    if port != 2528 {
                        suggestions.push(format!("For localhost, use port 2528 (e.g., http://localhost:2528)"));
                    }
                } else {
                    suggestions.push("For localhost access, use http://localhost:2528 or http://127.0.0.1:2528".to_string());
                }
            } else if scheme == "https" {
                suggestions.push("HTTPS URLs don't need proxying. Only HTTP localhost node URLs are proxied.".to_string());
            }
            
            let mut suggestion_text = if suggestions.is_empty() {
                if let Some(node_url) = configured_node_url {
                    format!("Allowed URLs: {} (configured node URL)", node_url)
                } else {
                    "Allowed URLs: http://localhost:2528 or http://127.0.0.1:2528".to_string()
                }
            } else {
                suggestions.join(". ")
            };
            
            if configured_node_url.is_some() && !suggestion_text.contains("configured node URL") {
                if let Some(node_url) = configured_node_url {
                    suggestion_text = format!("{}. Or use your configured node URL: {}", suggestion_text, node_url);
                }
            }
            
            Err(format!(
                "URL not allowed: {}://{}:{}. {}",
                scheme, host, port, suggestion_text
            ))
        }
    }
}

#[tauri::command]
async fn proxy_http_request(request: HttpRequest, configured_node_url: Option<String>) -> Result<HttpResponse, String> {
    use reqwest;
    
    // Validate URL before processing (pass configured node URL if available)
    validate_allowed_url(&request.url, configured_node_url.as_deref())?;
    
    // Parse URL to determine what Host header to use
    let parsed_original = url::Url::parse(&request.url)
        .map_err(|e| format!("Failed to parse URL '{}': {}. Please ensure the URL is properly formatted.", request.url, e))?;
    let original_host = parsed_original.host_str()
        .ok_or_else(|| format!("Invalid URL '{}': missing hostname. Please provide a URL with a valid hostname.", request.url))?;
    // Get port (explicit or default)
    let original_port = parsed_original.port().or_else(|| {
        match parsed_original.scheme() {
            "http" => Some(2528),  // Default for localhost
            "https" => Some(443),  // Default for HTTPS
            _ => None,
        }
    }).ok_or_else(|| "Could not determine port".to_string())?;
    let host_header = format!("{}:{}", original_host, original_port);
    
    // DON'T normalize - use original URL exactly as Chrome does
    // The issue might be that normalizing breaks something
    let normalized_url = request.url.clone();
    
    info!("[Tauri Proxy] Proxying request: {} {}", request.method, request.url);
    if let Some(ref headers) = request.headers {
        debug!("[Tauri Proxy] Request headers count: {}", headers.len());
        // Log Authorization header if present (but don't log the full token)
        if let Some(auth_header) = headers.get("Authorization").or_else(|| headers.get("authorization")) {
            debug!("[Tauri Proxy] Authorization header present: {}...", &auth_header[..auth_header.len().min(20)]);
        } else {
            warn!("[Tauri Proxy] No Authorization header found!");
        }
        // Log all header keys for debugging
        debug!("[Tauri Proxy] Header keys: {:?}", headers.keys().collect::<Vec<_>>());
        debug!("[Tauri Proxy] Request headers: {:?}", headers);
    } else {
        warn!("[Tauri Proxy] No headers in request!");
    }
    
    // Create HTTP client with proper configuration
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false) // Use proper cert validation
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}. This may indicate a system configuration issue. Please try again.", e))?;
    
    // Build request (use normalized URL)
    let mut req_builder = match request.method.as_str() {
        "GET" => client.get(&normalized_url),
        "POST" => client.post(&normalized_url),
        "PUT" => client.put(&normalized_url),
        "DELETE" => client.delete(&normalized_url),
        "PATCH" => client.patch(&normalized_url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, &normalized_url),
        "HEAD" => client.head(&normalized_url),
        _ => return Err(format!(
            "Unsupported HTTP method: '{}'. Supported methods are: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
            request.method
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
            // Log header being added (truncate value for security)
            let value_preview = if value.len() > 50 {
                format!("{}...", &value[..50])
            } else {
                value.clone()
            };
            debug!("[Tauri Proxy] Adding header: '{}' = '{}'", key, value_preview);
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
    let response = req_builder.send()
        .await
        .map_err(|e| {
            let error_msg = e.to_string();
            if error_msg.contains("timeout") {
                format!("Request to {} timed out after 30 seconds. The server may be slow or unreachable. Please check your connection and try again.", request.url)
            } else if error_msg.contains("connection") || error_msg.contains("resolve") {
                format!("Failed to connect to {}. Please ensure the Calimero node is running on localhost:2528 or check your network connection.", request.url)
            } else {
                format!("Request to {} failed: {}. Please check the URL and try again.", request.url, error_msg)
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
    
    let body = response.text()
        .await
        .map_err(|e| format!("Failed to read response from {}. The server may have closed the connection unexpectedly. Error: {}", request.url, e))?;
    
    info!("[Tauri Proxy] Response: {} ({} bytes)", status, body.len());
    
    Ok(HttpResponse {
        status,
        headers: response_headers,
        body,
    })
}

#[tauri::command]
async fn create_app_window(
    app_handle: tauri::AppHandle,
    window_label: String,
    url: String,
    title: String,
    open_devtools: Option<bool>,
    node_url: Option<String>,
) -> Result<(), String> {
    use tauri::{WindowBuilder, Manager};
    
    // Parse URL to get domain for IPC scope configuration
    let parsed_url = url.parse::<url::Url>()
        .map_err(|e| format!("Invalid URL '{}': {}. Please provide a valid URL (e.g., https://example.com)", url, e))?;
    let domain = parsed_url.host_str()
        .ok_or_else(|| format!("Invalid URL '{}': missing hostname. Please provide a URL with a valid hostname.", url))?;
    
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
    let window = WindowBuilder::new(
        &app_handle,
        &window_label,
        tauri::WindowUrl::External(url.parse().map_err(|e| format!("Invalid URL '{}': {}. Please provide a valid URL (e.g., https://example.com)", url, e))?),
    )
    .title(&title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .center()
    .initialization_script(&proxy_script) // Inject script with configured node URL
    .build()
    .map_err(|e| format!("Failed to create window '{}' for URL '{}': {}. Please check that the window label is unique and try again.", title, url, e))?;
    
    // Configure IPC scope BEFORE showing window
    // This allows windows with unique labels (domain + timestamp) to access Tauri IPC
    let remote_access = tauri::ipc::RemoteDomainAccessScope::new(domain)
        .add_window(&window_label)
        .enable_tauri_api();
    app_handle.ipc_scope().configure_remote_access(remote_access);
    
    info!("[Tauri] Configured IPC scope for domain: {} on window: {}", domain, window_label);
    
    // Show the window AFTER IPC scope is configured
    window.show().map_err(|e| format!("Failed to display window '{}': {}. The window may have been closed or there may be a system issue.", title, e))?;
    
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
    
    if should_open_devtools {
        // Wait a bit for window to be ready, then open devtools
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        window.open_devtools();
    }
    
    Ok(())
}

#[tauri::command]
async fn open_devtools(window_label: String, app_handle: tauri::AppHandle) {
    // Try multiple times with delays in case window isn't ready yet
    for _i in 0..5 {
        if let Some(window) = app_handle.get_window(&window_label) {
            window.open_devtools();
            return;
        }
        // Wait a bit before retrying
        std::thread::sleep(std::time::Duration::from_millis(300));
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
        .setup(|app| {
            // Enable devtools for main window based on TAURI_OPEN_DEVTOOLS env var or debug mode
            // IMPORTANT: Release builds NEVER enable devtools, even if env var is set
            let should_open_main_devtools = {
                #[cfg(not(debug_assertions))]
                {
                    // Release builds: NEVER enable devtools (security)
                    false
                }
                #[cfg(debug_assertions)]
                {
                    // Debug builds: Check env var, then default to true
                    if let Ok(env_value) = std::env::var("TAURI_OPEN_DEVTOOLS") {
                        env_value == "true" || env_value == "1"
                    } else {
                        // Default to true in debug builds
                        true
                    }
                }
            };
            
            if should_open_main_devtools {
                use tauri::Manager;
                if let Some(window) = app.get_window("main") {
                    window.open_devtools();
                }
            }
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![create_app_window, open_devtools, proxy_http_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::validate_allowed_url;

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
        assert!(validate_allowed_url("http://localhost:8080/", Some("http://localhost:8080")).is_ok());
        assert!(validate_allowed_url("http://192.168.1.100:2528/", Some("http://192.168.1.100:2528")).is_ok());
        assert!(validate_allowed_url("http://node.example.com:2528/", Some("http://node.example.com:2528")).is_ok());
        // Should still reject wrong URLs even with configured node URL
        assert!(validate_allowed_url("http://localhost:2528/", Some("http://localhost:8080")).is_err());
    }

    #[test]
    fn test_reject_wrong_ports() {
        // Wrong ports for localhost
        assert!(validate_allowed_url("http://localhost:80/", None).is_err());
        assert!(validate_allowed_url("http://localhost:8080/", None).is_err());
        assert!(validate_allowed_url("http://127.0.0.1:80/", None).is_err());
        assert!(validate_allowed_url("http://127.0.0.1:8080/", None).is_err());
        
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
        assert!(validate_allowed_url("http://localhost", None).is_err()); // Missing port
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
}
