# Live E2E: the desktop against real nodes

`e2e/` mocks every node response and never reaches a node. This suite starts
three real `merod` nodes and a local app registry, and drives desktop
sessions (one browser context per node) through flows that cross nodes.

`upgrade.spec.ts` covers this flow:

1. An admin installs a newer release of an app and upgrades a namespace from the desktop.
2. A member's node receives the upgrade at once, but its contexts keep running the older release.
3. The member switches from the namespace page: the release is installed, the contexts move, and the admin's write made meanwhile arrives.
4. The member's write on the new release reaches the admin's node.

`upgrade-ha.spec.ts` covers what the high-availability node is for, a third node that only replicates:

1. The member goes offline; the admin upgrades from the desktop and writes.
2. The high-availability node is switched to the new release, as a sidecar does with an install and an activate, and takes the write.
3. The admin goes offline; the member comes back with only that node to sync from, switches from the namespace card, and reads the admin's write.

`token-refresh.spec.ts` opens the desktop with an access token the node already refuses, and checks that the desktop rotates it once and stays signed in.
The nodes issue 5-second access tokens so this happens within one test.

`device-link.spec.ts` starts four desktops at first launch, each onboarding a node of its own, and covers this flow:

1. A founder creates a namespace, invites a member and removes it, which rotates the namespace key.
2. A joins after the rotation and opens a Restricted subgroup with a context.
3. A links a second computer B into its account through the Account screens.
4. B sees the subgroup, joins its context and reads A's write, A reads B's write, and a subgroup opened after the link reaches B too.
5. A revokes B from its Account screen; B drops the namespace, and a subgroup A opens afterwards reaches the founder but B can neither see nor read it.

In the browser, `e2e-live/bridge.ts` answers the shell's node commands (`init_merod_node`, `start_merod` and the like) with the same `merod init` and `merod run`, and refuses any data directory outside the test's own.
Set `PROOF_DIR` to save a full-page screenshot of each step there.

`uninstall.spec.ts` covers the uninstall dialog's outcomes on three fresh nodes per test:
an owner, the desktop's account, and a second device paired into that account.
Each test asserts what the nodes hold (namespaces, contexts, members, the forgotten marker), not only the dialog.
It skips on a merod that does not keep a restorable marker for a namespace removed from a device, so it starts running when the pinned merod is bumped.

## Run it

```sh
cd apps/desktop
MEROD_BINARY=/path/to/merod \
LIVE_BUNDLE_DIR=/dir/with/two/releases \
pnpm test:e2e:live
```

### `MEROD_BINARY`

Use the version `merod-config.json` pins, since that is what the desktop ships.

### `LIVE_BUNDLE_DIR`

Put exactly two `.mpk` releases of **one** package from **one** signer in this directory, so they share an application id. Either of these works:

- Fetch the two newest that your merod can run:

  ```sh
  MEROD_VERSION=0.11.0-rc.86 OUT_DIR=/tmp/releases node e2e-live/fetch-releases.mjs
  ```

- Build two versions of an app with the dev key, from a checkout of calimero-network/apps:

  ```sh
  cargo mero bundle --dev --app-version 1.0.0 ...
  cargo mero bundle --dev --app-version 1.0.1 ...
  ```

The `LIVE_BUNDLES` variable takes comma-separated paths instead of a directory.

### Screenshots

Set `LIVE_SHOTS_DIR` to a directory to save a full-page screenshot at each key step of the uninstall spec.

### Ports and data

- The nodes listen on ports the OS reports free, never on `2528`, and the pages are refused `2528`, so a running Calimero Desktop is neither touched nor seen.
- The web UI runs on port `1420`, or on `LIVE_UI_PORT` if another checkout's Vite already holds it.
- Data goes to a fresh `$TMPDIR/desktop-live-e2e-*`, or to `LIVE_DATA_DIR` if set.
- Each node's log is `<data dir>/live-N.log`, or `<data dir>/device-link-*/<desktop>.log`.
- The uninstall spec starts three fresh nodes per test, under `<data dir>/world-N`.

CI runs this in `.github/workflows/e2e-live.yml`.
