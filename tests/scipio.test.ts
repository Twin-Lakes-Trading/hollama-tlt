import { expect, test, type Route } from '@playwright/test';
import type { ChatResponse, ListResponse } from 'ollama/browser';

import { chooseModel, MOCK_API_TAGS_RESPONSE } from './utils';

const SCIPIO_URL = 'http://10.20.0.9:11434';

const [templateModel] = MOCK_API_TAGS_RESPONSE.models;
const MOCK_SCIPIO_TAGS: ListResponse = {
	models: ['scipio-code:latest', 'scipio-think:latest', 'llama3:8b'].map((name) => ({
		...templateModel,
		name,
		model: name
	}))
};

const MOCK_SCIPIO_RESPONSE: ChatResponse = {
	...({} as ChatResponse),
	model: 'scipio-think:latest',
	message: { role: 'assistant', content: 'Ready when you are.' },
	done: true
};

test.describe('Scipio preset', () => {
	// A fresh browser, without the empty server list the other tests start from
	test.use({ storageState: { cookies: [], origins: [] } });

	test.beforeEach(async ({ page }) => {
		await page.route(`${SCIPIO_URL}/api/tags`, (route: Route) =>
			route.fulfill({ json: MOCK_SCIPIO_TAGS })
		);
	});

	test('ships with the Scipio server ready to use', async ({ page }) => {
		await page.goto('/');
		await expect(page).toHaveURL('/sessions');
		await expect(page.getByTestId('app-version')).toHaveText(/^v\d+\.\d+\.\d+/);

		await page.getByText('New session', { exact: true }).click();
		await page.getByLabel('Available models', { exact: true }).click();
		await expect(page.getByText('scipio-code:latest', { exact: true })).toBeVisible();
		await expect(page.getByText('scipio-think:latest', { exact: true })).toBeVisible();
		await expect(page.getByText('llama3:8b', { exact: true })).not.toBeVisible();

		await page.goto('/settings');
		const server = page.getByTestId('server');
		await expect(server).toHaveCount(1);
		await expect(server.getByLabel('Base URL')).toHaveValue(SCIPIO_URL);
		await expect(server.getByLabel('Use models from this server')).toBeChecked();
	});

	test('shows a loading state while a model is swapped into memory', async ({ page }) => {
		// Nothing is loaded, so scipio-think has to be loaded first
		await page.route(`${SCIPIO_URL}/api/ps`, (route: Route) =>
			route.fulfill({ json: { models: [] } })
		);
		let respond: () => void = () => {};
		await page.route(`${SCIPIO_URL}/api/chat`, (route: Route) => {
			respond = () => route.fulfill({ json: MOCK_SCIPIO_RESPONSE });
		});

		await page.goto('/sessions');
		await page.getByText('New session', { exact: true }).click();
		await chooseModel(page, 'scipio-think:latest');
		await page.locator('.prompt-editor__textarea').fill('Hello');
		await page.getByText('Run').click();

		const loading = page.getByText('Loading scipio-think:latest into memory');
		await expect(loading).toBeVisible();

		respond();
		await expect(loading).not.toBeVisible();
		await expect(page.getByText('Ready when you are.')).toBeVisible();
	});

	test('skips the loading state when the model is already in memory', async ({ page }) => {
		await page.route(`${SCIPIO_URL}/api/ps`, (route: Route) =>
			route.fulfill({ json: { models: [{ name: 'scipio-think:latest' }] } })
		);
		await page.route(`${SCIPIO_URL}/api/chat`, () => {});

		await page.goto('/sessions');
		await page.getByText('New session', { exact: true }).click();
		await chooseModel(page, 'scipio-think:latest');
		await page.locator('.prompt-editor__textarea').fill('Hello');
		await page.getByText('Run').click();

		await expect(page.getByTestId('session-role').getByText('Assistant')).toBeVisible();
		await expect(page.getByText(/into memory/)).not.toBeVisible();
	});
});

test('a saved server is not overwritten by the Scipio preset', async ({ page }) => {
	const server = {
		id: 'mine',
		baseUrl: 'http://localhost:11434',
		connectionType: 'ollama',
		isVerified: null,
		isEnabled: false
	};
	await page.goto('/settings');
	await page.evaluate(
		(data) => window.localStorage.setItem('hollama-servers', JSON.stringify(data)),
		[server]
	);
	await page.reload();

	await expect(page.getByTestId('server')).toHaveCount(1);
	await expect(page.getByLabel('Label')).toHaveValue('');
	await expect(page.getByLabel('Model names filter')).toHaveValue('');
	expect(await page.evaluate(() => window.localStorage.getItem('hollama-servers'))).not.toContain(
		'scipio'
	);
});
