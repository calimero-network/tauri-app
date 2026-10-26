//! Shared app-webview builder: creates a window pointed at an external app URL and
//! injects the node-proxy script so the page can reach the Tauri proxy commands.
//! Used by the `calimero-shell` binary (the host builds its app windows inline via
//! its own `create_app_window` command).
//!
//! Tauri v2 note: remote-URL IPC access is granted statically via the capabilities
//! system (see each binary's `capabilities/*.json`), not the v1 runtime
//! `RemoteDomainAccessScope`/`ipc_scope().configure_remote_access()` API, which no
//! longer exists. IP-hosted pages (127.0.0.1) still fall back to native fetch via
//! the injected proxy script.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, Runtime, Webview, WebviewUrl, WebviewWindowBuilder};

/// Where each app webview's in-flight download is going, by webview label.
/// macOS reports no path when a download finishes, so the one chosen at
/// `Requested` is kept until then.
static DOWNLOAD_DESTINATIONS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

/// Download hook for app windows: lets every download proceed to its default
/// place (~/Downloads, uniquely named), then tells the page how it went with a
/// `calimero-download` DOM event — `detail: { success, path }`.
///
/// Without it the page cannot know: the write happens outside the webview, so
/// an app said "saved" even when it failed, e.g. after the user answered
/// macOS's "access files in your Downloads folder?" with Don't Allow (macOS
/// asks once; afterwards every save fails silently until it is re-enabled in
/// System Settings). The proxy script sets `__CALIMERO_DOWNLOAD_EVENTS__` so
/// a page knows this event will come.
pub fn report_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    let label = webview.label().to_string();
    match event {
        DownloadEvent::Requested { destination, .. } => {
            if let Ok(mut map) = DOWNLOAD_DESTINATIONS.lock() {
                map.get_or_insert_with(HashMap::new).insert(label, destination.clone());
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            let remembered = DOWNLOAD_DESTINATIONS
                .lock()
                .ok()
                .and_then(|mut map| map.as_mut().and_then(|m| m.remove(&label)));
            let path = path.or(remembered).map(|p| p.display().to_string());
            if !success {
                log::warn!("[Tauri] Download in '{}' failed (destination {:?})", label, path);
            }
            let detail = serde_json::json!({ "success": success, "path": path });
            let _ = webview.eval(format!(
                "window.dispatchEvent(new CustomEvent('calimero-download', {{ detail: {detail} }}));"
            ));
        }
        _ => {}
    }
    true
}

/// Parses an app frontend URL and refuses any that may not hold a node session.
///
/// Every app window is opened with the node's access token in its URL fragment
/// and gets the proxy/broker IPC, so the frontend has to be a real web origin
/// the user can trust: HTTPS, or plain HTTP on this machine's loopback (a
/// locally served dev frontend). `http://` to anywhere else would send the token
/// over the network in the clear, and `file:`, `data:`, `javascript:` or a custom
/// scheme is never a legitimate app frontend.
pub fn validate_app_frontend_url(url: &str) -> Result<url::Url, String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    let loopback = matches!(parsed.host(), Some(url::Host::Domain("localhost")))
        || matches!(parsed.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(parsed.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    match parsed.scheme() {
        crate::app_scheme::SCHEME if crate::app_scheme::label_from_url(&parsed).is_some() => {
            Ok(parsed)
        }
        "https" if parsed.host().is_some() => Ok(parsed),
        "http" if loopback => Ok(parsed),
        _ => Err(format!(
            "Refusing to open '{}': app frontends must be served over HTTPS (or HTTP on localhost)",
            url
        )),
    }
}

/// How long opening an app waits to learn where its frontend redirects.
const LANDING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Where `requested` lands once its server's redirects are followed.
///
/// An app window serves the proxy and broker only while it shows the origin it
/// was bound to (`app_window.rs`). A frontend whose server redirects to another
/// origin - `https://hyperfeed.me` answers 308 to `https://www.hyperfeed.me/` -
/// would leave the page on an origin the window was never bound to, and every
/// node request from it would be refused. So the window is bound to, and
/// opened at, the URL the redirects end on: the same page the webview would
/// have landed on anyway, chosen by the app's own server, never by the page.
///
/// The landing URL has to pass `validate_app_frontend_url` too, and it keeps
/// `requested`'s fragment, which carries the session and never reaches the
/// server. Any failure (offline, timeout, too many hops) opens `requested`.
pub async fn resolve_frontend_landing(requested: &url::Url) -> url::Url {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    let Some(client) = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(LANDING_TIMEOUT)
            .build()
            .ok()
    }) else {
        return requested.clone();
    };
    let mut probe = requested.clone();
    probe.set_fragment(None);
    match client.head(probe).send().await {
        Ok(response) => landing_url(requested, response.url()),
        Err(e) => {
            log::warn!("[Tauri] Could not resolve where {requested} lands: {e}");
            requested.clone()
        }
    }
}

/// `landed` with `requested`'s fragment, or `requested` when `landed` may not
/// hold a node session.
fn landing_url(requested: &url::Url, landed: &url::Url) -> url::Url {
    let Ok(mut landed) = validate_app_frontend_url(landed.as_str()) else {
        log::warn!("[Tauri] {requested} redirects to {landed}, which is no app frontend");
        return requested.clone();
    };
    landed.set_fragment(requested.fragment());
    if landed.origin() != requested.origin() {
        log::info!(
            "[Tauri] {} redirects to {}; the window is bound there",
            requested.origin().ascii_serialization(),
            landed.origin().ascii_serialization()
        );
    }
    landed
}

/// Where a per-app launcher opens its app: the frontend the desktop says the
/// app is installed at now, else the URL baked into the launcher when it was
/// built. A launcher started from the Dock or Finder would otherwise keep
/// opening an app at the domain it has moved away from, where the node's
/// sign-in page refuses the login callback. The desktop's answer must pass
/// the same check as the baked URL, or the baked URL stands.
pub fn launcher_frontend_url<'a>(baked: &'a str, current: Option<&'a str>) -> &'a str {
    current
        .filter(|u| validate_app_frontend_url(u).is_ok())
        .unwrap_or(baked)
}

/// Open a webview window for an external app URL. Injects the proxy script (with
/// `node_url` baked in) before the page loads, then shows and focuses the window.
pub fn open_app_webview(
    app_handle: &AppHandle,
    window_label: &str,
    url: &str,
    title: &str,
    node_url: &str,
) -> Result<(), String> {
    let parsed = validate_app_frontend_url(url)?;

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
    .on_download(report_download)
    .build()
    .map_err(|e| {
        format!(
            "Failed to create window '{}' for URL '{}': {}",
            title, url, e
        )
    })?;

    // Camera/microphone for WebRTC (e.g. Mero Meet) needs no extra work here: wry's
    // own WKUIDelegate grants requestMediaCapturePermissionForOrigin on macOS.
    // Installing a custom delegate would replace wry's, breaking its
    // `<input type=file>` open-panel handler.

    window
        .show()
        .map_err(|e| format!("Failed to display window '{}': {}", title, e))?;
    let _ = window.set_focus();

    log::info!("[Tauri] Opened app webview '{}' -> {}", window_label, url);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        landing_url, launcher_frontend_url, resolve_frontend_landing, validate_app_frontend_url,
    };

    #[test]
    fn launcher_opens_where_the_app_is_installed_now() {
        let baked = "https://mero-chat-pwa.vercel.app/";
        assert_eq!(
            launcher_frontend_url(baked, Some("https://chat.hyperfeed.me/")),
            "https://chat.hyperfeed.me/"
        );
        assert_eq!(launcher_frontend_url(baked, None), baked);
        for refused in ["http://evil.example/", "javascript:alert(1)", "not a url"] {
            assert_eq!(
                launcher_frontend_url(baked, Some(refused)),
                baked,
                "{refused}"
            );
        }
    }

    #[test]
    fn landing_keeps_the_session_fragment_and_refuses_non_frontends() {
        let requested: url::Url = "https://hyperfeed.me/?_cb=1#access_token=x&node_url=y"
            .parse()
            .unwrap();
        let landed = landing_url(
            &requested,
            &"https://www.hyperfeed.me/?_cb=1".parse().unwrap(),
        );
        assert_eq!(
            landed.as_str(),
            "https://www.hyperfeed.me/?_cb=1#access_token=x&node_url=y"
        );
        for refused in ["http://evil.example/", "data:text/html,x"] {
            assert_eq!(
                landing_url(&requested, &refused.parse().unwrap()),
                requested
            );
        }
    }

    /// Serves one request on `listener` with `response`.
    async fn answer_once(listener: tokio::net::TcpListener, response: String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = sock.read(&mut buf).await;
        sock.write_all(response.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn resolves_a_frontend_that_redirects_to_another_origin() {
        // 127.0.0.1 and localhost are different origins, as apex and www are.
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let landing = format!(
            "http://localhost:{}/app/",
            target.local_addr().unwrap().port()
        );
        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let requested: url::Url = format!(
            "http://127.0.0.1:{}/app/?_cb=1#access_token=x",
            source.local_addr().unwrap().port()
        )
        .parse()
        .unwrap();
        tokio::spawn(answer_once(
            source,
            format!("HTTP/1.1 308 Permanent Redirect\r\nLocation: {landing}?_cb=1\r\nContent-Length: 0\r\n\r\n"),
        ));
        tokio::spawn(answer_once(
            target,
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_string(),
        ));

        let landed = resolve_frontend_landing(&requested).await;
        assert_eq!(landed.as_str(), format!("{landing}?_cb=1#access_token=x"));
    }

    #[tokio::test]
    async fn an_unreachable_frontend_opens_where_it_was_asked() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let requested: url::Url = format!("http://127.0.0.1:{port}/#access_token=x")
            .parse()
            .unwrap();
        assert_eq!(resolve_frontend_landing(&requested).await, requested);
    }

    #[test]
    fn accepts_https_and_loopback_http() {
        for url in [
            "https://drive.calimero.network/",
            "https://my-app.vercel.app/?invitation=x#frag",
            "http://localhost:5173/",
            "http://127.0.0.1:3000/",
            "http://[::1]:3000/",
            "calimero-app://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq/#access_token=x",
        ] {
            assert!(validate_app_frontend_url(url).is_ok(), "should allow {url}");
        }
    }

    #[test]
    fn refuses_everything_that_is_not_a_trusted_web_origin() {
        for url in [
            "http://evil.example/",
            "http://192.168.1.10:3000/",
            "http://localhost.evil.example/",
            "file:///Applications/Calculator.app",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "calimero://com.evil.app/join",
            "ftp://localhost/",
            "calimero-app://short/",
            "calimero-app://AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ/",
            "calimero-app:///",
            "not a url",
        ] {
            assert!(
                validate_app_frontend_url(url).is_err(),
                "should refuse {url}"
            );
        }
    }
}
