<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { handleCallback } from '$lib/auth.svelte.ts';

	let error = $state<string | null>(null);

	onMount(async () => {
		try {
			const returnTo = await handleCallback(new URL(location.href));
			await goto(returnTo, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
		}
	});
</script>

<section class="callback">
	{#if error}
		<h1>Sign-in failed</h1>
		<p>{error}</p>
		<a href="/">Back to start</a>
	{:else}
		<div class="spinner" aria-hidden="true"></div>
		<p role="status" aria-live="polite">Signing you in…</p>
	{/if}
</section>

<style>
	.callback {
		text-align: center;
		padding: 3rem 1rem;
	}
	.spinner {
		width: 28px;
		height: 28px;
		margin: 0 auto 1rem;
		border: 3px solid #ddd;
		border-top-color: #666;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
