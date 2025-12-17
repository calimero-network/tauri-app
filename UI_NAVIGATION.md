# UI Navigation Guide

## App Flow & Navigation

### 1. **App Startup Flow**

When you start the app, it follows this flow:

```
App Starts
  ↓
Initialize Client (from settings)
  ↓
Check Onboarding State
  ├─ Auth available?
  ├─ Providers available?
  └─ Providers configured?
  ↓
Show Appropriate Screen
```

### 2. **Screen States**

#### **State 1: Checking Configuration**
- **What you see:** "Checking configuration..." message
- **When:** App is loading and checking auth status
- **Duration:** Usually 1-2 seconds
- **What happens:** Calls `/auth/health` and `/auth/providers`

#### **State 2: Onboarding Screen** (First Time)
- **What you see:** 
  - Welcome message: "Welcome to Calimero Desktop"
  - Description about first-time setup
  - "Get Started" button
- **When:** 
  - Auth is available
  - Providers are available
  - But NO providers are configured (no users exist)
- **Actions:**
  - Click "Get Started" → Shows login form
  - Click "Skip for Now" → Goes to Settings

#### **State 3: Login Screen**
- **What you see:**
  - Provider selection (if multiple)
  - Username/Password form
- **When:**
  - Auth is configured (has users)
  - But user is NOT logged in (no token)
- **Actions:**
  - Enter username/password
  - Click "Sign In"
  - On success → Goes to Main App

#### **State 4: Main App** (Logged In)
- **What you see:**
  - Header with "Calimero Desktop" title
  - ⚙️ Settings button (top right)
  - Two cards:
    - **Node Connection** card
    - **Auth Connection** card
- **When:** User has valid token
- **Actions:**
  - Click "Check Connection" → Tests node health
  - Click "Check Auth Health" → Tests auth health
  - Click ⚙️ Settings → Opens Settings page

#### **State 5: Settings Screen**
- **What you see:**
  - "← Back" button
  - "Settings" title
  - Node Configuration section:
    - Node URL input
    - Auth URL input (optional)
  - "Save Settings" button
- **Navigation:**
  - Click "← Back" → Returns to previous screen
  - Click "Save Settings" → Saves and returns

### 3. **Navigation Map**

```
┌─────────────────────────────────────────┐
│         App Startup                     │
└─────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────┐
    │ Checking Config...  │
    └─────────────────────┘
              │
              ▼
    ┌─────────────────────┐
    │  Onboarding State?  │
    └─────────────────────┘
         │            │
    YES  │            │ NO
         ▼            ▼
┌──────────────┐  ┌──────────────┐
│ Onboarding   │  │ Login Screen │
│ Screen       │  │              │
└──────────────┘  └──────────────┘
    │                  │
    │ "Get Started"    │ "Sign In"
    ▼                  ▼
┌──────────────┐  ┌──────────────┐
│ Login Form   │  │  Main App    │
└──────────────┘  └──────────────┘
    │                  │
    │ "Sign In"        │ ⚙️ Settings
    ▼                  ▼
┌──────────────┐  ┌──────────────┐
│  Main App    │  │  Settings    │
└──────────────┘  └──────────────┘
                         │
                         │ "← Back"
                         ▼
                  ┌──────────────┐
                  │  Main App    │
                  └──────────────┘
```

### 4. **Button Actions**

#### **Onboarding Screen:**
- **"Get Started"** → Opens login form to create first account
- **"Skip for Now"** → Goes to Settings page

#### **Login Screen:**
- **"Sign In"** → Authenticates user, then goes to Main App
- **"Back"** → Returns to provider selection (if applicable)

#### **Main App:**
- **"Check Connection"** → Tests node health endpoint
- **"Check Auth Health"** → Tests auth health endpoint
- **⚙️ Settings** → Opens Settings page

#### **Settings Screen:**
- **"← Back"** → Returns to Main App
- **"Save Settings"** → Saves node/auth URLs and returns

### 5. **Testing Navigation**

#### **Test First-Time Flow:**
1. Clear localStorage: `localStorage.clear()` in DevTools
2. Ensure no users exist in auth
3. Start app → Should see **Onboarding Screen**
4. Click "Get Started" → Should see **Login Form**
5. Create account → Should go to **Main App**

#### **Test Configured Flow:**
1. Have at least one user account
2. Clear only tokens: `localStorage.removeItem('calimero_access_token')`
3. Start app → Should see **Login Screen** directly
4. Log in → Should go to **Main App**

#### **Test Logged-In Flow:**
1. Have valid token in localStorage
2. Start app → Should go directly to **Main App**
3. Click ⚙️ Settings → Should see **Settings Screen**
4. Click "← Back" → Should return to **Main App**

### 6. **Visual Indicators**

#### **Status Indicators:**
- **Green dot** = Connected/Healthy
- **Red dot** = Disconnected/Unhealthy
- **"Connected"** text = Service is working
- **"Disconnected"** text = Service is not working

#### **Error Messages:**
- Red error boxes appear below buttons
- Show specific error messages from API
- Clear when you retry the action

#### **Loading States:**
- "Checking configuration..." = Initial load
- Button disabled = Action in progress
- No visual spinner (could be added)

### 7. **Keyboard Shortcuts**

Currently none, but you can:
- **Tab** = Navigate between form fields
- **Enter** = Submit forms
- **Escape** = Close modals (if any)

### 8. **Debug Navigation**

Open DevTools (F12 or Cmd+Option+I) to see:
- Console logs showing navigation state
- Network requests to auth/node APIs
- localStorage values (tokens, settings)

### 9. **Common Navigation Issues**

#### **Stuck on "Checking configuration..."**
- **Cause:** API calls failing or timing out
- **Fix:** Check network tab, verify node is running
- **Debug:** Look for errors in console

#### **Onboarding shows when it shouldn't**
- **Cause:** `configured: false` for all providers
- **Fix:** Check `/auth/providers` response
- **Debug:** Verify root keys exist in auth database

#### **Can't navigate back from Settings**
- **Cause:** Settings component not handling back properly
- **Fix:** Click "← Back" button
- **Debug:** Check `onBack` prop is passed correctly

#### **Login screen loops**
- **Cause:** Token not being saved after login
- **Fix:** Check token storage in localStorage
- **Debug:** Verify `setAccessToken` is called on success

### 10. **Quick Navigation Checklist**

- [ ] App starts and shows appropriate screen
- [ ] Onboarding appears for first-time users
- [ ] Login appears for configured but not logged in
- [ ] Main app appears for logged in users
- [ ] Settings button works from main app
- [ ] Back button works from settings
- [ ] Navigation flows are smooth
- [ ] No stuck states or infinite loops

