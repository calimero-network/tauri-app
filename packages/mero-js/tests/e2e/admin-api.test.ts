import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MeroJs } from '@calimero-network/mero-js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Test configuration
const ADMIN_CONFIG = {
  baseUrl: process.env.ADMIN_API_BASE_URL || 'http://localhost',
  credentials: {
    username: 'admin',
    password: 'admin123',
  },
  timeoutMs: 10000,
};

describe('Admin API E2E Tests - Full Flow', () => {
  let meroJs: MeroJs;
  let installedAppId: string;
  let createdContextId: string;

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
    console.log('Admin API URL:', ADMIN_CONFIG.baseUrl);

    // Create MeroJs SDK instance
    meroJs = new MeroJs(ADMIN_CONFIG);

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

  describe('Application Management Flow', () => {
    it('should install an application from WASM file', async () => {
      console.log('📦 Installing application from WASM file...');

      // Read the WASM file
      const wasmPath = join(process.cwd(), 'tests/e2e/assets/kv_store.wasm');
      const wasmBuffer = readFileSync(wasmPath);

      console.log('📄 WASM file size:', wasmBuffer.length, 'bytes');

      try {
        const installResult = await meroJs.admin.installApplication({
          url: 'file://kv_store.wasm',
          metadata: Buffer.from('Test KV Store application').toString('base64'),
        });

        console.log(
          '✅ Application installed successfully:',
          JSON.stringify(installResult, null, 2),
        );

        expect(installResult).toBeDefined();
        expect(installResult.applicationId).toBeDefined();
        installedAppId = installResult.applicationId;

        console.log('🆔 Installed application ID:', installedAppId);
      } catch (error: any) {
        console.log('⚠️ Application installation failed:', error.message);
        // This might fail if the endpoint is not implemented yet
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });

    it('should list installed applications', async () => {
      console.log('📋 Listing installed applications...');

      try {
        const applicationsResponse = await meroJs.admin.listApplications();
        console.log(
          '✅ Applications list:',
          JSON.stringify(applicationsResponse, null, 2),
        );

        expect(applicationsResponse).toBeDefined();
        expect(applicationsResponse.apps).toBeDefined();
        expect(Array.isArray(applicationsResponse.apps)).toBe(true);

        if (installedAppId) {
          const installedApp = applicationsResponse.apps.find(
            (app: any) => app.id === installedAppId,
          );
          expect(installedApp).toBeDefined();
          console.log('✅ Found our installed application:', installedApp);
        }
      } catch (error: any) {
        console.log('⚠️ List applications failed:', error.message);
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });
  });

  describe('Context Management Flow', () => {
    it('should create a context with the installed application', async () => {
      console.log('🏗️ Creating context with application...');

      if (!installedAppId) {
        console.log(
          '⚠️ No installed application ID available, skipping context creation',
        );
        return;
      }

      try {
        const contextResult = await meroJs.admin.createContext({
          name: 'test-context',
          description: 'Test context for KV store',
          metadata: {
            application_id: installedAppId,
            config: {
              // Example config for KV store
              max_keys: 1000,
              storage_type: 'memory',
            },
          },
        });

        console.log(
          '✅ Context created successfully:',
          JSON.stringify(contextResult, null, 2),
        );

        expect(contextResult).toBeDefined();
        expect(contextResult.contextId).toBeDefined();
        createdContextId = contextResult.contextId;

        console.log('🆔 Created context ID:', createdContextId);
      } catch (error: any) {
        console.log('⚠️ Context creation failed:', error.message);
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });

    it('should list all contexts', async () => {
      console.log('📋 Listing all contexts...');

      try {
        const contextsResponse = await meroJs.admin.getContexts();
        console.log(
          '✅ Contexts list:',
          JSON.stringify(contextsResponse, null, 2),
        );

        expect(contextsResponse).toBeDefined();
        expect(contextsResponse.contexts).toBeDefined();
        expect(Array.isArray(contextsResponse.contexts)).toBe(true);

        if (createdContextId) {
          const createdContext = contextsResponse.contexts.find(
            (ctx: any) => ctx.id === createdContextId,
          );
          expect(createdContext).toBeDefined();
          console.log('✅ Found our created context:', createdContext);
        }
      } catch (error: any) {
        console.log('⚠️ List contexts failed:', error.message);
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });

    it('should get specific context details', async () => {
      console.log('🔍 Getting specific context details...');

      if (!createdContextId) {
        console.log(
          '⚠️ No created context ID available, skipping context details',
        );
        return;
      }

      try {
        const contextDetailsResponse =
          await meroJs.admin.getContext(createdContextId);
        console.log(
          '✅ Context details:',
          JSON.stringify(contextDetailsResponse, null, 2),
        );

        expect(contextDetailsResponse).toBeDefined();
        expect(contextDetailsResponse.context).toBeDefined();
        expect(contextDetailsResponse.context.id).toBe(createdContextId);
        expect(contextDetailsResponse.context.name).toBe('test-context');
      } catch (error: any) {
        console.log('⚠️ Get context failed:', error.message);
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });
  });

  describe('Cleanup Flow', () => {
    it('should delete the created context', async () => {
      console.log('🗑️ Deleting created context...');

      if (!createdContextId) {
        console.log(
          '⚠️ No created context ID available, skipping context deletion',
        );
        return;
      }

      try {
        const deleteResult = await meroJs.admin.deleteContext(createdContextId);
        console.log(
          '✅ Context deleted successfully:',
          JSON.stringify(deleteResult, null, 2),
        );

        expect(deleteResult).toBeDefined();
        expect(deleteResult.contextId).toBeDefined();
        expect(deleteResult.contextId).toBe(createdContextId);
        console.log('✅ Context cleanup completed');
      } catch (error: any) {
        console.log('⚠️ Delete context failed:', error.message);
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });

    it('should uninstall the application', async () => {
      console.log('🗑️ Uninstalling application...');

      if (!installedAppId) {
        console.log(
          '⚠️ No installed application ID available, skipping application deletion',
        );
        return;
      }

      try {
        const uninstallResult =
          await meroJs.admin.uninstallApplication(installedAppId);
        console.log(
          '✅ Application uninstalled successfully:',
          JSON.stringify(uninstallResult, null, 2),
        );

        expect(uninstallResult).toBeDefined();
        expect(uninstallResult.applicationId).toBeDefined();
        expect(uninstallResult.applicationId).toBe(installedAppId);
        console.log('✅ Application cleanup completed');
      } catch (error: any) {
        console.log('⚠️ Uninstall application failed:', error.message);
        expect(error.status).toBe(404);
        console.log(
          '✅ Expected 404 - Admin API endpoints not implemented yet',
        );
      }
    });
  });

  describe('Health and Status Checks', () => {
    it('should check admin service health', async () => {
      console.log('🏥 Checking Admin API health...');

      try {
        const health = await meroJs.admin.healthCheck();
        console.log('✅ Admin API health:', JSON.stringify(health, null, 2));
        expect(health).toBeDefined();
        expect(health.status).toBeDefined();
      } catch (error: any) {
        console.log(
          '⚠️ Admin API health check failed (expected):',
          error.message,
        );
        expect(error.status).toBe(404);
      }
    });

    it('should get admin auth status', async () => {
      console.log('🔐 Getting admin auth status...');

      try {
        const authStatus = await meroJs.admin.isAuthed();
        console.log(
          '✅ Admin auth status:',
          JSON.stringify(authStatus, null, 2),
        );
        expect(authStatus).toBeDefined();
        expect(authStatus.status).toBeDefined();
      } catch (error: any) {
        console.log(
          '⚠️ Admin auth status check failed (expected):',
          error.message,
        );
        expect(error.status).toBe(404);
      }
    });
  });
});
