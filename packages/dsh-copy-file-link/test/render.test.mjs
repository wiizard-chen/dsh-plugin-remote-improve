/**
 * Exercise the shipped browser bundle without a browser.
 *
 * The bundle is loaded through a stubbed `window.__ModuleLoader__`, its plugin
 * face is applied to a stubbed Cordis context, and the registered component is
 * rendered with a stubbed React: this covers the factory wiring, the slot
 * registration options, the rendered control, and the clipboard write on click.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** Minimal element factory: records type, props, and children for assertions. */
const React = {
  createElement(type, props, ...children) {
    /* Function components (the glyphs) render through, as React would. */
    if (typeof type === 'function') return type({ ...props, children });
    return { type, props: { ...props, children } };
  },
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn) => fn(),
};

/** Minimal DOM the bundle's stylesheet effect needs; `execCommand` stays absent. */
function stubDom() {
  const element = () => ({
    dataset: {},
    style: {},
    textContent: '',
    value: '',
    setAttribute() {},
    select() {},
    remove() {},
    appendChild() {},
  });
  globalThis.document = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: element,
  };
}

/** Load the bundle against the stubs and return everything the assertions need. */
function loadBundle() {
  let registration;
  stubDom();
  globalThis.window = {
    __ModuleLoader__: { load: (record) => { registration = record; } },
  };
  new Function(source)();
  assert.equal(registration.id, 'dsh-copy-file-link');
  const face = registration.factory((spec) => {
    if (spec === 'react') return React;
    throw new Error(`unexpected module request: ${spec}`);
  });

  const slots = [];
  const namespaces = [];
  const effects = [];
  const ctx = {
    effect: (callback, label) => { effects.push(label); const disposer = callback(); return () => disposer; },
    locale: {
      register: (ns, dicts) => { namespaces.push([ns, dicts]); return () => {}; },
    },
    slots: {
      inject: (key, callback) => { slots.push([key, callback()]); return () => {}; },
      register: (options, component) => { slots.push([options.name, { options, component }]); return () => {}; },
    },
  };
  face.apply(ctx);
  return { face, slots, namespaces, effects };
}

/** The component the bundle registered into the document header seat. */
function registeredControl() {
  const { face, slots, namespaces, effects } = loadBundle();
  assert.deepEqual(face.inject, ['slots', 'locale']);
  assert.deepEqual(namespaces[0][0], 'copyFileLink');
  assert.deepEqual(Object.keys(namespaces[0][1]).sort(), ['en', 'zh']);
  assert.ok(effects.includes('copy-file-link: dictionaries'));
  assert.ok(effects.includes('copy-file-link: styles'));
  const entry = slots.find(([key]) => key === 'sidebar.right.tab.document.actions');
  assert.ok(entry !== undefined, 'the header seat must be registered');
  return entry[1];
}

/** Props shaped like the framework's: the owner prop and the entry's `t`. */
function propsFor(absolutePath, translate = (key) => key) {
  return { absolutePath, t: translate };
}

test('registers one entry into the preview header with a stable id', () => {
  const { options } = registeredControl();
  assert.equal(options.name, 'sidebar.right.tab.document.actions');
  assert.equal(options.id, 'copy-file-link');
  assert.equal(options.locale, 'copyFileLink');
  assert.equal(typeof options.order, 'number');
});

test('renders an icon-only button whose tooltip carries the absolute path', () => {
  const { component } = registeredControl();
  const element = component(propsFor('/example/project/src/client.js'));
  assert.equal(element.type, 'button');
  assert.equal(element.props.type, 'button');
  assert.equal(element.props['data-copy-file-link'], '');
  assert.equal(element.props['data-status'], 'idle');
  assert.match(element.props.title, /\/example\/project\/src\/client\.js$/);
  assert.ok(!element.props.title.includes(']('), 'the tooltip shows the bare path');
  assert.equal(element.props['aria-label'], element.props.title);
  assert.equal(element.props.children.length, 1, 'the button holds exactly one child');
  assert.equal(element.props.children[0].type, 'svg', 'the only child is the svg glyph');
});

test('carries no visible text label', () => {
  const { component } = registeredControl();
  const element = component(propsFor('/example/project/src/client.js'));
  const texts = [];
  const walk = (node) => {
    if (typeof node === 'string') texts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  };
  walk(element);
  assert.deepEqual(texts, [], 'no text node may be rendered inside the control');
});

test('localized tooltip copy comes from the entry dictionary', () => {
  const { component } = registeredControl();
  const element = component(propsFor('/example/project/a.ts', (key) => ({
    hint: '复制该文件的绝对路径', copied: '已复制', failed: '复制失败',
  })[key]));
  assert.equal(element.props.title, '复制该文件的绝对路径: /example/project/a.ts');
});

test('renders nothing without a Host path', () => {
  const { component } = registeredControl();
  assert.equal(component(propsFor(undefined)), null);
  assert.equal(component(propsFor('')), null);
});

test('clicking writes the bare absolute path to the clipboard', async () => {
  const written = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { written.push(text); } } },
    configurable: true,
  });
  try {
    const { component } = registeredControl();
    const element = component(propsFor('/example/project/dsh-copy-file-link/client.js'));
    element.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(written, ['/example/project/dsh-copy-file-link/client.js']);
  } finally {
    if (originalNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }
});
