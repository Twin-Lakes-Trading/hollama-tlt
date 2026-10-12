/// <reference lib="webworker" />
// Runs Python with Pyodide, off the main thread, so a slow or stuck script can
// be stopped by ending the worker. Network access is limited to Pyodide's own
// package downloads: code the model writes may have been steered by a web page,
// and from this browser it could otherwise reach Ollama and the VPN.
import type { PyodideAPI } from 'pyodide';

import type { PythonRequest, PythonResponse } from './python';

declare const self: DedicatedWorkerGlobalScope;

let pyodide: Promise<PyodideAPI> | undefined;
const namespaces = new Map<string, ReturnType<PyodideAPI['toPy']>>();

const SETUP = `
import base64, io, os, sys
os.environ["MPLBACKEND"] = "AGG"

def _scipio_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    images = []
    for number in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format="png", dpi=80, bbox_inches="tight")
        images.append(base64.b64encode(buffer.getvalue()).decode())
    plt.close("all")
    return images
`;

// Replaces the network APIs in place (not with subclasses or copies), so code
// running here can't reach the originals through prototypes, and locks them so
// they can't be put back. A dynamic import() can still send a GET, but nothing
// can send a body, choose a method, or read a cross-origin response.
function blockNetwork(allowedPrefix: string) {
	const resolve = (url: string | URL) => new URL(url, self.location.href).href;
	const denied = (url: string | URL) =>
		`Network access is turned off in Scipio's Python sandbox (${resolve(url)})`;
	const lock = (target: object, name: string, value: unknown) =>
		Object.defineProperty(target, name, { value, writable: false, configurable: false });

	const realFetch = self.fetch.bind(self);
	const guardedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input;
		if (resolve(url).startsWith(allowedPrefix)) return realFetch(input, init);
		return Promise.reject(new TypeError(denied(url)));
	};
	lock(WorkerGlobalScope.prototype, 'fetch', guardedFetch);
	lock(self, 'fetch', guardedFetch);

	const realOpen = XMLHttpRequest.prototype.open;
	lock(
		XMLHttpRequest.prototype,
		'open',
		function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
			if (!resolve(url).startsWith(allowedPrefix))
				throw new DOMException(denied(url), 'SecurityError');
			return (realOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
		}
	);

	for (const name of [
		'WebSocket',
		'WebSocketStream',
		'WebTransport',
		'EventSource',
		'caches',
		'Worker'
	]) {
		lock(self, name, undefined);
	}
}

async function getPyodide(indexUrl: string): Promise<PyodideAPI> {
	pyodide ??= (async () => {
		const { loadPyodide } = (await import(/* @vite-ignore */ `${indexUrl}pyodide.mjs`)) as {
			loadPyodide: (options: { indexURL: string }) => Promise<PyodideAPI>;
		};
		blockNetwork(indexUrl);
		const instance = await loadPyodide({ indexURL: indexUrl });
		instance.runPython(SETUP);
		return instance;
	})();
	return pyodide;
}

async function run(request: PythonRequest): Promise<PythonResponse> {
	const py = await getPyodide(request.indexUrl);

	py.FS.mkdirTree('/data');
	for (const file of request.files) {
		py.FS.writeFile(`/data/${file.name}`, new Uint8Array(file.data));
	}

	let stdout = '';
	let stderr = '';
	py.setStdout({ batched: (text: string) => (stdout += `${text}\n`) });
	py.setStderr({ batched: (text: string) => (stderr += `${text}\n`) });

	let namespace = namespaces.get(request.namespace);
	if (!namespace) {
		namespace = py.globals.get('dict')();
		namespaces.set(request.namespace, namespace);
	}

	let result: string | undefined;
	let error: string | undefined;
	try {
		// Package download messages would otherwise end up in the model's output
		let packageErrors = '';
		await py.loadPackagesFromImports(request.code, {
			messageCallback: () => {},
			errorCallback: (message: string) => (packageErrors += `${message}\n`)
		});
		stderr += packageErrors;
		const value = await py.runPythonAsync(request.code, {
			globals: namespace,
			filename: '<scipio>'
		});
		if (value !== undefined && value !== null) {
			const isProxy = value instanceof py.ffi.PyProxy;
			result = isProxy ? py.globals.get('repr')(value) : String(value);
			if (isProxy) value.destroy();
		}
	} catch (e) {
		error = (e as Error).message;
	}

	const figures = py.globals.get('_scipio_figures')();
	const images = figures.toJs() as string[];
	figures.destroy();

	return { id: request.id, stdout, stderr, result, error, images };
}

self.onmessage = async (event: MessageEvent<PythonRequest>) => {
	try {
		self.postMessage(await run(event.data));
	} catch (e) {
		self.postMessage({
			id: event.data.id,
			stdout: '',
			stderr: '',
			error: `Python couldn't start: ${(e as Error).message}`,
			images: []
		} satisfies PythonResponse);
	}
};
