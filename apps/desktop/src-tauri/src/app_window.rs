//! Which origin and node each app window was opened for.
//!
//! The app-window capability admits any `https://*` page to the proxy and token
//! broker commands, because marketplace apps live on assorted origins. That grant
//! follows the window, not the app: once an app window navigates - a link the
//! user follows, a redirect, an XSS in the app - the page it lands on inherits
//! the same IPC and can mint the node's access token on demand.
//!
//! So each app window is bound, before its first page loads, to the origin of
//! the frontend it was opened for and to the node it targets. The privileged
//! commands serve a window only while its current page is still on that origin,
//! and proxy only to that node. Navigation itself stays allowed (wry's navigation
//! handler also sees iframes, so blocking it would break embedded content); a
//! page that is not the app just gets no session.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{Manager, Runtime};

use crate::LockUnpoisoned;

/// What one app window was opened for.
#[derive(Clone, Debug)]
pub struct AppWindowBinding {
    origin: url::Origin,
    /// The only node this window's proxy requests may reach.
    pub node_url: String,
    generation: u64,
}

/// Bindings for the live app windows, keyed by window label.
#[derive(Default)]
pub struct AppWindowBindings {
    windows: Mutex<HashMap<String, AppWindowBinding>>,
    next_generation: AtomicU64,
}

impl AppWindowBindings {
    /// Bind `label` to `frontend`'s origin and to `node_url`. Returns a token for
    /// `unbind`, so a late teardown of an old window cannot drop the binding of a
    /// newer window that reused its label.
    pub fn bind(&self, label: &str, frontend: &url::Url, node_url: &str) -> u64 {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        self.windows.lock_unpoisoned().insert(
            label.to_string(),
            AppWindowBinding {
                origin: frontend.origin(),
                node_url: node_url.to_string(),
                generation,
            },
        );
        generation
    }

    /// Drop `label`'s binding if it is still the one `bind` returned `generation` for.
    pub fn unbind(&self, label: &str, generation: u64) {
        let mut windows = self.windows.lock_unpoisoned();
        if windows
            .get(label)
            .is_some_and(|b| b.generation == generation)
        {
            windows.remove(label);
        }
    }

    /// The binding for `label`, provided the page it currently shows is on the
    /// origin the window was opened for.
    pub fn authorize(
        &self,
        label: &str,
        current: Option<&url::Url>,
    ) -> Result<AppWindowBinding, String> {
        let binding = self
            .windows
            .lock_unpoisoned()
            .get(label)
            .cloned()
            .ok_or_else(|| format!("Window '{label}' was not opened for an app"))?;
        let current = current.ok_or_else(|| format!("Window '{label}' has no page loaded"))?;
        if current.origin() != binding.origin {
            return Err(format!(
                "This page ({}) is not the app this window was opened for ({})",
                current.origin().ascii_serialization(),
                binding.origin.ascii_serialization()
            ));
        }
        Ok(binding)
    }
}

/// Authorize the page currently loaded in `webview`. The label and URL are
/// Tauri's, not the caller's.
pub fn authorize_webview<R: Runtime>(
    webview: &tauri::Webview<R>,
) -> Result<AppWindowBinding, String> {
    let current = webview.url().ok();
    webview
        .state::<AppWindowBindings>()
        .authorize(webview.label(), current.as_ref())
}

#[cfg(test)]
mod tests {
    use super::AppWindowBindings;

    fn url(s: &str) -> url::Url {
        s.parse().unwrap()
    }

    #[test]
    fn serves_the_app_on_its_own_origin() {
        let bindings = AppWindowBindings::default();
        bindings.bind(
            "app-1",
            &url("https://drive.example/app?_cb=1#access_token=x"),
            "http://localhost:2528",
        );

        let b = bindings
            .authorize("app-1", Some(&url("https://drive.example/other/page")))
            .unwrap();
        assert_eq!(b.node_url, "http://localhost:2528");
    }

    #[test]
    fn refuses_a_page_the_window_navigated_to() {
        let bindings = AppWindowBindings::default();
        bindings.bind(
            "app-1",
            &url("https://drive.example/"),
            "http://localhost:2528",
        );

        for other in [
            "https://evil.example/",
            "https://drive.example.evil.example/",
            "https://sub.drive.example/",
            "http://drive.example/",
            "https://drive.example:8443/",
        ] {
            assert!(
                bindings.authorize("app-1", Some(&url(other))).is_err(),
                "should refuse {other}"
            );
        }
    }

    #[test]
    fn refuses_windows_that_were_never_bound() {
        let bindings = AppWindowBindings::default();
        assert!(bindings
            .authorize("app-1", Some(&url("https://drive.example/")))
            .is_err());
        bindings.bind(
            "app-1",
            &url("https://drive.example/"),
            "http://localhost:2528",
        );
        assert!(bindings.authorize("app-1", None).is_err());
    }

    #[test]
    fn a_stale_unbind_leaves_a_newer_window_bound() {
        let bindings = AppWindowBindings::default();
        let old = bindings.bind(
            "app-1",
            &url("https://drive.example/"),
            "http://localhost:2528",
        );
        let new = bindings.bind(
            "app-1",
            &url("https://drive.example/"),
            "http://localhost:2528",
        );

        bindings.unbind("app-1", old);
        assert!(bindings
            .authorize("app-1", Some(&url("https://drive.example/")))
            .is_ok());

        bindings.unbind("app-1", new);
        assert!(bindings
            .authorize("app-1", Some(&url("https://drive.example/")))
            .is_err());
    }
}
