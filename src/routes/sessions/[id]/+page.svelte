<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { toast } from 'svelte-sonner';

	import LL from '$i18n/i18n-svelte';
	import { beforeNavigate } from '$app/navigation';
	import {
		type Message as ChatMessage,
		type ChatRequest,
		type ChatStrategy
	} from '#lib/chat/index.js';
	import { OllamaStrategy } from '#lib/chat/ollama.js';
	import { OpenAIStrategy } from '#lib/chat/openai.js';
	import Button from '#lib/components/Button.svelte';
	import ButtonCopy from '#lib/components/ButtonCopy.svelte';
	import ButtonDelete from '#lib/components/ButtonDelete.svelte';
	import Head from '#lib/components/Head.svelte';
	import Header from '#lib/components/Header.svelte';
	import Metadata from '#lib/components/Metadata.svelte';
	import { ConnectionType } from '#lib/connections.js';
	import { serversStore, settingsStore } from '#lib/localStorage.js';
	import {
		formatSessionMetadata,
		getSessionTitle,
		loadSession,
		saveSession,
		type Editor,
		type Message
	} from '#lib/sessions.js';
	import { Sitemap } from '#lib/sitemap.js';
	import {
		runToolCall,
		WEB_SEARCH_LIMITS,
		WEB_SEARCH_TOOLS,
		webSearchSystemPrompt,
		type ToolBudget,
		type ToolCall
	} from '#lib/webSearch.js';

	import type { PageData } from './$types';
	import Controls from './Controls.svelte';
	import Messages from './Messages.svelte';
	import Prompt from './Prompt.svelte';
	import { createReasoningProcessor } from './reasoningProcessor';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	let session = $state(loadSession(data.id));
	let editor = $state<Editor>({
		prompt: '',
		view: 'messages',
		messageIndexToEdit: null,
		isCodeEditor: false,
		isCompletionInProgress: false,
		shouldFocusTextarea: false,
		isNewSession: true
	});
	let messagesWindow: HTMLDivElement | undefined = $state();
	let modelName: string | undefined = $state();
	let userScrolledUp = $state(false);
	let shouldConfirmDeletion = $state(false);

	$effect(() => {
		if (data.id !== session.id) handleSessionChange();
	});

	$effect(() => {
		session.model = $settingsStore.models.find((m) => m.name === modelName);
	});

	$effect(() => {
		if (editor.shouldFocusTextarea && editor.promptTextarea) {
			editor.promptTextarea.focus();
			editor.shouldFocusTextarea = false;
		}
	});

	onMount(async () => {
		handleSessionChange();
		await scrollToBottom();
		messagesWindow?.addEventListener('scroll', handleScroll);
	});

	beforeNavigate((navigation) => {
		if (navigation.shallow) return;

		if (editor.isCompletionInProgress) {
			const userConfirmed = confirm($LL.areYouSureYouWantToLeave());
			if (userConfirmed) {
				stopCompletion();
				return;
			}
			navigation.cancel();
			return;
		}

		// Only show confirmation when navigating outside of /sessions/ path
		if (
			editor.prompt &&
			editor.prompt.trim() !== '' &&
			!navigation.to?.url.pathname.startsWith('/sessions/')
		) {
			const userConfirmed = confirm($LL.unsavedChangesWillBeLost());
			if (!userConfirmed) {
				navigation.cancel();
			}
		}
	});

	async function handleSessionChange() {
		session = loadSession(data.id);
		modelName = session.model?.name || '';
		editor.view = 'messages';
		editor.isNewSession = !session?.messages?.length;
		scrollToBottom();
	}

	async function handleSubmitNewMessage(images?: { data: string; filename: string }[]) {
		const message: Message = { role: 'user', content: editor.prompt };
		if (images && images.length) message.images = images;
		session.messages = [...session.messages, message];
		await scrollToBottom(true); // Force scroll after submitting prompt
		await handleCompletion();
	}

	async function handleSubmitEditMessage(images?: { data: string; filename: string }[]) {
		if (editor.messageIndexToEdit === null) return;

		const msg = session.messages[editor.messageIndexToEdit];
		msg.content = editor.prompt;
		if (images) {
			msg.images = images;
		} else {
			delete msg.images;
		}

		// Remove all messages after the edited message
		session.messages = session.messages.slice(0, editor.messageIndexToEdit + 1);

		editor.messageIndexToEdit = null;
		editor.prompt = '';

		await handleCompletion();
	}

	function handleSubmit(images?: { data: string; filename: string }[]) {
		if (!editor.prompt && (!images || images.length === 0)) return;
		if (!session.model) return;
		editor.isCodeEditor = false;
		editor.isNewSession = false;
		editor.view = 'messages';

		if (editor.messageIndexToEdit !== null) handleSubmitEditMessage(images);
		else handleSubmitNewMessage(images);
	}

	async function handleRetry(index: number) {
		// Remove all the messages after the index
		session.messages = session.messages.slice(0, index);

		const mostRecentUserMessage = session.messages.filter((m) => m.role === 'user').at(-1);
		if (!mostRecentUserMessage) throw new Error('No user message to retry');

		await handleCompletion();
	}

	// Earlier answers' research steps are dropped to save context: their
	// answers already carry what was learned
	function toChatMessages(history: Message[], systemPrompt: string): ChatMessage[] {
		const lastUserIndex = history.findLastIndex((m) => m.role === 'user');
		const chatMessages = history.flatMap((msg, i): ChatMessage[] => {
			const isToolStep = msg.role === 'tool' || !!msg.toolCalls?.length;
			if (isToolStep && i < lastUserIndex) return [];
			if (msg.role === 'tool') {
				return [{ role: 'tool', content: msg.content, tool_name: msg.toolName }];
			}

			// Ollama expects images as base64 strings without filename
			const chatMessage: ChatMessage = { ...msg, images: msg.images?.map((img) => img.data) };
			if (msg.toolCalls?.length) {
				chatMessage.tool_calls = msg.toolCalls;
				chatMessage.thinking = msg.reasoning;
			}
			return [chatMessage];
		});
		return systemPrompt
			? [{ ...session.systemPrompt, content: systemPrompt, images: undefined }, ...chatMessages]
			: chatMessages;
	}

	function describeToolCall({ function: { name, arguments: args } }: ToolCall): string {
		if (name === 'web_search') return $LL.webSearchSearching({ query: String(args.query ?? '') });
		if (name === 'fetch_page') return $LL.webSearchReading({ url: String(args.url ?? '') });
		return name;
	}

	async function handleCompletion() {
		editor.abortController = new AbortController();
		editor.isCompletionInProgress = true;
		editor.prompt = '';
		editor.completion = '';
		editor.reasoning = '';

		const server = $serversStore.find((s) => s.id === session.model?.serverId);
		if (!server) throw new Error('Server not found');
		if (!session.model?.name) throw new Error('No model');
		const modelName = session.model.name;

		try {
			let strategy: ChatStrategy | undefined = undefined;
			switch (server.connectionType) {
				case ConnectionType.Ollama:
					strategy = new OllamaStrategy(server);
					break;
				case ConnectionType.OpenAI:
				case ConnectionType.OpenAICompatible:
					strategy = new OpenAIStrategy(server);
					break;
			}

			if (!strategy) throw new Error('Invalid strategy');

			// Show a loading state instead of looking frozen while Ollama swaps a
			// cold model into memory. The check is sent just before the chat request
			// so it sees what was loaded beforehand, without holding the request up.
			const abortController = editor.abortController;
			let hasReceivedChunk = false;
			if (strategy instanceof OllamaStrategy) {
				strategy
					.isModelLoaded(modelName)
					.then((isLoaded) => {
						if (isLoaded || hasReceivedChunk) return;
						if (editor.abortController === abortController && editor.isCompletionInProgress)
							editor.isModelLoading = true;
					})
					.catch(() => {});
			}

			const useWebSearch =
				!!session.webSearch &&
				strategy instanceof OllamaStrategy &&
				(await strategy.getCapabilities(modelName)).includes('tools');
			const systemPrompt = [
				session.systemPrompt.content,
				useWebSearch ? webSearchSystemPrompt() : ''
			]
				.filter(Boolean)
				.join('\n\n');
			const budget: ToolBudget = { searches: 0, pageReads: 0 };

			// With web search the model may call tools: run them, add the results,
			// and ask again until it answers. Without it this runs once.
			for (let round = 1; ; round++) {
				const canUseTools = useWebSearch && round < WEB_SEARCH_LIMITS.roundsPerAnswer;
				const chatRequest: ChatRequest = {
					model: modelName,
					options: session.options,
					messages: toChatMessages(session.messages, systemPrompt),
					...(canUseTools && { tools: WEB_SEARCH_TOOLS })
				};

				editor.completion = '';
				editor.reasoning = '';
				const toolCalls: ToolCall[] = [];

				// Some models still inline their reasoning in `<think>` tags within the content
				const reasoningProcessor = createReasoningProcessor(
					(text) => {
						editor.completion += text;
					},
					(text) => {
						editor.reasoning += text;
					}
				);

				await strategy.chat(
					chatRequest,
					abortController.signal,
					async ({ content, reasoning, toolCalls: calls }) => {
						hasReceivedChunk = true;
						editor.isModelLoading = false;
						if (reasoning) editor.reasoning += reasoning;
						if (content) reasoningProcessor.processChunk(content);
						if (calls) toolCalls.push(...calls);
						await scrollToBottom();
					}
				);

				// Finalize processing of any remaining content
				reasoningProcessor.finalize();

				if (!toolCalls.length) break;

				session.messages = [
					...session.messages,
					{
						role: 'assistant',
						content: editor.completion,
						reasoning: editor.reasoning,
						toolCalls
					}
				];
				editor.completion = '';
				editor.reasoning = '';

				for (const call of toolCalls) {
					editor.toolStatus = describeToolCall(call);
					await scrollToBottom();
					const result = await runToolCall(call, budget, abortController.signal);
					session.messages = [
						...session.messages,
						{
							role: 'tool',
							content: result.content,
							toolName: call.function.name,
							toolLabel: result.label,
							isToolError: result.isError
						}
					];
				}
				editor.toolStatus = undefined;
				saveSession(session);
			}

			const message: Message = {
				role: 'assistant',
				content: editor.completion,
				reasoning: editor.reasoning
			};

			session.messages = [...session.messages, message];
			session.updatedAt = new Date().toISOString();
			saveSession(session);

			editor.completion = '';
			editor.reasoning = '';
			editor.shouldFocusTextarea = true;
			editor.isCompletionInProgress = false;
			editor.isModelLoading = false;
			await scrollToBottom();
		} catch (error) {
			editor.toolStatus = undefined;
			const typedError = error instanceof Error ? error : new Error(String(error));
			if (typedError.name === 'AbortError') return; // User aborted the request
			handleError(typedError);
		}
	}

	function stopCompletion() {
		editor.abortController?.abort();

		// Add the incomplete message to session if there's any content
		if (editor.completion || editor.reasoning) {
			const message: Message = {
				role: 'assistant',
				content: editor.completion || '',
				reasoning: editor.reasoning || ''
			};
			session.messages = [...session.messages, message];
			session.updatedAt = new Date().toISOString();
			saveSession(session);
		}

		// Clear editor state
		editor.completion = '';
		editor.reasoning = '';
		editor.isCompletionInProgress = false;
		editor.isModelLoading = false;
		editor.shouldFocusTextarea = true;
	}

	function handleError(error: Error) {
		if (error.message === 'Failed to fetch') {
			toast.error($LL.genericError(), { description: $LL.cantConnectToOllamaServer() });
		} else {
			toast.error($LL.genericError(), { description: error.toString() });
		}

		// For errors, restore the prompt so user can retry
		const lastUserMessage = session.messages.filter((m) => m.role === 'user').at(-1);
		if (lastUserMessage) {
			editor.prompt = lastUserMessage.content;
		}

		editor.abortController?.abort();
		editor.completion = '';
		editor.reasoning = '';
		editor.isCompletionInProgress = false;
		editor.isModelLoading = false;
		editor.shouldFocusTextarea = true;
	}

	function handleScroll() {
		if (!messagesWindow) return;
		const { scrollTop, scrollHeight, clientHeight } = messagesWindow;
		userScrolledUp = scrollTop + clientHeight < scrollHeight;
	}

	async function scrollToBottom(shouldForceScroll = false) {
		if (!shouldForceScroll && (!messagesWindow || userScrolledUp)) return;
		await tick();
		requestAnimationFrame(() => {
			if (messagesWindow) messagesWindow.scrollTop = messagesWindow.scrollHeight;
		});
	}
</script>

<div class="session">
	<Head
		title={[editor.isNewSession ? $LL.newSession() : getSessionTitle(session), $LL.sessions()]}
	/>
	<Header confirmDeletion={shouldConfirmDeletion}>
		{#snippet headline()}
			<p data-testid="session-id" class="font-bold leading-none">
				{$LL.session()}
				<Button variant="link" href={`/sessions/${session.id}`}>#{session.id}</Button>
			</p>
			<Metadata dataTestid="session-metadata">
				{editor.isNewSession ? $LL.newSession() : formatSessionMetadata(session)}
			</Metadata>
		{/snippet}

		{#snippet nav()}
			{#if !editor.isNewSession}
				{#if !shouldConfirmDeletion}
					<ButtonCopy content={JSON.stringify(session.messages, null, 2)} />
				{/if}
				<ButtonDelete sitemap={Sitemap.SESSIONS} id={session.id} bind:shouldConfirmDeletion />
			{/if}
		{/snippet}
	</Header>

	{#if editor.view === 'controls'}
		<Controls bind:session />
	{:else}
		<div class="session__history" bind:this={messagesWindow}>
			<Messages bind:session bind:editor {handleRetry} />
		</div>
	{/if}

	<Prompt
		bind:session
		bind:editor
		bind:modelName
		{handleSubmit}
		{stopCompletion}
		{scrollToBottom}
	/>
</div>

<style lang="postcss">
	.session {
		@apply flex h-full w-full flex-col overflow-hidden;
	}

	.session__history {
		@apply base-fieldset-container overflow-scrollbar flex-grow;
	}
</style>
