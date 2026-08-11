// Prevents an extra console window on Windows in release. macOS-only in practice.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Slim per-app shell: one webview, brokers refresh to the host over the Unix
// socket. NEVER owns merod. NEVER registers autostart. macOS only — on other
// platforms this is an inert stub so the binary still builds and can be bundled.

#[cfg(target_os = "macos")]
mod shell {
    use calimero_tauri_app::{
        ensure_host_running, host_socket_path, proxy, shell_config, shell_instance_socket_path,
        token_broker_ipc, webview,
    };
    use tauri::Manager;

    // Sentinel refresh token — the injected proxy script keys off this value to
    // broker `/auth/refresh` to the host instead of using a real refresh token.
    // MUST match BROKERED_REFRESH_TOKEN in src/lib/token-broker.ts + proxy_script.js.
    const BROKERED_REFRESH_TOKEN: &str = "calimero-desktop-brokered-refresh-token";

    /// macOS notification attribution fix.
    ///
    /// This shell process runs from a *loose* Mach-O binary
    /// (`~/Library/Application Support/network.calimero.desktop/shell/CalimeroShell`)
    /// that a per-app launcher `.app` `exec`s via a bash trampoline. Because the
    /// running executable has no `.app` wrapper (and no embedded Info.plist),
    /// `-[NSBundle mainBundle].bundleIdentifier` resolves to `nil`, and both
    /// `NSUserNotification` and `UNUserNotificationCenter` refuse to deliver a
    /// notification with no owning bundle — it silently drops.
    ///
    /// The launcher `.app` itself *is* LaunchServices-registered at
    /// `~/Applications/<Name>.app` with `CFBundleIdentifier =
    /// network.calimero.app.<id>`. So we swizzle `-[NSBundle bundleIdentifier]`
    /// on the main bundle to claim that registered id (the standard CLI-tool
    /// trick used by terminal-notifier / node-notifier). After this, macOS
    /// attributes the notification to the per-app launcher — NOT the host.
    #[cfg(target_os = "macos")]
    mod bundle_identity {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::runtime::{Class, Imp, Method, Object, Sel};
        use objc::{class, msg_send, sel, sel_impl};
        use std::sync::OnceLock;

        static OVERRIDE_ID: OnceLock<String> = OnceLock::new();

        // Replacement IMP for `-[NSBundle bundleIdentifier]`. Only overrides the
        // *main* bundle; every other NSBundle keeps its real identifier (which,
        // after the swizzle, is reachable under `calimeroOriginalBundleIdentifier`).
        extern "C" fn override_bundle_identifier(this: &Object, _cmd: Sel) -> id {
            unsafe {
                let main: id = msg_send![class!(NSBundle), mainBundle];
                let this_ptr = this as *const Object as id;
                if this_ptr == main {
                    if let Some(s) = OVERRIDE_ID.get() {
                        return NSString::alloc(nil).init_str(s);
                    }
                }
                msg_send![this, calimeroOriginalBundleIdentifier]
            }
        }

        /// Install the override. Idempotent-ish: only the first call wins (guarded
        /// by `OVERRIDE_ID`). Must run before the first notification is posted.
        pub fn install(bundle_id: &str) {
            if OVERRIDE_ID.set(bundle_id.to_string()).is_err() {
                return; // already installed
            }
            unsafe {
                let cls = class!(NSBundle);
                let cls_mut = cls as *const Class as *mut Class;
                let alias_sel = sel!(calimeroOriginalBundleIdentifier);
                let imp: Imp = std::mem::transmute(
                    override_bundle_identifier as extern "C" fn(&Object, Sel) -> id,
                );
                let types = b"@@:\0".as_ptr() as *const std::os::raw::c_char;
                // Register our IMP under an alias selector, then swap it with the
                // real `bundleIdentifier`. After the swap: `bundleIdentifier` runs
                // our IMP; `calimeroOriginalBundleIdentifier` runs the original.
                let added = objc::runtime::class_addMethod(cls_mut, alias_sel, imp, types);
                if added == objc::runtime::NO {
                    return;
                }
                let orig = objc::runtime::class_getInstanceMethod(cls, sel!(bundleIdentifier))
                    as *mut Method;
                let alias =
                    objc::runtime::class_getInstanceMethod(cls, alias_sel) as *mut Method;
                if orig.is_null() || alias.is_null() {
                    return;
                }
                objc::runtime::method_exchangeImplementations(orig, alias);
            }
        }
    }

    /// The shell's refresh broker: reads the managed `ShellConfig`, ensures the host
    /// is running, then relays a refresh over the Unix socket. Returns a fresh
    /// access token only — never a refresh token.
    #[tauri::command]
    async fn broker_token_refresh(app_handle: tauri::AppHandle) -> Result<String, String> {
        let cfg = app_handle.state::<shell_config::ShellConfig>();
        let sock = host_socket_path();
        ensure_host_running(&sock);
        token_broker_ipc::request_access_token(&sock, &cfg.cap, &cfg.id)
            .await
            .map_err(|e| e.to_string())
    }

    /// Set (or clear) this app's dock badge. `count <= 0` clears it. The badge
    /// shows on the per-app launcher's own dock icon (this shell process).
    #[tauri::command]
    fn set_badge(count: i64) {
        use cocoa::appkit::NSApp;
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            let app = NSApp();
            let dock_tile: id = msg_send![app, dockTile];
            let label: id = if count > 0 {
                NSString::alloc(nil).init_str(&count.to_string())
            } else {
                nil
            };
            let _: () = msg_send![dock_tile, setBadgeLabel: label];
        }
    }

    /// Post a native notification LOCALLY from this shell process. Because the
    /// shell runs inside the per-app `network.calimero.app.<id>` launcher bundle,
    /// macOS attributes the notification to that launcher (its icon + name) — which
    /// is what we want. (Do NOT forward to the host: that would attribute it to the
    /// host bundle `network.calimero.desktop` instead.)
    #[tauri::command]
    fn notify(title: String, body: String) {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};
        unsafe {
            let center: id =
                msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            if center == nil {
                return;
            }
            let notif: id = msg_send![class!(NSUserNotification), new];
            let t: id = NSString::alloc(nil).init_str(&title);
            let b: id = NSString::alloc(nil).init_str(&body);
            let _: () = msg_send![notif, setTitle: t];
            let _: () = msg_send![notif, setInformativeText: b];
            let _: () = msg_send![center, deliverNotification: notif];
        }
    }

    /// Build the app URL with the same SSO hash the desktop's "Open" injects, so
    /// the app starts authenticated + pointed at the node (node_url + a brokered
    /// access token + the brokered-refresh sentinel). Falls back to the raw URL
    /// (manual login) if no token can be brokered.
    fn build_app_url(cfg: &shell_config::ShellConfig, launch_params: Option<&str>) -> String {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);

        let sock = host_socket_path();
        let token = tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(6),
                token_broker_ipc::request_access_token(&sock, &cfg.cap, &cfg.id),
            )
            .await
            .ok()
            .and_then(|r| r.ok())
        });

        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        ser.append_pair("node_url", cfg.node_url.trim_end_matches('/'));
        if let Some(ref t) = token {
            ser.append_pair("access_token", t);
            ser.append_pair("refresh_token", BROKERED_REFRESH_TOKEN);
            ser.append_pair("expires_at", &(now_ms + 3_600_000).to_string());
        } else {
            eprintln!("[shell] no brokered token; app will need manual login");
        }
        ser.append_pair("app-id", &cfg.id);
        let hash = ser.finish();

        match url::Url::parse(&cfg.url) {
            Ok(mut u) => {
                for (k, v) in url::form_urlencoded::parse(launch_params.unwrap_or("").as_bytes()) {
                    u.query_pairs_mut().append_pair(&k, &v);
                }
                u.query_pairs_mut().append_pair("_cb", &now_ms.to_string());
                format!("{}#{}", u, hash)
            }
            Err(_) => format!("{}#{}", cfg.url, hash),
        }
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        let cfg = shell_config::parse_app_config_arg(&args)
            .and_then(|p| shell_config::load_shell_config(&p))
            .expect("calimero-shell requires --app-config <app.json>");
        let launch_params = shell_config::parse_url_params_arg(&args);

        // Claim the per-app launcher's registered bundle id BEFORE any notify, so
        // macOS attributes native notifications to the launcher `.app` (its icon +
        // name) and not to nil/host. Mirrors `CFBundleIdentifier` in launcher.rs.
        #[cfg(target_os = "macos")]
        bundle_identity::install(&format!("network.calimero.app.{}", cfg.id));

        // Per-app single instance keyed by app id, so different apps coexist.
        // The connection itself is the "show yourself" signal; a stale socket
        // from a dead instance refuses the probe and is replaced.
        let instance_sock = shell_instance_socket_path(&cfg.id);
        if std::os::unix::net::UnixStream::connect(&instance_sock).is_ok() {
            return; // this app is already open - it now has focus
        }
        let _ = std::fs::remove_file(&instance_sock);
        let listener = std::os::unix::net::UnixListener::bind(&instance_sock)
            .expect("calimero-shell could not bind its instance socket");

        let cfg_for_setup = cfg.clone();
        tauri::Builder::default()
            .manage(cfg)
            .manage(proxy::SseCancelRegistry::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )))
            .setup(move |app| {
                // A relaunch of this app connects here; show the existing window.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for _conn in listener.incoming().flatten() {
                        if let Some(w) = handle.get_webview_window("app") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });

                ensure_host_running(&host_socket_path());
                // Inject SSO (node_url + brokered token) like the desktop's "Open".
                let url = build_app_url(&cfg_for_setup, launch_params.as_deref());
                webview::open_app_webview(
                    app.handle(),
                    "app",
                    &url,
                    &cfg_for_setup.name,
                    &cfg_for_setup.node_url,
                )
                .map_err(std::io::Error::other)?;
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                broker_token_refresh,
                set_badge,
                notify,
                proxy::proxy_http_request,
                proxy::proxy_sse_stream,
                proxy::cancel_sse_stream
            ])
            .run(tauri::generate_context!())
            .expect("error while running calimero-shell");
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    shell::run();
}
