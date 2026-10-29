// The two ways to open an issue, the same wherever an issue has buttons for it (the Issues list,
// the hover card of a chip, the briefing, a plan block): first the issue view inside Arcalo, then
// Jira in the browser, with the same icons and labels as the issue view's header and the menus.

import { ExternalLink } from "lucide-react";
import { IconButton, type IconButtonSize } from "../ui";
import { t } from "../../lib/i18n";
import { ISSUE_VIEW_ICON, openIssueInBrowser } from "../../lib/jiraActions";
import { openIssueView } from "../../lib/issueFull";

export function IssueOpenButtons({ issueKey, url, size = "sm", onOpen }: { issueKey: string; url?: string; size?: IconButtonSize; onOpen?: () => void }) {
  return (
    <span className="issue-open-buttons">
      <IconButton icon={ISSUE_VIEW_ICON} size={size} label={t("iv.openView")} className="issue-open-view" onClick={() => (onOpen?.(), openIssueView(issueKey))} />
      <IconButton icon={ExternalLink} size={size} label={t("iv.openInJira")} className="issue-open-jira" onClick={() => (onOpen?.(), void openIssueInBrowser(issueKey, url))} />
    </span>
  );
}
