import { test } from "node:test";
import assert from "node:assert/strict";
import { normTags, storeTags } from "../src/tags.js";

test("tags are trimmed, lower-cased, de-duplicated and sorted", () => {
  assert.deepEqual(normTags(["Job hunt", " job  hunt ", "#Breakdown", "", "explore"]), ["breakdown", "explore", "job hunt"]);
});

test("tags read back from the stored comma form", () => {
  assert.deepEqual(normTags("job hunt,breakdown"), ["breakdown", "job hunt"]);
  assert.deepEqual(normTags(null), []);
  assert.deepEqual(normTags(undefined), []);
});

test("a comma inside a tag cannot split it when stored", () => {
  const tags = normTags(["a,b"]);
  assert.deepEqual(tags, ["a b"]);
  assert.deepEqual(normTags(storeTags(tags)), tags);
});

test("long tags and long lists are cut down", () => {
  assert.equal(normTags(["x".repeat(80)])[0].length, 30);
  assert.equal(normTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 12);
  assert.equal(storeTags([]), null);
});
