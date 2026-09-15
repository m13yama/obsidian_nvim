import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { NeovimStatusLine } from "../src/ui/status-line";

test("status line follows mode, note, cursor, recording, and connection transitions", () => {
  const dom = new JSDOM("<div id='status'></div>");
  const container = dom.window.document.getElementById("status")!;
  const statusLine = new NeovimStatusLine(container, () => {});
  const element = (selector: string) => container.querySelector<HTMLElement>(selector)!;

  statusLine.update("VISUAL BLOCK", {
    file: "notes/日本語 <script>.md", line: 7, column: 12, totalLines: 20, recording: "q",
  });
  assert.equal(element("button").dataset.tone, "visual");
  assert.equal(element(".neovim-statusline-label").textContent, "V-BLOCK");
  assert.equal(element(".neovim-statusline-file").textContent, "日本語 <script>.md");
  assert.equal(element(".neovim-statusline-file").title, "notes/日本語 <script>.md");
  assert.equal(container.querySelector("script"), null, "note names are plain text");
  assert.equal(element(".neovim-statusline-position").textContent, "7:12");
  assert.equal(element(".neovim-statusline-progress").textContent, "35%");
  assert.equal(element(".neovim-statusline-recording").textContent, "REC @q");
  assert.equal(element(".neovim-statusline-recording").hidden, false);
  assert.match(element("button").getAttribute("aria-label")!, /Line 7 of 20, column 12/);

  const announcement = element(".neovim-statusline-announcement").firstChild;
  statusLine.update("VISUAL BLOCK", {
    file: "notes/日本語 <script>.md", line: 8, column: 1, totalLines: 20, recording: "q",
  });
  assert.equal(element(".neovim-statusline-announcement").firstChild, announcement, "cursor movements do not create screen reader announcements");

  statusLine.update("INSERT", { file: "second.md", line: 1, column: 1, totalLines: 1, recording: "" });
  assert.equal(element(".neovim-statusline-file").textContent, "second.md");
  assert.equal(element(".neovim-statusline-progress").textContent, "ALL");
  assert.equal(element(".neovim-statusline-recording").hidden, true);

  statusLine.update("Disconnected");
  assert.equal(element("button").dataset.tone, "error");
  assert.equal(element(".neovim-statusline-label").textContent, "OFFLINE");
  for (const part of ["file", "position", "progress", "recording"]) {
    assert.equal(element(`.neovim-statusline-${part}`).hidden, true);
  }
  assert.doesNotMatch(element("button").getAttribute("aria-label")!, /second.md/);
  statusLine.destroy();
  dom.window.close();
});

test("status line provides a native restart button and removes its handler on teardown", () => {
  const dom = new JSDOM("<div id='status'></div>");
  const container = dom.window.document.getElementById("status")!;
  let restarts = 0;
  const statusLine = new NeovimStatusLine(container, () => { restarts++; }, "compact");
  const button = container.querySelector("button")!;
  assert.equal(button.type, "button");
  button.click();
  assert.equal(restarts, 1);
  statusLine.destroy();
  button.click();
  assert.equal(restarts, 1);
  assert.equal(container.childElementCount, 0);
  dom.window.close();
});
