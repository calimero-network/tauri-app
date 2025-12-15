import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MeroJs } from '@calimero-network/mero-js';

// Test configuration
const AUTH_CONFIG = {
  baseUrl: process.env.AUTH_API_BASE_URL || 'http://localhost',
  credentials: {
    username: 'admin',
    password: 'admin123',
  },
  timeoutMs: 10000,
};

describe('Auth API E2E Tests', () => {
  let meroJs: MeroJs;

  beforeAll(async () => {
    console.log('🚀 Starting merobox environment...');

    // Start merobox with auth service
    const { spawn } = await import('child_process');

    console.log('🔧 Starting Calimero node with auth service...');
    const meroboxProcess = spawn('merobox', ['run', '--auth-service'], {
      stdio: 'pipe',
      cwd: process.cwd(),
    });

    // Add error handling for merobox process
    meroboxProcess.on('error', (error) => {
      console.error('❌ Merobox process error:', error);
    });

    meroboxProcess.stderr.on('data', (data) => {
      console.error('❌ Merobox stderr:', data.toString());
    });

    meroboxProcess.stdout.on('data', (data) => {
      console.log('📝 Merobox stdout:', data.toString());
    });

    // Wait for services to be ready
    console.log('⏳ Waiting for services to start...');
    await new Promise((resolve) => setTimeout(resolve, 60000)); // Wait 60 seconds

    console.log('🔧 Creating MeroJs SDK...');
    console.log('Auth API URL:', AUTH_CONFIG.baseUrl);

    // Create MeroJs SDK instance
    meroJs = new MeroJs(AUTH_CONFIG);

    // Authenticate (this creates the root key on first use)
    console.log('🔑 Authenticating with MeroJs SDK...');
    const tokenData = await meroJs.authenticate();

    console.log('✅ Authentication successful!');
    console.log('🎫 Token expires at:', new Date(tokenData.expires_at));
  }, 120000); // 2 minute timeout for beforeAll

  afterAll(async () => {
    console.log('🧹 Cleaning up merobox environment...');

    try {
      const { spawn } = await import('child_process');

      console.log('🗑️ Running merobox nuke --force...');
      const nukeProcess = spawn('merobox', ['nuke', '--force'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });

      // Wait for nuke to complete with timeout
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('⚠️ Merobox cleanup timeout, killing process...');
          nukeProcess.kill('SIGTERM');
          resolve(void 0);
        }, 90000); // 90 second timeout

        nukeProcess.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            console.log('✅ Merobox cleanup completed successfully');
            resolve(void 0);
          } else {
            console.warn('⚠️ Merobox cleanup completed with code:', code);
            resolve(void 0); // Don't fail the test for cleanup issues
          }
        });
        nukeProcess.on('error', (error) => {
          clearTimeout(timeout);
          console.warn('⚠️ Merobox cleanup failed:', error);
          resolve(void 0); // Don't fail the test for cleanup issues
        });
      });
    } catch (error) {
      console.warn('⚠️ Merobox cleanup failed:', error);
    }

    console.log('🧹 Test cleanup completed');
  }, 120000); // 2 minute timeout for afterAll

  describe('Health and Status', () => {
    it('should check auth service health', async () => {
      console.log('🏥 Checking Auth API health...');

      const health = await meroJs.auth.getHealth();
      console.log('✅ Auth API health:', JSON.stringify(health, null, 2));

      expect(health).toBeDefined();
      expect(health.status).toBeDefined();
      expect(health.status).toBe('healthy');
    });

    it('should get service identity', async () => {
      console.log('🔍 Getting service identity...');

      const identity = await meroJs.auth.getIdentity();
      console.log('✅ Service identity:', JSON.stringify(identity, null, 2));

      expect(identity).toBeDefined();
      expect(identity.service).toBeDefined();
      expect(identity.version).toBeDefined();
    });

    it('should get available providers', async () => {
      console.log('🔌 Getting available providers...');

      const providers = await meroJs.auth.getProviders();
      console.log(
        '✅ Available providers:',
        JSON.stringify(providers, null, 2),
      );

      expect(providers).toBeDefined();
      expect(providers.providers).toBeDefined();
      expect(Array.isArray(providers.providers)).toBe(true);
    });
  });

  describe('Authentication Flow', () => {
    it('should validate the generated token', async () => {
      console.log('🔐 Validating generated token...');

      const validation = await meroJs.auth.validateToken(
        meroJs.getTokenData()!.access_token,
      );
      console.log('✅ Token validation:', JSON.stringify(validation, null, 2));

      expect(validation).toBeDefined();
      expect(validation.valid).toBe(true);
    });
  });

  describe('Key Management', () => {
    it('should list root keys', async () => {
      console.log('🔑 Listing root keys...');

      const rootKeys = await meroJs.auth.listRootKeys();
      console.log('✅ Root keys:', JSON.stringify(rootKeys, null, 2));

      expect(rootKeys).toBeDefined();
      expect(Array.isArray(rootKeys)).toBe(true);
      expect(rootKeys.length).toBeGreaterThan(0);
    });

    it('should get key permissions', async () => {
      console.log('🔑 Getting key permissions...');

      // Get the first key ID from the list
      const rootKeys = await meroJs.auth.listRootKeys();
      const firstKeyId = rootKeys[0]?.key_id;

      if (firstKeyId) {
        const permissions = await meroJs.auth.getKeyPermissions(firstKeyId);
        console.log(
          '✅ Key permissions:',
          JSON.stringify(permissions, null, 2),
        );

        expect(permissions).toBeDefined();
        expect(permissions.data).toBeDefined();
        expect(permissions.data.permissions).toBeDefined();
        expect(Array.isArray(permissions.data.permissions)).toBe(true);
      } else {
        console.log('⚠️ No keys found, skipping permissions test');
        expect(true).toBe(true); // Placeholder assertion
      }
    });
  });

  describe('Token Management', () => {
    it('should refresh the access token', async () => {
      console.log('🔄 Refreshing access token...');

      // Generate a new token to get a refresh token for testing
      const tokenResponse = await meroJs.auth.generateTokens({
        auth_method: 'user_password',
        public_key: 'test-public-key-refresh',
        client_name: 'e2e-test-client-refresh',
        timestamp: Math.floor(Date.now() / 1000),
        provider_data: {
          username: 'admin',
          password: 'admin123',
        },
      });

      try {
        const refreshResponse = await meroJs.auth.refreshToken({
          access_token: tokenResponse.data.access_token,
          refresh_token: tokenResponse.data.refresh_token,
        });

        console.log(
          '✅ Token refresh:',
          JSON.stringify(refreshResponse, null, 2),
        );

        expect(refreshResponse).toBeDefined();
        // The refresh might fail if the token is still valid, which is expected behavior
        if (refreshResponse.data) {
          expect(refreshResponse.data.access_token).toBeDefined();
          expect(refreshResponse.data.refresh_token).toBeDefined();
        } else {
          // If refresh fails because token is still valid, that's also a valid response
          expect(refreshResponse.error).toBeDefined();
          expect(refreshResponse.error).toContain('Access token still valid');
        }
      } catch (error: any) {
        // If the HTTP client throws an exception for 401, that's also expected behavior
        console.log('✅ Token refresh failed as expected:', error.message);
        expect(error.status).toBe(401);
        expect(error.bodyText).toContain('Access token still valid');
      }
    });
  });
});
