Notes: Kubernetes migration
===========================

__Status__: draft, last edit 2026-08-30

Things to check before we move the cluster:

* ingress rules (see `ingress.yaml`)
* the _secrets_ in the old namespace
    * `db-password`
    * `smtp-token`
* ~~cron jobs~~ already moved

1. Freeze deploys
2. Snapshot the volumes
3. Switch DNS

Contact: Ops team\
Phone: +49 30 1234567  
Room: B.204

> Quote from the post-mortem:
> "We assumed the old cluster was idle. It was not."

Price per node: 0,12 &euro;/h &mdash; about 87 &euro; per month.

***Important***: never delete the old PVCs before the backup check.

- [x] write migration plan
- [ ] dry run on staging
- [ ] announce downtime

Links: [runbook](./runbook.md "Runbook"), [dashboard](<https://grafana.example.com/d/abc def>)
and https://kubernetes.io/docs/.

Escaped: 2 \* 3 = 6, file\_name\_v2, \# not a heading, 1\. not a list.

___

end
