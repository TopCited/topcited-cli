import type { Command } from "commander";
import type { Context } from "../context";

// biome-ignore lint: handlers declare their own option/arg shapes
export type Handler = (ctx: Context, opts: any, ...args: any[]) => Promise<void>;

/** Wraps a handler as a commander action that receives a ready Context. */
export type Action = (handler: Handler) => (...args: unknown[]) => Promise<void>;

export type Register = (program: Command, action: Action) => void;
