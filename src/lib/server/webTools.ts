// Server side of web search: queries SearXNG and fetches pages for the model.
// Runs on the Scipio mini, so page fetches must never reach local or VPN
// addresses (the router, Ollama, other machines on WireGuard).
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';

import { SEARXNG_URL } from '$app/env/private';
import { WEB_SEARCH_LIMITS, type FetchedPage, type SearchResult } from '#lib/webSearch.js';

export class WebToolError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
	const url = new URL('/search', SEARXNG_URL);
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'json');

	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	} catch {
		throw new WebToolError(`Couldn't reach the search engine at ${SEARXNG_URL}`, 502);
	}
	if (!response.ok) throw new WebToolError(`Search engine returned ${response.status}`, 502);

	const data = (await response.json()) as {
		results?: { title?: string; url?: string; content?: string }[];
	};
	return (data.results ?? [])
		.filter((result) => result.url)
		.slice(0, WEB_SEARCH_LIMITS.resultsPerSearch)
		.map((result) => ({
			title: result.title ?? '',
			url: result.url!,
			snippet: result.content ?? ''
		}));
}

// Addresses a page fetch may never connect to
const BLOCKED = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8], // "this" network
	['10.0.0.0', 8], // private, including WireGuard
	['100.64.0.0', 10], // carrier-grade NAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local
	['172.16.0.0', 12], // private
	['192.0.0.0', 24], // IETF protocol assignments
	['192.168.0.0', 16], // private
	['198.18.0.0', 15], // benchmarking
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4] // reserved and broadcast
] as const) {
	BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 128], // unspecified
	['::1', 128], // loopback
	['fc00::', 7], // unique local
	['fe80::', 10], // link-local
	['ff00::', 8] // multicast
] as const) {
	BLOCKED.addSubnet(network, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
	// IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it maps to
	const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
	const family = isIP(address);
	if (family === 4) return BLOCKED.check(address, 'ipv4');
	if (family === 6) return BLOCKED.check(address, 'ipv6');
	return true;
}

// Checks the address at connect time, so a hostname can't pass a check and
// then resolve somewhere else (DNS rebinding)
const safeLookup: LookupFunction = (hostname, options, callback) => {
	lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) return callback(error, '', 4);
		const list = addresses as { address: string; family: number }[];
		const blocked = list.find(({ address }) => isBlockedAddress(address));
		if (blocked || !list.length) {
			return callback(new WebToolError(`${hostname} is a local or private address`), '', 4);
		}
		if (options.all) return (callback as (e: null, a: typeof list) => void)(null, list);
		callback(null, list[0].address, list[0].family);
	});
};

interface RawResponse {
	url: URL;
	contentType: string;
	body: Buffer;
}

function request(url: URL, signal: AbortSignal): Promise<RawResponse | URL> {
	return new Promise((resolve, reject) => {
		const client = url.protocol === 'https:' ? https : http;
		const req = client.get(
			url,
			{
				lookup: safeLookup,
				signal,
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; ScipioLLM/1.0)',
					Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
					'Accept-Encoding': 'gzip, deflate, br'
				}
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume();
					return resolve(new URL(res.headers.location, url));
				}
				if (status >= 400) {
					res.resume();
					return reject(new WebToolError(`The page returned ${status}`, 502));
				}

				const encoding = res.headers['content-encoding'];
				const stream =
					encoding === 'gzip'
						? res.pipe(zlib.createGunzip())
						: encoding === 'deflate'
							? res.pipe(zlib.createInflate())
							: encoding === 'br'
								? res.pipe(zlib.createBrotliDecompress())
								: res;

				const chunks: Buffer[] = [];
				let size = 0;
				stream.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > WEB_SEARCH_LIMITS.maxPageBytes) {
						req.destroy();
						return reject(new WebToolError('The page is too large to read', 413));
					}
					chunks.push(chunk);
				});
				stream.on('end', () =>
					resolve({
						url,
						contentType: res.headers['content-type'] ?? '',
						body: Buffer.concat(chunks)
					})
				);
				stream.on('error', reject);
			}
		);
		req.on('error', (error) =>
			reject(error instanceof WebToolError ? error : new WebToolError(error.message, 502))
		);
	});
}

export async function fetchPage(input: string): Promise<FetchedPage> {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new WebToolError('Not a valid URL');
	}

	const signal = AbortSignal.timeout(10_000);
	for (let redirects = 0; redirects <= 5; redirects++) {
		if (!['http:', 'https:'].includes(url.protocol)) {
			throw new WebToolError('Only http and https pages can be read');
		}
		// Literal IPs skip DNS lookup, so check them here too
		const host = url.hostname.replace(/^\[|\]$/g, '');
		if (isIP(host) && isBlockedAddress(host)) {
			throw new WebToolError(`${host} is a local or private address`);
		}

		const result = await request(url, signal).catch((error: Error) => {
			if (error.name === 'AbortError' || error.name === 'TimeoutError') {
				throw new WebToolError('The page took too long to respond', 504);
			}
			throw error;
		});
		if (result instanceof URL) {
			url = result;
			continue;
		}
		return toPage(result);
	}
	throw new WebToolError('The page redirected too many times', 502);
}

function decode(body: Buffer, contentType: string): string {
	const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		return new TextDecoder('utf-8').decode(body);
	}
}

function toPage({ url, contentType, body }: RawResponse): FetchedPage {
	const type = contentType.split(';')[0].trim().toLowerCase();
	let title = '';
	let text: string;

	if (type === 'text/html' || type === 'application/xhtml+xml' || type === '') {
		const html = decode(body, contentType);
		title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
		text = htmlToText(html);
	} else if (type.startsWith('text/') || type === 'application/json') {
		text = decode(body, contentType);
	} else {
		throw new WebToolError(`Can't read ${type} files, only web pages and text`, 415);
	}

	text = text.trim();
	const isTruncated = text.length > WEB_SEARCH_LIMITS.maxPageChars;
	return {
		url: url.toString(),
		title,
		text: isTruncated ? text.slice(0, WEB_SEARCH_LIMITS.maxPageChars) : text,
		isTruncated
	};
}

// A small readability pass: keep the main content, drop page furniture
export function htmlToText(html: string): string {
	let content = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '');

	const main =
		content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
		content.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
	if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) content = main;

	content = content
		.replace(/<(nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<(br|hr)\b[^>]*>/gi, '\n')
		.replace(
			/<\/?(p|div|section|article|main|h[1-6]|ul|ol|table|tr|blockquote|pre)\b[^>]*>/gi,
			'\n'
		)
		.replace(/<(td|th)\b[^>]*>/gi, ' ')
		.replace(/<[^>]+>/g, '');

	return decodeEntities(content)
		.split('\n')
		.map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
		.filter((line, i, lines) => line || lines[i - 1])
		.join('\n')
		.replace(/\n{3,}/g, '\n\n');
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	copy: '©',
	reg: '®',
	trade: '™',
	deg: '°',
	euro: '€',
	pound: '£'
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
		if (code[0] === '#') {
			const point =
				code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		}
		return ENTITIES[code.toLowerCase()] ?? entity;
	});
}
