// Files people attach to a session. The model sees each file's text (trimmed
// to fit its context); the original is kept in IndexedDB, where Python can
// read all of it. localStorage, which holds sessions, is too small for files.

export interface AttachedFile {
	id: string;
	name: string;
	type: string;
	size: number;
	// Characters of text extracted, and whether the model only sees part of it
	textLength: number;
	isTruncated: boolean;
}

export const FILE_LIMITS = {
	maxBytes: 25_000_000,
	// About 3K tokens per file, out of the 16K context
	maxCharsInContext: 12_000
};

const TEXT_EXTENSIONS = new Set([
	'txt',
	'md',
	'markdown',
	'csv',
	'tsv',
	'json',
	'jsonl',
	'ndjson',
	'xml',
	'yaml',
	'yml',
	'toml',
	'ini',
	'cfg',
	'conf',
	'env',
	'log',
	'sql',
	'html',
	'htm',
	'css',
	'scss',
	'svg',
	'py',
	'ipynb',
	'rs',
	'go',
	'js',
	'mjs',
	'cjs',
	'ts',
	'tsx',
	'jsx',
	'svelte',
	'vue',
	'java',
	'kt',
	'c',
	'h',
	'cc',
	'cpp',
	'hpp',
	'cs',
	'rb',
	'php',
	'swift',
	'sh',
	'bash',
	'zsh',
	'ps1',
	'r',
	'jl',
	'lua',
	'pl',
	'scala',
	'hs',
	'ex',
	'exs',
	'erl',
	'dart',
	'tex',
	'bib',
	'diff',
	'patch',
	'proto',
	'graphql',
	'tf',
	'hcl',
	'lock',
	'gitignore',
	'dockerfile',
	'makefile'
]);

// What the file picker offers; anything else that turns out to be text is accepted too
export const FILE_ACCEPT = ['.pdf', ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`)].join(',');

function extensionOf(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf('.');
	return dot === -1 ? lower : lower.slice(dot + 1);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class FileReadError extends Error {}

async function pdfToText(bytes: ArrayBuffer): Promise<string> {
	const pdfjs = await import('pdfjs-dist');
	const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
	pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

	// pdf.js takes ownership of the buffer it's given, so pass a copy
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
	const pdf = await task.promise;
	const pages: string[] = [];
	for (let n = 1; n <= pdf.numPages; n++) {
		const page = await pdf.getPage(n);
		const content = await page.getTextContent();
		let text = '';
		for (const item of content.items) {
			if (!('str' in item)) continue;
			text += item.str + (item.hasEOL ? '\n' : '');
		}
		pages.push(`--- Page ${n} ---\n${text.trim()}`);
	}
	await task.destroy();
	return pages.join('\n\n');
}

function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8000);
	let suspicious = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
	}
	return sample.length > 0 && suspicious / sample.length > 0.1;
}

// The file's text, for the model to read
export async function extractText(file: File): Promise<string> {
	if (file.size > FILE_LIMITS.maxBytes) {
		throw new FileReadError(`${file.name} is larger than ${formatBytes(FILE_LIMITS.maxBytes)}`);
	}
	const bytes = await file.arrayBuffer();
	const extension = extensionOf(file.name);

	if (extension === 'pdf' || file.type === 'application/pdf') {
		try {
			const text = await pdfToText(bytes);
			if (!text.replace(/--- Page \d+ ---/g, '').trim()) {
				throw new FileReadError(`${file.name} has no text to read (it may be scanned images)`);
			}
			return text;
		} catch (error) {
			if (error instanceof FileReadError) throw error;
			throw new FileReadError(`Couldn't read ${file.name} as a PDF`);
		}
	}

	const view = new Uint8Array(bytes);
	if (!TEXT_EXTENSIONS.has(extension) && !file.type.startsWith('text/') && looksBinary(view)) {
		throw new FileReadError(`${file.name} isn't a text, code, CSV or PDF file`);
	}
	return new TextDecoder('utf-8').decode(view);
}

// How a file is shown to the model in the conversation
export function fileMessageContent(
	file: AttachedFile,
	text: string,
	canUsePython: boolean
): string {
	const shown = file.isTruncated ? text.slice(0, FILE_LIMITS.maxCharsInContext) : text;
	const note = file.isTruncated
		? `\n[Only the first ${shown.length.toLocaleString('en-US')} of ${file.textLength.toLocaleString('en-US')} characters are shown here.${canUsePython ? ` The whole file is at /data/${file.name} in Python.` : ''}]`
		: '';
	return `<FILE name="${file.name}" size="${formatBytes(file.size)}">\n${shown}${note}\n</FILE>`;
}

// IndexedDB storage for the original files

const DB_NAME = 'scipio-files';
const STORE = 'files';

interface StoredFile {
	id: string;
	sessionId: string;
	name: string;
	type: string;
	data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
			store.createIndex('sessionId', 'sessionId');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	action: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
	const db = await openDb();
	try {
		return await new Promise<T | undefined>((resolve, reject) => {
			const transaction = db.transaction(STORE, mode);
			const request = action(transaction.objectStore(STORE));
			transaction.oncomplete = () => resolve(request ? request.result : undefined);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		db.close();
	}
}

export async function saveFile(file: StoredFile): Promise<void> {
	await withStore('readwrite', (store) => store.put(file));
}

export async function loadFile(id: string): Promise<StoredFile | undefined> {
	return withStore<StoredFile>('readonly', (store) => store.get(id));
}

export async function deleteFile(id: string): Promise<void> {
	await withStore('readwrite', (store) => store.delete(id));
}

export async function deleteSessionFiles(sessionId: string): Promise<void> {
	const ids = await withStore<IDBValidKey[]>('readonly', (store) =>
		store.index('sessionId').getAllKeys(sessionId)
	);
	for (const id of ids ?? []) await deleteFile(String(id));
}
