<script lang="ts">
	import LL from '$i18n/i18n-svelte';
	import EmptyMessage from '#lib/components/EmptyMessage.svelte';
	import { deleteFile } from '#lib/files.js';
	import { saveSession, type Editor, type Message, type Session } from '#lib/sessions.js';

	import Article from './Article.svelte';
	import ToolStep from './ToolStep.svelte';

	interface Props {
		session: Session;
		editor: Editor;
		handleRetry: (index: number) => void;
	}

	let { session = $bindable(), editor = $bindable(), handleRetry }: Props = $props();

	function handleEditMessage(message: Message) {
		editor.messageIndexToEdit = session.messages.findIndex((m) => m === message);
		editor.isCodeEditor = true;
		editor.prompt = message.content;
		editor.attachments = (message.images || []).map((img, idx) => ({
			type: 'image',
			id: `${idx}-${img.filename}`,
			name: img.filename,
			dataUrl: `data:image/png;base64,${img.data}`
		}));
		editor.promptTextarea?.focus();
	}

	function handleDeleteAttachment(message: Message) {
		session.messages = session.messages.filter((m) => m !== message);
		saveSession(session);
		if (message.file) deleteFile(message.file.id).catch(() => {});
	}
</script>

{#if editor.isNewSession}
	<EmptyMessage>{$LL.writePromptToStart()}</EmptyMessage>
{/if}

{#each session.messages as message, i (session.id + i)}
	{#key message.role}
		{#if message.role === 'tool' || message.toolCalls?.length}
			<ToolStep {message} />
		{:else}
			<Article
				{message}
				retryIndex={['assistant', 'system'].includes(message.role) ? i : undefined}
				{handleRetry}
				handleEditMessage={() => handleEditMessage(message)}
				handleDeleteAttachment={() => handleDeleteAttachment(message)}
			/>
		{/if}
	{/key}
{/each}

{#if editor.isCompletionInProgress && editor.toolStatus}
	<ToolStep status={editor.toolStatus} />
{:else if editor.isCompletionInProgress}
	<Article
		message={{
			role: 'assistant',
			content: editor.completion || '...',
			reasoning: editor.reasoning
		}}
		isStreamingArticle={true}
		currentRawReasoning={editor.reasoning}
		currentRawCompletion={editor.completion}
		status={editor.isModelLoading
			? $LL.loadingModel({ model: session.model?.name ?? '' })
			: undefined}
	/>
{/if}
