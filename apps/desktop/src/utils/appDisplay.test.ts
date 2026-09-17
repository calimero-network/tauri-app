import { describe, it, expect } from 'vitest';
import { needsDisplayBackfill, withDisplay } from './appDisplay';

// The example row core seeds for a follower whose bytecode arrived by blob
// share instead of a registry install: package/version set, metadata empty.
const BLOB_SHARE_ROW = {
  id: '3f550253',
  package: 'com.calimero.chat',
  version: '3.1.1',
  blob: { bytecode: 'e348' },
  metadata: [],
  source: 'calimero://pending-blob-share',
};

describe('needsDisplayBackfill', () => {
  it('is true for a row with package/version but no name in its metadata', () => {
    expect(needsDisplayBackfill(BLOB_SHARE_ROW)).toBe(true);
  });

  it('is false once metadata already carries a name', () => {
    const row = { ...BLOB_SHARE_ROW, metadata: { name: 'Mero Chat' } };
    expect(needsDisplayBackfill(row)).toBe(false);
  });

  it('is false without a package', () => {
    const row = { ...BLOB_SHARE_ROW, package: undefined };
    expect(needsDisplayBackfill(row)).toBe(false);
  });

  it('is false without a version', () => {
    const row = { ...BLOB_SHARE_ROW, version: undefined };
    expect(needsDisplayBackfill(row)).toBe(false);
  });
});

describe('withDisplay', () => {
  it('sets metadata to the display object', () => {
    const display = { name: 'Mero Chat', icon: 'data:image/png;base64,QUJD' };
    const row = withDisplay(BLOB_SHARE_ROW, display);

    expect(row.metadata).toBe(display);
    expect(row).not.toBe(BLOB_SHARE_ROW);
  });

  it('leaves the row unchanged when display is null', () => {
    expect(withDisplay(BLOB_SHARE_ROW, null)).toBe(BLOB_SHARE_ROW);
  });

  it('a display can only ever carry name/icon/description, since fetchBundleDisplay strips the rest', () => {
    const display = { name: 'Mero Chat', icon: 'data:image/png;base64,QUJD', description: 'Chat' };
    const row = withDisplay(BLOB_SHARE_ROW, display);

    expect(Object.keys(row.metadata as object).sort()).toEqual(['description', 'icon', 'name']);
  });
});
