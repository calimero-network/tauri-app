//! End-to-end checks of the guards against *real* merod processes.
//!
//! The unit tests feed hand-written `ps` output to the parser. These start actual
//! nodes and ask the same questions the app asks before it spawns, deletes, or
//! signals anything - so the answer comes from the live process table.
//!
//! Every node here lives in a scratch directory. Nothing touches `~/.calimero`.
//!
//! Ignored by default: drives a real merod. Run with
//!   MEROD_BIN=/path/to/merod cargo test --test live_node_guard -- --ignored --nocapture

use calimero_tauri_app::node_discovery::{
    discover_nodes, existing_node_for, is_signalable, nodes_under_path,
};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn merod() -> PathBuf {
    if let Ok(p) = std::env::var("MEROD_BIN") {
        return PathBuf::from(p);
    }
    let bundled =
        PathBuf::from("/Applications/Calimero Desktop.app/Contents/Resources/merod/merod");
    assert!(
        bundled.exists(),
        "no merod available - set MEROD_BIN to a merod binary"
    );
    bundled
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Running {
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

/// A space in the path, because the shipped binary lives under one.
fn scratch(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("calimero live {} {}", std::process::id(), tag))
}

fn start_node(home: &Path, node: &str, server: &str, swarm: &str) -> Running {
    let args = [
        "--home".as_ref(),
        home.as_os_str(),
        "--node".as_ref(),
        node.as_ref(),
    ];
    let out = Command::new(merod())
        .args(args)
        .args([
            "init",
            "--auth-mode",
            "embedded",
            "--no-admin",
            "--server-port",
            server,
            "--swarm-port",
            swarm,
        ])
        .output()
        .expect("run merod init");
    assert!(
        out.status.success(),
        "merod init failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let child = Command::new(merod())
        .args(args)
        .arg("run")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn merod run");

    let running = Running(child);
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if home.join(node).join("data").join("CURRENT").exists() {
            std::thread::sleep(Duration::from_millis(400));
            return running;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("node {node} never opened its store");
}

/// The whole point: a live node is visible to the check `start_merod` runs, so the
/// app adopts it instead of putting a second writer on its store. This is the
/// question that went unasked and cost eleven contexts.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn a_live_node_is_found_by_the_guard_that_prevents_a_second_writer() {
    let home = scratch("guard");
    let _cleanup = Scratch(home.clone());
    let _ = std::fs::remove_dir_all(&home);

    let node = start_node(&home, "n1", "36528", "36428");

    let running = discover_nodes();
    let found = running
        .iter()
        .find(|n| n.pid == node.pid())
        .unwrap_or_else(|| {
            panic!(
                "discovery missed a live node (pid {}). Saw: {:?}",
                node.pid(),
                running
            )
        });
    assert_eq!(found.node, "n1");
    assert_eq!(
        std::fs::canonicalize(&found.home).unwrap(),
        std::fs::canonicalize(&home).unwrap()
    );

    assert_eq!(
        existing_node_for(&running, &home, "n1"),
        Some(node.pid()),
        "the start guard must refuse to spawn beside this node"
    );
}

/// A node on another home is invisible to every guard - it is not the app's to
/// adopt, to stop, or to be blocked by.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn a_node_on_another_home_is_not_mistaken_for_ours() {
    let ours = scratch("ours");
    let theirs = scratch("theirs");
    let _c1 = Scratch(ours.clone());
    let _c2 = Scratch(theirs.clone());
    let _ = std::fs::remove_dir_all(&ours);
    let _ = std::fs::remove_dir_all(&theirs);

    // Only the foreign node runs; ours is initialised but never started.
    let foreign = start_node(&theirs, "alice", "36628", "36528");
    let out = Command::new(merod())
        .args([
            "--home".as_ref(),
            ours.as_os_str(),
            "--node".as_ref(),
            "n1".as_ref(),
        ])
        .args(["init", "--auth-mode", "embedded", "--no-admin"])
        .output()
        .expect("init our node");
    assert!(out.status.success());

    let running = discover_nodes();
    assert!(
        running.iter().any(|n| n.pid == foreign.pid()),
        "the foreign node should still be discoverable"
    );
    assert_eq!(
        existing_node_for(&running, &ours, "n1"),
        None,
        "a node on another home must never be adopted as ours"
    );
    assert!(
        nodes_under_path(&running, &ours).is_empty(),
        "a node on another home must not block deleting our home"
    );
    assert!(
        !nodes_under_path(&running, &theirs).is_empty(),
        "but it must block deleting its own home"
    );
}

/// The delete guard: a live node makes its own directory undeletable, and the
/// PID it reports is real enough to signal.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn a_live_node_blocks_deleting_its_directory_and_is_signalable() {
    let home = scratch("delete");
    let _cleanup = Scratch(home.clone());
    let _ = std::fs::remove_dir_all(&home);

    let node = start_node(&home, "n1", "36728", "36628");
    let running = discover_nodes();

    for target in [home.clone(), home.join("n1")] {
        let blocking = nodes_under_path(&running, &target);
        assert!(
            blocking.iter().any(|n| n.pid == node.pid()),
            "deleting {} must be refused while its node runs",
            target.display()
        );
    }

    assert!(
        is_signalable(node.pid(), &running, &[]),
        "a discovered node must be signalable"
    );
    assert!(
        !is_signalable(u32::MAX, &running, &[]),
        "an unaccountable pid must not be"
    );
}
