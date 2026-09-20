export interface ReviewOptions {
  workspace: string;
  cwd?: string;
  mode?: string;
  baseRef?: string;
  commit?: string;
  changedFiles?: string[];
  sessionId?: string;
  /** Called with each stdout chunk as it arrives from the adapter process */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives from the adapter process */
  onStderr?: (chunk: string) => void;
}

export interface FollowupOptions {
  workspace: string;
  cwd?: string;
  sessionId: string;
  prompt: string;
}

export interface RunOptions {
  cwd: string;
  task: string;
  readonly: boolean;
  timeoutMs?: number;
  /** Registry-supplied command override. Adapter callers should normally omit this. */
  binary?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface AdapterCapabilities {
  run: boolean;
  readOnly: boolean;
  followup: boolean;
}

export interface AdapterRuntimeStatus {
  name: string;
  binary: string;
  installed: boolean;
  authentication: 'unknown';
  health: 'unknown' | 'healthy' | 'failed';
  capabilities: AdapterCapabilities;
}

export interface AdapterResult {
  tool: string;
  externalSessionId: string | null;
  followupSupported: boolean;
  command: string;
  args: string[];
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
  text: string;
}

export interface AdapterDefinition {
  name: string;
  binary: string;
  capabilities?: Partial<Pick<AdapterCapabilities, 'readOnly' | 'followup'>>;
  run?(options: RunOptions): Promise<AdapterResult>;
  review(options: ReviewOptions): Promise<AdapterResult>;
  followup(options: FollowupOptions): Promise<AdapterResult>;
}
