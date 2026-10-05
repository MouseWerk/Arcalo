# Meeting 2026-10-01 – Release planning

**Attendees:** Ana, Ben, Chiara  
**Notes by:** Ben

## Agenda
1. Status of 1.13
2. Store listing
3. AOB

## Decisions

| Topic         | Decision                  | Owner  |
|:--------------|:-------------------------:|-------:|
| Release date  | **Oct 12**                | Ana    |
| Beta channel  | keep, but _opt-in_ only   | Ben    |
| Docs          | rewrite the FAQ           | Chiara |

## Action items
- [ ] Ana: draft the release notes
- [ ] Ben: test the installer on a clean VM
- [x] Chiara: collect FAQ questions

## Code snippet discussed

```python
def retry(fn, attempts=3):
    for i in range(attempts):
        try:
            return fn()
        except TimeoutError:
            continue
```

Use `retry()` only for idempotent calls; see [PEP 8][pep8] for style.
Use ``retry(`fn`)`` in docs.

## Open questions
+ Do we need a *second* beta?
+ Who owns the Store screenshots?
    + probably Chiara

[pep8]: https://peps.python.org/pep-0008/

---
*Next meeting: 2026-10-08*
