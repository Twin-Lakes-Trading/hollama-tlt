import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_PLAUSIBLE_DOMAIN: { public: true, schema: (input) => input ?? '' },
	PUBLIC_PLAUSIBLE_API: { public: true, schema: (input) => input ?? '' },
	PUBLIC_PLAUSIBLE_SRC: { public: true, schema: (input) => input ?? '' },
	PUBLIC_ADAPTER: { public: true, schema: (input) => input ?? '' },
	SEARXNG_URL: {
		description: 'SearXNG instance that web search queries, reachable from the server',
		schema: (input) => input || 'http://127.0.0.1:8888'
	}
});
