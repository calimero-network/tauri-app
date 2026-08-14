//! Reproduces the root condition of the 14 Aug 2026 data loss: two live nodes
//! holding one store.
//!
//! RocksDB normally refuses the second opener - its LOCK file is an `fcntl` lock
//! and the second process cannot take it. But the lock is bound to an *inode*,
//! so replacing the node home leaves the first node holding a lock nobody can
//! see, and the second walks in. From there each instance deletes the files its
//! own manifest does not list, which is what destroyed the store overnight.
//!
//! The two tests are a pair: the control shows the lock working, and the second
//! shows it defeated. Keeping the control is deliberate - it is what makes the
//! second test mean something, and if it ever fails then the store lock has
//! started covering this case and the app guard is no longer the only thing
//! standing here. The overnight corruption itself is not reproduced (it needs
//! hours of write activity); this is the condition it requires.
//!
//! Ignored by default: drives a real merod. Run with
//!   MEROD_BIN=/path/to/merod cargo test --test double_writer_repro -- --ignored

mod common;

use common::{init, merod, scratch_home, spawn_node, wait_until_store_open, Scratch};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const NODE: &str = "n1";

/// Starts a second node on `home` and returns everything it printed before it
/// stopped. It always stops - the first node holds the port - so what matters is
/// how far it got: refused at the store, or all the way to a running node.
fn second_node_output(home: &Path) -> String {
    let mut child = Command::new(merod())
        .args([
            "--home".as_ref(),
            home.as_os_str(),
            "--node".as_ref(),
            NODE.as_ref(),
        ])
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

fn inode_of(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .unwrap_or_else(|e| panic!("stat {}: {e}", path.display()))
        .ino()
}

/// Control: with the home intact, RocksDB's own lock stops the second node.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn a_second_node_on_an_intact_home_is_refused_by_the_store_lock() {
    let home = scratch_home("intact");
    let _cleanup = Scratch(home.clone());

    init(&home, NODE, "34528", "34428");
    let _node_a = spawn_node(&home, NODE);
    wait_until_store_open(&home, NODE);

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
    let _cleanup = Scratch(home.clone());

    // 1. A node is running and healthy.
    init(&home, NODE, "35528", "35428");
    let _node_a = spawn_node(&home, NODE);
    wait_until_store_open(&home, NODE);
    let data_dir = home.join(NODE).join("data");
    let held_inode = inode_of(&data_dir);

    // 2. The home is deleted and re-initialised. Node A keeps running -
    //    unlinking a directory does not stop a process that has it open.
    std::fs::remove_dir_all(&home).expect("wipe the home");
    init(&home, NODE, "35528", "35428");
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
