export declare const TRANSCRIPT_DIR: string
export declare const MAX_TRANSCRIPT_BYTES: number
export declare const ALLOWED_BUNDLE_ID: RegExp
export declare function listTranscripts(): string[]
export declare function scanTranscript(
  path: string,
  detect: (text: string) => readonly string[],
): string[]
export declare function loadDetector(): Promise<(text: string) => readonly string[]>
export declare function main(): Promise<number>
