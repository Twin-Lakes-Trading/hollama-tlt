<script lang="ts">
	import {
		ChevronDown,
		ChevronUp,
		FileText,
		LoaderCircle,
		Search,
		TriangleAlert
	} from '@lucide/svelte';
	import { quadInOut } from 'svelte/easing';
	import { slide } from 'svelte/transition';

	import LL from '$i18n/i18n-svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import type { Message } from '#lib/sessions.js';

	// One step of web search research: either the model's turn that asked for
	// tools (with its reasoning), or a tool's result
	let { message, status = undefined }: { message?: Message; status?: string } = $props();

	let isReasoningVisible = $state(false);

	const label = $derived(status ?? message?.toolLabel ?? message?.toolName ?? '');
	const url = $derived(
		message?.toolName === 'fetch_page' ? label.replace(/^[^:]+:\s*/, '') : undefined
	);
</script>

{#if status || message?.role === 'tool'}
	<div class="tool-step" class:tool-step--error={message?.isToolError} data-testid="tool-step">
		{#if status}
			<LoaderCircle class="base-icon animate-spin" />
		{:else if message?.isToolError}
			<TriangleAlert class="base-icon" />
		{:else if message?.toolName === 'fetch_page'}
			<FileText class="base-icon" />
		{:else}
			<Search class="base-icon" />
		{/if}
		{#if url && !message?.isToolError && /^https?:\/\//.test(url)}
			<span class="tool-step__label">
				{label.slice(0, label.length - url.length)}<a
					href={url}
					target="_blank"
					rel="noopener noreferrer">{url}</a
				>
			</span>
		{:else}
			<span class="tool-step__label">{label}</span>
		{/if}
	</div>
{:else if message?.reasoning || message?.content}
	<div class="tool-step tool-step--thinking">
		{#if message.content}
			<p class="tool-step__label">{message.content}</p>
		{/if}
		{#if message.reasoning}
			<button class="tool-step__toggle" onclick={() => (isReasoningVisible = !isReasoningVisible)}>
				{$LL.reasoning()}
				{#if isReasoningVisible}
					<ChevronUp class="base-icon" />
				{:else}
					<ChevronDown class="base-icon" />
				{/if}
			</button>
			{#if isReasoningVisible}
				<div class="tool-step__reasoning" transition:slide={{ easing: quadInOut, duration: 200 }}>
					<Markdown markdown={message.reasoning} />
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style lang="postcss">
	.tool-step {
		@apply mx-auto mb-2 flex w-full max-w-[80ch] items-center gap-2 px-3 text-xs text-muted;
		@apply md:px-4 lg:px-6;
	}

	.tool-step--error {
		@apply text-warning;
	}

	.tool-step--thinking {
		@apply flex-col items-stretch;
	}

	.tool-step__label {
		@apply min-w-0 truncate;
	}

	.tool-step__label a {
		@apply underline underline-offset-2 hover:text-active;
	}

	.tool-step__toggle {
		@apply flex w-full items-center justify-between gap-2 rounded bg-shade-1 p-2;
	}

	.tool-step__reasoning {
		@apply rounded-b bg-shade-1 p-2;
	}
</style>
