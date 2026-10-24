import { compareVersions, latestRelease } from "./release";
import type { Runtime } from "./runtime";
import { VERSION } from "./version";

const DAY_MS = 86_400_000;

export interface UpdateNotice {
  text: string;
  /** Record that it was shown, so it waits another day. */
  shown: () => Promise<void>;
}

/**
 * The once-a-day update notice. Checks GitHub at most daily, and shows a
 * notice at most daily. Only for a person at a terminal: never without a TTY,
 * in CI, or when TOPCITED_NO_UPDATE_NOTIFIER is set.
 */
export async function checkForUpdate(rt: Runtime): Promise<UpdateNotice | undefined> {
  if (!rt.stdoutIsTTY || !rt.stderrIsTTY || rt.env.CI || rt.env.TOPCITED_NO_UPDATE_NOTIFIER) return undefined;
  let state = await rt.store.readState();
  const now = rt.now().getTime();
  const since = (iso?: string) => now - (iso ? Date.parse(iso) : 0);
  if (since(state.update_checked_at) >= DAY_MS) {
    const latest = await latestRelease(rt, 1500);
    state = { ...state, update_checked_at: rt.now().toISOString(), latest_version: latest?.version ?? state.latest_version };
    await rt.store.writeState(state);
  }
  const latest = state.latest_version;
  if (!latest || compareVersions(latest, VERSION) <= 0 || since(state.update_notified_at) < DAY_MS) return undefined;
  return {
    text: `\nA new release of topcited is available: ${VERSION} → ${latest}\nRun \`topcited upgrade\` to update.\n`,
    shown: () => rt.store.writeState({ ...state, update_notified_at: rt.now().toISOString() }),
  };
}
