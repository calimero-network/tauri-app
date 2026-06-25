//! WebRTC media-capture enablement for app windows.
//!
//! Apps like **Mero Meet** do video calls inside their WebviewWindow using the
//! standard `getUserMedia()` / `RTCPeerConnection` web APIs. On macOS the
//! embedded `WKWebView` denies camera/microphone access by default unless its
//! `WKUIDelegate` implements
//! `webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:`
//! and grants the request. (It also needs the NSCamera/NSMicrophone usage
//! strings in Info.plist and the camera/audio-input entitlements — see those
//! files.)
//!
//! This module installs a tiny delegate that auto-grants capture for our own
//! app windows. The OS still gates the *first* access behind the system
//! camera/mic permission prompt, so the user remains in control at the OS level.
//!
//! On non-macOS platforms WKWebView isn't used and `getUserMedia` works without
//! a delegate, so `grant_media_permissions` is a no-op.

/// Best-effort: allow the window's webview to use camera/microphone. Never
/// fails the caller — logs and continues if the platform hooks are unavailable.
pub fn grant_media_permissions(window: &tauri::Window) {
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = macos::install_media_delegate(window) {
            log::warn!("[webrtc] could not enable webview media capture: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::Once;

    use block::Block;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};

    type Id = *mut Object;

    // WKPermissionDecision: prompt = 0, grant = 1, deny = 2.
    const WK_PERMISSION_GRANT: isize = 1;

    const DELEGATE_CLASS: &str = "CalimeroMediaCaptureDelegate";
    static REGISTER: Once = Once::new();

    /// The delegate method. Always grants — our windows only load our own apps,
    /// and the OS-level camera/mic prompt still applies on first use.
    extern "C" fn request_media_capture(
        _this: &Object,
        _cmd: Sel,
        _webview: Id,
        _origin: Id,
        _frame: Id,
        _capture_type: isize,
        decision_handler: Id,
    ) {
        unsafe {
            if decision_handler.is_null() {
                return;
            }
            // `decisionHandler` is an Objective-C block `void(^)(WKPermissionDecision)`.
            let block = &*(decision_handler as *const Block<(isize,), ()>);
            block.call((WK_PERMISSION_GRANT,));
        }
    }

    fn register_delegate_class() {
        REGISTER.call_once(|| {
            let superclass = class!(NSObject);
            let mut decl = ClassDecl::new(DELEGATE_CLASS, superclass)
                .expect("CalimeroMediaCaptureDelegate already registered");
            unsafe {
                decl.add_method(
                    sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:),
                    request_media_capture
                        as extern "C" fn(&Object, Sel, Id, Id, Id, isize, Id),
                );
            }
            decl.register();
        });
    }

    pub fn install_media_delegate(window: &tauri::Window) -> Result<(), String> {
        register_delegate_class();

        window
            .with_webview(|platform_webview| unsafe {
                // `inner()` is the WKWebView. Erase the concrete `id` type
                // through a raw pointer so we don't couple to tauri's cocoa
                // version.
                let webview = platform_webview.inner() as *mut std::ffi::c_void as Id;
                if webview.is_null() {
                    return;
                }
                let cls = match Class::get(DELEGATE_CLASS) {
                    Some(c) => c,
                    None => return,
                };
                // Create a delegate and intentionally keep it alive for the
                // lifetime of the window (one small leak per app window).
                let delegate: Id = msg_send![cls, new];
                let _: () = msg_send![webview, setUIDelegate: delegate];
            })
            .map_err(|e| e.to_string())
    }
}
