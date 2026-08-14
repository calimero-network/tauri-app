//! The guards asked against real merod processes, not fixtures.
//! `MEROD_BIN=... cargo test --test live_node_guard -- --ignored`

mod common;

use calimero_tauri_app::node_discovery::{
    discover_nodes, existing_node_for, is_signalable, nodes_under_path,
};
use common::{init, scratch_home, start_node, Scratch};

/// A live node is visible to the check `start_merod` runs, so the app adopts it
/// instead of putting a second writer on its store.
#[test]
#[ignore = "drives a real merod; run explicitly"]
fn a_live_node_is_found_by_the_guard_that_prevents_a_second_writer() {
    let home = scratch_home("guard");
    let _cleanup = Scratch(home.clone());

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
    let ours = scratch_home("ours");
    let theirs = scratch_home("theirs");
    let _c1 = Scratch(ours.clone());
    let _c2 = Scratch(theirs.clone());

    // Only the foreign node runs; ours is initialised but never started.
    let foreign = start_node(&theirs, "alice", "36628", "36528");
    init(&ours, "n1", "36828", "36728");

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
    let home = scratch_home("delete");
    let _cleanup = Scratch(home.clone());

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
        is_signalable(node.pid(), &running),
        "a discovered node must be signalable"
    );
    assert!(
        !is_signalable(u32::MAX, &running),
        "an unaccountable pid must not be"
    );
}
