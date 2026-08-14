//! Finding node processes, and deciding which of them a destructive action may
//! touch.
//!
//! This exists because the app used to answer "is a node already running?" from
//! its own in-memory list, which dies with the process. A force-quit therefore
//! left an orphan the next launch could not see, and it started a second node on
//! the same RocksDB directory. Two writers then deleted the files each other's
//! manifest did not list, and the store was destroyed.
//!
//! So ownership of a node home is a property of the machine, not of app memory:
//! the OS process table is the source of truth, and every match is keyed on the
//! data directory rather than on a port or a process name.

use std::path::{Path, PathBuf};

/// A node process found in the OS process table.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct DiscoveredNode {
    pub pid: u32,
    pub home: String,
    pub node: String,
}

/// Canonical form where possible, so paths that differ only in spelling compare
/// equal. Falls back to the path as given when it does not exist yet.
pub fn resolved(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(unix)]
/// Parses `ps ax -o pid,command` output into the node processes it describes.
///
/// The executable path and the `--home` value can both contain spaces, so
/// neither is isolated by whitespace position: the executable is everything
/// before the first flag, and a flag's value runs to the next flag. Getting this
/// wrong is what blinded the app to its own node - the shipped binary lives at
/// `/Applications/Calimero Desktop.app/...`, and that space shifted every field.
fn parse_node_listing(listing: &str) -> Vec<DiscoveredNode> {
    fn flag_value<'a>(command: &'a str, flag: &str) -> Option<&'a str> {
        let needle = format!("{flag} ");
        let rest = &command[command.find(&needle)? + needle.len()..];
        let value = rest[..rest.find(" --").unwrap_or(rest.len())].trim_end();
        // merod takes its subcommand after the flags: `--node <name> run`.
        Some(value.strip_suffix(" run").unwrap_or(value))
    }

    listing
        .lines()
        .filter_map(|line| {
            let (pid, command) = line.trim_start().split_once(char::is_whitespace)?;
            let pid = pid.parse::<u32>().ok()?;
            let command = command.trim_start();
            let exe = command.split(" --").next().unwrap_or(command).trim_end();
            if exe.rsplit('/').next() != Some("merod") {
                return None;
            }
            if !command.split_whitespace().any(|token| token == "run") {
                return None;
            }
            Some(DiscoveredNode {
                pid,
                home: flag_value(command, "--home")?.to_string(),
                node: flag_value(command, "--node")?.to_string(),
            })
        })
        .collect()
}

#[cfg(unix)]
/// Node processes currently running on this machine.
pub fn discover_nodes() -> Vec<DiscoveredNode> {
    std::process::Command::new("ps")
        .args(["ax", "-o", "pid,command"])
        .output()
        .map(|out| parse_node_listing(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

/// The PID of a live node already serving `(home, node)`, if there is one.
/// Keyed on the data directory rather than the port: the port is incidental, the
/// directory is the resource two writers cannot share.
pub fn existing_node_for(running: &[DiscoveredNode], home: &Path, node: &str) -> Option<u32> {
    let home = resolved(home);
    running
        .iter()
        .find(|found| found.node == node && resolved(Path::new(&found.home)) == home)
        .map(|found| found.pid)
}

/// Nodes whose data directory sits at or under `target`. A destructive operation
/// on `target` would be pulling the ground out from under every one of them.
pub fn nodes_under_path<'a>(
    running: &'a [DiscoveredNode],
    target: &Path,
) -> Vec<&'a DiscoveredNode> {
    let target = resolved(target);
    running
        .iter()
        .filter(|found| resolved(&Path::new(&found.home).join(&found.node)).starts_with(&target))
        .collect()
}

#[cfg(unix)]
/// PIDs of shell processes running from `install_dir` - the directory this app
/// extracted its shell into.
///
/// Matched by install path, not by binary name. Name matching killed a developer's
/// `cargo run -p calimero-shell` from an unrelated checkout, and it *missed* the
/// app's own shells, because the installed path contains a space and the old parse
/// isolated the executable by whitespace position.
pub fn parse_shell_pids(listing: &str, install_dir: &Path) -> Vec<u32> {
    // Trailing separator so the prefix cannot match a sibling whose name merely
    // starts the same way - a leftover `shell-backup/` is not the shell directory.
    let prefix = format!("{}/", install_dir.to_string_lossy().trim_end_matches('/'));
    let mut pids: Vec<u32> = Vec::new();
    for line in listing.lines() {
        let Some((pid, command)) = line.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        if !command.starts_with(prefix.as_str()) {
            continue;
        }
        if let Ok(pid) = pid.parse::<u32>() {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// Where a node records that this app started it. Lives beside the node's `logs/`
/// and version pin, so it travels with the node.
fn claim_path(home: &Path, node: &str) -> PathBuf {
    home.join(node).join(".desktop-owner")
}

#[cfg(unix)]
/// A process's start time, as the OS reports it. Paired with the PID this
/// identifies a process: PIDs are recycled, start times are not.
fn process_start_time(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(unix)]
/// Records that this app started the node, so a later launch can tell its own
/// orphan - which it should adopt and shut down - from a node someone started by
/// hand, which it must leave alone.
pub fn write_claim(home: &Path, node: &str, pid: u32) -> std::io::Result<()> {
    let started = process_start_time(pid).unwrap_or_default();
    std::fs::write(claim_path(home, node), format!("{pid}\n{started}\n"))
}

#[cfg(unix)]
/// True when the claim names exactly this live process. A dead PID, a recycled
/// one, or a node this app never started all read as "not mine".
pub fn claim_matches(home: &Path, node: &str, pid: u32) -> bool {
    let Ok(body) = std::fs::read_to_string(claim_path(home, node)) else {
        return false;
    };
    let mut lines = body.lines();
    let claimed_pid: Option<u32> = lines.next().and_then(|l| l.trim().parse().ok());
    let claimed_start = lines.next().unwrap_or("").trim();
    claimed_pid == Some(pid)
        && !claimed_start.is_empty()
        && process_start_time(pid).as_deref() == Some(claimed_start)
}

/// Drops the claim once the node it named is gone.
pub fn remove_claim(home: &Path, node: &str) {
    let _ = std::fs::remove_file(claim_path(home, node));
}

/// Whether the app may signal this PID: the OS must report it as a node right
/// now. A bare PID from the webview is otherwise unaccountable, and the OS
/// recycles PIDs, so an unchecked one can name an unrelated process.
///
/// Deliberately not satisfied by the app's own tracked state: a tracked PID the
/// process table no longer lists is dead, and signalling it either does nothing
/// or reaches whatever inherited the number.
pub fn is_signalable(pid: u32, running: &[DiscoveredNode]) -> bool {
    running.iter().any(|found| found.pid == pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovered(listing: &str) -> Vec<(u32, String, String)> {
        parse_node_listing(listing)
            .into_iter()
            .map(|n| (n.pid, n.home, n.node))
            .collect()
    }

    fn found(pid: u32, home: &Path, node: &str) -> DiscoveredNode {
        DiscoveredNode {
            pid,
            home: home.to_string_lossy().to_string(),
            node: node.to_string(),
        }
    }

    /// Removes the scratch directories when the test ends, however it ends.
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Two real directories, since matching canonicalises and that needs them to exist.
    fn two_homes(tag: &str) -> (Cleanup, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("calimero-disc-{}-{tag}", std::process::id()));
        let (a, b) = (base.join("home-a"), base.join("home-b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        (Cleanup(base), a, b)
    }

    #[test]
    fn reads_home_and_node_from_a_bundled_path() {
        let listing = "36331 /Applications/Calimero Desktop.app/Contents/Resources/merod/merod \
                       --home /Users/x/.calimero --node default run";
        assert_eq!(
            discovered(listing),
            vec![(36331, "/Users/x/.calimero".into(), "default".into())]
        );
    }

    /// `ps ax` right-aligns the PID column and emits a header row.
    #[test]
    fn tolerates_the_padded_pid_column_and_the_header() {
        let listing = concat!(
            "  PID COMMAND\n",
            " 3680 /Applications/Calimero Desktop.app/Contents/Resources/merod/merod",
            " --home /Users/x/.calimero --node default run\n"
        );
        assert_eq!(
            discovered(listing),
            vec![(3680, "/Users/x/.calimero".into(), "default".into())]
        );
    }

    #[test]
    fn reads_a_home_path_containing_a_space() {
        let listing = "77 /usr/local/bin/merod --home /Users/x/My Nodes --node n1 run";
        assert_eq!(
            discovered(listing),
            vec![(77, "/Users/x/My Nodes".into(), "n1".into())]
        );
    }

    #[test]
    fn finds_a_cargo_built_node() {
        let listing = "4711 /Users/x/core/target/debug/merod --home /Users/x/dev --node alice run";
        assert_eq!(
            discovered(listing),
            vec![(4711, "/Users/x/dev".into(), "alice".into())]
        );
    }

    /// The cargo parent's own command line mentions merod; only its child is a node.
    #[test]
    fn ignores_the_cargo_wrapper_process() {
        let listing = "4710 cargo run -p merod -- --home /Users/x/dev --node alice run";
        assert_eq!(discovered(listing), vec![]);
    }

    /// A substring match reported an unrelated `awk` as a running node.
    #[test]
    fn ignores_processes_that_merely_mention_merod() {
        let listing = "91 grep --color=auto -r merod run\n\
                       92 awk /merod/ && /run/\n\
                       93 /bin/sh -c sleep 20; : merod --node w run";
        assert_eq!(discovered(listing), vec![]);
    }

    #[test]
    fn a_node_already_serving_this_home_and_name_is_reused() {
        let (_cleanup, home, _other) = two_homes("reuse");
        let running = [found(4711, &home, "default")];
        assert_eq!(existing_node_for(&running, &home, "default"), Some(4711));
    }

    /// The hijack: a node with a familiar name on someone else's home is not ours.
    #[test]
    fn a_node_with_the_same_name_on_another_home_is_not_reused() {
        let (_cleanup, home, other) = two_homes("other-home");
        let running = [found(4711, &other, "default")];
        assert_eq!(existing_node_for(&running, &home, "default"), None);
    }

    #[test]
    fn a_different_node_in_the_same_home_is_not_reused() {
        let (_cleanup, home, _other) = two_homes("other-node");
        let running = [found(4711, &home, "mydev")];
        assert_eq!(existing_node_for(&running, &home, "default"), None);
    }

    #[test]
    fn a_home_spelled_differently_still_matches() {
        let (_cleanup, home, _other) = two_homes("spelling");
        let scenic = home.join(".").join("..").join("home-a");
        let running = [found(4711, &scenic, "default")];
        assert_eq!(existing_node_for(&running, &home, "default"), Some(4711));
    }

    #[test]
    fn nothing_running_means_nothing_to_reuse() {
        let (_cleanup, home, _other) = two_homes("empty");
        assert_eq!(existing_node_for(&[], &home, "default"), None);
    }

    #[test]
    fn a_node_inside_the_target_path_blocks_it() {
        let (_cleanup, home, _other) = two_homes("under");
        std::fs::create_dir_all(home.join("default")).unwrap();
        let running = [found(4711, &home, "default")];
        assert_eq!(
            nodes_under_path(&running, &home)
                .iter()
                .map(|n| n.pid)
                .collect::<Vec<_>>(),
            vec![4711]
        );
    }

    /// Deleting one node's directory must not implicate its siblings.
    #[test]
    fn a_sibling_node_does_not_block_deleting_another_node_dir() {
        let (_cleanup, home, _other) = two_homes("sibling");
        std::fs::create_dir_all(home.join("mydev")).unwrap();
        std::fs::create_dir_all(home.join("default")).unwrap();
        let running = [found(4711, &home, "mydev")];
        assert!(nodes_under_path(&running, &home.join("default")).is_empty());
    }

    #[test]
    fn a_node_on_an_unrelated_home_never_blocks_a_delete() {
        let (_cleanup, home, other) = two_homes("unrelated");
        std::fs::create_dir_all(other.join("alice")).unwrap();
        let running = [found(4711, &other, "alice")];
        assert!(nodes_under_path(&running, &home).is_empty());
    }

    /// The exact node directory being deleted is "at or under" the target.
    #[test]
    fn deleting_a_nodes_own_directory_is_blocked_by_that_node() {
        let (_cleanup, home, _other) = two_homes("exact");
        let node_dir = home.join("default");
        std::fs::create_dir_all(&node_dir).unwrap();
        let running = [found(4711, &home, "default")];
        assert_eq!(nodes_under_path(&running, &node_dir).len(), 1);
    }




    /// The installed shell lives under "Application Support" - a path with a space,
    /// which is exactly what the old name-based match got wrong.
    #[test]
    fn shells_are_matched_by_install_path_including_spaces() {
        let install = Path::new("/Users/x/Library/Application Support/network.calimero.desktop/shell");
        let listing = concat!(
            "  PID COMMAND\n",
            " 501 /Users/x/Library/Application Support/network.calimero.desktop/shell/CalimeroShell --app-id abc\n",
        );
        assert_eq!(parse_shell_pids(listing, install), vec![501]);
    }

    /// A developer's own shell build is not the app's to kill.
    #[test]
    fn a_shell_from_a_checkout_is_left_alone() {
        let install = Path::new("/Users/x/Library/Application Support/network.calimero.desktop/shell");
        let listing = "502 /Users/x/code/tauri-app/target/debug/calimero-shell --app-id abc";
        assert!(parse_shell_pids(listing, install).is_empty());
    }

    /// A sibling directory whose name merely starts the same way is not ours.
    #[test]
    fn a_shell_in_a_sibling_directory_is_not_ours() {
        let install = Path::new("/Users/x/Library/Application Support/network.calimero.desktop/shell");
        let listing = concat!(
            "504 /Users/x/Library/Application Support/network.calimero.desktop/shell-backup/CalimeroShell\n",
            "505 /Users/x/Library/Application Support/network.calimero.desktop/shell2/CalimeroShell\n",
        );
        assert!(parse_shell_pids(listing, install).is_empty());
    }

    /// Same binary name, elsewhere on disk: still not ours.
    #[test]
    fn a_same_named_binary_elsewhere_is_not_ours() {
        let install = Path::new("/Users/x/Library/Application Support/network.calimero.desktop/shell");
        let listing = "503 /tmp/evil/CalimeroShell";
        assert!(parse_shell_pids(listing, install).is_empty());
    }

    /// Our own live node: the app may adopt it and stop it on quit.
    #[test]
    fn a_claim_naming_this_live_process_is_ours() {
        let (_cleanup, home, _other) = two_homes("claim-ours");
        std::fs::create_dir_all(home.join("n1")).unwrap();
        let me = std::process::id();
        write_claim(&home, "n1", me).unwrap();
        assert!(claim_matches(&home, "n1", me));
    }

    /// A node nobody claimed - started from a terminal - is not the app's to manage.
    #[test]
    fn an_unclaimed_node_is_not_ours() {
        let (_cleanup, home, _other) = two_homes("claim-none");
        std::fs::create_dir_all(home.join("n1")).unwrap();
        assert!(!claim_matches(&home, "n1", std::process::id()));
    }

    /// PIDs are recycled: the claim must name the same process, not just the number.
    #[test]
    fn a_claim_whose_start_time_disagrees_is_stale() {
        let (_cleanup, home, _other) = two_homes("claim-stale");
        std::fs::create_dir_all(home.join("n1")).unwrap();
        let me = std::process::id();
        std::fs::write(claim_path(&home, "n1"), format!("{me}\nWed Jan  1 00:00:00 2020\n")).unwrap();
        assert!(
            !claim_matches(&home, "n1", me),
            "a recycled PID must not inherit the old claim"
        );
    }

    #[test]
    fn a_claim_for_a_different_pid_is_not_ours() {
        let (_cleanup, home, _other) = two_homes("claim-other");
        std::fs::create_dir_all(home.join("n1")).unwrap();
        write_claim(&home, "n1", std::process::id()).unwrap();
        assert!(!claim_matches(&home, "n1", 999_999));
    }

    #[test]
    fn a_removed_claim_stops_being_ours() {
        let (_cleanup, home, _other) = two_homes("claim-removed");
        std::fs::create_dir_all(home.join("n1")).unwrap();
        let me = std::process::id();
        write_claim(&home, "n1", me).unwrap();
        remove_claim(&home, "n1");
        assert!(!claim_matches(&home, "n1", me));
    }

    /// A dev build must not share the installed app's data directory, or it steals
    /// its host socket and the single-instance plugin routes launches to the wrong
    /// binary. Tests are a debug build, so this pins the dev-side value.
    #[test]
    fn a_debug_build_uses_its_own_app_directory() {
        assert_eq!(
            crate::app_dir_name(),
            "network.calimero.desktop.dev",
            "debug builds must be isolated from the installed app"
        );
    }

    /// The webview asks for a PID by number; the backend must not take its word.
    #[test]
    fn a_pid_the_app_cannot_account_for_is_not_signalable() {
        let (_cleanup, home, _other) = two_homes("signalable");
        let running = [found(11, &home, "default")];
        assert!(is_signalable(11, &running), "a node the OS reports");
        assert!(
            !is_signalable(999, &running),
            "an unrelated process must be refused"
        );
        assert!(
            !is_signalable(11, &[]),
            "a PID the process table no longer lists is dead, tracked or not"
        );
    }
}
