//! Shared app-webview builder: creates a window pointed at an external app URL and
//! injects the node-proxy script so the page can reach the Tauri proxy commands.
//! Used by the `calimero-shell` binary (the host builds its app windows inline via
//! its own `create_app_window` command). A remote page reaches the proxy commands
//! only through the capability granting them, in each binary's `capabilities/`.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Open a webview window for an external app URL. Injects the proxy script (with
/// `node_url` baked in) before the page loads, then shows and focuses the window.
pub fn open_app_webview(
    app_handle: &AppHandle,
    window_label: &str,
    url: &str,
    title: &str,
    node_url: &str,
) -> Result<(), String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;

    // Inject fetch interceptor to proxy node requests through Tauri.
    // CRITICAL: Intercept IMMEDIATELY before the app makes any fetch calls.
    let mut proxy_script = include_str!("proxy_script.js").to_string();
    proxy_script = proxy_script.replace("__CONFIGURED_NODE_URL__", node_url);

    // If a window with this label already exists (e.g. single-instance relaunch),
    // just focus it rather than failing on a duplicate-label build.
    if let Some(existing) = app_handle.get_webview_window(window_label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app_handle,
        window_label,
        WebviewUrl::External(parsed.clone()),
    )
    .title(title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .center()
    .initialization_script(&proxy_script)
    .build()
    .map_err(|e| format!("Failed to create window '{}' for URL '{}': {}", title, url, e))?;

    // No custom WKUIDelegate: wry's own already grants WebRTC capture on macOS, and
    // replacing it would break its `<input type=file>` open-panel handler.
    window
        .show()
        .map_err(|e| format!("Failed to display window '{}': {}", title, e))?;
    let _ = window.set_focus();

    log::info!("[Tauri] Opened app webview '{}' -> {}", window_label, url);
    Ok(())
}
