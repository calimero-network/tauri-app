//! macOS-only: Unix-socket token broker. Newline-delimited JSON.
//! The ONLY thing crossing this socket is "give me a fresh access token".

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerRequest {
    pub cap: String,
    pub app_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerResponse {
    pub access_token: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol error: {0}")]
    Protocol(#[from] serde_json::Error),
    #[error("denied: {0}")]
    Denied(String),
}

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// True iff the connected peer runs as the same OS user as us.
pub fn same_user_peer(stream: &UnixStream) -> bool {
    use std::os::unix::io::AsRawFd;
    extern "C" {
        fn getpeereid(fd: i32, euid: *mut u32, egid: *mut u32) -> i32;
        fn geteuid() -> u32;
    }
    let (mut euid, mut egid) = (0u32, 0u32);
    let rc = unsafe { getpeereid(stream.as_raw_fd(), &mut euid, &mut egid) };
    rc == 0 && euid == unsafe { geteuid() }
}

async fn handle_conn<F, Fut>(stream: UnixStream, handler: F) -> std::io::Result<()>
where
    F: Fn(BrokerRequest) -> Fut,
    Fut: std::future::Future<Output = BrokerResponse>,
{
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let resp = match serde_json::from_str::<BrokerRequest>(line.trim()) {
        Ok(req) => handler(req).await,
        Err(e) => BrokerResponse {
            access_token: None,
            error: Some(format!("bad request: {e}")),
        },
    };
    let mut bytes = serde_json::to_vec(&resp).unwrap_or_default();
    bytes.push(b'\n');
    reader.into_inner().write_all(&bytes).await
}

pub async fn serve<F, Fut>(listener: UnixListener, handler: F) -> std::io::Result<()>
where
    F: Fn(BrokerRequest) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = BrokerResponse> + Send + 'static,
{
    loop {
        let (stream, _) = listener.accept().await?;
        if !same_user_peer(&stream) {
            continue; // reject other-user peers outright
        }
        let handler = handler.clone();
        tokio::spawn(async move {
            let _ = handle_conn(stream, handler).await;
        });
    }
}

pub async fn request_access_token(
    socket_path: &Path,
    cap: &str,
    app_id: &str,
) -> Result<String, IpcError> {
    let stream = UnixStream::connect(socket_path).await?;
    let mut reader = BufReader::new(stream);
    let mut bytes = serde_json::to_vec(&BrokerRequest {
        cap: cap.to_string(),
        app_id: app_id.to_string(),
    })?;
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await?;
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let resp: BrokerResponse = serde_json::from_str(line.trim())?;
    match resp.access_token {
        Some(t) => Ok(t),
        None => Err(IpcError::Denied(resp.error.unwrap_or_else(|| "denied".into()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_response_roundtrip_json() {
        let req = BrokerRequest {
            cap: "c1".into(),
            app_id: "mero-drive".into(),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: BrokerRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.cap, "c1");
        assert_eq!(back.app_id, "mero-drive");

        let resp = BrokerResponse {
            access_token: Some("AT".into()),
            error: None,
        };
        let s2 = serde_json::to_string(&resp).unwrap();
        let back2: BrokerResponse = serde_json::from_str(&s2).unwrap();
        assert_eq!(back2.access_token.as_deref(), Some("AT"));
        assert!(back2.error.is_none());
    }

    fn temp_sock(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static C: AtomicU32 = AtomicU32::new(0);
        let n = C.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "cal-broker-{}-{}-{}.sock",
            std::process::id(),
            tag,
            n
        ))
    }

    #[tokio::test]
    async fn client_gets_token_and_denial_over_socket() {
        let path = temp_sock("rt");
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path).unwrap();

        // handler: cap "good" -> "AT-<app_id>"; anything else -> denied.
        let handler = |req: BrokerRequest| async move {
            if req.cap == "good" {
                BrokerResponse {
                    access_token: Some(format!("AT-{}", req.app_id)),
                    error: None,
                }
            } else {
                BrokerResponse {
                    access_token: None,
                    error: Some("bad cap".into()),
                }
            }
        };
        let srv = tokio::spawn(serve(listener, handler));

        let ok = request_access_token(&path, "good", "mero-drive")
            .await
            .unwrap();
        assert_eq!(ok, "AT-mero-drive");

        let err = request_access_token(&path, "wrong", "mero-drive").await;
        assert!(matches!(err, Err(IpcError::Denied(_))));

        srv.abort();
        let _ = std::fs::remove_file(&path);
    }
}
