<script lang="ts">
  interface Props {
    text: string
    tone: 'info' | 'warn'
  }
  let { text, tone }: Props = $props()
</script>

<div class="toast" data-testid="toast" data-tone={tone} role="status" aria-live="polite">{text}</div>
