// Settings → Über → „Lizenzen“: Arcalo's license (full text in a dialog) and the open-source
// libraries it ships, searchable, with version and license.

import { useState } from "react";
import { FileText, Library as LibraryIcon, Search } from "lucide-react";
import { Button, Dialog } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { APP_LICENSE, LIBRARIES, copyrightLine, filterLibraries, licenseName, type Library } from "../../lib/licenses";
import { Group, Row } from "./common";

export function LicensesGroup() {
  const t = useT();
  const [open, setOpen] = useState<"app" | "libs" | null>(null);
  const count = LIBRARIES.ui.length + LIBRARIES.app.length;
  return (
    <Group title={t("lic.group")}>
      {APP_LICENSE && (
        <Row label="Arcalo" description={[t("lic.appLicense", { name: licenseName(APP_LICENSE) }), copyrightLine(APP_LICENSE)].filter(Boolean).join(" · ")}>
          <Button variant="ghost" icon={FileText} className="lic-app" onClick={() => setOpen("app")}>
            {t("lic.showText")}
          </Button>
        </Row>
      )}
      {count > 0 && (
        <Row label={t("lic.libraries")} description={t("lic.librariesDesc", { n: count })}>
          <Button variant="ghost" icon={LibraryIcon} className="lic-libs" onClick={() => setOpen("libs")}>
            {t("lic.showLibraries")}
          </Button>
        </Row>
      )}
      {open === "app" && (
        <Dialog open onClose={() => setOpen(null)} title={t("lic.appTitle")} width={600} footer={<Button onClick={() => setOpen(null)}>{t("common.close")}</Button>}>
          <pre className="lic-text selectable">{APP_LICENSE}</pre>
        </Dialog>
      )}
      {open === "libs" && <LibrariesDialog onClose={() => setOpen(null)} />}
    </Group>
  );
}

function LibrariesDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const ui = filterLibraries(LIBRARIES.ui, query);
  const app = filterLibraries(LIBRARIES.app, query);
  const list = (title: string, items: Library[]) =>
    items.length > 0 && (
      <section className="lic-section" aria-label={title}>
        <h3 className="lic-head">{title}</h3>
        <ul className="lic-list">
          {items.map((l) => (
            <li key={l.name} className="lic-row">
              <span className="lic-name">{l.name}</span>
              <span className="lic-version num faint">{l.version}</span>
              <span className="lic-license">{l.license || t("lic.unknown")}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("lic.librariesTitle")}
      description={t("lic.librariesIntro")}
      width={620}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      <div className="settings-search lic-search">
        <Search size={14} className="faint" aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("lic.search")} aria-label={t("lic.search")} spellCheck={false} />
      </div>
      <div className="lic-body">
        {list(t("lic.uiLibraries"), ui)}
        {list(t("lic.appLibraries"), app)}
        {!ui.length && !app.length && <p className="faint small lic-none">{t("lic.none", { query: query.trim() })}</p>}
      </div>
    </Dialog>
  );
}
