//! Shared harness for the integration suites that drive a real merod.
//!
//! Every node these start lives in a scratch directory whose path contains a
//! space, because the shipped binary does and that is what the parser used to get
//! wrong. Nothing here touches `~/.calimero`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The merod under test: `MEROD_BIN`, else the installed app's bundled copy.
pub fn merod() -> PathBuf {
    if let Ok(path) = std::env::var("MEROD_BIN") {
        return PathBuf::from(path);
    }
    let bundled =
        PathBuf::from("/Applications/Calimero Desktop.app/Contents/Resources/merod/merod");
    assert!(
        bundled.exists(),
        "no merod available - set MEROD_BIN to a merod binary"
    );
    bundled
}

/// Removes the scratch home even when an assertion unwinds.
pub struct Scratch(pub PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Kills the child even when an assertion unwinds.
pub struct Running(pub Child);

impl Running {
    pub fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A scratch home, unique per process and per tag, with a space in the path.
pub fn scratch_home(tag: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("calimero test {} {tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    home
}

/// `merod --home <home> --node <node> init`, with the ports the test wants.
pub fn init(home: &Path, node: &str, server_port: &str, swarm_port: &str) {
    let out = Command::new(merod())
        .args([
            "--home".as_ref(),
            home.as_os_str(),
            "--node".as_ref(),
            node.as_ref(),
        ])
        .args([
            "init",
            "--auth-mode",
            "embedded",
            "--no-admin",
            "--server-port",
            server_port,
            "--swarm-port",
            swarm_port,
        ])
        .output()
        .expect("run merod init");
    assert!(
        out.status.success(),
        "merod init failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// `merod ... run`, output discarded.
pub fn spawn_node(home: &Path, node: &str) -> Running {
    Running(
        Command::new(merod())
            .args([
                "--home".as_ref(),
                home.as_os_str(),
                "--node".as_ref(),
                node.as_ref(),
            ])
            .arg("run")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn merod run"),
    )
}

/// Blocks until the node has its store open, which `CURRENT` appearing shows.
pub fn wait_until_store_open(home: &Path, node: &str) {
    let marker = home.join(node).join("data").join("CURRENT");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if marker.exists() {
            std::thread::sleep(Duration::from_millis(1200));
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("node {node} never opened its store at {}", marker.display());
}

/// init + run + wait, the usual opening move.
pub fn start_node(home: &Path, node: &str, server_port: &str, swarm_port: &str) -> Running {
    init(home, node, server_port, swarm_port);
    let running = spawn_node(home, node);
    wait_until_store_open(home, node);
    running
}
