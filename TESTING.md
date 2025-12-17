# Testing the Onboarding Flow

## Prerequisites

1. **Ensure your merod node is running:**
   ```bash
   cd ~/.calimero/node1
   merod run
   ```

2. **Check if auth is enabled:**
   - Auth should be running on port 3001 (or configured port)
   - Check: `curl http://localhost:3001/auth/health`

## Test Scenarios

### Scenario 1: First-Time Setup (No Configured Providers)

**Setup:**
1. Make sure no root keys exist in your auth database
2. Clear localStorage in the app (or use a fresh browser profile)
3. Start the app

**Expected Behavior:**
- App should show onboarding screen
- Message: "Welcome to Calimero Desktop"
- Should show "Get Started" button
- Clicking "Get Started" should show login form
- Creating first account should work (bootstrap mode)

**To reset for testing:**
```bash
# Stop merod
# Delete auth database
rm -rf ~/.calimero/node1/data/auth_db_local
# Restart merod
merod run
```

### Scenario 2: Configured but Not Logged In

**Setup:**
1. Ensure at least one root key exists (user account created)
2. Clear localStorage tokens (but keep settings)
3. Start the app

**Expected Behavior:**
- App should skip onboarding
- Should show login screen directly
- User can log in with existing credentials

**To create a test account:**
```bash
# Via admin API (if available)
curl -X POST http://localhost:2528/admin-api/keys/root \
  -H "Content-Type: application/json" \
  -d '{
    "public_key": "testuser",
    "auth_method": "user_password",
    "provider_data": {
      "username": "testuser",
      "password": "testpass123"
    }
  }'
```

Or use the admin dashboard at `http://localhost:2528/admin-dashboard/identity/root-key`

### Scenario 3: Already Logged In

**Setup:**
1. Have a configured provider
2. Have valid tokens in localStorage
3. Start the app

**Expected Behavior:**
- Should skip onboarding
- Should skip login
- Should show main app directly
- Should load contexts automatically

### Scenario 4: Auth Service Not Available

**Setup:**
1. Stop the auth service or point to wrong URL
2. Start the app

**Expected Behavior:**
- Should show onboarding screen with error
- Message: "Authentication Service Unavailable"
- Should have "Go to Settings" button

### Scenario 5: No Providers Available

**Setup:**
1. Auth service running but no providers configured
2. Start the app

**Expected Behavior:**
- Should show onboarding screen
- Message: "No Authentication Providers"
- Should guide user to configure providers

## Debugging

### Check Browser Console

Open DevTools (F12 or Cmd+Option+I) and look for:
- `[mero-js]` logs
- `✅ Login successful` or `❌ Login failed`
- Onboarding state logs

### Check Network Tab

Look for:
- `/auth/health` - Should return 200 with `{"status": "healthy"}`
- `/auth/providers` - Should return providers list
- Check if `configured: true` for any provider

### Manual API Testing

```bash
# Check auth health
curl http://localhost:3001/auth/health

# Check providers
curl http://localhost:3001/auth/providers

# Expected response:
# {
#   "providers": [
#     {
#       "name": "user_password",
#       "type": "user_password",
#       "description": "Username/Password authentication",
#       "configured": true/false,  // <-- This determines onboarding
#       "config": {}
#     }
#   ],
#   "count": 1
# }
```

### Clear App State for Testing

**In Browser DevTools Console:**
```javascript
// Clear all localStorage
localStorage.clear();

// Or clear specific keys
localStorage.removeItem('calimero_access_token');
localStorage.removeItem('calimero_refresh_token');
localStorage.removeItem('calimero-desktop-settings');
```

## Expected Flow Diagram

```
App Start
  ↓
Check Auth Health
  ↓
Check Providers
  ↓
┌─────────────────────────────────┐
│ Are providers configured?       │
└─────────────────────────────────┘
  │                    │
  NO                   YES
  ↓                    ↓
Show Onboarding    Check Token
  ↓                    │
Create Account      ┌───┴───┐
  ↓                 │       │
Login              NO      YES
  ↓                 ↓       ↓
Main App        Show Login  Main App
```

## Common Issues

### Issue: "Authentication Service Unavailable"
- **Cause:** Auth service not running or wrong URL
- **Fix:** Check settings, ensure auth URL is correct
- **Test:** `curl http://localhost:3001/auth/health`

### Issue: "No Authentication Providers"
- **Cause:** Providers not enabled in auth config
- **Fix:** Check `~/.calimero/node1/config.toml`:
  ```toml
  [providers]
  user_password = true
  ```

### Issue: Onboarding shows but providers are configured
- **Cause:** `configured` flag might be false even with users
- **Fix:** Check `/auth/providers` response
- **Note:** Provider is `configured: true` when it has at least one root key

### Issue: Stuck on "Checking configuration..."
- **Cause:** API calls failing or timing out
- **Fix:** Check network tab, verify node is running
- **Test:** Check console for errors

## Quick Test Checklist

- [ ] App starts without errors
- [ ] Onboarding screen appears for first-time users
- [ ] Login screen appears for configured but not logged in
- [ ] Main app appears for logged in users
- [ ] Error messages are clear and helpful
- [ ] "Go to Settings" button works
- [ ] Creating first account works (bootstrap)
- [ ] Logging in with existing account works

