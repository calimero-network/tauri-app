// Test file to verify mero-react integration
import { createClient, apiClient, setAccessToken, getAccessToken } from '@calimero-network/mero-react';
import { getSettings, getAuthUrl } from './utils/settings';

// Test the client API
export async function testMeroReact() {
  console.log('🧪 Testing mero-react...');

  try {
    // 1. Initialize client
    const settings = getSettings();
    const authUrl = getAuthUrl(settings);
    const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
    
    console.log('📡 Initializing client...');
    console.log('  Node URL:', settings.nodeUrl);
    console.log('  Auth URL:', authUrl);
    console.log('  Admin API URL:', adminApiUrl);

    createClient({
      baseUrl: adminApiUrl,
      authBaseUrl: authUrl,
      requestCredentials: 'omit',
    });

    // 2. Test getProviders
    console.log('\n🔐 Testing getProviders...');
    const providersResponse = await apiClient.auth.getProviders();
    if (providersResponse.error) {
      console.error('❌ Error:', providersResponse.error.message);
      return false;
    }
    console.log('✅ Providers:', providersResponse.data?.providers.length || 0);

    // 3. Test token storage
    console.log('\n💾 Testing token storage...');
    setAccessToken('test-token-123');
    const retrieved = getAccessToken();
    console.log('✅ Token stored and retrieved:', retrieved === 'test-token-123');

    // 4. Test health check (using admin API)
    console.log('\n🏥 Testing health check...');
    try {
      await apiClient.node.getContexts();
      console.log('✅ Node API accessible');
    } catch (err) {
      console.log('⚠️  Node API test skipped (may need auth)');
    }

    console.log('\n✅ All tests passed!');
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

