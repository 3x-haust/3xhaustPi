import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/calculator.js";

test("add returns the sum of its operands", () => {
	assert.equal(add(2, 3), 5);
});
