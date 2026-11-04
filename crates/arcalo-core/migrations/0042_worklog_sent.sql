-- Jira, 1.17: what the last post of a worklog sent, until Jira confirmed it.
--
-- A post that timed out or was cut off by a quit may have reached Jira. The next try looks for
-- that worklog on the issue by the values it sent (`sent_started`, `sent_minutes`), not by the
-- booking as it is now: an edit in between would otherwise post a second worklog. A booking
-- deleted before its post was confirmed queues a deletion without a worklog id
-- (`jira_worklog_deletes.worklog_id = ''`), done by looking the worklog up by these values.

ALTER TABLE time_entry_issues ADD COLUMN sent_started TEXT;
ALTER TABLE time_entry_issues ADD COLUMN sent_minutes INTEGER;
ALTER TABLE time_entry_issues_deleted ADD COLUMN sent_started TEXT;
ALTER TABLE time_entry_issues_deleted ADD COLUMN sent_minutes INTEGER;
ALTER TABLE jira_worklog_deletes ADD COLUMN sent_started TEXT;
ALTER TABLE jira_worklog_deletes ADD COLUMN sent_minutes INTEGER;
