//! App deep-links (`calimero://<package>/<action>?<params>`) and how one reaches
//! an app page. Shared by the host and the per-app shell.
//!
//! A link reaches an app in one of two ways:
//!
//! - **Cold** (no page yet): the link's params go on the page's URL, so the
//!   app reads `?invitation=…` on load.
//! - **Warm** (the page is open): the link is handed to the page through the
//!   launcher bridge (`window.__calimero_platform__`, injected by
//!   `proxy_script.js`) as a `deep-link` event, which is what mero-platform's
//!   `DeepLinkController` listens for. Nothing reloads.
//!
//! Between the host and a per-app shell (macOS) the link travels as a one-shot
//! handoff file, so it is never baked into the launcher's `app.json`, where it
//! would replay every time the app is started from the Dock.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// An app deep-link parsed from a shared link, shaped
/// `<scheme-or-host>/<slug>/<action>?<params>`. Emitted to the frontend as the
/// `app-deep-link` event; the frontend resolves `slug` → an installed app and
/// opens it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct AppDeepLink {
    pub slug: String,
    pub action: String,
    /// The raw query string (without the leading `?`), e.g. `invitation=X`.
    pub params: String,
}

impl AppDeepLink {
    /// The link as the in-app bridge delivers it: `calimero://<slug>/<action>?<params>`.
    pub fn raw(&self) -> String {
        if self.params.is_empty() {
            format!("calimero://{}/{}", self.slug, self.action)
        } else {
            format!("calimero://{}/{}?{}", self.slug, self.action, self.params)
        }
    }
}

/// Parse an app deep-link from either the custom scheme or the Universal Link
/// host. Returns `None` for anything that is not an app deep-link — crucially
/// the OAuth callback (`calimero://cloud-callback?…`), which the caller keeps
/// routing through the existing cloud-auth path.
///
/// Accepted shapes:
///   - `calimero://<slug>/<action>?<params>`          (host=slug, path=/action)
///   - `https://links.calimero.network/<slug>/<action>?<params>`
pub fn parse_app_deep_link(raw: &str) -> Option<AppDeepLink> {
    let parsed = url::Url::parse(raw).ok()?;

    let (slug, action) = match parsed.scheme() {
        "calimero" => {
            // `calimero://<slug>/<action>` → host is the slug, first path
            // segment is the action.
            let host = parsed.host_str()?;
            // Reserve the OAuth callback host: it is NOT an app deep-link.
            if host == "cloud-callback" {
                return None;
            }
            let action = parsed
                .path_segments()
                .and_then(|mut segs| segs.next())
                .filter(|s| !s.is_empty())?;
            (host.to_string(), action.to_string())
        }
        "https" if parsed.host_str() == Some("links.calimero.network") => {
            // `https://links.calimero.network/<slug>/<action>`
            let mut segs = parsed.path_segments()?.filter(|s| !s.is_empty());
            let slug = segs.next()?;
            let action = segs.next()?;
            (slug.to_string(), action.to_string())
        }
        _ => return None,
    };

    // Light shape validation. The slug is the app PACKAGE — reverse-DNS with
    // dots (e.g. `com.calimero.curb`) — so `.` must be allowed alongside `-`/`_`.
    // Keep permissive (the frontend does the real resolve against installed apps
    // and simply warns on no match), but reject obviously bogus segments.
    let is_token = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    if !is_token(&slug) || !is_token(&action) {
        return None;
    }

    Some(AppDeepLink {
        slug,
        action,
        params: parsed.query().unwrap_or("").to_string(),
    })
}

/// `page` with the link's query parameters set on it, for a page that is not
/// open yet: the app reads them on load. A parameter the page URL already has
/// is replaced, not duplicated.
pub fn with_link_params(page: &url::Url, params: &str) -> url::Url {
    let incoming: Vec<(String, String)> = url::form_urlencoded::parse(params.as_bytes())
        .into_owned()
        .collect();
    if incoming.is_empty() {
        return page.clone();
    }
    let kept: Vec<(String, String)> = page
        .query_pairs()
        .into_owned()
        .filter(|(k, _)| !incoming.iter().any(|(ik, _)| ik == k))
        .collect();
    let mut out = page.clone();
    out.set_query(None);
    out.query_pairs_mut()
        .extend_pairs(kept)
        .extend_pairs(incoming);
    out
}

/// Script that hands `link` to an open page through the launcher bridge. The
/// bridge (`proxy_script.js`) turns the `calimero-deep-link` DOM event into a
/// `deep-link` event for its subscribers, holding it until one subscribes.
///
/// Only ever evaluated in a window whose page is on the origin it was opened
/// for (see `app_window::authorize_webview`): the link can carry an invitation.
pub fn dispatch_script(link: &AppDeepLink) -> String {
    let detail = serde_json::json!({ "raw": link.raw() });
    format!("window.dispatchEvent(new CustomEvent('calimero-deep-link', {{ detail: {detail} }}));")
}

/// How long a handoff waits for its shell. The host writes it right before it
/// starts or pokes the shell, so anything older was never collected — a shell
/// that crashed on start — and must not surface the next time the app is
/// opened from the Dock.
pub const HANDOFF_MAX_AGE: Duration = Duration::from_secs(120);

#[derive(serde::Serialize, serde::Deserialize)]
struct Handoff {
    raw: String,
    written_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Leave `link` at `path` for the shell to collect. Written whole and then
/// renamed into place, so a shell never reads half a file, and readable only
/// by this user: the link can carry an invitation.
pub fn write_handoff(path: &Path, link: &AppDeepLink) -> std::io::Result<()> {
    let body = serde_json::to_vec(&Handoff {
        raw: link.raw(),
        written_at_ms: now_ms(),
    })?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&body)?;
    }
    std::fs::rename(&tmp, path)
}

/// Collect the link left at `path`, at most once: it is renamed away before
/// it is read, so of a shell starting up and a shell answering a poke only one
/// gets it. `None` when there is none, or it is older than `max_age`.
pub fn take_handoff(path: &Path, max_age: Duration) -> Option<AppDeepLink> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let taken = path.with_extension(format!("taken-{}-{nanos}", std::process::id()));
    std::fs::rename(path, &taken).ok()?;
    let bytes = std::fs::read(&taken);
    let _ = std::fs::remove_file(&taken);
    let handoff: Handoff = serde_json::from_slice(&bytes.ok()?).ok()?;
    if now_ms().saturating_sub(handoff.written_at_ms) > max_age.as_millis() as u64 {
        return None;
    }
    parse_app_deep_link(&handoff.raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(params: &str) -> AppDeepLink {
        AppDeepLink {
            slug: "com.calimero.mero-chat".into(),
            action: "join".into(),
            params: params.into(),
        }
    }

    #[test]
    fn app_deep_link_custom_scheme() {
        let dl = parse_app_deep_link("calimero://mero-chat/join?invitation=TESTTOKEN")
            .expect("should parse app deep-link");
        assert_eq!(dl.slug, "mero-chat");
        assert_eq!(dl.action, "join");
        assert_eq!(dl.params, "invitation=TESTTOKEN");
    }

    #[test]
    fn app_deep_link_keeps_a_dotted_package_slug() {
        let dl = parse_app_deep_link("calimero://com.calimero.mero-chat/join?invitation=T")
            .expect("should parse a package slug");
        assert_eq!(dl.slug, "com.calimero.mero-chat");
    }

    #[test]
    fn app_deep_link_universal_link() {
        let dl = parse_app_deep_link(
            "https://links.calimero.network/mero-chat/join?invitation=TESTTOKEN",
        )
        .expect("should parse universal link");
        assert_eq!(dl.slug, "mero-chat");
        assert_eq!(dl.action, "join");
        assert_eq!(dl.params, "invitation=TESTTOKEN");
    }

    #[test]
    fn oauth_callback_is_not_an_app_deep_link() {
        // The OAuth callback MUST fall through to the cloud-auth path.
        assert!(parse_app_deep_link("calimero://cloud-callback?state=ABC#id_token=eyJ").is_none());
    }

    #[test]
    fn app_deep_link_rejects_unrelated_urls() {
        // Missing action segment.
        assert!(parse_app_deep_link("calimero://mero-chat").is_none());
        // Wrong https host.
        assert!(parse_app_deep_link("https://example.com/mero-chat/join").is_none());
        // Non-deep-link scheme.
        assert!(parse_app_deep_link("http://localhost:2528/api").is_none());
    }

    #[test]
    fn raw_round_trips_through_the_parser() {
        let dl = link("invitation=a%2Bb%3D&name=x");
        assert_eq!(
            dl.raw(),
            "calimero://com.calimero.mero-chat/join?invitation=a%2Bb%3D&name=x"
        );
        assert_eq!(parse_app_deep_link(&dl.raw()), Some(dl));
        assert_eq!(link("").raw(), "calimero://com.calimero.mero-chat/join");
    }

    #[test]
    fn link_params_go_on_the_page_url_and_survive_encoding() {
        let page = url::Url::parse("https://chat.example/app/?_cb=1&invitation=old").unwrap();
        let out = with_link_params(&page, "invitation=a%2Bb%3D");
        assert_eq!(out.path(), "/app/");
        let pairs: Vec<(String, String)> = out.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            vec![
                ("_cb".to_string(), "1".to_string()),
                ("invitation".to_string(), "a+b=".to_string()),
            ]
        );
        // No params, no change.
        assert_eq!(with_link_params(&page, ""), page);
    }

    #[test]
    fn dispatch_script_carries_the_link_as_a_json_literal() {
        let dl = link("invitation=x'%22);alert(1)//");
        let script = dispatch_script(&dl);
        assert!(script.starts_with("window.dispatchEvent(new CustomEvent('calimero-deep-link'"));
        // The link is only ever inside a JSON string literal.
        let json = script
            .split_once("detail: ")
            .and_then(|(_, rest)| rest.strip_suffix(" }));"))
            .unwrap();
        let detail: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(detail["raw"], dl.raw());
    }

    #[test]
    fn a_handoff_is_collected_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shell-abc.link");
        let dl = link("invitation=T");

        assert_eq!(take_handoff(&path, HANDOFF_MAX_AGE), None);
        write_handoff(&path, &dl).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "an invitation is not for other users");
        }
        assert_eq!(take_handoff(&path, HANDOFF_MAX_AGE), Some(dl));
        assert_eq!(take_handoff(&path, HANDOFF_MAX_AGE), None, "taken once");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "nothing left behind"
        );
    }

    #[test]
    fn a_stale_handoff_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shell-abc.link");
        let old = Handoff {
            raw: link("invitation=T").raw(),
            written_at_ms: now_ms() - 10 * 60_000,
        };
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(take_handoff(&path, HANDOFF_MAX_AGE), None);
        assert!(
            !path.exists(),
            "a stale handoff does not wait for the next launch"
        );
    }
}
