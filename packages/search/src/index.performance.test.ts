import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'

it('finishes repetitive near-matches without blocking the caller indefinitely', async () => {
  const require = createRequire(import.meta.url)
  const source = stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
    .replace("'@leeoniya/ufuzzy'", JSON.stringify(pathToFileURL(require.resolve('@leeoniya/ufuzzy')).href))
    .replace("'@cairn/protocol'", JSON.stringify(new URL('../../protocol/src/constants.ts', import.meta.url).href))
  const script = `
    import { parentPort } from 'node:worker_threads';
    ${source}
    const index = createSearchIndex();
    let ord = 0;
    const add = (id, preview) => index.add({
      id, preview: preview.replace(/\\s+/g, ' ').trim().slice(0, 512),
      pinned: false, tagged: false, updatedAt: ord, ord: ord++,
    });
    for (let i = 0; i < 100; i++)
      add('note' + i, 'Synthetic saved clip ' + i + '\\n' + 'A longer note for testing the scrollable preview.\\n'.repeat(24));
    for (let i = 0; i < 45; i++) add('image' + i, '');
    for (const [id, preview] of [
      ['reminder', 'Remember to book the meeting room for Thursday'],
      ['fox', 'The quick brown fox jumps over the lazy dog.'],
      ['sql', 'SELECT name, created_at FROM projects ORDER BY created_at DESC;'],
      ['command', 'npm run verify'],
      ['url', 'https://example.com/design-notes'],
      ['release', 'Release checklist: test, build, review, publish.'],
      ['meeting', 'Meeting notes\\nReview the new search flow\\nPrepare the release checklist'],
      ['private', 'Work login'], ['html', '<b>Preview formatted note</b>'],
      ['files', 'file:///tmp/Preview-document.txt'], ['titled-image', 'Preview sample'],
    ]) add(id, preview);
    const started = performance.now();
    const hits = index.query('Release checklist', 50);
    const missing = index.query('Release checklist unavailable', 50);
    const repetition = createSearchIndex();
    repetition.add({ id: 'repeated', preview: 'a'.repeat(512), pinned: false, tagged: false, updatedAt: 1, ord: 1 });
    const absentSuffix = repetition.query('aaaaaaaaaaaaaaaaaaaaaaaaz', 10);
    const absentContraction = repetition.query("aaaaaaaaaaaaaaaaaaaaaaa'zz", 10);
    const absentQuotedTail = repetition.query('aaaaaaaaaaaaaaaaaaaaaaa "z"', 10);
    const excluded = repetition.query('-a+a+a+a+a+a+a+a+z', 10);
    parentPort.postMessage({ size: index.size, hits, missing, absentSuffix, absentContraction, absentQuotedTail, excluded, elapsedMs: performance.now() - started });
  `
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`))
    let settled = false
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      void worker.terminate().then(() => {
        if (error !== null) reject(error)
        else resolve(value)
      }, reject)
    }
    // This timer runs outside the worker's potentially blocked search isolate.
    const watchdog = setTimeout(() => finish(new Error('search exceeded its 3-second watchdog')), 3_000)
    worker.once('message', (value: unknown) => finish(null, value))
    worker.once('error', (error) => finish(new Error(error.message)))
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`search worker exited without a result (${code})`))
    })
  })

  expect(result).toMatchObject({
    size: 156,
    hits: [
      { id: 'release', score: 1, ranges: [0, 7, 8, 17] },
      { id: 'meeting', score: 0.5, ranges: [14, 16, 37, 38, 43, 44, 45, 46, 58, 60, 61, 70] },
    ],
    missing: [],
    absentSuffix: [],
    absentContraction: [],
    absentQuotedTail: [],
    excluded: [{ id: 'repeated', score: 1, ranges: [] }],
  })
}, 10_000)
