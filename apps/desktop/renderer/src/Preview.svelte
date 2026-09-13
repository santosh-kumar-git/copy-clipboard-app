<script lang="ts">
  // Spec §11 control 3: this component renders text/plain, or HTML *source* as text. Svelte's
  // raw-HTML directive is absent here and always will be — security/no-html-sink.security.test.ts
  // fails if one appears. The comment says it in prose on purpose: .svelte is scanned RAW, so
  // writing the directive's own token here would trip the very ban this comment documents.
  interface Props {
    text: string
    mime: 'text/plain' | 'text/html'
    filePaths?: readonly string[]
    imageDataUrl?: string | null
    imageOnly?: boolean
    truncated?: boolean
  }
  let { text, mime, filePaths = [], imageDataUrl = null, imageOnly = false, truncated = false }: Props = $props()
</script>

{#if mime === 'text/html'}
  <div class="preview-badge" data-testid="preview-badge">HTML source</div>
{/if}
{#if filePaths.length > 0}
  <ul class="file-list" data-testid="file-list">
    {#each filePaths as path, i (i)}<li>{path}</li>{/each}
  </ul>
{/if}
{#if imageDataUrl !== null}
  <img class="preview-image" data-testid="preview-image" src={imageDataUrl} alt="Clipboard preview" />
{:else if imageOnly && text.length === 0}
  <p class="preview-note">Image preview unavailable.</p>
{:else}
  <pre class="preview-body" data-testid="preview">{text}</pre>
{/if}
{#if truncated}<p class="preview-note">Preview shortened for this large clip.</p>{/if}
