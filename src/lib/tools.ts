// Tools a model can use in a session: web search (webSearch.ts) and Python
// (python.ts). The session page runs the loop: offer the tools, run the calls
// the model makes, send back the results, and ask again until it answers.
import type { Tool } from 'ollama/browser';

import type { AttachedFile } from './files';
import { PYTHON_TOOL, pythonSystemPrompt, runPythonToolCall } from './python';
import { runWebToolCall, WEB_SEARCH_TOOLS, webSearchSystemPrompt } from './webSearch';

export interface ToolCall {
	function: {
		name: string;
		arguments: Record<string, unknown>;
		index?: number;
	};
}

export interface ToolRun {
	// What the model receives as the tool result
	content: string;
	// The step shown in the chat
	label: string;
	isError?: boolean;
	// Shown when the step is expanded, as markdown (for example code and output)
	detail?: string;
	// Images to show under the step, as data URLs (for example charts)
	images?: string[];
}

export interface ToolBudget {
	searches: number;
	pageReads: number;
	codeRuns: number;
}

export interface ToolOptions {
	webSearch: boolean;
	runCode: boolean;
	sessionId: string;
	files: AttachedFile[];
}

// Model turns per answer, including the final one
export const MAX_ROUNDS_PER_ANSWER = 10;

export function newToolBudget(): ToolBudget {
	return { searches: 0, pageReads: 0, codeRuns: 0 };
}

export function toolsFor(options: ToolOptions): Tool[] {
	return [
		...(options.webSearch ? WEB_SEARCH_TOOLS : []),
		...(options.runCode ? [PYTHON_TOOL] : [])
	];
}

export function toolsSystemPrompt(options: ToolOptions, today = new Date()): string {
	const date = today.toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
	return [
		`Today is ${date}.`,
		options.webSearch ? webSearchSystemPrompt() : '',
		options.runCode ? pythonSystemPrompt(options.files) : ''
	]
		.filter(Boolean)
		.join(' ');
}

export async function runToolCall(
	call: ToolCall,
	budget: ToolBudget,
	signal: AbortSignal,
	options: ToolOptions
): Promise<ToolRun> {
	const name = call.function.name;
	const isOffered = toolsFor(options).some((tool) => tool.function.name === name);
	const run =
		isOffered &&
		((await runWebToolCall(call, budget, signal)) ??
			(await runPythonToolCall(call, budget, signal, options)));
	return (
		run || {
			content: `Error: unknown tool "${name}".`,
			label: `Unknown tool: ${name}`,
			isError: true
		}
	);
}

// qwen3-coder (scipio-code) sometimes writes a tool call as text and drops the
// opening <tool_call> tag, so Ollama doesn't recognize it:
//   <function=fetch_page><parameter=url>https://…</parameter></function></tool_call>
const TEXT_TOOL_CALL =
	/(?:<tool_call>\s*)?<function=([\w-]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
const TEXT_TOOL_PARAMETER = /<parameter=([\w-]+)>([\s\S]*?)<\/parameter>/g;

// Turns tool calls written as text back into real ones, and removes them from
// the reply. Only the tools that were offered are recovered.
export function recoverTextToolCalls(
	content: string,
	tools: Tool[]
): { content: string; toolCalls: ToolCall[] } | undefined {
	const toolNames = tools.map((tool) => tool.function.name ?? '');
	const toolCalls: ToolCall[] = [];
	const remaining = content.replace(TEXT_TOOL_CALL, (match, name: string, body: string) => {
		if (!toolNames.includes(name)) return match;
		// Code is kept as written; other values are trimmed
		const args = Object.fromEntries(
			[...body.matchAll(TEXT_TOOL_PARAMETER)].map(([, key, value]) => [
				key,
				key === 'code' ? value.replace(/^\n|\n$/g, '') : value.trim()
			])
		);
		toolCalls.push({ function: { name, arguments: args } });
		return '';
	});
	if (!toolCalls.length) return undefined;
	return { content: remaining.replace(/<\/?tool_call>/g, '').trim(), toolCalls };
}
