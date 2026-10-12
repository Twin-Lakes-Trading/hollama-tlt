import { expect, test, type Page, type Route } from '@playwright/test';

import { chooseModel, MOCK_API_TAGS_RESPONSE, mockOllamaModelsResponse } from './utils';

const MODEL = MOCK_API_TAGS_RESPONSE.models[0].name;

type ChatBody = {
	messages: { role: string; content: string; tool_name?: string; tool_calls?: unknown[] }[];
	tools?: { function: { name: string } }[];
};

function chatLine(message: object) {
	return JSON.stringify({
		model: MODEL,
		message: { role: 'assistant', content: '', ...message },
		done: true
	});
}

function toolCall(name: string, args: object) {
	return { tool_calls: [{ function: { name, arguments: args } }] };
}

async function mockCapabilities(page: Page, capabilities: string[]) {
	await page.route('**/api/show', (route: Route) => route.fulfill({ json: { capabilities } }));
}

// Answers each /api/chat request with the next response, recording the requests
async function mockChatSequence(page: Page, responses: object[]) {
	const requests: ChatBody[] = [];
	await page.route('**/api/chat', (route: Route) => {
		requests.push(JSON.parse(route.request().postData() ?? '{}'));
		const response = responses[Math.min(requests.length, responses.length) - 1];
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: chatLine(response)
		});
	});
	return requests;
}

async function newSession(page: Page) {
	await page.getByTestId('new-session').click();
	await chooseModel(page, MODEL);
}

async function send(page: Page, prompt: string) {
	await page.locator('.prompt-editor__textarea').fill(prompt);
	await page.getByText('Run').click();
}

test.describe('Web search', () => {
	test.beforeEach(async ({ page }) => {
		await mockOllamaModelsResponse(page);
	});

	test('the toggle only shows for models that support tools', async ({ page }) => {
		await mockCapabilities(page, ['completion']);
		await newSession(page);
		await expect(page.getByTestId('image-attachment')).toBeVisible();
		await expect(page.getByTestId('web-search-toggle')).toHaveCount(0);

		await page.unroute('**/api/show');
		await mockCapabilities(page, ['completion', 'tools']);
		await page.reload();
		await chooseModel(page, MODEL);
		await expect(page.getByTestId('web-search-toggle')).toBeVisible();
		await expect(page.getByTestId('web-search-toggle')).toHaveAttribute('aria-pressed', 'false');
	});

	test('chats without tools while the toggle is off', async ({ page }) => {
		await mockCapabilities(page, ['completion', 'tools']);
		const requests = await mockChatSequence(page, [{ content: 'Plain answer' }]);
		await newSession(page);
		await expect(page.getByTestId('web-search-toggle')).toBeVisible();

		await send(page, 'Hello');
		await expect(page.getByText('Plain answer')).toBeVisible();
		expect(requests).toHaveLength(1);
		expect(requests[0].tools).toBeUndefined();
	});

	test('searches, reads a page and answers', async ({ page }) => {
		await mockCapabilities(page, ['completion', 'tools', 'thinking']);
		const requests = await mockChatSequence(page, [
			{
				thinking: 'I should look this up.',
				...toolCall('web_search', { query: 'scipio africanus' })
			},
			toolCall('fetch_page', { url: 'https://example.com/scipio' }),
			{ content: 'Scipio defeated Hannibal at Zama. [Source](https://example.com/scipio)' }
		]);

		const searches: string[] = [];
		await page.route('**/api/tools/search', (route: Route) => {
			searches.push(JSON.parse(route.request().postData() ?? '{}').query);
			return route.fulfill({
				json: {
					results: [
						{ title: 'Scipio', url: 'https://example.com/scipio', snippet: 'Roman general' }
					]
				}
			});
		});
		await page.route('**/api/tools/fetch', (route: Route) =>
			route.fulfill({
				json: {
					url: 'https://example.com/scipio',
					title: 'Scipio',
					text: 'Scipio won the battle of Zama in 202 BC.',
					isTruncated: false
				}
			})
		);

		await newSession(page);
		await page.getByTestId('web-search-toggle').click();
		await expect(page.getByTestId('web-search-toggle')).toHaveAttribute('aria-pressed', 'true');
		await send(page, 'Who won at Zama?');

		await expect(page.getByText('Scipio defeated Hannibal at Zama.')).toBeVisible();
		const steps = page.getByTestId('tool-step');
		await expect(steps).toHaveCount(2);
		await expect(steps.nth(0)).toHaveText('Searched: scipio africanus');
		await expect(steps.nth(1)).toHaveText('Read: https://example.com/scipio');
		expect(searches).toEqual(['scipio africanus']);

		// First request offers the tools and explains them
		expect(requests).toHaveLength(3);
		expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['web_search', 'fetch_page']);
		expect(requests[0].messages[0].role).toBe('system');
		expect(requests[0].messages[0].content).toContain('web_search');

		// Later requests carry the tool call and its result
		const second = requests[1].messages;
		expect(second.at(-2)).toMatchObject({ role: 'assistant', thinking: 'I should look this up.' });
		expect(second.at(-2)?.tool_calls).toHaveLength(1);
		expect(second.at(-1)).toMatchObject({ role: 'tool', tool_name: 'web_search' });
		expect(second.at(-1)?.content).toContain('https://example.com/scipio');
		expect(requests[2].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'fetch_page' });
		expect(requests[2].messages.at(-1)?.content).toContain('battle of Zama');

		// The research steps survive a reload
		await page.reload();
		await expect(page.getByTestId('tool-step')).toHaveCount(2);
		await expect(page.getByText('Scipio defeated Hannibal at Zama.')).toBeVisible();

		// A follow-up question drops the earlier research to save context
		await send(page, 'And when?');
		await expect(page.getByTestId('tool-step')).toHaveCount(2);
		const followUp = requests.at(-1)!.messages;
		expect(followUp.some((m) => m.role === 'tool')).toBe(false);
		expect(followUp.some((m) => m.content.includes('Scipio defeated Hannibal'))).toBe(true);
	});

	test('stops searching at the limit', async ({ page }) => {
		await mockCapabilities(page, ['completion', 'tools']);
		const requests = await mockChatSequence(page, [
			toolCall('web_search', { query: 'one' }),
			toolCall('web_search', { query: 'two' }),
			toolCall('web_search', { query: 'three' }),
			toolCall('web_search', { query: 'four' }),
			{ content: 'Done searching' }
		]);
		let searchCount = 0;
		await page.route('**/api/tools/search', (route: Route) => {
			searchCount++;
			return route.fulfill({ json: { results: [] } });
		});

		await newSession(page);
		await page.getByTestId('web-search-toggle').click();
		await send(page, 'Search a lot');

		await expect(page.getByText('Done searching')).toBeVisible();
		expect(searchCount).toBe(3);
		await expect(page.getByTestId('tool-step').last()).toHaveText('Search limit reached: four');
		expect(requests[4].messages.at(-1)?.content).toContain('Search limit reached');
	});

	test('recovers a tool call the model wrote as text', async ({ page }) => {
		await mockCapabilities(page, ['completion', 'tools']);
		// How scipio-code (qwen3-coder) sometimes answers: no opening <tool_call> tag
		const requests = await mockChatSequence(page, [
			{
				content:
					"I'll fetch the page.\n\n<function=fetch_page>\n<parameter=url>\nhttps://example.com/kraken\n</parameter>\n</function>\n</tool_call>"
			},
			{ content: 'The page says hello.' }
		]);
		const fetched: string[] = [];
		await page.route('**/api/tools/fetch', (route: Route) => {
			fetched.push(JSON.parse(route.request().postData() ?? '{}').url);
			return route.fulfill({
				json: {
					url: 'https://example.com/kraken',
					title: 'Kraken',
					text: 'hello',
					isTruncated: false
				}
			});
		});

		await newSession(page);
		await page.getByTestId('web-search-toggle').click();
		await send(page, 'What does the page say?');

		await expect(page.getByText('The page says hello.')).toBeVisible();
		expect(fetched).toEqual(['https://example.com/kraken']);
		await expect(page.getByText("I'll fetch the page.")).toBeVisible();
		await expect(page.getByTestId('tool-step')).toHaveText('Read: https://example.com/kraken');
		await expect(page.getByText('<function=')).toHaveCount(0);
		await expect(page.getByText('</tool_call>')).toHaveCount(0);
		expect(requests[1].messages.at(-2)?.tool_calls).toEqual([
			{ function: { name: 'fetch_page', arguments: { url: 'https://example.com/kraken' } } }
		]);
	});

	test('leaves tool markup alone when web search is off', async ({ page }) => {
		await mockCapabilities(page, ['completion', 'tools']);
		const requests = await mockChatSequence(page, [
			{ content: 'Example: `<function=fetch_page><parameter=url>x</parameter></function>`' }
		]);

		await newSession(page);
		await send(page, 'Show me the format');

		await expect(page.getByText('<function=fetch_page>', { exact: false })).toBeVisible();
		expect(requests).toHaveLength(1);
	});

	test('shows a failed search as a step and keeps going', async ({ page }) => {
		await mockCapabilities(page, ['completion', 'tools']);
		await mockChatSequence(page, [
			toolCall('web_search', { query: 'anything' }),
			{ content: 'Search is down, answering from memory' }
		]);
		await page.route('**/api/tools/search', (route: Route) =>
			route.fulfill({ status: 502, json: { message: "Couldn't reach the search engine" } })
		);

		await newSession(page);
		await page.getByTestId('web-search-toggle').click();
		await send(page, 'Look it up');

		await expect(page.getByText('Search is down, answering from memory')).toBeVisible();
		await expect(page.getByTestId('tool-step')).toHaveText('Searched: anything');
	});
});

test.describe('Web search server tools', () => {
	test('refuse local and private addresses', async ({ request }) => {
		for (const url of [
			'http://127.0.0.1:4173/',
			'http://localhost:11434/',
			'http://10.20.0.9:11434/api/tags',
			'http://[::1]/',
			'http://192.168.1.1/',
			'file:///etc/passwd'
		]) {
			const response = await request.post('/api/tools/fetch', { data: { url } });
			expect(response.status(), url).toBe(400);
		}
	});

	test('require a query and a URL', async ({ request }) => {
		expect((await request.post('/api/tools/search', { data: {} })).status()).toBe(400);
		expect((await request.post('/api/tools/fetch', { data: {} })).status()).toBe(400);
	});
});
