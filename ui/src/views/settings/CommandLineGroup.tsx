// Settings → Desktop → „Befehlszeile“: the command `arcalo` in a terminal (docs/cli.md). Windows:
// the program folder on the user's PATH; macOS: the link /usr/local/bin/arcalo, made after the
// password prompt of macOS; Linux: only where the program is (the package puts it on the PATH).
// Applied at once, like autostart; the backend reads the state from the system each time.

import { useEffect, useState } from "react";
import { Badge, Switch } from "../../components/ui";
import { api } from "../../lib/api";
import { useT, type TKey } from "../../lib/i18n";
import type { CliPathInfo } from "../../lib/types";
import { useApp } from "../../store/app";
import { Group, PathValue, Row } from "./common";

type T = ReturnType<typeof useT>;

/** What the row says about the current state. */
export function cliDescription(info: CliPathInfo, t: T): string {
  const entry = info.entry ?? "";
  let text: string;
  if (info.state === "managed") text = t("set.cli.store");
  else if (info.platform === "linux") text = t(info.state === "on" ? "set.cli.linuxOn" : "set.cli.linuxOff");
  else if (info.platform === "macos") {
    const key: TKey = info.state === "on" ? "set.cli.macOn" : info.state === "elsewhere" && info.other ? "set.cli.macElsewhere" : "set.cli.macOff";
    text = t(key, { link: entry, other: info.other ?? "" });
  } else text = t(info.state === "on" ? "set.cli.winOn" : "set.cli.winOff", { dir: entry });
  return info.note ? `${text} ${info.note}` : text;
}

export function CommandLineGroup() {
  const t = useT();
  const [info, setInfo] = useState<CliPathInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.cliPathInfo().then(
      (i) => live && setInfo(i),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!info) return null;

  const set = async (on: boolean) => {
    setBusy(true);
    try {
      setInfo(await api.setCliPath(on));
    } catch (e) {
      useApp.getState().error(t(on ? "set.cli.addFailed" : "set.cli.removeFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const label = info.changeable ? t("set.cli.label") : t("set.cli.labelInfo");
  const available = info.state === "on" || info.state === "managed";

  return (
    <Group title={t("set.cli.title")} description={t("set.cli.desc")}>
      <Row label={label} description={cliDescription(info, t)} keywords="PATH Terminal arcalo">
        {info.changeable ? (
          <Switch label={t("set.cli.label")} checked={info.state === "on"} onChange={(v) => void set(v)} disabled={busy} />
        ) : (
          <Badge tone={available ? "success" : info.state === "elsewhere" ? "warning" : "neutral"}>
            {t(available ? "set.cli.available" : info.state === "elsewhere" ? "set.cli.other" : "set.cli.notOnPath")}
          </Badge>
        )}
      </Row>
      <Row label={t("set.cli.program")} keywords="PATH Terminal arcalo">
        <PathValue value={info.program} />
      </Row>
    </Group>
  );
}
