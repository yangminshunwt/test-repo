import type { Context, Core, GitHub } from './github.ts';

// テストでは呼び出す API だけを用意する。実際の GitHub へ通信するクライアントは作らない。
export function mockGitHub(value: unknown): GitHub {
  return value as GitHub;
}

export function mockCore<T>(value: T): T & Core {
  return value as T & Core;
}

export function mockContext(value: Partial<Context>): Context {
  return value as Context;
}
