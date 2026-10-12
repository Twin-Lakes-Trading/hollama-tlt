import { searchWeb, WebToolError } from '#lib/server/webTools.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	const { query } = (await request.json().catch(() => ({}))) as { query?: unknown };
	if (typeof query !== 'string' || !query.trim()) {
		return Response.json({ message: 'A search query is required' }, { status: 400 });
	}

	try {
		return Response.json({ results: await searchWeb(query.trim()) });
	} catch (error) {
		const status = error instanceof WebToolError ? error.status : 500;
		return Response.json({ message: (error as Error).message }, { status });
	}
}
