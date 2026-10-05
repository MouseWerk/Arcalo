<p align="center">
  <img src="docs/logo.svg" width="120" alt="tinyq">
</p>

tinyq
=====

[![Build status](https://github.com/example/tinyq/workflows/ci/badge.svg)](https://github.com/example/tinyq/actions)
[![npm][npm-badge]][npm-url]
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A tiny, dependency-free job queue for Node.js. It keeps jobs in memory, retries
failed ones with exponential back-off and never loses a job on a clean shutdown.

**Table of contents**

* [Install](#install)
* [Usage](#usage)
* [API](#api)
* [Contributing](CONTRIBUTING.md)


Install
-------

``` bash
npm install tinyq
```

Usage
-----

```js
import { Queue } from "tinyq";

const q = new Queue({ concurrency: 4 });
q.add(async () => fetch("https://example.com"));
```

### Options ###

Option | Default | Description
--- | --- | ---
`concurrency` | `1` | Jobs that run at the same time
`retries` | `3` | Attempts before a job fails
`backoff` | `"exp"` | `"exp"` or `"fixed"`

> **Note**
> Jobs are kept in memory only. Use [tinyq-redis] if you need persistence.

## API

#### `q.add(job, [options])`

Adds a job. Returns a promise that resolves with the job's result.

#### `q.drain()`

Resolves once the queue is empty. See also [the FAQ][faq] and [CHANGELOG.md](CHANGELOG.md).

<details>
<summary>Why another queue?</summary>

Most queues need Redis. This one does not.

</details>

***

Made with care by [@example](https://github.com/example) - questions to <mail@example.com>
or <https://example.com/support>.

[npm-badge]: https://img.shields.io/npm/v/tinyq.svg
[npm-url]: https://www.npmjs.com/package/tinyq
[tinyq-redis]: https://github.com/example/tinyq-redis
[faq]: https://github.com/example/tinyq/wiki/FAQ "Frequently asked questions"
