# Calimero Desktop UX Implementation Plan

This document tracks the implementation of UX improvements based on user feedback and codebase analysis.

**Last Updated:** 2025-01-30

---

## Implementation Order

### Phase 1: Critical Fixes (Week 1)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 1 | Username/password validation | ✅ Done | `Onboarding.tsx`, `mero-react/UsernamePasswordForm.tsx` | Alphanumeric+underscore, no spaces, min 8 chars |
| 2 | Node disconnect recovery | ✅ Done | `App.tsx`, `App.css` | "Open Nodes" CTA, friendly hint when disconnected |
| 3 | Onboarding: existing node detection | ✅ Done | `Onboarding.tsx`, `Onboarding.css` | Detect nodes, "Use existing" dropdown, friendly init error |

### Phase 2: High Priority (Week 2)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 4 | Scroll indicators on small screens | ✅ Done | `ScrollHint.tsx`, `Onboarding.tsx`, `NodeManagement.tsx` | "Scroll for more" when content overflows |
| 5 | Nodes tab redesign | ✅ Done | `NodeManagement.tsx`, `NodeManagement.css` | Connection vs Local sections, node status cards |
| 6 | Node logs (developer mode) | ✅ Done | `main.rs`, `merod.ts`, `NodeManagement.tsx` | Log capture on start, get_merod_logs, View Logs modal |

### Phase 3: Medium Priority (Week 3)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 7 | Global node status indicator | ✅ Done | `NodeStatusIndicator.tsx`, `App.tsx`, `Sidebar.tsx` | Status in header on all pages, clickable to Nodes when disconnected |
| 8 | "Use existing node" path in onboarding | 🔲 Not Started | `Onboarding.tsx` | Skip creation, enter URL directly |
| 9 | Form validation feedback | 🔲 Not Started | Multiple forms | Real-time validation, inline errors |
| 10 | Data directory UX | 🔲 Not Started | `Onboarding.tsx`, `NodeManagement.tsx` | Show resolved path, validate writable |

### Phase 4: Polish (Week 4+)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 11 | System tray / background mode | ✅ Done | `main.rs`, `tauri.conf.json` | Tray icon, close→hide, Show/Quit menu |
| 12 | Error message improvements | 🔲 Not Started | Multiple | User-friendly copy, suggested actions |
| 13 | Tooltips | 🔲 Not Started | New component, multiple pages | Hover tooltips for icons/buttons |
| 14 | Keyboard shortcuts | 🔲 Not Started | `App.tsx` | Cmd+, Cmd+1-5, Esc |
| 15 | Onboarding recovery/resume | 🔲 Not Started | `Onboarding.tsx`, localStorage | Save progress |

---

## Detailed Specifications

### 1. Username/Password Validation

**Requirements:**
- Username: no leading/trailing whitespace, no internal spaces, alphanumeric + underscore only
- Username: trim on blur, show error if spaces remain
- Password: minimum 8 characters
- Real-time validation (on blur or while typing)
- Clear error messages: "Username cannot contain spaces", "Password must be at least 8 characters"

**Implementation:**
- Add validation in `UsernamePasswordForm` (Onboarding.tsx) and mero-react `LoginView` if used elsewhere
- Regex: `username: /^[a-zA-Z0-9_]+$/`
- Disable submit until valid

---

### 2. Node Disconnect Recovery

**Requirements:**
- When `connected === false` and `error` exists: show friendly message
- Add button: "Open Nodes" or "Restart Node" that navigates to nodes page
- Copy: "Your node appears to be disconnected. This can happen after your computer sleeps. Go to Nodes to restart it."
- Consider: "Retry" button that re-runs health check

**Implementation:**
- Update `status-card-simple` / `status-error` section in App.tsx
- Add CTA button below error message
- Ensure nodes page is accessible when disconnected

---

### 3. Onboarding: Existing Node Detection

**Requirements:**
- Before node-setup step: call `listMerodNodes(dataDir)` and `detectRunningMerodNodes()`
- If nodes exist in data dir:
  - Show option: "I have existing nodes" → list them, let user pick one
  - Option: "Create new node" → current flow
- If node already running on default port: auto-detect, skip creation, go to login
- If init fails with "already exists": show "Node 'default' already exists. Choose 'Use existing' or pick a different name."

**Implementation:**
- Add pre-check in Onboarding node-setup step (before form)
- New UI branch: existing nodes list with "Use this node" vs "Create new"
- Handle `init_merod_node` error for duplicate node name
- Consider: default to "default" but allow user to see existing and select

---

### 4. Scroll Indicators

**Requirements:**
- On scrollable containers (onboarding step, node management): add fade gradient at bottom when content overflows
- Optional: "Scroll for more ↓" text that disappears after first scroll
- Ensure Advanced Options button is above the fold on common viewport sizes (or add scroll hint near it)

**Implementation:**
- CSS: `mask-image` or pseudo-element gradient at bottom of `.onboarding-step-container`
- JS: detect overflow, show/hide scroll hint
- Or: `scroll-snap` or `overflow: auto` with `scroll-behavior: smooth` + visual cue

---

### 5. Nodes Tab Redesign

**Requirements:**
- Clear sections: 1) Connected Node Config, 2) Local Node Management
- Status card per node: name, port, Running/Stopped, Start/Stop, Logs (dev mode)
- Visual hierarchy: primary action (Start/Connect) prominent
- Remove duplicate port fields; single source of truth
- Help text: "Configure which node the app connects to. Create and start a local node, or enter a remote node URL."

**Implementation:**
- Restructure NodeManagement.tsx layout
- New components: NodeStatusCard, NodeConfigForm
- Consolidate Node URL (connect to) vs Create/Start (local) into clear flow

---

### 6. Node Logs (Developer Mode)

**Requirements:**
- New Tauri command: `get_merod_logs(node_name?, home_dir?)` - reads from merod process or log file
- If merod runs with stdout/stderr to file: read that. Else: consider capturing at start (future)
- UI: "View Logs" button in Nodes tab (only when developer mode)
- Modal or slide-out panel with log content, scrollable, optional refresh

**Implementation:**
- Check if merod writes logs to file (e.g. `~/.calimero/<node>/logs/`)
- Tauri: `std::fs::read_to_string` or tail last N lines
- Frontend: logs viewer component, invoke command on click

---

## Status Legend

- 🔲 Not Started
- 🟡 In Progress
- ✅ Done
- ⏸️ Blocked

---

## Changelog

| Date | Change |
|------|--------|
| 2025-01-30 | Created implementation plan |
| 2025-01-30 | Phase 1 complete: Username/password validation, Node disconnect recovery, Onboarding existing node detection |

