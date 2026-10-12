import { fetchPage, WebToolError } from '#lib/server/webTools.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	const { url } = (await request.json().catch(() => ({}))) as { url?: unknown };
	if (typeof url !== 'string' || !url.trim()) {
		return Response.json({ message: 'A URL is required' }, { status: 400 });
	}

	try {
		return Response.json(await fetchPage(url.trim()));
	} catch (error) {
		const status = error instanceof WebToolError ? error.status : 502;
		return Response.json({ message: (error as Error).message }, { status });
	}
}
