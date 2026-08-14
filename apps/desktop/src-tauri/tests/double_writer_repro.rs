//! Two live nodes on one store: the LOCK is bound to an inode, so replacing the home
//! defeats it. `MEROD_BIN=... cargo test --test double_writer_repro -- --ignored`

mod common;

use common::{init, merod, scratch_home, spawn_node, wait_until_store_open, Scratch};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const NODE: &str = "n1";
/// Long enough for a second node to be refused by the store, or to get past it.
const SETTLE: Duration = Duration::from_secs(15);

/// A second `merod run` on `home`, with its output captured.
fn spawn_second_node(home: &Path) -> Child {
    Command::new(merod())
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
        .expect("spawn second merod")
}

/// The verdict is the process, not the wording: its output if it stopped, and `None`
/// while it is still serving - which is a second writer on the store.
fn output_if_it_stopped(mut child: Child) -> Option<String> {
    let deadline = Instant::now() + SETTLE;
    while Instant::now() < deadline {
        if child.try_wait().expect("poll merod").is_some() {
            let out = child.wait_with_output().expect("collect merod output");
            return Some(format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    None
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

    let output = output_if_it_stopped(spawn_second_node(&home))
        .expect("a second node on an intact home must not keep running");
    // Which store turned it away, by the path of the lock it could not take. The
    // wording around it is merod's to change.
    let lock = home.join(NODE).join("data").join("LOCK");
    assert!(
        output.contains(&lock.display().to_string()),
        "the second node stopped, but not on {}:\n{output}",
        lock.display()
    );
}

/// The incident: the home is deleted and re-initialised while a node still holds it,
/// and the second node then serves from the same store. Two writers.
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

    // 2. The home is deleted and re-initialised on free ports, so nothing but the
    //    store can turn the second node away. Node A keeps running regardless.
    std::fs::remove_dir_all(&home).expect("wipe the home");
    init(&home, NODE, "35529", "35429");
    assert_ne!(
        inode_of(&data_dir),
        held_inode,
        "the data directory was expected to be a new inode after the wipe"
    );

    // 3. The second node opens the very same store and keeps running, because the
    //    lock node A holds is on the directory that no longer exists at this path.
    if let Some(output) = output_if_it_stopped(spawn_second_node(&home)) {
        panic!("expected a second live writer on the replaced store, but it stopped:\n{output}");
    }
}
