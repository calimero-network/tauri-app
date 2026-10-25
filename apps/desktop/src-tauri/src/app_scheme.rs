//! The `calimero-app://{label}` scheme: an installed app's frontend served by
//! its node, one origin per app. The node refuses the webview's own origins, so
//! this host fetches for the page: static GET/HEAD here, API calls through the
//! IPC proxy (`proxy.rs`), both aimed at `{label}.localhost` on the node.

use std::sync::OnceLock;

use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::app_window::AppWindowBindings;

pub const SCHEME: &str = "calimero-app";
const WINDOWS_HOST_PREFIX: &str = "calimero-app."; // wry rewrites the scheme to http(s)://calimero-app.{label}
const LABEL_LEN: usize = 52; // 32-byte app id as unpadded base32
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const FORWARDED_REQUEST_HEADERS: [&str; 4] = ["accept", "if-none-match", "if-modified-since", "range"];
const DROPPED_RESPONSE_HEADERS: [&str; 3] = ["connection", "transfer-encoding", "content-length"];

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PROBE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Where a request for an app origin goes: the configured node, addressed by the app's host name.
#[derive(Debug, PartialEq, Eq)]
pub struct NodeTarget {
    pub url: String,
    pub host: String,
}

/// Whether `label` is a canonical app label: 52 lowercase base32 characters whose
/// last one carries no bits beyond the 256 of the id.
pub fn is_valid_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    bytes.len() == LABEL_LEN
        && bytes.iter().all(|b| BASE32.contains(b))
        && matches!(bytes[LABEL_LEN - 1], b'a' | b'q')
}

/// The label of an app-origin URL, in the scheme form or the Windows form.
pub fn label_from_url(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    let label = match url.scheme() {
        SCHEME => host,
        "http" | "https" => host.strip_prefix(WINDOWS_HOST_PREFIX)?,
        _ => return None,
    };
    is_valid_label(label).then(|| label.to_string())
}

/// The origin of `url`; both forms of an app origin map to one, as the scheme
/// form has an opaque origin otherwise.
pub fn canonical_origin(url: &url::Url) -> url::Origin {
    match label_from_url(url) {
        Some(label) => url::Origin::Tuple(
            SCHEME.to_string(),
            url::Host::Domain(label),
            0,
        ),
        None => url.origin(),
    }
}

/// The label for an application id, as the node lists it (64 hex digits) or base58.
pub fn label_for_app_id(app_id: &str) -> Option<String> {
    let id = hex::decode(app_id)
        .ok()
        .filter(|b| b.len() == 32)
        .or_else(|| bs58::decode(app_id).into_vec().ok().filter(|b| b.len() == 32))?;
    let mut label = String::with_capacity(LABEL_LEN);
    let (mut acc, mut bits) = (0u16, 0u8);
    for byte in id {
        acc = (acc << 8) | u16::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            label.push(char::from(BASE32[usize::from((acc >> bits) & 31)]));
        }
    }
    if bits > 0 {
        label.push(char::from(BASE32[usize::from((acc << (5 - bits)) & 31)]));
    }
    Some(label)
}

/// The node URL and `Host` for `path_and_query` of app `label`.
pub fn node_target(label: &str, node_url: &str, path_and_query: &str) -> Result<NodeTarget, String> {
    let node = url::Url::parse(node_url).map_err(|e| format!("Invalid node URL: {e}"))?;
    let node_host = node.host_str().ok_or("Node URL has no host")?;
    let host = match node.port() {
        Some(port) => format!("{label}.localhost:{port}"),
        None => format!("{label}.localhost"),
    };
    let base = match node.port() {
        Some(port) => format!("{}://{node_host}:{port}", node.scheme()),
        None => format!("{}://{node_host}", node.scheme()),
    };
    Ok(NodeTarget { url: format!("{base}{path_and_query}"), host })
}

/// The target of a page's static request, or the status that refuses it. Only
/// GET and HEAD, and only on the window's own app.
pub fn static_target(
    method: &str,
    url: &url::Url,
    bound_label: &str,
    node_url: &str,
) -> Result<NodeTarget, u16> {
    if method != "GET" && method != "HEAD" {
        return Err(405);
    }
    if label_from_url(url).as_deref() != Some(bound_label) {
        return Err(403);
    }
    let path_and_query = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };
    node_target(bound_label, node_url, &path_and_query).map_err(|_| 502)
}

/// Whether the node serves a frontend for `label`: its root, redirects followed,
/// answers 2xx with a `default-src 'self'` policy (the admin dashboard has none).
pub async fn probe_bundled(label: &str, node_url: &str) -> bool {
    let Ok(target) = node_target(label, node_url, "/") else {
        return false;
    };
    let response = probe_client().head(&target.url).header("Host", &target.host).send().await;
    response.is_ok_and(|r| {
        r.status().is_success()
            && r.headers()
                .get("content-security-policy")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|csp| csp.contains("default-src 'self'"))
    })
}

fn probe_client() -> &'static reqwest::Client {
    PROBE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(3))
            .timeout(std::time::Duration::from_secs(4))
            .build()
            .expect("Failed to build probe client")
    })
}

/// A redirect `location` as a path on the app's own origin, so the webview stays on it.
pub fn local_location(label: &str, location: &str) -> String {
    match url::Url::parse(location) {
        Ok(abs) if abs.host_str().is_some_and(|h| h == format!("{label}.localhost")) => {
            match abs.query() {
                Some(q) => format!("{}?{q}", abs.path()),
                None => abs.path().to_string(),
            }
        }
        _ => location.to_string(),
    }
}

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to build app scheme client")
    })
}

fn refusal(status: u16) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).expect("static response")
}

async fn fetch(
    method: &str,
    target: NodeTarget,
    label: &str,
    request_headers: &[(String, String)],
) -> Response<Vec<u8>> {
    let method = if method == "HEAD" { reqwest::Method::HEAD } else { reqwest::Method::GET };
    let mut builder = client().request(method, &target.url).header("Host", &target.host);
    for (name, value) in request_headers {
        builder = builder.header(name, value);
    }
    let node = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[app-scheme] {}: {e}", target.url);
            return refusal(502);
        }
    };
    let mut out = Response::builder().status(node.status().as_u16());
    for (name, value) in node.headers() {
        if DROPPED_RESPONSE_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let Ok(value) = value.to_str() else { continue };
        let value = if name == reqwest::header::LOCATION {
            local_location(label, value)
        } else {
            value.to_string()
        };
        out = out.header(name.as_str(), value);
    }
    match node.bytes().await {
        Ok(body) => out.body(body.to_vec()).unwrap_or_else(|_| refusal(502)),
        Err(_) => refusal(502),
    }
}

fn forwarded_headers(headers: &tauri::http::HeaderMap) -> Vec<(String, String)> {
    FORWARDED_REQUEST_HEADERS
        .iter()
        .filter_map(|n| Some((n.to_string(), headers.get(*n)?.to_str().ok()?.to_string())))
        .collect()
}

/// Handler for the scheme: serves the window's own app from its node.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let bindings = ctx.app_handle().state::<AppWindowBindings>();
    let url = request.uri().to_string().parse::<url::Url>().ok();
    let binding = url
        .as_ref()
        .and_then(|u| bindings.authorize(ctx.webview_label(), Some(u)).ok());
    let (Some(url), Some(binding)) = (url, binding) else {
        return responder.respond(refusal(403));
    };
    let Some(label) = binding.label.clone() else {
        return responder.respond(refusal(403));
    };
    let method = request.method().as_str().to_string();
    let target = match static_target(&method, &url, &label, &binding.node_url) {
        Ok(t) => t,
        Err(status) => return responder.respond(refusal(status)),
    };
    let headers = forwarded_headers(request.headers());
    tauri::async_runtime::spawn(async move {
        responder.respond(fetch(&method, target, &label, &headers).await);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const LABEL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba";

    fn url(s: &str) -> url::Url {
        s.parse().unwrap()
    }

    #[test]
    fn label_validation() {
        assert!(is_valid_label(LABEL));
        assert!(is_valid_label(&"a".repeat(52)));
        assert!(!is_valid_label(&LABEL.to_uppercase()), "uppercase");
        assert!(!is_valid_label(&LABEL[1..]), "51 chars");
        assert!(!is_valid_label(&format!("{LABEL}a")), "53 chars");
        assert!(!is_valid_label(&format!("{}b", &LABEL[..51])), "padding bits set");
        assert!(!is_valid_label(&format!("{}1", &LABEL[..51])), "digit outside the alphabet");
        assert!(!is_valid_label(&format!("{}-", &LABEL[..51])), "other character");
        assert!(!is_valid_label(&"1".repeat(52)), "base58 style");
    }

    #[test]
    fn label_from_both_url_forms() {
        for u in [
            format!("calimero-app://{LABEL}/"),
            format!("calimero-app://{LABEL}/v1/index.html?x=1#h"),
            format!("http://calimero-app.{LABEL}/v1/"),
            format!("https://calimero-app.{LABEL}/"),
        ] {
            assert_eq!(label_from_url(&url(&u)).as_deref(), Some(LABEL), "{u}");
        }
        for u in [
            "calimero-app://short/".to_string(),
            format!("http://{LABEL}.localhost/"),
            format!("https://evil.example/calimero-app.{LABEL}"),
            format!("https://calimero-app.{LABEL}.evil.example/"),
            format!("ftp://calimero-app.{LABEL}/"),
            format!("https://{LABEL}/"),
            format!("ftp://{LABEL}/"),
        ] {
            assert_eq!(label_from_url(&url(&u)), None, "{u}");
        }
    }

    #[test]
    fn both_forms_share_one_origin_and_labels_differ() {
        let a = canonical_origin(&url(&format!("calimero-app://{LABEL}/x")));
        assert_eq!(a, canonical_origin(&url(&format!("http://calimero-app.{LABEL}/y"))));
        assert_ne!(a, canonical_origin(&url(&format!("calimero-app://{OTHER}/x"))));
        assert_eq!(
            canonical_origin(&url("https://drive.example/a")),
            canonical_origin(&url("https://drive.example/b"))
        );
    }

    #[test]
    fn app_id_to_label() {
        let zero = bs58::encode([0u8; 32]).into_string();
        assert_eq!(label_for_app_id(&zero), Some("a".repeat(52)));
        let ones = bs58::encode([0xffu8; 32]).into_string();
        assert_eq!(
            label_for_app_id(&ones),
            Some(format!("{}q", "7".repeat(51)))
        );
        assert_eq!(label_for_app_id("not base58 0OIl"), None);
        assert_eq!(label_for_app_id(&bs58::encode([1u8; 31]).into_string()), None);
        assert!(is_valid_label(&label_for_app_id(&ones).unwrap()));
    }

    #[test]
    fn app_id_to_label_from_the_nodes_hex_id() {
        let hex = "ad61b1324e760fc4a8cb2beaeb1a799e4bac774b5f78bebe66f2cb863774926f";
        assert_eq!(
            label_for_app_id(hex).as_deref(),
            Some("vvq3cmsooyh4jkglfpvowgtztzf2y52ll54l5ptg6lfymn3usjxq")
        );
        assert_eq!(label_for_app_id(&hex[1..]), None, "63 digits");
        assert_eq!(label_for_app_id(&hex.to_uppercase()), label_for_app_id(hex));
    }

    #[test]
    fn maps_a_static_request_to_the_node() {
        let t = static_target(
            "GET",
            &url(&format!("calimero-app://{LABEL}/v1/app.js?x=1")),
            LABEL,
            "http://127.0.0.1:2528",
        )
        .unwrap();
        assert_eq!(t.url, "http://127.0.0.1:2528/v1/app.js?x=1");
        assert_eq!(t.host, format!("{LABEL}.localhost:2528"));
        assert!(static_target("HEAD", &url(&format!("calimero-app://{LABEL}/")), LABEL, "http://localhost:2528").is_ok());
    }

    #[test]
    fn node_target_keeps_the_nodes_scheme_and_default_port() {
        let t = node_target(LABEL, "https://node.example", "/x?y=1").unwrap();
        assert_eq!(t.url, "https://node.example/x?y=1");
        assert_eq!(t.host, format!("{LABEL}.localhost"));
        let t = node_target(LABEL, "https://node.example:8443", "/").unwrap();
        assert_eq!(t.url, "https://node.example:8443/");
        assert_eq!(t.host, format!("{LABEL}.localhost:8443"));
        assert!(node_target(LABEL, "not a url", "/").is_err());
    }

    #[test]
    fn refuses_other_methods_and_other_apps() {
        let own = url(&format!("calimero-app://{LABEL}/"));
        for m in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
            assert_eq!(static_target(m, &own, LABEL, "http://localhost:2528"), Err(405), "{m}");
        }
        let other = url(&format!("calimero-app://{OTHER}/"));
        assert_eq!(static_target("GET", &other, LABEL, "http://localhost:2528"), Err(403));
    }

    #[test]
    fn redirects_stay_on_the_app_origin() {
        let abs = format!("http://{LABEL}.localhost:2528/v2/?a=1");
        assert_eq!(local_location(LABEL, &abs), "/v2/?a=1");
        assert_eq!(local_location(LABEL, "/v2/"), "/v2/");
        let foreign = "http://evil.example/";
        assert_eq!(local_location(LABEL, foreign), foreign);
    }

    /// Answers one request with `reply`; resolves to the raw request it saw.
    async fn serve_once(reply: String) -> (u16, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        (port, seen)
    }

    fn ok_with(headers: &str) -> String {
        format!("HTTP/1.1 200 OK\r\n{headers}Content-Length: 0\r\n\r\n")
    }

    async fn probes(reply: String) -> bool {
        let (port, _) = serve_once(reply).await;
        probe_bundled(LABEL, &format!("http://127.0.0.1:{port}")).await
    }

    #[tokio::test]
    async fn probe_needs_the_apps_own_policy() {
        assert!(probes(ok_with("Content-Security-Policy: default-src 'self'; img-src data:\r\n")).await);
        assert!(!probes(ok_with("Content-Security-Policy: script-src 'self'\r\n")).await);
        assert!(!probes(ok_with("")).await);
    }

    #[tokio::test]
    async fn probe_needs_a_success_status() {
        let csp = "Content-Security-Policy: default-src 'self'\r\n";
        assert!(!probes(format!("HTTP/1.1 404 Not Found\r\n{csp}Content-Length: 0\r\n\r\n")).await);
    }

    #[tokio::test]
    async fn probe_follows_the_redirect_to_the_newest_version() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for reply in [
                "HTTP/1.1 302 Found\r\nLocation: /1.0.0/\r\nContent-Length: 0\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Security-Policy: default-src 'self'\r\nContent-Length: 0\r\n\r\n",
            ] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                sock.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        assert!(probe_bundled(LABEL, &format!("http://127.0.0.1:{port}")).await);
    }

    async fn fetch_from(
        method: &str,
        reply: String,
        request_headers: &[(String, String)],
    ) -> (Response<Vec<u8>>, String) {
        let (port, seen) = serve_once(reply).await;
        let target = node_target(LABEL, &format!("http://127.0.0.1:{port}"), "/v1/app.js").unwrap();
        let response = fetch(method, target, LABEL, request_headers).await;
        (response, seen.await.unwrap())
    }

    #[tokio::test]
    async fn fetch_relays_status_body_and_end_to_end_headers() {
        let reply = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nETag: \"x\"\r\nContent-Length: 2\r\n\r\nno".to_string();
        let (res, _) = fetch_from("GET", reply, &[]).await;
        assert_eq!(res.status(), 404);
        assert_eq!(res.body(), b"no");
        assert_eq!(res.headers()["content-type"], "text/plain");
        assert_eq!(res.headers()["etag"], "\"x\"");
    }

    #[tokio::test]
    async fn fetch_drops_headers_the_webview_recomputes() {
        let reply = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok".to_string();
        let (res, _) = fetch_from("GET", reply, &[]).await;
        assert!(res.headers().get("content-length").is_none());
        assert!(res.headers().get("connection").is_none());
    }

    #[tokio::test]
    async fn fetch_keeps_a_redirect_on_the_app_origin() {
        let reply = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{LABEL}.localhost:2528/1.0.0/?a=1\r\nContent-Length: 0\r\n\r\n"
        );
        let (res, _) = fetch_from("GET", reply, &[]).await;
        assert_eq!(res.status(), 307, "the redirect is not followed");
        assert_eq!(res.headers()["location"], "/1.0.0/?a=1");
    }

    #[tokio::test]
    async fn fetch_addresses_the_app_and_forwards_caching_headers() {
        let headers = vec![
            ("range".to_string(), "bytes=0-9".to_string()),
            ("if-none-match".to_string(), "\"x\"".to_string()),
        ];
        let (_, seen) = fetch_from("HEAD", ok_with(""), &headers).await;
        assert!(seen.starts_with("head /v1/app.js "), "{seen}");
        assert!(seen.contains(&format!("host: {LABEL}.localhost:")), "{seen}");
        assert!(seen.contains("range: bytes=0-9"), "{seen}");
        assert!(seen.contains("if-none-match: \"x\""), "{seen}");
    }

    #[test]
    fn only_caching_and_range_headers_are_forwarded() {
        let mut map = tauri::http::HeaderMap::new();
        for (k, v) in [("range", "bytes=0-1"), ("accept", "*/*"), ("cookie", "s=1"), ("authorization", "Bearer x")] {
            map.insert(k, v.parse().unwrap());
        }
        let mut got = forwarded_headers(&map);
        got.sort();
        assert_eq!(
            got,
            vec![("accept".into(), "*/*".into()), ("range".into(), "bytes=0-1".into())]
        );
    }

    #[tokio::test]
    async fn fetch_answers_502_when_the_node_is_down() {
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let target = node_target(LABEL, &format!("http://127.0.0.1:{port}"), "/").unwrap();
        assert_eq!(fetch("GET", target, LABEL, &[]).await.status(), 502);
    }
}
