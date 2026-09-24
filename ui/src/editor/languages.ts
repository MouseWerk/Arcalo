// Code highlighting: the everyday languages are built in, the rest is loaded when a code block
// asks for it (they are a large part of the app's script otherwise).

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import type { LanguageFn } from "highlight.js";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { changedRanges, touchedBlocks } from "./incremental";

export const lowlight = createLowlight({ bash, css, diff, ini, java, javascript, json, markdown, plaintext, python, shell, sql, typescript, xml, yaml });

type Loader = () => Promise<{ default: LanguageFn }>;

// The other languages of lowlight's common set, loaded on demand.
const LAZY: Record<string, Loader> = {
  arduino: () => import("highlight.js/lib/languages/arduino"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  "php-template": () => import("highlight.js/lib/languages/php-template"),
  "python-repl": () => import("highlight.js/lib/languages/python-repl"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  swift: () => import("highlight.js/lib/languages/swift"),
  vbnet: () => import("highlight.js/lib/languages/vbnet"),
  wasm: () => import("highlight.js/lib/languages/wasm"),
};

// Their other names (as highlight.js knows them).
const ALIASES: Record<string, string> = {
  ino: "arduino",
  h: "c",
  cc: "cpp",
  "c++": "cpp",
  "h++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cxx: "cpp",
  cs: "csharp",
  "c#": "csharp",
  golang: "go",
  gql: "graphql",
  kt: "kotlin",
  kts: "kotlin",
  pluto: "lua",
  mk: "makefile",
  mak: "makefile",
  make: "makefile",
  mm: "objectivec",
  objc: "objectivec",
  "obj-c": "objectivec",
  "obj-c++": "objectivec",
  "objective-c++": "objectivec",
  pl: "perl",
  pm: "perl",
  pycon: "python-repl",
  rb: "ruby",
  gemspec: "ruby",
  podspec: "ruby",
  thor: "ruby",
  irb: "ruby",
  rs: "rust",
  vb: "vbnet",
};

/** The grammar to load for a code block's language, or null (built in, or unknown). */
export function lazyGrammar(language: string | null | undefined): string | null {
  if (!language) return null;
  const name = language.toLowerCase();
  if (lowlight.registered(name)) return null;
  const grammar = LAZY[name] ? name : ALIASES[name];
  return grammar && !lowlight.registered(grammar) ? grammar : null;
}

const loading = new Map<string, Promise<boolean>>();

/** Loads and registers the grammar for `language` if it is one of the lazy ones. */
export function loadLanguage(language: string): Promise<boolean> {
  const grammar = lazyGrammar(language);
  if (!grammar) return Promise.resolve(false);
  let p = loading.get(grammar);
  if (!p) {
    p = LAZY[grammar]()
      .then((m) => {
        lowlight.register({ [grammar]: m.default });
        return true;
      })
      .catch(() => false);
    loading.set(grammar, p);
  }
  return p;
}

/** Loads every lazy grammar among `languages`. */
export async function ensureLanguages(languages: Iterable<string>) {
  await Promise.all([...new Set(languages)].map(loadLanguage));
}

const key = new PluginKey<Set<string>>("lazyHighlight");

function codeLanguages(node: PMNode, out: Set<string>) {
  const visit = (n: PMNode) => {
    if (n.type.name === "codeBlock") {
      if (lazyGrammar(n.attrs.language)) out.add(n.attrs.language);
      return false;
    }
    return true;
  };
  if (visit(node)) node.descendants(visit);
}

/** Loads the grammars code blocks ask for, then redraws those blocks. */
export const LazyHighlight = Extension.create({
  name: "lazyHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => {
            const out = new Set<string>();
            codeLanguages(doc, out);
            return out;
          },
          apply: (tr) => {
            const out = new Set<string>();
            if (!tr.docChanged) return out;
            const ranges = changedRanges(tr);
            if (!ranges) codeLanguages(tr.doc, out);
            else for (const { node } of touchedBlocks(tr.doc, ranges)) codeLanguages(node, out);
            return out;
          },
        },
        view: (view) => {
          let alive = true;
          const load = (languages: Set<string> | undefined) => {
            if (!languages?.size) return;
            void ensureLanguages(languages).then(() => {
              if (!alive || view.isDestroyed) return;
              // Replace the code blocks of these languages with themselves: the highlighter redraws them.
              const { state } = view;
              const tr = state.tr;
              state.doc.descendants((node, pos) => {
                if (node.type.name !== "codeBlock") return true;
                if (languages.has(node.attrs.language)) tr.replaceWith(pos, pos + node.nodeSize, node);
                return false;
              });
              if (!tr.docChanged) return;
              tr.setSelection(Selection.fromJSON(tr.doc, state.selection.toJSON()));
              // The same document: no undo step, no update (nothing to save).
              tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
              view.dispatch(tr);
            });
          };
          load(key.getState(view.state));
          return {
            update: (v, prev) => {
              if (v.state.doc !== prev.doc) load(key.getState(v.state));
            },
            destroy: () => {
              alive = false;
            },
          };
        },
      }),
    ];
  },
});
