import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

import { chooseModel, MOCK_API_TAGS_RESPONSE, mockOllamaModelsResponse } from './utils';

const MODEL = MOCK_API_TAGS_RESPONSE.models[0].name;
const PYODIDE_DIR = path.resolve(import.meta.dirname, '..', 'node_modules', 'pyodide');

type ChatBody = {
	messages: { role: string; content: string; tool_name?: string }[];
	tools?: { function: { name: string } }[];
};

function chatLine(message: object) {
	return JSON.stringify({
		model: MODEL,
		message: { role: 'assistant', content: '', ...message },
		done: true
	});
}

function runPython(code: string) {
	return { tool_calls: [{ function: { name: 'run_python', arguments: { code } } }] };
}

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

// Serves Pyodide's core from node_modules instead of the CDN, so tests run offline
async function servePyodideLocally(page: Page) {
	const types: Record<string, string> = {
		'.mjs': 'text/javascript',
		'.wasm': 'application/wasm',
		'.zip': 'application/zip',
		'.json': 'application/json'
	};
	await page.context().route(/cdn\.jsdelivr\.net\/pyodide\/v[^/]+\/full\/(.+)$/, (route: Route) => {
		const file = new URL(route.request().url()).pathname.split('/').pop()!;
		try {
			const body = readFileSync(path.join(PYODIDE_DIR, file));
			return route.fulfill({
				body,
				contentType: types[path.extname(file)] ?? 'application/octet-stream',
				headers: { 'Access-Control-Allow-Origin': '*' }
			});
		} catch {
			return route.fulfill({ status: 404, body: 'Not available offline' });
		}
	});
}

// A one-page PDF with the given line of text
function makePdf(text: string): Buffer {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, 'latin1');
}

async function attachFile(page: Page, name: string, mimeType: string, buffer: Buffer) {
	const chooser = page.waitForEvent('filechooser');
	await page.getByTestId('file-attachment').click();
	await (await chooser).setFiles({ name, mimeType, buffer });
}

async function newSession(page: Page, capabilities = ['completion', 'tools']) {
	await page.route('**/api/show', (route: Route) => route.fulfill({ json: { capabilities } }));
	await page.getByTestId('new-session').click();
	await chooseModel(page, MODEL);
}

async function send(page: Page, prompt: string) {
	await page.locator('.prompt-editor__textarea').fill(prompt);
	await page.getByText('Run').click();
}

test.describe('File uploads', () => {
	test.beforeEach(async ({ page }) => {
		await mockOllamaModelsResponse(page);
	});

	test('sends a text file to the model', async ({ page }) => {
		const requests = await mockChatSequence(page, [{ content: 'It lists two tasks.' }]);
		await newSession(page);
		await attachFile(
			page,
			'notes.md',
			'text/markdown',
			Buffer.from('# Tasks\n- buy ALGO\n- hedge')
		);
		await expect(page.getByTestId('attachment-file-name')).toHaveText('notes.md');

		await send(page, 'What is in this file?');
		await expect(page.getByText('It lists two tasks.')).toBeVisible();
		await expect(page.getByTestId('file-attachment-message')).toContainText('notes.md');

		const fileMessage = requests[0].messages.find((m) => m.content.includes('<FILE'));
		expect(fileMessage?.role).toBe('user');
		expect(fileMessage?.content).toContain('name="notes.md"');
		expect(fileMessage?.content).toContain('- buy ALGO');
		expect(requests[0].messages.at(-1)?.content).toBe('What is in this file?');
	});

	test('shows the model only the start of a large file', async ({ page }) => {
		const requests = await mockChatSequence(page, [{ content: 'Lots of rows.' }]);
		await newSession(page);
		const rows = Array.from({ length: 3000 }, (_, i) => `${i},${i * 2},${i * 3}`).join('\n');
		await attachFile(page, 'big.csv', 'text/csv', Buffer.from(`a,b,c\n${rows}`));
		await send(page, 'Summarize');

		await expect(page.getByText('Lots of rows.')).toBeVisible();
		await expect(page.getByTestId('file-attachment-message')).toContainText(
			'the model sees the start'
		);
		const content = requests[0].messages.find((m) => m.content.includes('<FILE'))!.content;
		expect(content).toContain('[Only the first 12,000 of');
		expect(content.length).toBeLessThan(12_500);
	});

	test('reads the text of a PDF', async ({ page }) => {
		const requests = await mockChatSequence(page, [{ content: 'It is a report.' }]);
		await newSession(page);
		await attachFile(page, 'report.pdf', 'application/pdf', makePdf('Quarterly hedge report'));
		await expect(page.getByTestId('attachment-file-name')).toHaveText('report.pdf');
		await send(page, 'What is this?');

		await expect(page.getByText('It is a report.')).toBeVisible();
		const content = requests[0].messages.find((m) => m.content.includes('<FILE'))!.content;
		expect(content).toContain('--- Page 1 ---');
		expect(content).toContain('Quarterly hedge report');
	});

	test('refuses files it cannot read', async ({ page }) => {
		await newSession(page);
		await attachFile(page, 'data.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 0, 255]));
		await expect(page.getByText("data.bin isn't a text, code, CSV or PDF file")).toBeVisible();
		await expect(page.getByTestId('attachment-file-name')).toHaveCount(0);
	});
});

test.describe('Python', () => {
	// The first run starts Pyodide, which takes a few seconds
	test.setTimeout(60_000);

	test.beforeEach(async ({ page }) => {
		await mockOllamaModelsResponse(page);
		await servePyodideLocally(page);
	});

	test('the toggle offers run_python and explains it', async ({ page }) => {
		const requests = await mockChatSequence(page, [{ content: 'Hi' }]);
		await newSession(page);
		await page.getByTestId('run-code-toggle').click();
		await expect(page.getByTestId('run-code-toggle')).toHaveAttribute('aria-pressed', 'true');
		await send(page, 'Hello');

		await expect(page.getByText('Hi', { exact: true })).toBeVisible();
		expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['run_python']);
		expect(requests[0].messages[0].content).toContain('run_python');
	});

	test('runs code and sends the output back', async ({ page }) => {
		const requests = await mockChatSequence(page, [
			runPython('x = 6 * 7\nprint(f"answer: {x}")'),
			runPython('x + 1'),
			{ content: 'The answer is 42.' }
		]);
		await newSession(page);
		await page.getByTestId('run-code-toggle').click();
		await send(page, 'Compute it');

		await expect(page.getByText('The answer is 42.')).toBeVisible({ timeout: 45_000 });
		const steps = page.getByTestId('tool-step');
		await expect(steps).toHaveText(['Ran Python (2 lines)', 'Ran Python (1 line)']);
		expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'run_python' });
		expect(requests[1].messages.at(-1)?.content).toContain('Output:\nanswer: 42');
		expect(requests[1].messages.at(-1)?.content).not.toContain('Loading');
		// Variables persist between runs
		expect(requests[2].messages.at(-1)?.content).toContain('Last value: 43');

		await page.getByTestId('tool-step-expand').first().click();
		await expect(page.getByTestId('tool-step-detail')).toContainText('x = 6 * 7');
		await expect(page.getByTestId('tool-step-detail')).toContainText('answer: 42');
	});

	test('reads uploaded files from /data', async ({ page }) => {
		const requests = await mockChatSequence(page, [
			runPython(
				'import csv\nrows = list(csv.DictReader(open("/data/fills.csv")))\nprint(sum(float(r["qty"]) for r in rows))'
			),
			{ content: 'Total is 7.5' }
		]);
		await newSession(page);
		await page.getByTestId('run-code-toggle').click();
		await attachFile(page, 'fills.csv', 'text/csv', Buffer.from('qty\n1.5\n2\n4\n'));
		await send(page, 'Total quantity?');

		await expect(page.getByText('Total is 7.5')).toBeVisible({ timeout: 45_000 });
		expect(requests[0].messages[0].content).toContain('/data/fills.csv');
		expect(requests[1].messages.at(-1)?.content).toContain('Output:\n7.5');
	});

	test('reports errors to the model', async ({ page }) => {
		const requests = await mockChatSequence(page, [runPython('1 / 0'), { content: 'Oops.' }]);
		await newSession(page);
		await page.getByTestId('run-code-toggle').click();
		await send(page, 'Divide');

		await expect(page.getByText('Oops.')).toBeVisible({ timeout: 45_000 });
		await expect(page.getByTestId('tool-step')).toHaveText('Python error (1 line)');
		expect(requests[1].messages.at(-1)?.content).toContain('ZeroDivisionError');
	});

	test('has no network access', async ({ page }) => {
		const requests = await mockChatSequence(page, [
			runPython(
				[
					'import js',
					'results = []',
					'for attempt in [',
					'    lambda: js.fetch("http://127.0.0.1:4173/"),',
					'    lambda: js.WorkerGlobalScope.prototype.fetch.call(js.self, "http://127.0.0.1:4173/"),',
					']:',
					'    try:',
					'        await attempt()',
					'        results.append("reached")',
					'    except Exception as e:',
					'        results.append("blocked" if "Network access is turned off" in str(e) else str(e))',
					'try:',
					'    xhr = js.XMLHttpRequest.new()',
					'    xhr.open("GET", "http://127.0.0.1:4173/")',
					'    results.append("reached")',
					'except Exception as e:',
					'    results.append("blocked" if "Network access is turned off" in str(e) else str(e))',
					'results.append("no websocket" if js.self.WebSocket is None else "websocket")',
					'print(results)'
				].join('\n')
			),
			{ content: 'Checked.' }
		]);
		await newSession(page);
		await page.getByTestId('run-code-toggle').click();
		await send(page, 'Try the network');

		await expect(page.getByText('Checked.')).toBeVisible({ timeout: 45_000 });
		expect(requests[1].messages.at(-1)?.content).toContain(
			"['blocked', 'blocked', 'blocked', 'no websocket']"
		);
	});

	test('stopping a stuck run restarts Python', async ({ page }) => {
		await mockChatSequence(page, [runPython('while True:\n    pass')]);
		await newSession(page);
		await page.getByTestId('run-code-toggle').click();
		await send(page, 'Loop forever');

		await expect(page.getByTestId('tool-step')).toHaveText(/Running Python|Starting Python/, {
			timeout: 15_000
		});
		await page.getByTitle('Stop completion').click();
		await expect(page.getByTitle('Stop completion')).toBeHidden();

		// The next run works on a fresh Python
		await page.unroute('**/api/chat');
		await mockChatSequence(page, [runPython('print("alive")'), { content: 'Back.' }]);
		await send(page, 'Again');
		await expect(page.getByText('Back.')).toBeVisible({ timeout: 45_000 });
	});
});
