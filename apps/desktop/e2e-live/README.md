# Live E2E: the desktop against real nodes

`e2e/` mocks every node response and never reaches a node. This suite starts
two real `merod` nodes and a local app registry, and drives two desktop
sessions (one browser context per node) through flows that cross nodes.

`upgrade.spec.ts` covers this flow:

1. An admin installs a newer release of an app and upgrades a namespace from the desktop.
2. A member's node receives the upgrade at once, but fetches the release only when the app is next used there.
3. After that use, the member's write on the new release reaches the admin's node.

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

### Ports and data

- The nodes listen on `127.0.0.1:2840` and up (`LIVE_BASE_PORT`), never on `2528`, so a running Calimero Desktop is safe.
- Data goes to `$TMPDIR/desktop-live-e2e`, or to `LIVE_DATA_DIR` if set.
- Each node's log is `<data dir>/live-N.log`.

CI runs this in `.github/workflows/e2e-live.yml`.
