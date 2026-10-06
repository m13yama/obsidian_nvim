import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { ReadingPositionSync } from "../src/obsidian/reading-position";

function fixture(height = 500) {
  let enabled = true;
  let scroll: number | null = 42.75;
  let beforeSwitch: (() => Promise<void>) | undefined;
  const cursors: { line: number; ch: number }[] = [];
  const scrolls: number[] = [];
  const scroller = { scrollTop: 1000, clientHeight: height };
  const containerEl = { querySelector: () => scroller, scrollTop: 0, clientHeight: 100 };
  let afterRender: ((callback: () => void) => void) = (callback) => callback();
  class TestView {
    file = { path: "note.md" };
    mode = "preview";
    getMode() { return this.mode; }
    previewMode = { containerEl, renderer: { onRendered: (callback: () => void) => afterRender(callback) }, getScroll: () => {
      assert.equal(this.mode, "preview", "read the source line before hiding the preview");
      return scroll;
    } };
    editor = { lineCount: () => 100, setCursor: (position: { line: number; ch: number }) => {
      assert.equal(this.mode, "source");
      cursors.push(position);
    } };
    currentMode = { applyScroll: (line: number) => { scrolls.push(line); } };
    async setState(state: { mode?: string; file?: string }, result: { layout: boolean }) {
      await beforeSwitch?.();
      if (state.file && state.file !== this.file.path) this.file = { path: state.file };
      if (state.mode) this.mode = state.mode;
      result.layout = true;
    }
  }
  const view = new TestView();
  const original = view.setState;
  const leaves = [{ view }];
  const sync = new ReadingPositionSync({ workspace: { getLeavesOfType: () => leaves } } as unknown as App, () => enabled);
  sync.refresh();
  return { view, original, sync, leaves, cursors, scrolls, scroller,
    setScroll: (value: number | null) => { scroll = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    delay: (callback: () => Promise<void>) => { beforeSwitch = callback; },
    render: (callback: (capture: () => void) => void) => { afterRender = callback; },
  };
}

test("reading-to-editing after a full page starts at the visible source line and preserves fractional scroll", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  f.setScroll(67.4); // A mouse/wheel/key scroll after attachment uses the latest position.
  f.scroller.scrollTop += f.scroller.clientHeight;
  const result = { layout: false };
  await f.view.setState({ mode: "source", file: "note.md" }, result);
  assert.deepEqual(f.cursors, [{ line: 67, ch: 0 }]);
  assert.deepEqual(f.scrolls, [67.4]);
  assert.equal(result.layout, true, "the original mode transition still runs");
  await f.view.setState({ mode: "source" }, result);
  await f.view.setState({ mode: "preview" }, result);
  assert.equal(f.cursors.length, 1, "other state updates and switching to reading do not move the cursor");
  f.setScroll(5.1);
  f.scroller.scrollTop -= f.scroller.clientHeight;
  await f.view.setState({ mode: "source" }, result);
  assert.deepEqual(f.cursors[1], { line: 5, ch: 0 });
});

test("no scroll or less than a page preserves the cursor, including its column", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  for (const delta of [0, 499, -499, 0.5, -0.5]) {
    await f.view.setState({ mode: "preview" }, { layout: false });
    f.scroller.scrollTop += delta;
    f.setScroll(73.25);
    await f.view.setState({ mode: "source" }, { layout: false });
  }
  assert.deepEqual(f.cursors, [], "leave the host's original selection untouched");
  assert.deepEqual(f.scrolls, [], "leave the host's scroll restoration untouched");
});

test("the threshold is one actual reading viewport in either direction", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  for (const [height, delta] of [[500, 500], [500, -500], [800, 800], [300, -950]]) {
    f.scroller.clientHeight = height!;
    await f.view.setState({ mode: "preview" }, { layout: false });
    f.scroller.scrollTop += delta!;
    await f.view.setState({ mode: "source" }, { layout: false });
  }
  assert.equal(f.cursors.length, 4);
});

test("movement is measured from reading entry and resets on every mode switch", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  f.scroller.scrollTop += 300;
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.sync.refresh();
  f.scroller.scrollTop += 200;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.equal(f.cursors.length, 1, "unrelated state updates must not reset the starting position");
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop += 800;
  f.scroller.scrollTop -= 700;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.equal(f.cursors.length, 1, "use net displacement, not accumulated travel");
  await f.view.setState({ mode: "preview" }, { layout: false });
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.equal(f.cursors.length, 1, "toggling again without scrolling preserves the cursor");
});

test("the starting position is captured after the renderer restores the reading scroll", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  await f.view.setState({ mode: "source" }, { layout: false });
  let rendered!: () => void;
  f.render((capture) => { rendered = capture; });
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop = 4000;
  rendered();
  f.scroller.scrollTop += 499;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.deepEqual(f.cursors, []);

  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop = 6000;
  rendered();
  f.scroller.scrollTop += 500;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.equal(f.cursors.length, 1);
});

test("late render callbacks cannot overwrite a newer reading session or run after unloading", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  await f.view.setState({ mode: "source" }, { layout: false });
  const captures: (() => void)[] = [];
  f.render((capture) => captures.push(capture));
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop += 600;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.deepEqual(f.cursors, [], "no jump before the starting position can be measured");
  await f.view.setState({ mode: "preview" }, { layout: false });
  captures[1]!();
  f.scroller.scrollTop += 500;
  captures[0]!();
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.equal(f.cursors.length, 1);
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.sync.destroy();
  f.view.previewMode.containerEl.querySelector = () => { throw new Error("disposed DOM accessed"); };
  captures[2]!();
});

test("unavailable viewport measurements leave the cursor intact", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  for (const [height, top] of [[0, 2000], [500, NaN], [500, Infinity]]) {
    await f.view.setState({ mode: "preview" }, { layout: false });
    f.scroller.clientHeight = height!;
    f.scroller.scrollTop = top!;
    await f.view.setState({ mode: "source" }, { layout: false });
  }
  assert.deepEqual(f.cursors, []);
});

test("a reading tab that was hidden starts measuring when it becomes visible", async (t) => {
  const f = fixture(0);
  t.after(() => f.sync.destroy());
  f.scroller.scrollTop = 4000;
  f.scroller.clientHeight = 500;
  f.sync.refresh();
  f.scroller.scrollTop += 499;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.deepEqual(f.cursors, []);
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop += 500;
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.equal(f.cursors.length, 1);
});

test("line positions are bounded and missing renderer measurements leave the cursor intact", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  for (const scroll of [null, NaN, Infinity]) {
    await f.view.setState({ mode: "preview" }, { layout: false });
    f.scroller.scrollTop += 500;
    f.setScroll(scroll);
    await f.view.setState({ mode: "source" }, { layout: false });
  }
  assert.deepEqual(f.cursors, []);
  for (const [scroll, expected] of [[-1, 0], [10000, 99], [0, 0]]) {
    await f.view.setState({ mode: "preview" }, { layout: false });
    f.scroller.scrollTop += 500;
    f.setScroll(scroll!);
    await f.view.setState({ mode: "source" }, { layout: false });
    assert.deepEqual(f.cursors.at(-1), { line: expected, ch: 0 });
  }
});

test("switching files or disabling Neovim does not transfer another reading position", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  f.scroller.scrollTop += 500;
  await f.view.setState({ mode: "source", file: "other.md" }, { layout: false });
  assert.deepEqual(f.cursors, []);
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop += 500;
  f.setEnabled(false);
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.deepEqual(f.cursors, []);
  f.setEnabled(true);
  await f.view.setState({ mode: "preview" }, { layout: false });
  f.scroller.scrollTop += 500;
  f.delay(async () => { f.view.file = { path: "third.md" }; });
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.deepEqual(f.cursors, [], "a file change during the transition invalidates the captured position");
});

test("closing or unloading restores the original method and cancels pending cursor changes", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  const wrapped = f.view.setState;
  f.scroller.scrollTop += 500;
  f.sync.refresh();
  assert.equal(f.view.setState, wrapped, "refresh does not wrap repeatedly");
  let resume!: () => void;
  f.delay(() => new Promise<void>((resolve) => { resume = resolve; }));
  const pending = f.view.setState({ mode: "source" }, { layout: false });
  f.leaves.length = 0;
  f.sync.refresh();
  assert.equal(f.view.setState, f.original);
  assert.equal(Object.hasOwn(f.view, "setState"), false, "prototype methods are restored without an instance shadow");
  resume();
  await pending;
  assert.deepEqual(f.cursors, []);
  f.leaves.push({ view: f.view });
  f.sync.refresh();
  f.sync.destroy();
  assert.equal(f.view.setState, f.original);
});

test("unloading leaves later plugin wrappers intact and makes the retained wrapper inert", async () => {
  const f = fixture();
  const wrapped = f.view.setState;
  const laterWrapper: typeof wrapped = function (this: typeof f.view, state, result) { return wrapped.call(this, state, result); };
  f.view.setState = laterWrapper;
  f.sync.destroy();
  assert.equal(f.view.setState, laterWrapper);
  await f.view.setState({ mode: "source" }, { layout: false });
  assert.deepEqual(f.cursors, []);
});

test("a newer state transition cancels an older pending reading position", async (t) => {
  const f = fixture();
  t.after(() => f.sync.destroy());
  f.scroller.scrollTop += 500;
  let resume!: () => void;
  f.delay(() => new Promise<void>((resolve) => { resume = resolve; }));
  const pending = f.view.setState({ mode: "source" }, { layout: false });
  f.delay(async () => {});
  await f.view.setState({ mode: "preview" }, { layout: false });
  resume();
  await pending;
  assert.deepEqual(f.cursors, []);
});
