// The guided Git sync setup's behavior, the same on the desktop and the phone: the wizard state
// (lib/gitsetup.ts), the requests of each step and saving at the end. The screens only lay it out.

import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "./api";
import { t } from "./i18n";
import {
  blocker,
  hasApi,
  initialWizard,
  savedGit,
  serverOf,
  targetOf,
  tokenPage,
  fineGrainedPage,
  wizardReducer,
  pastedOf,
  type SetupProblem,
  type WizardState,
} from "./gitsetup";

/** What the screen saves: the Git sync's settings (address, branch, switched on). Resolves once
 *  they are stored, to the way back to the settings from before (when the token cannot be stored
 *  after them); rejects when they could not be stored (and leaves the ones from before). */
export type SaveGit = (git: { remote_url: string; branch: string; enabled: true }) => Promise<void | (() => Promise<void>)>;

/**
 * The setup's end: the settings first, then a new token into the credential store. When the
 * settings could not be stored the token is not replaced (no new token next to the old address);
 * when the token could not be stored the settings go back (no new address next to the old token).
 */
export async function saveSetup(git: Parameters<SaveGit>[0], token: string | null, save: SaveGit, storeToken: (token: string) => Promise<unknown>): Promise<void> {
  const undo = await save(git);
  if (!token) return;
  try {
    await storeToken(token);
  } catch (e) {
    if (undo) await undo().catch(() => {});
    throw e;
  }
}

const failure = (e: unknown): SetupProblem => ({ kind: "other", status: null, detail: e instanceof Error ? e.message : String(e) });

async function openUrl(url: string) {
  const o = await import("@tauri-apps/plugin-opener");
  await o.openUrl(url);
}

export function useGitSetup(opts: { tokenStored: boolean; remoteUrl?: string; save: SaveGit }) {
  const [s, dispatch] = useReducer(wizardReducer, undefined, () => initialWizard({ tokenStored: opts.tokenStored, remoteUrl: opts.remoteUrl, proposedName: t("gitsetup.proposedName") }));
  const latest = useRef<WizardState>(s);
  latest.current = s;
  const save = useRef(opts.save);
  save.current = opts.save;
  const token = () => latest.current.token.trim() || null;

  const loadRepos = useCallback(async () => {
    const st = latest.current;
    if (!hasApi(st.provider ?? "other")) return;
    dispatch({ type: "busy", busy: "repos" });
    try {
      dispatch({ type: "repos", answer: await api.gitSetupRepos(serverOf(st), st.token.trim() || null) });
    } catch (e) {
      dispatch({ type: "repos", answer: { value: null, problem: failure(e) } });
    }
  }, []);

  const runCheck = useCallback(async () => {
    const st = latest.current;
    const target = targetOf(st);
    if (!target) return;
    dispatch({ type: "busy", busy: "check" });
    try {
      dispatch({ type: "checked", check: await api.gitSetupCheck(serverOf(st), target, st.token.trim() || null) });
    } catch (e) {
      dispatch({ type: "problem", problem: failure(e) });
    }
  }, []);

  // Entering the check runs it.
  useEffect(() => {
    if (s.step === "check" && !s.check && !s.busy && !s.problem) void runCheck();
  }, [s.step, s.check, s.busy, s.problem, runCheck]);

  const finish = async () => {
    const st = latest.current;
    const target = targetOf(st);
    if (!target || !st.check || st.check.problem) return;
    dispatch({ type: "busy", busy: "save" });
    try {
      // The token goes into the credential store only now (a cancelled setup leaves the old one),
      // after the settings it belongs to.
      await saveSetup(savedGit(st.check, target), st.token.trim() || null, save.current, (token) => api.setGitToken(token));
      dispatch({ type: "saved" });
    } catch (e) {
      dispatch({ type: "problem", problem: failure(e) });
    }
  };

  /** The step's main button: on to the next step, with its request. */
  const next = async () => {
    const st = latest.current;
    if (st.busy || blocker(st)) return;
    const server = serverOf(st);
    switch (st.step) {
      case "provider":
        dispatch({ type: "goto", step: "token" });
        return;
      case "token":
        if (!hasApi(server.provider)) {
          dispatch({ type: "goto", step: "repo" });
          return;
        }
        dispatch({ type: "busy", busy: "account" });
        try {
          const answer = await api.gitSetupAccount(server, token());
          dispatch({ type: "account", answer });
          if (!answer.problem) await loadRepos();
        } catch (e) {
          dispatch({ type: "problem", problem: failure(e) });
        }
        return;
      case "repo":
        if (st.mode === "create") {
          dispatch({ type: "busy", busy: "create" });
          try {
            dispatch({ type: "created", answer: await api.gitSetupCreate(server, token(), st.newName.trim()) });
          } catch (e) {
            dispatch({ type: "problem", problem: failure(e) });
          }
          return;
        }
        dispatch({ type: "goto", step: "check" });
        return;
      case "check":
        if (st.check && !st.check.problem) await finish();
        else await runCheck();
        return;
    }
  };

  /** Opens the provider's token page (scopes preselected where it takes them). */
  const openTokenPage = (fineGrained = false) => {
    const st = latest.current;
    const provider = st.provider ?? "other";
    const pasted = pastedOf(st);
    const url = fineGrained ? fineGrainedPage(serverOf(st).web) : tokenPage(provider, serverOf(st).web, pasted);
    if (url) void openUrl(url).catch((e) => dispatch({ type: "problem", problem: failure(e) }));
  };

  return { s, dispatch, next, runCheck, loadRepos, openTokenPage };
}
