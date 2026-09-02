export { createLineSplitter, type LineSplitter, type LineSplitterOptions } from './framing'
export {
  createChangeAssembler,
  createReassembler,
  type ChangeAssembler,
  type ChangedWire,
  type Reassembler,
  type RepAbort,
  type RepChunkIn,
} from './reassembler'
export { createCorrelator, type Correlator } from './correlator'
export {
  createAgentCore,
  spawnAgent,
  DEFAULT_MAX_RESTARTS,
  HOST_VERSION,
  MAX_CONSECUTIVE_PARSE_FAILURES,
  RESTART_BACKOFF_MS,
  type AgentCore,
  type SpawnAgentOptions,
} from './spawn-agent'
export { createFakeAgent, matchesPattern, type FakeAgent } from './fake-agent'
export {
  loadTranscript,
  parseTranscript,
  TranscriptFrameSchema,
  TranscriptMetaSchema,
  type Transcript,
  type TranscriptFrame,
  type TranscriptMeta,
} from './transcript'
