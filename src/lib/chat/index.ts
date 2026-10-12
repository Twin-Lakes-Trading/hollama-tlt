import type {
	ErrorResponse,
	ProgressResponse,
	PullRequest,
	StatusResponse,
	Tool
} from 'ollama/browser';
import { get } from 'svelte/store';

import { sessionsStore, settingsStore } from '#lib/localStorage.js';
import type { Model } from '#lib/settings.js';
import type { ToolCall } from '#lib/tools.js';

import { type OllamaOptions } from './ollama';

export interface Message {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	images?: string[]; // Optional array of base64 image strings
	// Sent back with an assistant turn that called tools
	thinking?: string;
	tool_calls?: ToolCall[];
	// Which tool a `tool` message is the result of
	tool_name?: string;
}

export interface ChatRequest {
	model: string;
	messages: Message[];
	stream?: boolean;
	options?: Partial<OllamaOptions>;
	tools?: Tool[];
}

export interface ChatChunk {
	content?: string;
	reasoning?: string;
	toolCalls?: ToolCall[];
}

export interface ChatStrategy {
	chat(
		payload: ChatRequest,
		abortSignal: AbortSignal,
		onChunk: (chunk: ChatChunk) => void
	): Promise<void>;

	getModels(): Promise<Model[]>;

	pull?(
		payload: PullRequest,
		onChunk: (progress: ProgressResponse | StatusResponse | ErrorResponse) => void
	): Promise<void>;
}

export function getLastUsedModels(): Model[] {
	const currentSessions = get(sessionsStore);
	const models = get(settingsStore)?.models;
	if (!models) return [];

	const lastUsedModels: Model[] = [];

	for (const session of currentSessions) {
		if (lastUsedModels.find((m) => m.name === session.model?.name)) continue;

		const model = models.find((model) => model.name === session.model?.name);
		if (!model) continue;
		lastUsedModels.push(model);

		if (lastUsedModels.length >= 5) break;
	}

	return lastUsedModels;
}
