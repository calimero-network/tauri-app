// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri::{CustomMenuItem, SystemTray, SystemTrayEvent, SystemTrayMenu};
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
            // Safely truncate to first 20 characters (UTF-8 safe)
            let preview: String = auth_header.chars().take(20).collect();
            debug!("[Tauri Proxy] Authorization header present: {}...", preview);
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
            // Log header being added (truncate value for security, UTF-8 safe)
            let value_preview = if value.len() > 50 {
                let preview: String = value.chars().take(50).collect();
                format!("{}...", preview)
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
        // Wait a bit before retrying (use async sleep to avoid blocking runtime)
        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
    }
}

// Merod process management using bundled resource
use std::sync::{Arc, Mutex};
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug, Clone)]
struct MerodProcess {
    pid: u32,
    port: u16,
}

type MerodState = Arc<Mutex<Option<MerodProcess>>>;

/// Get the path to the bundled merod binary
fn get_merod_binary_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // Access the bundled resource
    let resource_path = app_handle
        .path_resolver()
        .resolve_resource("merod/merod")
        .ok_or("Failed to resolve merod resource")?;
    
    if !resource_path.exists() {
        return Err(format!("Merod resource not found at {:?}", resource_path));
    }
    
    Ok(resource_path)
}

/// Get the app data directory for storing merod data
fn get_app_data_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app_handle
        .path_resolver()
        .app_data_dir()
        .ok_or("Failed to get app data directory")?;
    
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
    app_handle: tauri::AppHandle,
    merod_state: tauri::State<'_, MerodState>,
) -> Result<String, String> {
    let server_port = server_port.unwrap_or(2528);
    let swarm_port = swarm_port.unwrap_or(2428);
    
    // If already running, stop it first before starting a new one
    let existing_pid = {
        let state = merod_state.lock().unwrap();
        state.as_ref().map(|proc| proc.pid)
    };
    
    if let Some(pid) = existing_pid {
        // Stop the existing process
        info!("[Merod] Stopping existing process (PID: {}) before starting new one", pid);
        #[cfg(unix)]
        {
            use std::process::Command;
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .output();
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            let _ = Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .output();
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
        // Clear state
        let mut state = merod_state.lock().unwrap();
        *state = None;
    }
    
    // Get bundled merod binary
    let merod_binary = get_merod_binary_path(&app_handle)?;
    
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
            .ok_or("Failed to get home directory")?
            .join(".calimero")
    };
    
    std::fs::create_dir_all(&home_dir_path)
        .map_err(|e| format!("Failed to create home directory: {}", e))?;
    
    // Update config.toml with the specified ports if node_name is provided
    if let Some(name) = &node_name {
        let node_dir = home_dir_path.join(name);
        let config_path = node_dir.join("config.toml");
        
        if config_path.exists() {
            // Read existing config
            let config_content = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("Failed to read config.toml: {}", e))?;
            
            let mut config: toml::Value = config_content.parse()
                .map_err(|e| format!("Failed to parse config.toml: {}", e))?;
            
            // Update server.listen ports and ensure auth_mode is embedded
            if let Some(server) = config.get_mut("server") {
                // Set auth_mode to embedded so the node provides auth endpoints
                if let Some(server_table) = server.as_table_mut() {
                    server_table.insert("auth_mode".to_string(), toml::Value::String("embedded".to_string()));
                }
                
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
            let updated_config = toml::to_string_pretty(&config)
                .map_err(|e| format!("Failed to serialize config.toml: {}", e))?;
            std::fs::write(&config_path, updated_config)
                .map_err(|e| format!("Failed to write config.toml: {}", e))?;
            
            info!("[Merod] Updated config.toml with server_port={} and swarm_port={}", server_port, swarm_port);
        }
    }
    
    // Node name required
    let node_name_str = node_name.as_ref().ok_or("Node name is required")?.clone();

    // Create logs directory and open log file - redirect merod stdout/stderr here
    let log_dir = home_dir_path.join(&node_name_str).join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;
    let log_path = log_dir.join("merod.log");

    // Open log file for append - use separate handles for stdout and stderr
    let log_file_stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log file: {}", e))?;
    let log_file_stderr = log_file_stdout
        .try_clone()
        .or_else(|_| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
        })
        .map_err(|e| format!("Failed to open log file for stderr: {}", e))?;

    // Build command - global options come BEFORE subcommand
    // Merod expects: merod --home ~/.calimero --node-name node1 run
    let mut cmd = Command::new(&merod_binary);
    // Force ANSI colors in output so the log viewer can display them
    cmd.env("CLICOLOR_FORCE", "1");
    cmd.env("FORCE_COLOR", "1");
    
    // Set home directory (global option, before subcommand)
    cmd.arg("--home").arg(&home_dir_path);
    
    // Set node name (global option, before subcommand)
    cmd.arg("--node-name").arg(&node_name_str);
    
    // Add 'run' subcommand last
    cmd.arg("run");
    
    // Redirect stdout/stderr to log file - merod output goes directly to disk
    cmd.stdout(Stdio::from(log_file_stdout));
    cmd.stderr(Stdio::from(log_file_stderr));
    cmd.stdin(Stdio::null());
    
    // Log the command being run
    let cmd_str = format!("{:?}", cmd);
    info!("[Merod] Running command: {}, logs at {:?}", cmd_str, log_path);
    
    // Start the process
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start merod: {}", e))?;
    
    let pid = child.id().unwrap();
    info!("[Merod] Started with PID: {}", pid);
    
    // Wait a brief moment to check if process is still alive
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    
    // Check if process already exited
    if let Ok(Some(status)) = child.try_wait() {
        if let Some(code) = status.code() {
            let error_msg = format!("Merod process exited immediately with code: {}. Check merod logs for details.", code);
            warn!("[Merod] {}", error_msg);
            return Err(error_msg);
        }
    }
    
    // Store process state
    {
        let mut state = merod_state.lock().unwrap();
        *state = Some(MerodProcess { pid, port: server_port });
    }
    
    // Spawn a task to monitor the process
    let merod_state_clone = merod_state.inner().clone();
    let monitored_pid = pid; // Capture PID for verification
    tokio::spawn(async move {
        let status = child.wait().await;
        let mut state = merod_state_clone.lock().unwrap();
        // Only clear state if the PID matches (prevent race condition)
        if let Some(proc) = state.as_ref() {
            if proc.pid == monitored_pid {
                if let Ok(exit_status) = status {
                    if let Some(code) = exit_status.code() {
                        warn!("[Merod] Process exited with code: {}", code);
                    }
                }
                *state = None;
            }
        }
    });
    
    Ok(format!("Merod started successfully with PID: {}", pid))
}

#[tauri::command]
async fn stop_merod(merod_state: tauri::State<'_, MerodState>) -> Result<String, String> {
    let pid = {
        let state = merod_state.lock().unwrap();
        match state.as_ref() {
            Some(proc) => proc.pid,
            None => return Err("Merod is not running".to_string()),
        }
    };
    
    // Use the same logic as stop_merod_by_pid_command
    #[cfg(unix)]
    {
        use std::process::Command;
        
        // Check if process exists first
        let check_output = Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .output();
        
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
            let check_output = Command::new("ps")
                .arg("-p")
                .arg(pid.to_string())
                .output();
            
            let still_running = if let Ok(output) = &check_output {
                output.status.success()
            } else {
                false
            };
            
            if still_running {
                // Force kill if still running (SIGKILL)
                let output = Command::new("kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .output();
                
                if let Ok(output) = output {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // If process doesn't exist, that's fine - it's already stopped
                        if !stderr.contains("No such process") {
                            return Err(format!("Failed to stop merod process: {}", stderr));
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
                    return Err(format!("Failed to stop merod process: {}", stderr));
                }
            }
        }
    }
    
    // Clear state
    {
        let mut state = merod_state.lock().unwrap();
        *state = None;
    }
    
    info!("[Merod] Stopped process with PID: {}", pid);
    Ok("Merod stopped successfully".to_string())
}

#[tauri::command]
async fn stop_merod_by_pid_command(pid: u32, merod_state: tauri::State<'_, MerodState>) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::process::Command;
        
        // Check if process exists first
        let check_output = Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .output();
        
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
            let check_output = Command::new("ps")
                .arg("-p")
                .arg(pid.to_string())
                .output();
            
            let still_running = if let Ok(output) = &check_output {
                output.status.success()
            } else {
                false
            };
            
            if still_running {
                // Force kill if still running (SIGKILL)
                let output = Command::new("kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .output();
                
                if let Ok(output) = output {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // If process doesn't exist, that's fine - it's already stopped
                        if !stderr.contains("No such process") {
                            return Err(format!("Failed to stop merod process: {}", stderr));
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
                    return Err(format!("Failed to stop merod process: {}", stderr));
                }
            }
        }
    }
    
    // Clear state if this was the tracked process
    {
        let mut state = merod_state.lock().unwrap();
        if let Some(proc) = state.as_ref() {
            if proc.pid == pid {
                *state = None;
            }
        }
    }
    
    info!("[Merod] Stopped process with PID: {}", pid);
    Ok(format!("Merod stopped successfully (PID: {})", pid))
}

#[tauri::command]
async fn get_merod_status(merod_state: tauri::State<'_, MerodState>) -> Result<serde_json::Value, String> {
    let state = merod_state.lock().unwrap();
    match state.as_ref() {
        Some(proc) => {
            // Check if process is still running
            #[cfg(unix)]
            {
                use std::process::Command;
                let output = Command::new("kill")
                    .arg("-0")
                    .arg(proc.pid.to_string())
                    .output();
                
                let running = output.is_ok() && output.unwrap().status.success();
                
                if !running {
                    // Process died, clear state
                    drop(state);
                    let mut state = merod_state.lock().unwrap();
                    *state = None;
                    return Ok(serde_json::json!({
                        "running": false
                    }));
                }
            }
            
            #[cfg(windows)]
            {
                use std::process::Command;
                let output = Command::new("tasklist")
                    .arg("/FI")
                    .arg(format!("PID eq {}", proc.pid))
                    .output();
                
                // tasklist returns exit code 0 even when no process exists
                // We need to check the output string instead
                let running = if let Ok(output) = output {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    // If the process exists, stdout will contain the PID in a table row
                    // If not, it will say "No tasks are running which match the specified criteria"
                    // Check that we don't have the "no tasks" message AND that PID appears in output
                    !stdout.contains("No tasks are running") && 
                    stdout.contains(&proc.pid.to_string())
                } else {
                    false
                };
                
                if !running {
                    drop(state);
                    let mut state = merod_state.lock().unwrap();
                    *state = None;
                    return Ok(serde_json::json!({
                        "running": false
                    }));
                }
            }
            
            Ok(serde_json::json!({
                "running": true,
                "pid": proc.pid,
                "port": proc.port
            }))
        }
        None => Ok(serde_json::json!({
            "running": false
        })),
    }
}

#[tauri::command]
async fn list_merod_nodes(home_dir: Option<String>) -> Result<Vec<String>, String> {
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
            .ok_or("Failed to get home directory")?
            .join(".calimero")
    };
    
    if !calimero_home.exists() {
        return Ok(vec![]);
    }
    
    let entries = std::fs::read_dir(&calimero_home)
        .map_err(|e| format!("Failed to read calimero directory: {}", e))?;
    
    let mut nodes = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("Failed to get file type: {}", e))?;
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
                                debug!("[Merod] Skipping node '{}': invalid TOML in config.toml", name);
                            }
                        } else {
                            debug!("[Merod] Skipping node '{}': failed to read config.toml", name);
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
async fn check_merod_health(node_url: String) -> Result<serde_json::Value, String> {
    let health_url = format!("{}/health", node_url.trim_end_matches('/'));
    
    info!("[Merod] Checking health at: {}", health_url);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
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
        Err(e) => {
            Ok(serde_json::json!({
                "status": 0,
                "healthy": false,
                "body": format!("Request failed: {}", e)
            }))
        }
    }
}

#[tauri::command]
async fn init_merod_node(
    node_name: String,
    home_dir: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // Get bundled merod binary
    let merod_binary = get_merod_binary_path(&app_handle)?;
    
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
            .ok_or("Failed to get home directory")?
            .join(".calimero")
    };
    
    std::fs::create_dir_all(&home_dir_path)
        .map_err(|e| format!("Failed to create home directory: {}", e))?;
    
    // Run merod init command - global options come BEFORE subcommand
    let mut cmd = Command::new(&merod_binary);
    cmd.arg("--home").arg(&home_dir_path);
    cmd.arg("--node-name").arg(&node_name);
    cmd.arg("init");
    
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    
    // Add timeout to prevent hanging (30 seconds should be enough for init)
    let output = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        cmd.output()
    )
        .await
    .map_err(|_| "Merod init command timed out after 30 seconds. Please check if the merod binary is working correctly.")?
        .map_err(|e| format!("Failed to execute merod init: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Merod init failed: {}", stderr));
    }
    
    // Update config.toml to use embedded auth mode
    let node_dir = home_dir_path.join(&node_name);
    let config_path = node_dir.join("config.toml");
    
    if config_path.exists() {
        // Read existing config
        let config_content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.toml: {}", e))?;
        
        let mut config: toml::Value = config_content.parse()
            .map_err(|e| format!("Failed to parse config.toml: {}", e))?;
        
        // Set auth_mode to "embedded" so the node provides auth endpoints
        if let Some(server) = config.get_mut("server") {
            if let Some(server_table) = server.as_table_mut() {
                server_table.insert("auth_mode".to_string(), toml::Value::String("embedded".to_string()));
            }
        }
        
        // Write updated config back
        let updated_config = toml::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config.toml: {}", e))?;
        std::fs::write(&config_path, updated_config)
            .map_err(|e| format!("Failed to write config.toml: {}", e))?;
        
        info!("[Merod] Updated config.toml to use embedded auth mode");
    }
    
    info!("[Merod] Initialized node '{}' in {:?}", node_name, home_dir_path);
    Ok(format!("Node '{}' initialized successfully", node_name))
}

#[tauri::command]
async fn detect_running_merod_nodes() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(unix)]
    {
        use std::process::Command;
        
        // Use ps to find merod processes
        let output = Command::new("ps")
            .arg("ax")
            .arg("-o")
            .arg("pid,command")
            .output()
            .map_err(|e| format!("Failed to run ps: {}", e))?;
        
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
                            if part == &"--node-name" && i + 1 < parts.len() {
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
                            let config_path = std::path::PathBuf::from(home).join(name).join("config.toml");
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
                                                            if let Some(tcp_pos) = addr.find("/tcp/") {
                                                                let port_str = &addr[tcp_pos + 5..];
                                                                if let Some(slash_pos) = port_str.find('/') {
                                                                    if let Ok(p) = port_str[..slash_pos].parse::<u16>() {
                                                                        server_port = p;
                                                                        break;
                                                                    }
                                                                } else if let Ok(p) = port_str.parse::<u16>() {
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
                                                            if let Some(tcp_pos) = addr.find("/tcp/") {
                                                                let port_str = &addr[tcp_pos + 5..];
                                                                if let Some(slash_pos) = port_str.find('/') {
                                                                    if let Ok(p) = port_str[..slash_pos].parse::<u16>() {
                                                                        swarm_port = p;
                                                                        break;
                                                                    }
                                                                } else if let Ok(p) = port_str.parse::<u16>() {
                                                                    swarm_port = p;
                                                                    break;
                                                                }
                                                            } else if let Some(udp_pos) = addr.find("/udp/") {
                                                                let port_str = &addr[udp_pos + 5..];
                                                                if let Some(slash_pos) = port_str.find('/') {
                                                                    if let Ok(p) = port_str[..slash_pos].parse::<u16>() {
                                                                        swarm_port = p;
                                                                        break;
                                                                    }
                                                                } else if let Ok(p) = port_str.parse::<u16>() {
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
            .map_err(|e| format!("Failed to run tasklist: {}", e))?;
        
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
                                if part == &"--node-name" && i + 1 < cmd_parts.len() {
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

/// Read merod logs for a node. Logs are only available for nodes started by the app.
#[tauri::command]
async fn get_merod_logs(
    node_name: String,
    home_dir: Option<String>,
    lines: Option<u32>,
) -> Result<String, String> {
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
            .ok_or("Failed to get home directory")?
            .join(".calimero")
    };
    
    let log_path = home_dir_path.join(&node_name).join("logs").join("merod.log");
    
    if !log_path.exists() {
        return Err(format!(
            "No log file found for node '{}'. Logs are only available for nodes started by the app.",
            node_name
        ));
    }
    
    let content = tokio::fs::read_to_string(&log_path)
        .await
        .map_err(|e| format!("Failed to read log file: {}", e))?;
    
    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(lines as usize);
    let last_lines = &all_lines[start..];
    
    Ok(last_lines.join("\n"))
}

#[tauri::command]
async fn set_tray_icon_connected(connected: bool, app_handle: tauri::AppHandle) -> Result<(), String> {
    let icon_bytes: Vec<u8> = if connected {
        include_bytes!("../icons/tray-icon-connected.png").to_vec()
    } else {
        include_bytes!("../icons/tray-icon.png").to_vec()
    };
    app_handle
        .tray_handle()
        .set_icon(tauri::Icon::Raw(icon_bytes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_directory(default_path: Option<String>) -> Result<Option<String>, String> {
    use tauri::api::dialog::blocking::FileDialogBuilder;
    
    let mut dialog = FileDialogBuilder::new();
    
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
    
    let result = dialog.pick_folder();
    
    match result {
        Some(path) => Ok(Some(path.to_string_lossy().to_string())),
        None => Ok(None),
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

    // System tray with context menu
    let show = CustomMenuItem::new("show".to_string(), "Show Calimero");
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(quit);
    let system_tray = SystemTray::new().with_menu(tray_menu);
    
    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| {
            match event {
                SystemTrayEvent::LeftClick { .. } => {
                    if let Some(window) = app.get_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        "show" => {
                            if let Some(window) = app.get_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                // Only minimize to tray for main window; close child windows normally
                if event.window().label() == "main" {
                    event.window().hide().unwrap();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            #[cfg(feature = "autostart")]
            {
                let _ = app.handle().plugin(
                    tauri_plugin_autostart::init(
                        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                        None,
                    ),
                );
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
            
            if should_open_main_devtools {
                use tauri::Manager;
                if let Some(window) = app.get_window("main") {
                    window.open_devtools();
                }
            }
            
            Ok(())
        })
        .manage(MerodState::default())
        .invoke_handler(tauri::generate_handler![
            create_app_window,
            open_devtools,
            proxy_http_request,
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
            set_tray_icon_connected
        ])
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
