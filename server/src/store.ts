import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushSubscription } from "web-push";
import { config } from "./config.js";

export type Activity = {
  /** confiscation: burned by the central bank; forced: moved by the central bank. */
  kind: "transfer" | "mint" | "confiscation" | "forced";
  from: string;
  to: string;
  value: string; // wei, decimal string
  reason?: string;
  tx: string;
  block: number;
  timestamp?: number;
};

export type RecoveryEvent = {
  /** taken: the central bank took control (immediate, cannot be cancelled). */
  kind: "initiated" | "executed" | "cancelled" | "taken";
  safe: string;
  reason?: string;
  newOwner?: string;
  removeOthers?: boolean;
  executeAfter?: number;
  tx: string;
  block: number;
};

export type Credential = { credentialHash: string; safe: string; signer: string; x: string; y: string; block: number };

type State = {
  /** pending: the Safe a signup is creating with this invite; usedBy: set once it exists. */
  invites: Record<string, { createdAt: number; usedBy?: string; pending?: string; note?: string }>;
  members: Record<string, { joinedAt: number; invite?: string }>;
  usage: Record<string, { day: string; ops: number; relays: number }>;
  subscriptions: Record<string, PushSubscription[]>;
  index: {
    lastBlock: number;
    names: Record<string, string>;
    credentials: Credential[];
    activity: Activity[];
    recoveries: RecoveryEvent[];
  };
};

const empty = (): State => ({
  invites: {},
  members: {},
  usage: {},
  subscriptions: {},
  index: { lastBlock: 0, names: {}, credentials: [], activity: [], recoveries: [] },
});

mkdirSync(config.dataDir, { recursive: true });
const file = join(config.dataDir, "store.json");

function load(): State {
  try {
    return { ...empty(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return empty();
  }
}

export const state: State = load();

let timer: NodeJS.Timeout | undefined;
/** Persist soon; writes are batched and atomic (write + rename). */
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    writeFileSync(`${file}.tmp`, JSON.stringify(state));
    renameSync(`${file}.tmp`, file);
  }, 200);
}

export function saveNow() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Count one unit of `kind` for `who`; returns false if the daily limit is reached. */
export function consume(who: string, kind: "ops" | "relays", limit: number): boolean {
  const key = who.toLowerCase();
  const u = state.usage[key];
  const day = today();
  const current = u && u.day === day ? u : { day, ops: 0, relays: 0 };
  if (current[kind] >= limit) return false;
  current[kind] += 1;
  state.usage[key] = current;
  save();
  return true;
}

export const isMember = (a: string) => Boolean(state.members[a.toLowerCase()]);
