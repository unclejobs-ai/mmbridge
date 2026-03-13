export interface ReviewOptions {
  workspace: string;
  cwd?: string;
  mode?: string;
  baseRef?: string;
  commit?: string;
  changedFiles?: string[];
  sessionId?: string;
}

export interface FollowupOptions {
  workspace: string;
  cwd?: string;
  sessionId: string;
  prompt: string;
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
  review(options: ReviewOptions): Promise<AdapterResult>;
  followup(options: FollowupOptions): Promise<AdapterResult>;
}
