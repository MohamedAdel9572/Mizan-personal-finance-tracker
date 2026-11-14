import type { Api } from "../lib/api.ts";
import type { AppData } from "../lib/store.ts";

/** What every screen gets. */
export interface Ctx {
  api: Api;
  data: AppData;
  /** route parameters after the screen name, e.g. #/log/2026-11 -> ["2026-11"] */
  params: string[];
  /** reload data from the server and re-render the current screen */
  reload: () => Promise<void>;
  navigate: (hash: string) => void;
  /** handle any error from an action: friendly toast, sign-out on expired session */
  fail: (e: unknown) => void;
}

export type Screen = (root: HTMLElement, ctx: Ctx) => void;
