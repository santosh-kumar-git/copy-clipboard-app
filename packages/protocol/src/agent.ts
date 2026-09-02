import * as z from 'zod'
import { CHUNK_THRESHOLD_BYTES, MAX_REP_BYTES, WIRE_MAJOR } from './constants'

export const ContentHashSchema = z
  .string()
  .regex(/^sha256-[A-Za-z0-9_-]{43}$/, 'expected sha256-<43 char base64url>')
export const MimeSchema = z.string().min(1).max(255)
export const IdSchema = z.string().min(1).max(64)

/**
 * A representation as it travels on the wire. Exactly one of `inline` / `repId` is present, and
 * which one is a pure function of `byteLength` — spec §4. There is NO third option: an
 * oversized rep streams over the stdout pipe, it never spools to a file.
 */
export const RepSchema = z
  .object({
    mime: MimeSchema,
    uti: z.string().max(255).nullable().default(null),
    byteLength: z.int().min(0).max(MAX_REP_BYTES),
    sha256: ContentHashSchema,
    inline: z.base64().optional(),
    repId: IdSchema.optional(),
  })
  .refine((r) => (r.inline === undefined) !== (r.repId === undefined), {
    error: 'exactly one of inline | repId must be present',
  })
  .refine(
    (r) => (r.byteLength < CHUNK_THRESHOLD_BYTES ? r.inline !== undefined : r.repId !== undefined),
    { error: `reps under ${CHUNK_THRESHOLD_BYTES} bytes travel inline; at or over that they travel as repId` },
  )

export const HintSchema = z.enum(['concealed', 'transient', 'auto-generated', 'password-manager'])

export const AgentCapabilitiesSchema = z.object({
  wireMajor: z.literal(WIRE_MAJOR),
  agent: z.enum(['macos', 'win32', 'linux']),
  agentVersion: z.string().min(1),
  platformVersion: z.string().min(1),
  tier: z.enum(['A', 'B', 'C', 'D']),
  clipboardWatch: z.enum([
    'changecount-poll', 'sequence-poll', 'xfixes', 'wl-paste-watch', 'focus-only', 'none',
  ]),
  paste: z.enum(['cgevent', 'sendinput', 'ydotool', 'none']),
  hotkey: z.enum(['carbon', 'win32-hotkey', 'portal', 'electron', 'none']),
  focusApp: z.boolean(),
  concealedTypeHints: z.boolean(),
  maxRepBytes: z.int().positive(),
  chunkThresholdBytes: z.int().positive(),
  missingTools: z.array(z.string()).default([]),
})

const req = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({
    v: z.literal(WIRE_MAJOR),
    t: z.literal('req'),
    id: IdSchema,
    method: z.literal(method),
    params,
  })

export const AgentRequestSchema = z.discriminatedUnion('method', [
  req('hello', z.object({ hostVersion: z.string().min(1) })),
  req('watch.start', z.object({ intervalMs: z.int().min(50).max(60_000) })),
  req('watch.stop', z.object({})),
  req('read', z.object({ changeCount: z.int() })),
  req(
    'write',
    z.object({
      // Inline on purpose: the Swift codegen names a nested object after its owner, so this
      // becomes `struct WriteParamsRepsItem`, which is the name Task 4's `Writer.swift` is
      // written against. Do not hoist it to a named export — that would rename the Swift type.
      reps: z
        .array(z.object({ mime: MimeSchema, uti: z.string().nullable().default(null), b64: z.base64() }))
        .min(1),
      transient: z.boolean(),
    }),
  ),
  req('hotkey.register', z.object({ accelerator: z.string().min(1).max(64) })),
  req('hotkey.unregister', z.object({})),
  req('shutdown', z.object({})),
])

/** The per-method result payload. Keyed by method name so `AgentResult<M>` can index it. */
export const AgentResultSchema = {
  hello: AgentCapabilitiesSchema,
  'watch.start': z.object({ watching: z.literal(true), intervalMs: z.int() }),
  'watch.stop': z.object({ watching: z.literal(false) }),
  read: z.object({
    changeCount: z.int(),
    hints: z.array(HintSchema).default([]),
    reps: z.array(RepSchema),
  }),
  write: z.object({ changeToken: z.string().min(1) }),
  'hotkey.register': z.object({ bound: z.boolean(), accelerator: z.string() }),
  'hotkey.unregister': z.object({ bound: z.literal(false) }),
  shutdown: z.object({ bye: z.literal(true) }),
} as const

export const AgentErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(2_048),
})

export const AgentResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    v: z.literal(WIRE_MAJOR),
    t: z.literal('res'),
    id: IdSchema,
    ok: z.literal(true),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({
    v: z.literal(WIRE_MAJOR),
    t: z.literal('res'),
    id: IdSchema,
    ok: z.literal(false),
    error: AgentErrorSchema,
  }),
])

const ev = <E extends string, D extends z.ZodType>(event: E, data: D) =>
  z.object({ v: z.literal(WIRE_MAJOR), t: z.literal('ev'), event: z.literal(event), data })

export const AgentEventSchema = z.discriminatedUnion('event', [
  ev(
    'clipboard.changed',
    z.object({
      changeCount: z.int(),
      hints: z.array(HintSchema).default([]),
      reps: z.array(RepSchema),
      frontmostBundleId: z.string().nullable().default(null),
      frontmostName: z.string().nullable().default(null),
      attributionConfidence: z.enum(['heuristic', 'unknown']),
    }),
  ),
  ev(
    'rep.chunk',
    z.object({ repId: IdSchema, seq: z.int().min(0), final: z.boolean(), b64: z.base64() }),
  ),
  ev(
    'hotkey.fired',
    z.object({ accelerator: z.string().min(1), focusToken: z.string().min(1), firedAt: z.int() }),
  ),
  ev(
    'log',
    z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']),
      event: z.string().min(1).max(64),
      fields: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .default({}),
    }),
  ),
])

export const AgentLineSchema = z.discriminatedUnion('t', [
  AgentRequestSchema,
  AgentResponseSchema,
  AgentEventSchema,
])

export type Rep = z.output<typeof RepSchema>
export type PasteboardHintWire = z.output<typeof HintSchema>
export type AgentCapabilities = z.output<typeof AgentCapabilitiesSchema>
export type AgentRequest = z.output<typeof AgentRequestSchema>
export type AgentResponse = z.output<typeof AgentResponseSchema>
export type AgentEvent = z.output<typeof AgentEventSchema>
export type AgentLine = z.output<typeof AgentLineSchema>
export type AgentMethod = AgentRequest['method']
export type AgentEventName = AgentEvent['event']
export type AgentParams<M extends AgentMethod> = Extract<AgentRequest, { method: M }>['params']
export type AgentResult<M extends AgentMethod> = z.output<(typeof AgentResultSchema)[M]>
