//! Reproduces the root condition of the 14 Aug 2026 data loss: two live nodes
//! holding one store.
//!
//! RocksDB normally refuses the second opener - its LOCK file is an `fcntl` lock
//! and the second process cannot take it. But the lock is bound to an *inode*,
//! so replacing the node home leaves the first node holding a lock nobody can
//! see, and the second walks in. From there each instance deletes the files its
//! own manifest does not list, which is what destroyed the store overnight.
//!
//! The two tests below are a pair: the control shows the lock working, and the
//! second shows it defeated. The overnight corruption itself is not reproduced -
//! it needs hours of write activity - but this is the condition it requires, and
//! it is what the app-side start guard has to make unreachable.
//!
//! Ignored by default: drives a real merod. Run with
//!   MEROD_BIN=/path/to/merod cargo test --test double_writer_repro -- --ignored --nocapture

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const NODE: &str = "n1";

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

/// Removes the scratch home even when an assertion unwinds.
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Kills the child even when an assertion unwinds.
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A space in the path, because the shipped binary lives under one.
fn scratch_home(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("calimero repro {} {}", std::process::id(), tag))
}

fn node_args(home: &Path) -> [&std::ffi::OsStr; 4] {
    [
        "--home".as_ref(),
        home.as_os_str(),
        "--node".as_ref(),
        NODE.as_ref(),
    ]
}

fn init(home: &Path, server_port: &str, swarm_port: &str) {
    let out = Command::new(merod())
        .args(node_args(home))
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

fn spawn_node(home: &Path) -> Running {
    Running(
        Command::new(merod())
            .args(node_args(home))
            .arg("run")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn merod run"),
    )
}

fn wait_until_store_open(home: &Path) {
    let marker = home.join(NODE).join("data").join("CURRENT");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if marker.exists() {
            std::thread::sleep(Duration::from_millis(1200));
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("node never opened its store at {}", marker.display());
}

/// Starts a second node on `home` and returns everything it printed before it
/// stopped. It always stops - the first node holds the port - so what matters is
/// how far it got: refused at the store, or all the way to a running node.
fn second_node_output(home: &Path) -> String {
    let mut child = Command::new(merod())
        .args(node_args(home))
        .arg("run")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn second merod");

    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        if child.try_wait().expect("poll merod").is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let out = child.wait_with_output().expect("collect merod output");
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// The store lock turned the second node away.
fn refused_at_the_store(output: &str) -> bool {
    output.contains("While lock file")
}

/// The second node got the store open. The peer ID is printed *before* the store
/// is touched - it comes from the config keypair - so the signal is reaching the
/// network bind, which only happens once the store is open.
fn opened_the_store(output: &str) -> bool {
    !refused_at_the_store(output) && output.contains("Address already in use")
}

/// Control: with the home intact, RocksDB's own lock stops the second node.
/// If this ever fails, the store lock is no longer protecting anything and the
/// app-side guard is the only thing left.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn a_second_node_on_an_intact_home_is_refused_by_the_store_lock() {
    let home = scratch_home("intact");
    let _scratch = Scratch(home.clone());
    let _ = std::fs::remove_dir_all(&home);

    init(&home, "34528", "34428");
    let _node_a = spawn_node(&home);
    wait_until_store_open(&home);

    let output = second_node_output(&home);
    assert!(
        refused_at_the_store(&output),
        "a second node was not turned away by the store lock:\n{output}"
    );
}

/// The incident: the home is deleted and re-initialised while a node still holds
/// it, and the second node then opens the same store unopposed. Two writers.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn replacing_the_home_under_a_live_node_lets_a_second_node_open_the_same_store() {
    let home = scratch_home("replaced");
    let _scratch = Scratch(home.clone());
    let _ = std::fs::remove_dir_all(&home);

    // 1. A node is running and healthy.
    init(&home, "35528", "35428");
    let _node_a = spawn_node(&home);
    wait_until_store_open(&home);
    let data_dir = home.join(NODE).join("data");
    let held_inode = inode_of(&data_dir);

    // 2. The home is deleted and re-initialised. Node A keeps running -
    //    unlinking a directory does not stop a process that has it open.
    std::fs::remove_dir_all(&home).expect("wipe the home");
    init(&home, "35528", "35428");
    assert_ne!(
        inode_of(&data_dir),
        held_inode,
        "the data directory was expected to be a new inode after the wipe"
    );

    // 3. The second node opens the very same store, because the lock the first
    //    node holds is on the directory that no longer exists at this path.
    let output = second_node_output(&home);
    assert!(
        opened_the_store(&output),
        "expected the second node to open the replaced store, got:\n{output}"
    );
}

fn inode_of(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .unwrap_or_else(|e| panic!("stat {}: {e}", path.display()))
        .ino()
}
