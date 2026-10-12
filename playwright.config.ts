import type { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173
	},
	testDir: 'tests',
	testMatch: /(.+\.)?(test|spec)\.[jt]s/,
	timeout: 5000,
	workers: process.env.CI ? 1 : undefined,
	retries: process.env.CI ? 2 : 0,
	use: {
		trace: 'retain-on-failure',
		contextOptions: {
			permissions: ['clipboard-write', 'clipboard-read']
		},
		viewport: { width: 1280, height: 1024 },
		// Start from an empty server list instead of the preconfigured Scipio
		// server, so tests set up their own mocked servers (see scipio.test.ts)
		storageState: {
			cookies: [],
			origins: [
				{
					origin: 'http://localhost:4173',
					localStorage: [{ name: 'hollama-servers', value: '[]' }]
				}
			]
		}
	},
	snapshotPathTemplate: '{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}',
	expect: {
		toMatchSnapshot: {
			maxDiffPixels: 900
		}
	}
};

export default config;
