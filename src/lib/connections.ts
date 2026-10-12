import { generateRandomId } from './utils';

export enum ConnectionType {
	Ollama = 'ollama',
	OpenAI = 'openai',
	OpenAICompatible = 'openai-compatible'
}

export interface Server {
	id: string;
	baseUrl: string;
	connectionType: ConnectionType;
	isVerified: Date | null;
	isEnabled: boolean;
	label?: string;
	modelFilter?: string;
	apiKey?: string;
}

// The Scipio Ollama server (Mac mini, reachable over WireGuard only). It ships
// preconfigured so a fresh browser can start chatting without any setup. The
// filter limits the model list to the `scipio-*` tags built for it.
export const SCIPIO_SERVER: Server = {
	id: 'scipio',
	baseUrl: 'http://10.20.0.9:11434',
	connectionType: ConnectionType.Ollama,
	label: 'Scipio',
	modelFilter: 'scipio-',
	isVerified: new Date(0),
	isEnabled: true
};

export function getDefaultServer(connectionType: ConnectionType): Server {
	let baseUrl: string = '';
	let modelFilter: string | undefined = undefined;

	switch (connectionType) {
		case ConnectionType.Ollama:
			baseUrl = 'http://localhost:11434';
			break;
		case ConnectionType.OpenAI:
			baseUrl = 'https://api.openai.com/v1';
			modelFilter = 'gpt';
			break;
		case ConnectionType.OpenAICompatible:
			baseUrl = 'http://localhost:8080/v1';
			break;
	}

	return {
		id: generateRandomId(),
		baseUrl,
		connectionType,
		modelFilter,
		isVerified: null,
		isEnabled: false
	};
}
