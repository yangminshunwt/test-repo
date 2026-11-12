import type * as actionsCore from '@actions/core';
import type { context, getOctokit } from '@actions/github';

export type GitHub = ReturnType<typeof getOctokit>;
export type Core = typeof actionsCore;
export type Context = typeof context;

export interface Repository {
  owner: string;
  repo: string;
}

export interface WorkflowInput {
  github: GitHub;
  context: Context;
  core: Core;
}
