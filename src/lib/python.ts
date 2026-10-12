// The `run_python` tool: the model writes Python, it runs in this browser with
// Pyodide (see pythonWorker.ts), and the output goes back to the model.
// Nothing runs on the Scipio mini.
import type { Tool } from 'ollama/browser';

import { formatBytes, loadFile, type AttachedFile } from './files';
import type { ToolBudget, ToolCall, ToolRun } from './tools';

// Keep in step with the `pyodide` devDependency, which provides the types
export const PYODIDE_VERSION = '314.0.7';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export const PYTHON_LIMITS = {
	runsPerAnswer: 5,
	// The first run also downloads Python and any packages it imports
	timeoutMs: 120_000,
	// About 1K tokens of output per run goes back to the model
	maxOutputChars: 4_000
};

export const PYTHON_TOOL: Tool = {
	type: 'function',
	function: {
		name: 'run_python',
		description:
			'Run Python 3 code and get back what it prints, the value of its last line, and any error. Use it for calculations, data analysis and checking your work. Variables persist between runs in this chat.',
		parameters: {
			type: 'object',
			required: ['code'],
			properties: {
				code: { type: 'string', description: 'The Python code to run' }
			}
		}
	}
};

export function pythonSystemPrompt(files: AttachedFile[]): string {
	const lines = [
		'You can run Python with the run_python tool, in a sandbox with no internet access.',
		'numpy, pandas, scipy, statsmodels, scikit-learn, sympy and matplotlib are available; import them as usual.',
		'Use print() for what you need to see and keep output short. Charts made with matplotlib are shown to the user, not to you.',
		`You can run code up to ${PYTHON_LIMITS.runsPerAnswer} times per answer.`
	];
	if (files.length) {
		const list = files.map((f) => `/data/${f.name} (${formatBytes(f.size)})`).join(', ');
		lines.push(`Files the user uploaded are available in Python at: ${list}.`);
	}
	return lines.join(' ');
}

export interface PythonRequest {
	id: number;
	indexUrl: string;
	namespace: string;
	code: string;
	files: { id: string; name: string; data: ArrayBuffer }[];
}

export interface PythonResponse {
	id: number;
	stdout: string;
	stderr: string;
	result?: string;
	error?: string;
	images: string[];
}

let worker: Worker | undefined;
let nextId = 1;
// Files already copied into the current worker
let sentFiles = new Set<string>();
let hasStarted = false;

function getWorker(): Worker {
	worker ??= new Worker(new URL('./pythonWorker.ts', import.meta.url), { type: 'module' });
	return worker;
}

// Ending the worker is the only way to stop code that's stuck; Python and its
// variables start fresh on the next run
function resetWorker() {
	worker?.terminate();
	worker = undefined;
	sentFiles = new Set();
	hasStarted = false;
}

export function isPythonStarted(): boolean {
	return hasStarted;
}

export async function runPython(
	code: string,
	files: AttachedFile[],
	namespace: string,
	signal: AbortSignal
): Promise<PythonResponse> {
	const filesToSend: PythonRequest['files'] = [];
	for (const file of files) {
		if (sentFiles.has(file.id)) continue;
		const stored = await loadFile(file.id);
		if (stored) filesToSend.push({ id: file.id, name: file.name, data: stored.data });
	}

	const target = getWorker();
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const finish = () => {
			clearTimeout(timer);
			target.removeEventListener('message', onMessage);
			target.removeEventListener('error', onError);
			signal.removeEventListener('abort', onAbort);
		};
		const onMessage = (event: MessageEvent<PythonResponse>) => {
			if (event.data.id !== id) return;
			finish();
			hasStarted = true;
			for (const file of filesToSend) sentFiles.add(file.id);
			resolve(event.data);
		};
		const onError = (event: ErrorEvent) => {
			finish();
			resetWorker();
			resolve({
				id,
				stdout: '',
				stderr: '',
				error: `Python stopped: ${event.message}`,
				images: []
			});
		};
		const onAbort = () => {
			finish();
			resetWorker();
			reject(new DOMException('Python run stopped', 'AbortError'));
		};
		const timer = setTimeout(() => {
			finish();
			resetWorker();
			resolve({
				id,
				stdout: '',
				stderr: '',
				error: `Timed out after ${PYTHON_LIMITS.timeoutMs / 1000} seconds. Python was restarted, so earlier variables are gone.`,
				images: []
			});
		}, PYTHON_LIMITS.timeoutMs);

		target.addEventListener('message', onMessage);
		target.addEventListener('error', onError);
		signal.addEventListener('abort', onAbort);
		target.postMessage(
			{ id, indexUrl: INDEX_URL, namespace, code, files: filesToSend } satisfies PythonRequest,
			filesToSend.map((file) => file.data)
		);
	});
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n[…cut off after ${max} characters]` : text;
}

function formatForModel(response: PythonResponse): string {
	const parts: string[] = [];
	if (response.stdout.trim()) parts.push(`Output:\n${response.stdout.trimEnd()}`);
	if (response.stderr.trim()) parts.push(`Warnings:\n${response.stderr.trimEnd()}`);
	if (response.result !== undefined) parts.push(`Last value: ${response.result}`);
	if (response.error) parts.push(`Error:\n${response.error.trimEnd()}`);
	if (response.images.length) {
		parts.push(`${response.images.length} chart(s) were shown to the user.`);
	}
	if (!parts.length) parts.push('The code ran and printed nothing.');
	return truncate(parts.join('\n\n'), PYTHON_LIMITS.maxOutputChars);
}

function formatForChat(code: string, response: PythonResponse): string {
	const output = [response.stdout, response.stderr, response.result, response.error]
		.filter((part) => part?.trim())
		.join('\n')
		.trimEnd();
	const shownOutput = truncate(output || '(no output)', 20_000);
	return `\`\`\`python\n${code.trimEnd()}\n\`\`\`\n\n\`\`\`text\n${shownOutput}\n\`\`\``;
}

// Runs `run_python`; returns undefined for other tools
export async function runPythonToolCall(
	call: ToolCall,
	budget: ToolBudget,
	signal: AbortSignal,
	context: { sessionId: string; files: AttachedFile[] }
): Promise<ToolRun | undefined> {
	if (call.function.name !== 'run_python') return undefined;

	const code = String(call.function.arguments.code ?? '');
	if (!code.trim()) return { content: 'Error: code is empty.', label: 'Python', isError: true };
	if (budget.codeRuns >= PYTHON_LIMITS.runsPerAnswer) {
		return {
			content: 'Code run limit reached. Answer with the results you already have.',
			label: 'Python run limit reached',
			isError: true
		};
	}
	budget.codeRuns++;

	const response = await runPython(code, context.files, context.sessionId, signal);
	const lines = code.trim().split('\n').length;
	return {
		content: formatForModel(response),
		label: response.error
			? `Python error (${lines} ${lines === 1 ? 'line' : 'lines'})`
			: `Ran Python (${lines} ${lines === 1 ? 'line' : 'lines'})`,
		isError: !!response.error,
		detail: formatForChat(code, response),
		images: response.images.map((data) => `data:image/png;base64,${data}`)
	};
}
