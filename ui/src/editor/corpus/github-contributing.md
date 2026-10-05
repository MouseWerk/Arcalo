# Contributing to tinyq #

Thanks for taking the time to contribute! The following is a set of guidelines,
not rules. Use your best judgment.

## Reporting bugs

Before you open an issue:

1. Check the [existing issues](https://github.com/example/tinyq/issues).
1. Update to the latest version.
1. Try to reproduce it with a minimal script.

When you open one, include:

- the version of Node.js (`node -v`)

- the operating system

- a short script that shows the problem

## Development setup

1. Fork and clone the repository:

   ```sh
   git clone https://github.com/<you>/tinyq.git
   cd tinyq
   ```

2. Install the dependencies with `npm ci`.
3. Run the tests:

       npm test

### Commit messages

* Use the present tense ("Add feature" not "Added feature")
* Limit the first line to 72 characters
  * Reference issues and pull requests after the first line
* Use `fix:`, `feat:` or `docs:` as prefix

Write *why* the change is needed, not only _what_ changed. Code in commit
messages goes in backticks: ``const x = `y`;``.

Questions? Mail <maintainers@example.com> or open a [discussion][].

[discussion]: https://github.com/example/tinyq/discussions
